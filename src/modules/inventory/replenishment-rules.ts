/**
 * Replenishment of picking locations (WMS-23/24, ADR 0051): the pure
 * pieces of the decision. No database: `replenishmentPlan` reads the facts
 * and asks these.
 */

import { dec, type Decimal } from "@/lib";

/**
 * Where a rule stands, worked out every time (nothing stored):
 * - `ok`: what is there is not below the minimum;
 * - `coming`: below, but open tasks already bring enough;
 * - `due`: below and there is stock in storage to bring;
 * - `no_stock`: below and nothing free in storage;
 * - `no_room`: below, but the location admits nothing more (capacity or a
 *   restriction);
 * - `review`: its location was archived or is no longer for picking, or
 *   its product was archived: nothing is done with it.
 */
export type ReplenishmentState =
  "ok" | "coming" | "due" | "no_stock" | "no_room" | "review";

export const REPLENISHMENT_STATE_LABELS: Record<ReplenishmentState, string> = {
  ok: "Bien",
  coming: "Repuesto en camino",
  due: "Por reponer",
  no_stock: "Sin existencias para reponer",
  no_room: "Sin espacio",
  review: "Revisar la regla",
};

/** The rule's quantities, in the product's unit. */
export type RuleQuantities = {
  min: Decimal;
  max: Decimal;
  /** Null = any quantity (in the product's step). */
  multiple: Decimal | null;
};

/** Is the location below its minimum, counting what is on its way? */
export const isBelowMinimum = (
  rule: RuleQuantities,
  here: Decimal,
  coming: Decimal,
): boolean => here.plus(coming).lessThan(rule.min);

/** The largest multiple of `unit` that is not more than `amount`. */
export function floorToMultiple(amount: Decimal, unit: Decimal | null) {
  if (!unit || !unit.greaterThan(0)) return amount;
  if (!amount.greaterThan(0)) return dec(0);
  return amount.dividedToIntegerBy(unit).times(unit);
}

/**
 * What to bring: up to the maximum, counting what is there and what is on
 * its way, in multiples. Zero when it is not below its minimum.
 */
export function replenishQuantity(
  rule: RuleQuantities,
  here: Decimal,
  coming: Decimal,
): Decimal {
  if (!isBelowMinimum(rule, here, coming)) return dec(0);
  const missing = rule.max.minus(here).minus(coming);
  return floorToMultiple(missing, rule.multiple);
}

/**
 * The largest `k` in [0, most] for which `fits(k)` holds, knowing that if
 * `k` fits every smaller one does too (more goods never fit better). Asks
 * `fits` about log2(most) times.
 */
export async function largestThatFits(
  most: number,
  fits: (k: number) => Promise<boolean>,
): Promise<number> {
  if (most <= 0) return 0;
  if (await fits(most)) return most;
  let low = 0;
  let high = most;
  // Invariant: low fits (0 always does: nothing more), high does not.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * How much to take from each origin, in order: from each one a multiple
 * (whole boxes) when there is one; if no origin has a whole multiple, what
 * there is (better than leaving the picking location empty). `free` is
 * what each origin (a lot in a place) can give, already in the order they
 * are taken; `groupFree` what each place can give across its lots, shared
 * by the origins of that place (`groupOf`).
 */
export function splitAmongSources<T extends { free: Decimal }>(
  sources: readonly T[],
  wanted: Decimal,
  multiple: Decimal | null,
  groupOf: (source: T) => string,
  groupFree: ReadonlyMap<string, Decimal>,
): { source: T; quantity: Decimal }[] {
  const take = (byMultiple: boolean) => {
    const parts: { source: T; quantity: Decimal }[] = [];
    const used = new Map<string, Decimal>();
    let left = wanted;
    for (const source of sources) {
      if (!left.greaterThan(0)) break;
      const group = groupOf(source);
      const inGroup = (groupFree.get(group) ?? source.free).minus(
        used.get(group) ?? 0,
      );
      let most = source.free.lessThan(left) ? source.free : left;
      if (inGroup.lessThan(most)) most = inGroup;
      const quantity = byMultiple ? floorToMultiple(most, multiple) : most;
      if (!quantity.greaterThan(0)) continue;
      parts.push({ source, quantity });
      used.set(group, (used.get(group) ?? dec(0)).plus(quantity));
      left = left.minus(quantity);
    }
    return parts;
  };
  const whole = take(true);
  if (whole.length > 0 || !multiple) return whole;
  return take(false);
}

/** The state of a rule once the decision is known. */
export function replenishmentStateOf(facts: {
  valid: boolean;
  rule: RuleQuantities;
  here: Decimal;
  coming: Decimal;
  /** What the decision would bring now (zero when it brings nothing). */
  bring: Decimal;
  /** Why it brings nothing while below its minimum. */
  blockedBy: "room" | "stock" | null;
}): ReplenishmentState {
  if (!facts.valid) return "review";
  if (!facts.here.lessThan(facts.rule.min)) return "ok";
  if (!isBelowMinimum(facts.rule, facts.here, facts.coming)) return "coming";
  if (facts.bring.greaterThan(0)) return "due";
  return facts.blockedBy === "room" ? "no_room" : "no_stock";
}
