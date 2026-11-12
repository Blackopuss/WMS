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
import { PICKING_STRATEGY } from "./settings";
import { AVAILABLE_STOCK } from "./stock-status";
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

export type PickSource = { locationId: string; quantity: Decimal };

/**
 * Where to pick a quantity of a product from: the strategy of assignment,
 * in one place. The company chooses it (WMS-49, `PICKING_STRATEGY`): the
 * fullest location first (fewer trips) or the emptiest (frees places);
 * FIFO and FEFO (with lots, WMS-21) will go here too. Only AVAILABLE stock that nothing
 * reserves in its location, never the staging location itself, and never
 * more than is free of the product. Returns less than asked when there is
 * not enough. Call it under the product's lock.
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
      ...AVAILABLE_STOCK,
    },
    select: { locationId: true, quantity: true },
  });
  const emptiestFirst =
    (await readSetting(tx, PICKING_STRATEGY)) === "emptiest";
  const ranked = balances
    .map((row) => ({
      locationId: row.locationId,
      quantity: dec(row.quantity.toString()),
    }))
    .sort(
      (a, b) =>
        (emptiestFirst
          ? a.quantity.comparedTo(b.quantity)
          : b.quantity.comparedTo(a.quantity)) ||
        a.locationId.localeCompare(b.locationId),
    );
  const sources: PickSource[] = [];
  for (const place of ranked) {
    if (!wanted.greaterThan(0)) break;
    const free = await freeToMoveFrom(tx, productId, place.locationId);
    const take = minOf(free, wanted);
    if (!take.greaterThan(0)) continue;
    sources.push({ locationId: place.locationId, quantity: take });
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
  task: { outboundLineId: string; fromLocationId: string },
) {
  const where = {
    sourceType: OUTBOUND_LINE_SOURCE,
    sourceId: task.outboundLineId,
    state: "ACTIVE" as const,
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
  task: { outboundLineId: string; fromLocationId: string; quantity: Decimal },
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
    quantity: Decimal;
    picked: Decimal;
    unitCode: string;
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
