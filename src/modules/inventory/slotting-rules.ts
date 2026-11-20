/**
 * Relocation suggestions (WMS-65, ADR 0086), pure: no database. The
 * service reads the facts and asks these rules what to suggest and in
 * which order. Nothing is stored: a suggestion is derived each time.
 */

import { dec, type Decimal } from "@/lib";

import type { AbcClass } from "./abc-rules";
import { compareRoute, routeKey, type RoutePlace } from "./pick-route";

/**
 * - `closer`: what leaves often and has no picking place, to an empty one.
 * - `idle`: what has not moved, out of a picking place, to storage.
 * - `consolidate`: the same lot spread over storage places, together.
 */
export type SlottingKind = "closer" | "idle" | "consolidate";

export const SLOTTING_KINDS: readonly SlottingKind[] = [
  "closer",
  "idle",
  "consolidate",
];

export const isSlottingKind = (value: unknown): value is SlottingKind =>
  typeof value === "string" &&
  (SLOTTING_KINDS as readonly string[]).includes(value);

/** `inventory.slotting.fast_classes`: «a» or «ab»; anything else is «a». */
export function fastClassesOf(value: string): ReadonlySet<AbcClass> {
  return new Set<AbcClass>(value === "ab" ? ["A", "B"] : ["A"]);
}

/** `inventory.slotting.limit`, read safely (20 when not an option). */
export function slottingLimitOf(value: string): number {
  return value === "10" ? 10 : value === "50" ? 50 : 20;
}

/**
 * The fast products in the order they are suggested: class A before B,
 * then by name, then id (always the same order).
 */
export function rankFastProducts<
  T extends { productId: string; abcClass: AbcClass; name: string },
>(products: readonly T[]): T[] {
  const weight = (value: AbcClass) =>
    value === "A" ? 0 : value === "B" ? 1 : 2;
  return [...products].sort(
    (a, b) =>
      weight(a.abcClass) - weight(b.abcClass) ||
      a.name.localeCompare(b.name, "es", { sensitivity: "base" }) ||
      a.productId.localeCompare(b.productId),
  );
}

/**
 * Picking places in walking order (the order of the picking route, ADR
 * 0054): the first one is the one suggested. «Cerca» is this order; the
 * system has no distances.
 */
export function inWalkingOrder<T extends RoutePlace & { id: string }>(
  places: readonly T[],
): T[] {
  return [...places].sort(
    (a, b) =>
      compareRoute(routeKey(a), routeKey(b)) || a.id.localeCompare(b.id),
  );
}

export type SpreadPlace = {
  locationId: string;
  /** Available of the product and lot there. */
  quantity: Decimal | string;
  /**
   * All of it may leave: nothing set aside nor in a pallet, and the place
   * holds nothing else of the product. Only such a place empties.
   */
  movable: boolean;
};

/**
 * How to join a lot spread over several places: the origins in the order
 * they are tried (the one holding least first; only movable ones) and,
 * for each, the targets (the others, the one holding most first). Empty
 * with fewer than two places. Ties by location id.
 */
export function consolidationPlan(
  places: readonly SpreadPlace[],
): { fromId: string; targets: string[] }[] {
  if (places.length < 2) return [];
  const rows = places.map((place) => ({
    ...place,
    amount: dec(place.quantity),
  }));
  const ascending = [...rows].sort(
    (a, b) =>
      a.amount.comparedTo(b.amount) || a.locationId.localeCompare(b.locationId),
  );
  const descending = [...ascending].reverse();
  return ascending
    .filter((row) => row.movable && row.amount.greaterThan(0))
    .map((origin) => ({
      fromId: origin.locationId,
      targets: descending
        .filter((row) => row.locationId !== origin.locationId)
        .map((row) => row.locationId),
    }));
}

/** The one line that says why, shown next to each suggestion. */
export function slottingReason(
  kind: SlottingKind,
  facts: { abcClass?: AbcClass | null; idleDays?: number; places?: number },
): string {
  switch (kind) {
    case "closer":
      return `Sale seguido (clase ${facts.abcClass ?? "A"}) y no tiene lugar de surtido.`;
    case "idle":
      return `No ha tenido movimiento en ${facts.idleDays ?? 90} días y ocupa un lugar de surtido.`;
    case "consolidate":
      return `Está repartido en ${facts.places ?? 2} ubicaciones de almacenaje.`;
  }
}
