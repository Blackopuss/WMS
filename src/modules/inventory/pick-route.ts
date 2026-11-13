/**
 * The walking order of picking (WMS-25, ADR 0054): one pass through the
 * warehouse, by the code of the place each task leaves from. Pure: no
 * database. «Basic optimization» as the plan asks: no coordinates nor
 * distances — the codes of a warehouse (WMS-22A) already follow its aisles.
 *
 * Natural order: numbers inside a code compare as numbers, so `A-01-2`,
 * `A-01-02` and `A-1-2` sit together and `A-01-10` comes after `A-01-02`;
 * letters compare without caring for case or accents. A place without a
 * code uses its path («Zona A › Pasillo 2 › Estante 3») the same way.
 */

export type RoutePlace = {
  /** Its code (what its label says), or null. */
  code: string | null;
  /** «Zona A › Pasillo 2 › Estante 3». */
  path: string;
};

const CHUNKS = /\d+|\D+/g;

const textOrder = (a: string, b: string) =>
  a.localeCompare(b, "es", { sensitivity: "base" });

/** Numbers by their value, however many zeros lead them. */
function numberOrder(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** Compares two codes or paths in natural order. */
export function compareRoute(a: string, b: string): number {
  const left = a.trim().match(CHUNKS) ?? [];
  const right = b.trim().match(CHUNKS) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!;
    const y = right[i]!;
    const digits = /^\d/.test(x) && /^\d/.test(y);
    const order = digits ? numberOrder(x, y) : textOrder(x, y);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/** What a place is ordered by: its code, or its path without one. */
export const routeKey = (place: RoutePlace) => place.code?.trim() || place.path;

/**
 * The items in walking order. Ties (the same place) keep the order they
 * came in, so the caller decides what goes first there. Never changes the
 * list it receives.
 */
export function inRouteOrder<T>(
  items: readonly T[],
  placeOf: (item: T) => RoutePlace,
): T[] {
  return items
    .map((item, index) => ({ item, index, key: routeKey(placeOf(item)) }))
    .sort((a, b) => compareRoute(a.key, b.key) || a.index - b.index)
    .map((entry) => entry.item);
}
