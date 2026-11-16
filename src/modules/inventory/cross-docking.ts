import "server-only";

import { dec, type Decimal } from "@/lib";
import { isFacilityInScope } from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { lockRows, type TenantDb } from "@/server";

import { dayWindow } from "./calendar-day";
import { planCrossDock, type WaitingLine } from "./cross-dock-rules";
import { isExpired, lotDayOf } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import { formatOutboundNumber } from "./outbound-states";
import { createPickTasks, nextTaskNumber } from "./picking";
import { OUTBOUND_LINE_SOURCE } from "./reservation-sources";
import { freeToTake } from "./reservations";
import { CROSS_DOCK_MODE, PICK_EXPIRED } from "./settings";
import type { StockStatus } from "./stock-status";
import { formatTaskNumber } from "./task-states";
import { isWaitingPlace } from "./unplaced";

/**
 * Cross-docking (WMS-54, ADR 0052): what arrives at a place «de paso» for
 * an outbound order that waits for it goes straight to the order — set
 * aside for its line where it arrived, with a normal picking task from
 * there to the staging location — instead of being put away. The rest goes
 * on to put-away as always.
 *
 * Two steps inside the transaction of the entry (a purchase receipt or a
 * manual entry), so the locks keep their order:
 *
 *   products → locations → (purchase order) → outbound orders →
 *   container → tasks → capacity
 *
 * 1. `lockCrossDockOrders`, right after the locations (and the purchase
 *    order), before anything else: finds the orders that may wait for these
 *    products and locks them.
 * 2. `sendToWaitingOrders`, once the balances of the entry are written and
 *    before its put-away tasks: reads the orders again under their locks,
 *    asks `planCrossDock` who gets what and writes the reservations and
 *    picking tasks.
 *
 * An order waits while it is released or being picked and one of its lines
 * has less set aside than it asks (derived from its active reservations;
 * nothing is stored). Only when the company turns it on (`CROSS_DOCK_MODE`).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const WAITING_STATUSES = ["RELEASED", "PICKING"] as const;

/** Orders looked at, at most, for one entry. */
const MAX_ORDERS = 200;

/** The orders locked for an entry; null when the company does not cross-dock. */
export type CrossDockLock = { orderIds: string[] } | null;

/**
 * Locks the outbound orders that may wait for these products in these
 * warehouses, when the company cross-docks. Call it after the locks of the
 * products and the locations (and the purchase order) and before the
 * container and the capacity.
 */
export async function lockCrossDockOrders(
  tx: Tx,
  actor: InventoryActor,
  input: { productIds: readonly string[]; facilityIds: readonly string[] },
): Promise<CrossDockLock> {
  if (input.productIds.length === 0 || input.facilityIds.length === 0) {
    return null;
  }
  if ((await readSetting(tx, CROSS_DOCK_MODE)) !== "on") return null;
  const candidates = await tx.outboundOrder.findMany({
    where: {
      status: { in: [...WAITING_STATUSES] },
      facilityId: { in: [...new Set(input.facilityIds)] },
      lines: { some: { productId: { in: [...new Set(input.productIds)] } } },
    },
    orderBy: [{ priority: "desc" }, { number: "asc" }],
    take: MAX_ORDERS,
    select: { id: true, facilityId: true },
  });
  const allowed: string[] = [];
  const facilities = new Map<string, boolean>();
  for (const order of candidates) {
    if (!facilities.has(order.facilityId)) {
      facilities.set(
        order.facilityId,
        await isFacilityInScope(tx, actor.userId, order.facilityId),
      );
    }
    if (facilities.get(order.facilityId)) allowed.push(order.id);
  }
  return { orderIds: await lockRows(tx, "outboundOrder", allowed) };
}

/** What arrived, one entry per line of the entry. */
export type CrossDockArrivalInput = {
  productId: string;
  locationId: string;
  lotId: string | null;
  /** In the product's unit. */
  quantity: Decimal;
  status: StockStatus;
};

export type CrossDockSent = {
  orderId: string;
  /** «PS-0004». */
  orderNumber: string;
  /** «12 piezas de Guante». */
  text: string;
  /** «T-0031». */
  taskNumbers: string[];
};

export type CrossDockResult = {
  /** What went to orders of each arrival, by its position (0 if nothing). */
  sent: Decimal[];
  orders: CrossDockSent[];
  /** «12 piezas de Guante van directo al pedido PS-0004 (tarea T-0031).» */
  notes: string[];
};

const nothing = (count: number): CrossDockResult => ({
  sent: Array.from({ length: count }, () => dec(0)),
  orders: [],
  notes: [],
});

