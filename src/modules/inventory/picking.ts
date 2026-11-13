import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import { readSetting } from "@/platform/settings";
import { lockRows, type TenantDb } from "@/server";

import {
  formatStock,
  postTaskTransfer,
  type InventoryActor,
} from "./movements";
import {
  consumeReservation,
  freeToMoveFrom,
  freeToTake,
  reserveStock,
} from "./reservations";
import { dayWindow } from "./calendar-day";
import { isExpired, lotDayOf } from "./lot-rules";
import { PICKING_STRATEGY, PICK_EXPIRED } from "./settings";
import { AVAILABLE_ANY_LOT } from "./stock-status";
import { formatTaskNumber } from "./task-states";

/**
 * Picking (WMS-14, spec 5.2). Releasing an outbound order reserves its
 * stock where it is — one reservation per line and location — and creates
 * a PICK task for each: «take 12 pieces of A-01 to Preparación». The task
 * keeps that stock reserved in its location until it is picked, so nothing
 * else takes it. Delivering it moves what was picked to the staging
 * location, where it stays reserved for the order (packing and shipping
 * come next); what was not picked is released. When no picking task of the
 * order is left open, the order is picked.
 *
 * Every function here runs inside the caller's transaction, with the lock
 * order of documents: products → locations → order → task.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const minOf = (a: Decimal, b: Decimal) => (a.lessThan(b) ? a : b);

/** Reservations of an outbound order are per line. */
export const OUTBOUND_LINE_SOURCE = "outbound_order_line";

export type PickSource = {
  locationId: string;
  /** The lot to pick, for a product by lot (WMS-21); null otherwise. */
  lotId: string | null;
  quantity: Decimal;
};

/**
 * Where to pick a quantity of a product from — location and, for a product
 * by lot, which lot: the strategy of assignment, in one place.
 *
 * What expires first always leaves first (founder, 2026-11-13; ADR 0040):
 * lots are ranked by their expiry date, those without one last, whatever
 * the company chose. The company's choice (WMS-49, `PICKING_STRATEGY`)
 * decides the rest — between locations of the same lot, and for products
 * whose lots carry no date or that have no lots: the fullest location
 * first (fewer trips), the emptiest (frees places) or the oldest lot
 * (FIFO).
 *
 * Only AVAILABLE stock that nothing reserves in its location, never the
 * staging location itself, never more than is free of the product, and —
 * unless the company says otherwise (`PICK_EXPIRED`) — never a lot that
 * already expired. Returns less than asked when there is not enough. Call
 * it under the product's lock.
 */
export async function pickSources(
  tx: Tx,
  productId: string,
  quantity: Decimal,
  /** Only from the order's warehouse (WMS-18), never its staging location. */
  scope: { stagingId: string; facilityId: string },
): Promise<PickSource[]> {
  let wanted = minOf(quantity, await freeToTake(tx, productId, null));
  if (!wanted.greaterThan(0)) return [];
  const balances = await tx.stockBalance.findMany({
    where: {
      productId,
      quantity: { gt: 0 },
      locationId: { not: scope.stagingId },
      location: { archivedAt: null, facilityId: scope.facilityId },
      ...AVAILABLE_ANY_LOT,
    },
    select: {
      locationId: true,
      quantity: true,
      lot: { select: { id: true, expiresOn: true } },
    },
  });
  const strategy = await readSetting(tx, PICKING_STRATEGY);
  const skipExpired =
    balances.some((row) => row.lot?.expiresOn) &&
    (await readSetting(tx, PICK_EXPIRED)) !== "allow";
  const today = skipExpired ? (await dayWindow(tx, new Date()))?.day : null;
  const rows = balances
    .map((row) => ({
      locationId: row.locationId,
      lotId: row.lot?.id ?? null,
      expiresOn: lotDayOf(row.lot?.expiresOn),
      quantity: dec(row.quantity.toString()),
    }))
    // A lot is good through its expiry day (the company's calendar).
    .filter((row) => !today || !isExpired(row.expiresOn, today));
  const byQuantity = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    strategy === "emptiest"
      ? a.quantity.comparedTo(b.quantity)
      : b.quantity.comparedTo(a.quantity);
  // Lot ids are UUIDv7: their order is the order the lots were registered.
  const byAge = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    (a.lotId ?? "").localeCompare(b.lotId ?? "");
  // No date goes last: it is not about to expire.
  const byExpiry = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    (a.expiresOn ?? "9999-12-31").localeCompare(b.expiresOn ?? "9999-12-31");
  const ranked = rows.sort(
    (a, b) =>
      byExpiry(a, b) ||
      (strategy === "fifo" ? byAge(a, b) : 0) ||
      byQuantity(a, b) ||
      a.locationId.localeCompare(b.locationId) ||
      byAge(a, b),
  );
  const sources: PickSource[] = [];
  // What this plan already takes of each location, across its lots.
  const takenAt = new Map<string, Decimal>();
  for (const place of ranked) {
    if (!wanted.greaterThan(0)) break;
    const already = takenAt.get(place.locationId) ?? dec(0);
    const freeInPlace = (
      await freeToMoveFrom(tx, productId, place.locationId)
    ).minus(already);
    const free = place.lotId
      ? minOf(
          freeInPlace,
          await freeToMoveFrom(tx, productId, place.locationId, place.lotId),
        )
      : freeInPlace;
    const take = minOf(free, wanted);
    if (!take.greaterThan(0)) continue;
    sources.push({
      locationId: place.locationId,
      lotId: place.lotId,
      quantity: take,
    });
    takenAt.set(place.locationId, already.plus(take));
    wanted = wanted.minus(take);
  }
  return sources;
}

