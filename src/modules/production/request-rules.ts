/**
 * Rules of production requests (WMS-28B, ADR 0075). Pure: no database.
 */
import { dec, type Decimal } from "@/lib";

import { scaleInput } from "./order-rules";

type Amount = Decimal | string;

/** Margins over the minimum a company may choose (`production.request.low_margin`). */
export const LOW_MARGIN_PERCENTS = ["0", "10", "25", "50"] as const;

/**
 * «Close to low stock»: the product has a minimum and what is available is
 * at or below minimum × (1 + margin %). A minimum of zero offers the
 * product only when nothing is available.
 */
export function isNearMinimum(
  available: Amount,
  minimum: Amount,
  marginPercent: Amount,
): boolean {
  const line = dec(minimum.toString()).times(
    dec(1).plus(dec(marginPercent.toString()).dividedBy(100)),
  );
  return !dec(available.toString()).greaterThan(line);
}

/**
 * How much of a product the free material reaches for, at most `wanted`:
 * for each material the largest quantity (in steps of the product) whose
 * scaled need — the same rule as the order, rounded up — fits in what is
 * free. Zero when a material has nothing free.
 */
export function reachableQuantity(
  wanted: Amount,
  productStep: Amount,
  baseQuantity: Amount,
  materials: readonly {
    recipeQuantity: Amount;
    step: Amount;
    free: Amount;
  }[],
): Decimal {
  const step = dec(productStep.toString());
  let best = dec(wanted.toString());
  for (const material of materials) {
    const free = dec(material.free.toString());
    const fits = (quantity: Decimal) =>
      !scaleInput(
        material.recipeQuantity,
        quantity,
        baseQuantity,
        material.step,
      ).greaterThan(free);
    if (fits(best)) continue;
    // A first guess from the proportion, rounded down to the product step,
    // then down one step at a time while the rounded-up need does not fit.
    let guess = free
      .times(dec(baseQuantity.toString()))
      .dividedBy(dec(material.recipeQuantity.toString()))
      .dividedBy(step)
      .floor()
      .times(step);
    if (guess.greaterThan(best)) guess = best;
    for (let i = 0; i < 1000 && guess.greaterThan(0) && !fits(guess); i++) {
      guess = guess.minus(step);
    }
    best = guess.greaterThan(0) && fits(guess) ? guess : dec(0);
  }
  return best;
}
