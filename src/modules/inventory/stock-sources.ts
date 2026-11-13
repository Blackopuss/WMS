/**
 * The order in which stock is taken from where it is (WMS-14, WMS-21A):
 * picking (`pickSources`) and replenishment (`replenishmentPlan`, WMS-24)
 * ask it, so both follow the same rule. Pure: no database.
 *
 * What expires first always leaves first (founder, 2026-11-13; ADR 0040):
 * lots by their expiry date, those without one last, whatever the company
 * chose. The company's choice (`PICKING_STRATEGY`) decides the rest —
 * between locations of the same lot, and for products whose lots carry no
 * date or that have no lots: the fullest location first (fewer trips), the
 * emptiest (frees places) or the oldest lot (FIFO).
 */

import type { Decimal } from "@/lib";

export type StockSourceRow = {
  locationId: string;
  /** UUIDv7: their order is the order the lots were registered. */
  lotId: string | null;
  /** «2027-03-05», or null without a date. */
  expiresOn: string | null;
  quantity: Decimal;
};

/**
 * Rows in the order they are taken. Ties: location id, then lot age, so
 * the order is always the same. Never changes the list it receives.
 */
export function rankStockSources<T extends StockSourceRow>(
  rows: readonly T[],
  /** The value of `PICKING_STRATEGY`; anything else reads as «fullest». */
  strategy: string,
): T[] {
  const byQuantity = (a: T, b: T) =>
    strategy === "emptiest"
      ? a.quantity.comparedTo(b.quantity)
      : b.quantity.comparedTo(a.quantity);
  const byAge = (a: T, b: T) => (a.lotId ?? "").localeCompare(b.lotId ?? "");
  // No date goes last: it is not about to expire.
  const byExpiry = (a: T, b: T) =>
    (a.expiresOn ?? "9999-12-31").localeCompare(b.expiresOn ?? "9999-12-31");
  return [...rows].sort(
    (a, b) =>
      byExpiry(a, b) ||
      (strategy === "fifo" ? byAge(a, b) : 0) ||
      byQuantity(a, b) ||
      a.locationId.localeCompare(b.locationId) ||
      byAge(a, b),
  );
}