/**
 * Reserves a line's stock in each of its sources and creates its PICK
 * tasks, inside the release of the order (already RELEASED in this
 * transaction). Returns how many tasks it created and the next number.
 */
export async function createPickTasks(
  tx: Tx,
  actor: InventoryActor,
  input: {
    order: { number: string; recipient: string; priority: "NORMAL" | "URGENT" };
    line: { id: string; productId: string; unitCode: string };
    sources: PickSource[];
    stagingId: string;
    /** Number of the first task. */
    nextNumber: number;
  },
): Promise<number> {
  let number = input.nextNumber;
  for (const source of input.sources) {
    const reserved = await reserveStock(tx, actor, {
      productId: input.line.productId,
      locationId: source.locationId,
      lotId: source.lotId,
      quantity: source.quantity,
      source: { type: OUTBOUND_LINE_SOURCE, id: input.line.id },
    });
    if (!reserved.ok) {
      throw new Error(`Free stock of ${input.line.productId} moved under lock`);
    }
    await tx.warehouseTask.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        number: number++,
        kind: "PICK",
        priority: input.order.priority,
        outboundLineId: input.line.id,
        productId: input.line.productId,
        fromLocationId: source.locationId,
        toLocationId: input.stagingId,
        lotId: source.lotId,
        quantity: source.quantity.toString(),
        unitCode: input.line.unitCode,
        createdByUserId: actor.userId,
      },
    });
  }
  return number;
}

/** The next number of a task in the company. */
export async function nextTaskNumber(tx: Tx): Promise<number> {
  const last = await tx.warehouseTask.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (last?.number ?? 0) + 1;
}

/**
 * The reservation a PICK task holds: its line in its origin. Orders
 * released before picking existed reserved without a location; those are
 * used as a fallback.
 */
async function reservationOf(
  tx: Tx,
  task: {
    outboundLineId: string;
    fromLocationId: string;
    lotId: string | null;
  },
) {
  const where = {
    sourceType: OUTBOUND_LINE_SOURCE,
    sourceId: task.outboundLineId,
    state: "ACTIVE" as const,
    // WMS-21: two tasks of a line may leave from the same location, each
    // with its lot and its own reservation.
    lotId: task.lotId,
  };
  return (
    (await tx.stockReservation.findFirst({
      where: { ...where, locationId: task.fromLocationId },
      select: { id: true, remaining: true },
    })) ??
    (await tx.stockReservation.findFirst({
      where: { ...where, locationId: null },
      select: { id: true, remaining: true },
    }))
  );
}

