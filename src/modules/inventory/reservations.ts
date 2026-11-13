import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { forOrganization, type TenantDb } from "@/server";

import { containedAt, containedMessage } from "./contained";
import { formatStock, type InventoryActor } from "./movements";
import { AVAILABLE_ANY_LOT, availableOfLot } from "./stock-status";

/**
 * Reservations (WMS-12, ADR 0033): stock set aside for a document without
 * moving it. A reservation subtracts from what is AVAILABLE — of its
 * location when it names one, and of the product always — so:
 *
 *   free to take in a location = min(available there − reserved there,
 *                                    available of the product − reserved of it)
 *
 * Documents (outbound orders, production) call `reserveStock`,
 * `consumeReservation` and `releaseReservations` inside their own
 * transaction, after locking the product (and the location): that lock is
 * what keeps two reservations from taking the same stock. Exits, moves and
 * state changes of AVAILABLE stock ask `freeToTake` under the same lock and
 * never take what is reserved. Counts and imported exits record what
 * already happened and are not stopped.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Tx | ReturnType<typeof forOrganization>;

/**
 * WMS-52 (ADR 0042): a task sets aside what it is about to move inside the
 * same product (a put-away). It only counts in its location: the product's
 * total does not change by moving it, so it does not subtract from what is
 * available of the product as a whole.
 */
export const TASK_HOLD = "warehouse_task";

/**
 * Reservations that hold stock of the product as a whole (documents that
 * will take it out): for every read of what is reserved of a product,
 * anywhere. A location's reservations are all of them.
 */
export const PRODUCT_HOLDS = { sourceType: { not: TASK_HOLD } } as const;

export type ReservationSource = {
  /** «outbound_order_line», «production_order_line»… */
  type: string;
  id: string;
};

/**
 * WMS-21: `lotId` narrows a sum to one lot; `undefined` adds every lot (and
 * is all a product without lots has).
 */
async function availableOf(
  client: Reader,
  productId: string,
  locationId: string | null,
  lotId?: string,
): Promise<Decimal> {
  const sum = await client.stockBalance.aggregate({
    where: {
      productId,
      ...(locationId ? { locationId } : {}),
      ...(lotId ? availableOfLot(lotId) : AVAILABLE_ANY_LOT),
    },
    _sum: { quantity: true },
  });
  return dec((sum._sum.quantity ?? 0).toString());
}

async function reservedOf(
  client: Reader,
  productId: string,
  locationId: string | null,
  lotId?: string,
): Promise<Decimal> {
  const sum = await client.stockReservation.aggregate({
    where: {
      productId,
      state: "ACTIVE",
      ...(locationId ? { locationId } : PRODUCT_HOLDS),
      ...(lotId ? { lotId } : {}),
    },
    _sum: { remaining: true },
  });
  return dec((sum._sum.remaining ?? 0).toString());
}

/**
 * WMS-53 (ADR 0043): in a location, what is inside its containers is not
 * free either — like a reservation of the location, it does not subtract
 * from the product as a whole (it is still its stock).
 */
async function freeOf(
  client: Reader,
  productId: string,
  locationId: string | null,
  lotId?: string,
): Promise<Decimal> {
  const [available, reserved, contained] = await Promise.all([
    availableOf(client, productId, locationId, lotId),
    reservedOf(client, productId, locationId, lotId),
    locationId
      ? containedAt(client, productId, locationId, lotId)
      : Promise.resolve(dec(0)),
  ]);
  return available.minus(reserved).minus(contained);
}

const least = (values: Decimal[]) => {
  const free = values.reduce((a, b) => (b.lessThan(a) ? b : a));
  return free.isNegative() ? dec(0) : free;
};

/**
 * What can still be taken (or reserved) of a product — in a location, or
 * anywhere with `null` — without touching what is reserved. Never
 * negative. Call it under the product's lock to decide.
 *
 * WMS-21: with `lotId`, of that lot: the least of what is free of the
 * product, of the location (every lot: a reservation that names no lot
 * holds any of them) and of the lot there.
 */
export async function freeToTake(
  client: Reader,
  productId: string,
  locationId: string | null,
  lotId?: string | null,
): Promise<Decimal> {
  const lot = lotId || undefined;
  return least(
    await Promise.all([
      freeOf(client, productId, null),
      ...(locationId ? [freeOf(client, productId, locationId)] : []),
      ...(lot ? [freeOf(client, productId, locationId, lot)] : []),
    ]),
  );
}

/**
 * What a move inside the same product can take out of a location: only the
 * reservations of that location matter (the product total does not
 * change). With `lotId`, of that lot there.
 */
export async function freeToMoveFrom(
  client: Reader,
  productId: string,
  locationId: string,
  lotId?: string | null,
): Promise<Decimal> {
  const lot = lotId || undefined;
  return least(
    await Promise.all([
      freeOf(client, productId, locationId),
      ...(lot ? [freeOf(client, productId, locationId, lot)] : []),
    ]),
  );
}