const listed = (parts: string[]) =>
  parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}`;

/**
 * Splits what arrived between the orders locked by `lockCrossDockOrders`
 * and put-away, and writes, for each share, the reservation of its line in
 * the place it arrived and its picking task to the staging location. Call
 * it after the balances of the entry exist and before its put-away tasks,
 * which then cover only what `sent` leaves.
 */
export async function sendToWaitingOrders(
  tx: Tx,
  actor: InventoryActor,
  lock: CrossDockLock,
  arrivals: readonly CrossDockArrivalInput[],
  movementId: string,
): Promise<CrossDockResult> {
  if (!lock || lock.orderIds.length === 0) return nothing(arrivals.length);

  const places = await tx.location.findMany({
    where: { id: { in: [...new Set(arrivals.map((a) => a.locationId))] } },
    select: {
      id: true,
      facilityId: true,
      isDefault: true,
      isStaging: true,
      type: true,
      archivedAt: true,
    },
  });
  const placeOf = new Map(places.map((place) => [place.id, place]));
  const lotIds = [
    ...new Set(arrivals.flatMap((a) => (a.lotId ? [a.lotId] : []))),
  ];
  const lots = lotIds.length
    ? await tx.lot.findMany({
        where: { id: { in: lotIds } },
        select: { id: true, expiresOn: true },
      })
    : [];
  const expiryOf = new Map(
    lots.map((lot) => [lot.id, lotDayOf(lot.expiresOn)]),
  );
  // ADR 0040: an order does not get an expired lot unless the company
  // allows picking them.
  const skipExpired =
    [...expiryOf.values()].some(Boolean) &&
    (await readSetting(tx, PICK_EXPIRED)) !== "allow";
  const today = skipExpired ? (await dayWindow(tx, new Date()))?.day : null;

  // What of each arrival may go to an order: healthy, loose, at a place
  // «de paso», not expired, and free there (shared by arrivals of the
  // same product, place and lot).
  const usable: Decimal[] = [];
  const usedAt = new Map<string, Decimal>();
  for (const arrival of arrivals) {
    const place = placeOf.get(arrival.locationId);
    const expiresOn = arrival.lotId
      ? (expiryOf.get(arrival.lotId) ?? null)
      : null;
    if (
      arrival.status !== "AVAILABLE" ||
      !arrival.quantity.greaterThan(0) ||
      !place ||
      place.archivedAt ||
      !isWaitingPlace(place) ||
      (today && isExpired(expiresOn, today))
    ) {
      usable.push(dec(0));
      continue;
    }
    const slot = `${arrival.productId} ${arrival.locationId} ${arrival.lotId ?? ""}`;
    const used = usedAt.get(slot) ?? dec(0);
    const free = (
      await freeToTake(tx, arrival.productId, arrival.locationId, arrival.lotId)
    ).minus(used);
    const take = free.lessThan(arrival.quantity) ? free : arrival.quantity;
    const quantity = take.greaterThan(0) ? take : dec(0);
    usedAt.set(slot, used.plus(quantity));
    usable.push(quantity);
  }
  if (!usable.some((quantity) => quantity.greaterThan(0))) {
    return nothing(arrivals.length);
  }

  // The orders again, under their locks: one cancelled or picked since the
  // first read no longer waits.
  const products = [...new Set(arrivals.map((a) => a.productId))];
  const orders = await tx.outboundOrder.findMany({
    where: { id: { in: lock.orderIds }, status: { in: [...WAITING_STATUSES] } },
    select: {
      id: true,
      number: true,
      priority: true,
      recipient: true,
      dueOn: true,
      releasedAt: true,
      createdAt: true,
      facilityId: true,
      lines: {
        where: { productId: { in: products } },
        select: { id: true, productId: true, quantity: true, unitCode: true },
      },
    },
  });
  const lineIds = orders.flatMap((order) => order.lines.map((l) => l.id));
  if (lineIds.length === 0) return nothing(arrivals.length);
  const held = await tx.stockReservation.groupBy({
    by: ["sourceId"],
    where: {
      sourceType: OUTBOUND_LINE_SOURCE,
      sourceId: { in: lineIds },
      state: "ACTIVE",
    },
    _sum: { remaining: true },
  });
  const heldOf = new Map(
    held.map((row) => [
      row.sourceId,
      dec((row._sum.remaining ?? 0).toString()),
    ]),
  );
  const orderOf = new Map(orders.map((order) => [order.id, order]));
  const lineOf = new Map(
    orders.flatMap((order) => order.lines.map((line) => [line.id, line])),
  );

  // One plan per warehouse: goods only go to orders of their own.
  const facilityIds = [...new Set(places.map((place) => place.facilityId))];
  const sent = arrivals.map(() => dec(0));
  type Share = {
    arrival: number;
    orderId: string;
    lineId: string;
    quantity: Decimal;
  };
  const shares: Share[] = [];
  for (const facilityId of facilityIds) {
    const indexes = arrivals
      .map((_, index) => index)
      .filter(
        (index) =>
          placeOf.get(arrivals[index]!.locationId)?.facilityId === facilityId &&
          usable[index]!.greaterThan(0),
      );
    if (indexes.length === 0) continue;
    const waiting: WaitingLine[] = [];
    for (const order of orders) {
      if (order.facilityId !== facilityId) continue;
      for (const line of order.lines) {
        const left = dec(line.quantity.toString()).minus(
          heldOf.get(line.id) ?? 0,
        );
        if (!left.greaterThan(0)) continue;
        waiting.push({
          orderId: order.id,
          lineId: line.id,
          productId: line.productId,
          waiting: left,
          urgent: order.priority === "URGENT",
          dueOn: order.dueOn ? order.dueOn.toISOString().slice(0, 10) : null,
          releasedAt: (order.releasedAt ?? order.createdAt).getTime(),
          number: order.number,
        });
      }
    }
    if (waiting.length === 0) continue;
    const plan = planCrossDock(
      indexes.map((index) => ({
        productId: arrivals[index]!.productId,
        lotId: arrivals[index]!.lotId,
        expiresOn: arrivals[index]!.lotId
          ? (expiryOf.get(arrivals[index]!.lotId!) ?? null)
          : null,
        quantity: usable[index]!,
      })),
      waiting,
    );
    for (const share of plan.shares) {
      shares.push({ ...share, arrival: indexes[share.arrival]! });
    }
  }
  if (shares.length === 0) return nothing(arrivals.length);

  // Where picked goods of each warehouse wait: an order that was released
  // already has its staging location.
  const stagings = await tx.location.findMany({
    where: { facilityId: { in: facilityIds }, isStaging: true },
    select: { id: true, facilityId: true },
  });
  const stagingOf = new Map(stagings.map((row) => [row.facilityId, row.id]));
  const names = await tx.product.findMany({
    where: { id: { in: products } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(names.map((row) => [row.id, row.name]));

  let next = await nextTaskNumber(tx);
  type Sent = {
    parts: Map<string, { quantity: Decimal; unitCode: string }>;
    tasks: number[];
  };
  const byOrder = new Map<string, Sent>();
  for (const share of shares) {
    const arrival = arrivals[share.arrival]!;
    const order = orderOf.get(share.orderId)!;
    const line = lineOf.get(share.lineId)!;
    const stagingId = stagingOf.get(order.facilityId);
    if (!stagingId) continue;
    const first = next;
    // Reserves the share where it arrived and creates its picking task;
    // what was free was decided under the same locks just above.
    next = await createPickTasks(tx, actor, {
      order: {
        number: formatOutboundNumber(order.number),
        recipient: order.recipient,
        priority: order.priority,
      },
      line: { id: line.id, productId: line.productId, unitCode: line.unitCode },
      sources: [
        {
          locationId: arrival.locationId,
          lotId: arrival.lotId,
          quantity: share.quantity,
        },
      ],
      stagingId,
      nextNumber: next,
      crossDockMovementId: movementId,
    });
    sent[share.arrival] = sent[share.arrival]!.plus(share.quantity);
    const entry: Sent = byOrder.get(order.id) ?? {
      parts: new Map(),
      tasks: [],
    };
    const part = entry.parts.get(line.productId) ?? {
      quantity: dec(0),
      unitCode: line.unitCode,
    };
    part.quantity = part.quantity.plus(share.quantity);
    entry.parts.set(line.productId, part);
    for (let number = first; number < next; number++) entry.tasks.push(number);
    byOrder.set(order.id, entry);
  }

  const sentOrders: CrossDockSent[] = [];
  const notes: string[] = [];
  for (const [orderId, entry] of byOrder) {
    const order = orderOf.get(orderId)!;
    const text = listed(
      [...entry.parts].map(
        ([productId, part]) =>
          `${formatStock(part.quantity.toString(), part.unitCode)} de ${nameOf.get(productId) ?? "un producto"}`,
      ),
    );
    const taskNumbers = entry.tasks.map(formatTaskNumber);
    sentOrders.push({
      orderId,
      orderNumber: formatOutboundNumber(order.number),
      text,
      taskNumbers,
    });
    notes.push(
      `${text} ${entry.parts.size === 1 && [...entry.parts.values()][0]!.quantity.equals(1) ? "va" : "van"} directo al pedido ${formatOutboundNumber(order.number)} (${taskNumbers.length === 1 ? `tarea ${taskNumbers[0]}` : `tareas ${listed(taskNumbers)}`}).`,
    );
  }
  return { sent, orders: sentOrders, notes };
}
