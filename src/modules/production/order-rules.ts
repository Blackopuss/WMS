/**
 * How a production order copies its recipe (WMS-28, ADR 0073). Pure: no
 * database. The factor is the order's quantity over the version's «for how
 * much», exact. A material is rounded UP to its step (half a screw is not
 * set aside: what the order needs is at least that); what comes out is
 * rounded DOWN to its step (what is expected never promises more). It is
 * the one place a quantity is rounded, because nobody typed it: the order
 * shows what it sets aside.
 */
import { dec, type Decimal } from "@/lib";

export type ScaledLine = {
  productId: string;
  /** For the order, in `unitCode`. */
  quantity: Decimal;
  unitCode: string;
};

/** Largest quantity a line may carry (as `MAX_QUANTITY` of the catalog). */
const MAX = dec("999999999.999");

const roundTo = (value: Decimal, step: Decimal, up: boolean) => {
  const steps = value.dividedBy(step);
  return (up ? steps.ceil() : steps.floor()).times(step);
};

/**
 * The factor of an order: its quantity over the recipe's base. Both are
 * positive; the result keeps every digit (40 significant).
 */
export function recipeFactor(
  orderQuantity: Decimal | string,
  baseQuantity: Decimal | string,
): Decimal {
  return dec(orderQuantity.toString()).dividedBy(dec(baseQuantity.toString()));
}

/** A material scaled for the order, rounded up to its step. */
export function scaleInput(
  recipeQuantity: Decimal | string,
  factor: Decimal,
  step: Decimal | string,
): Decimal {
  return roundTo(
    dec(recipeQuantity.toString()).times(factor),
    dec(step.toString()),
    true,
  );
}

/** What comes out scaled for the order, rounded down to its step. */
export function scaleOutput(
  recipeQuantity: Decimal | string,
  factor: Decimal,
  step: Decimal | string,
): Decimal {
  return roundTo(
    dec(recipeQuantity.toString()).times(factor),
    dec(step.toString()),
    false,
  );
}

/** True when a scaled quantity fits a line of the database. */
export const fitsLine = (quantity: Decimal) => !quantity.greaterThan(MAX);
