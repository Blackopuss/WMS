/**
 * Cross-docking (WMS-54, ADR 0052): the pure rule that splits what just
 * arrived between the outbound orders that wait for it and put-away. No
 * database: `sendToWaitingOrders` reads the facts under its locks and asks
 * this function, so the order is decided in one place.
 *
 * Lines are served one after the other: urgent orders first, then by the
 * day they leave (orders without a day last), then the one released
 * earlier, then the order number. Each line takes, from the arrivals of its
 * product, what expires first (those without a date last; then the order
 * they arrived in), never more than it waits for. What is left of each
 * arrival goes on to put-away.
 */

import { dec, type Decimal } from "@/lib";

export type CrossDockArrival = {
  productId: string;
  lotId: string | null;
  /** «2027-03-05», or null without a date. */
  expiresOn: string | null;
  /** What may go to an order, in the product's unit (free and healthy). */
  quantity: Decimal;
};

export type WaitingLine = {
  orderId: string;
  lineId: string;
  productId: string;
  /** What the line still waits for, in the product's unit (> 0). */
  waiting: Decimal;
  urgent: boolean;
  /** «2026-11-20», or null when the order has no day to leave. */
  dueOn: string | null;
  /** When it was released (ms); older first. */
  releasedAt: number;
  /** The order number, the last tie-break. */
  number: number;
};

export type CrossDockShare = {
  /** Position of the arrival in the list received. */
  arrival: number;
  orderId: string;
  lineId: string;
  quantity: Decimal;
};

export type CrossDockPlan = {
  /** In the order the lines are served. */
  shares: CrossDockShare[];
  /** What is left of each arrival, by its position: it goes to put-away. */
  left: Decimal[];
};

/** The order in which waiting lines are served. Never changes its input. */
export function rankWaitingLines<T extends WaitingLine>(
  lines: readonly T[],
): T[] {
  return [...lines].sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      (a.dueOn ?? "9999-99-99").localeCompare(b.dueOn ?? "9999-99-99") ||
      a.releasedAt - b.releasedAt ||
      a.number - b.number ||
      a.lineId.localeCompare(b.lineId),
  );
}

export function planCrossDock(
  arrivals: readonly CrossDockArrival[],
  lines: readonly WaitingLine[],
): CrossDockPlan {
  const left = arrivals.map((arrival) =>
    arrival.quantity.greaterThan(0) ? arrival.quantity : dec(0),
  );
  // Positions of the arrivals of each product, what expires first first.
  const byProduct = new Map<string, number[]>();
  arrivals.forEach((arrival, index) => {
    const list = byProduct.get(arrival.productId) ?? [];
    list.push(index);
    byProduct.set(arrival.productId, list);
  });
  for (const list of byProduct.values()) {
    list.sort(
      (a, b) =>
        (arrivals[a]!.expiresOn ?? "9999-99-99").localeCompare(
          arrivals[b]!.expiresOn ?? "9999-99-99",
        ) || a - b,
    );
  }
  const shares: CrossDockShare[] = [];
  for (const line of rankWaitingLines(lines)) {
    let wanted = line.waiting;
    for (const index of byProduct.get(line.productId) ?? []) {
      if (!wanted.greaterThan(0)) break;
      const there = left[index]!;
      if (!there.greaterThan(0)) continue;
      const take = there.lessThan(wanted) ? there : wanted;
      shares.push({
        arrival: index,
        orderId: line.orderId,
        lineId: line.lineId,
        quantity: take,
      });
      left[index] = there.minus(take);
      wanted = wanted.minus(take);
    }
  }
  return { shares, left };
}
