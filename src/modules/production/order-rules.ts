/**
 * How a production order copies its recipe (WMS-28, ADR 0073). Pure: no
 * database. Each line is (recipe quantity × order quantity) ÷ «for how
 * much» of the version: multiplied first and divided once, so when the
 * true result is exact it comes out exact (dividing first would carry the
 * error of the last digit into the rounding). A material is rounded UP to
 * its step (half a screw is not set aside: what the order needs is at
 * least that); what comes out is rounded DOWN to its step (what is
 * expected never promises more). It is the one place a quantity is
 * rounded, because nobody typed it: the order shows what it sets aside.
 */
import { dec, type Decimal } from "@/lib";

/** Largest quantity a line may carry (as `MAX_QUANTITY` of the catalog). */
const MAX = dec("999999999.999");

type Amount = Decimal | string;

function scaled(
  recipeQuantity: Amount,
  orderQuantity: Amount,
  baseQuantity: Amount,
  step: Amount,
  up: boolean,
): Decimal {
  const exact = dec(recipeQuantity.toString())
    .times(dec(orderQuantity.toString()))
    .dividedBy(dec(baseQuantity.toString()));
  const unit = dec(step.toString());
  const steps = exact.dividedBy(unit);
  return (up ? steps.ceil() : steps.floor()).times(unit);
}

/** A material scaled for the order, rounded up to its step. */
export function scaleInput(
  recipeQuantity: Amount,
  orderQuantity: Amount,
  baseQuantity: Amount,
  step: Amount,
): Decimal {
  return scaled(recipeQuantity, orderQuantity, baseQuantity, step, true);
}

/** What comes out scaled for the order, rounded down to its step. */
export function scaleOutput(
  recipeQuantity: Amount,
  orderQuantity: Amount,
  baseQuantity: Amount,
  step: Amount,
): Decimal {
  return scaled(recipeQuantity, orderQuantity, baseQuantity, step, false);
}

/** True when a scaled quantity fits a line of the database. */
export const fitsLine = (quantity: Decimal) => !quantity.greaterThan(MAX);