/**
 * Why an operation cannot take `free` and more from a location: what is in
 * its containers (WMS-53) when there is any, else what is reserved. Ask it
 * only on the way out, when `free` fell short.
 */
export async function blockedMessage(
  client: Reader,
  free: Decimal,
  unitCode: string,
  verb: string,
  at: {
    productId: string;
    locationId: string;
    locationName?: string | null;
    lotId?: string | null;
  },
): Promise<string> {
  const contained = await containedAt(
    client,
    at.productId,
    at.locationId,
    at.lotId ?? undefined,
  );
  if (contained.isZero()) return reservedMessage(free, unitCode, verb);
  return (
    containedMessage(contained, unitCode, at.locationName ?? null) +
    (free.isZero()
      ? ""
      : ` Suelto y libre: ${formatStock(free.toString(), unitCode)}.`)
  );
}

/** «Hay 5 piezas reservadas: solo puedes tomar 15 piezas.» */
export function reservedMessage(
  free: Decimal,
  unitCode: string,
  verb = "tomar",
): string {
  return free.isZero()
    ? `Lo que hay está apartado para pedidos o tareas: no puedes ${verb} nada.`
    : `Parte de lo que hay está apartado para pedidos o tareas: solo puedes ${verb} ${formatStock(free.toString(), unitCode)}.`;
}

export type ReserveResult =
  { ok: true; reservationId: string } | { ok: false; free: string };

/**
 * Sets stock aside for a document, inside its transaction and after it
 * locked the product (and the location). Refuses what is not free.
 */
export async function reserveStock(
  tx: Tx,
  actor: InventoryActor,
  input: {
    productId: string;
    locationId?: string | null;
    /** The lot set aside, for a product by lot (WMS-21). */
    lotId?: string | null;
    /** In the product's unit, already checked by the caller. */
    quantity: Decimal | string;
    source: ReservationSource;
  },
): Promise<ReserveResult> {
  const quantity = dec(input.quantity.toString());
  if (!quantity.greaterThan(0)) throw new Error("Reservation must be > 0");
  const locationId = input.locationId ?? null;
  const lotId = input.lotId ?? null;
  const free = await freeToTake(tx, input.productId, locationId, lotId);
  if (free.lessThan(quantity)) return { ok: false, free: free.toString() };
  const id = newId();
  await tx.stockReservation.create({
    data: {
      id,
      organizationId: actor.organizationId,
      productId: input.productId,
      locationId,
      lotId,
      quantity: quantity.toString(),
      remaining: quantity.toString(),
      sourceType: input.source.type,
      sourceId: input.source.id,
      createdByUserId: actor.userId,
    },
  });
  return { ok: true, reservationId: id };
}

/**
 * Uses part of a reservation (its document is taking the stock now). It
 * closes at zero; consuming more than remains is a defect.
 */
export async function consumeReservation(
  tx: Tx,
  reservationId: string,
  quantity: Decimal | string,
): Promise<void> {
  const amount = dec(quantity.toString());
  const reservation = await tx.stockReservation.findFirst({
    where: { id: reservationId, state: "ACTIVE" },
    select: { remaining: true },
  });
  const remaining = dec(reservation?.remaining.toString() ?? 0);
  if (!reservation || remaining.lessThan(amount)) {
    throw new Error(`Reservation ${reservationId} cannot give ${amount}`);
  }
  const left = remaining.minus(amount);
  await tx.stockReservation.update({
    where: { id: reservationId },
    data: left.isZero()
      ? { remaining: "0", state: "CLOSED", closedAt: new Date() }
      : { remaining: left.toString() },
  });
}

/** Frees whatever a document still holds; returns how many it closed. */
export async function releaseReservations(
  tx: Tx,
  source: ReservationSource,
): Promise<number> {
  const result = await tx.stockReservation.updateMany({
    where: { sourceType: source.type, sourceId: source.id, state: "ACTIVE" },
    data: { remaining: "0", state: "CLOSED", closedAt: new Date() },
  });
  return result.count;
}

/** Reserved of each product (every location), in its unit. */
export async function getReservedTotals(
  actor: InventoryActor,
  productIds: readonly string[],
): Promise<Record<string, string>> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const ids = [...new Set(productIds.map(String))].slice(0, 500);
  if (ids.length === 0) return {};
  const sums = await forOrganization(
    actor.organizationId,
  ).stockReservation.groupBy({
    by: ["productId"],
    where: { productId: { in: ids }, state: "ACTIVE", ...PRODUCT_HOLDS },
    _sum: { remaining: true },
  });
  return Object.fromEntries(
    sums.map((row) => [row.productId, (row._sum.remaining ?? 0).toString()]),
  );
}