/** Lets go of what a PICK task held and was not picked. */
export async function releasePickReservation(
  tx: Tx,
  task: {
    outboundLineId: string;
    fromLocationId: string;
    lotId: string | null;
    quantity: Decimal;
  },
  picked: Decimal,
): Promise<void> {
  const reservation = await reservationOf(tx, task);
  if (!reservation) return;
  const remaining = dec(reservation.remaining.toString());
  // A fallback reservation (no location) covers the whole line: only this
  // task's part is let go.
  const give = minOf(remaining, task.quantity.minus(picked));
  if (give.greaterThan(0)) await consumeReservation(tx, reservation.id, give);
}

/**
 * Delivers a PICK task: what was picked leaves its reservation in the
 * origin, moves to the staging location (TRANSFER, key `task:<id>`) and is
 * reserved there for the same line; what was not picked is released.
 * The caller locked product → locations → order → task.
 */
export async function deliverPick(
  tx: Tx,
  actor: InventoryActor,
  task: {
    id: string;
    number: number;
    outboundLineId: string;
    productId: string;
    fromLocationId: string;
    toLocationId: string;
    lotId: string | null;
    quantity: Decimal;
    picked: Decimal;
    unitCode: string;
    /** The units picked, for a product by serial (WMS-21B). */
    serials?: string[];
  },
): Promise<
  | {
      ok: true;
      movementId: string;
      /** Locations left above their capacity (WMS-22B). */
      notes: string[];
    }
  | { ok: false; error: string }
> {
  const reservation = await reservationOf(tx, task);
  const held = dec(reservation?.remaining.toString() ?? 0);
  if (!reservation || held.lessThan(task.picked)) {
    return {
      ok: false,
      error:
        "Lo apartado para este pedido ya no está completo en esa ubicación.",
    };
  }
  // First let go of the reservation in the origin, so the move may take it.
  await consumeReservation(tx, reservation.id, task.picked);
  const moved = await postTaskTransfer(tx, actor, {
    productId: task.productId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    quantity: task.picked.toString(),
    lotId: task.lotId,
    serials: task.serials,
    taskId: task.id,
    idempotencyKey: `task:${task.id}`,
    reference: formatTaskNumber(task.number),
  });
  if (!moved.ok) {
    return {
      ok: false,
      error:
        moved.formError ??
        Object.values(moved.fieldErrors ?? {})[0] ??
        "No se pudo mover lo surtido.",
    };
  }
  const kept = await reserveStock(tx, actor, {
    productId: task.productId,
    locationId: task.toLocationId,
    lotId: task.lotId,
    quantity: task.picked,
    source: { type: OUTBOUND_LINE_SOURCE, id: task.outboundLineId },
  });
  if (!kept.ok) throw new Error(`Picked stock of task ${task.id} not free`);
  await releasePickReservation(tx, task, task.picked);
  return { ok: true, movementId: moved.movementId, notes: moved.notes ?? [] };
}

/**
 * After a PICK task closes: the order is picked when none of its picking
 * tasks is left open. Its first accepted task already made it PICKING.
 */
export async function settlePickedOrder(tx: Tx, orderId: string) {
  const order = await tx.outboundOrder.findFirst({
    where: { id: orderId },
    select: { status: true },
  });
  if (order?.status !== "PICKING") return;
  const open = await tx.warehouseTask.count({
    where: {
      kind: "PICK",
      outboundLine: { orderId },
      status: { notIn: ["DELIVERED", "CANCELLED"] },
    },
  });
  if (open === 0) {
    await tx.outboundOrder.update({
      where: { id: orderId },
      data: { status: "PICKED" },
    });
  }
}

/** The first task someone takes starts the picking of its order. */
export async function startPicking(tx: Tx, orderId: string) {
  await tx.outboundOrder.updateMany({
    where: { id: orderId, status: "RELEASED" },
    data: { status: "PICKING" },
  });
}

/** Locks the order of a PICK task (read before, it never changes). */
export async function lockPickOrder(tx: Tx, orderId: string | null) {
  if (orderId) await lockRows(tx, "outboundOrder", [orderId]);
}

/** «12 piezas», for messages about a picked quantity. */
export const pickedText = (quantity: Decimal, unitCode: string) =>
  formatStock(quantity.toString(), unitCode);
