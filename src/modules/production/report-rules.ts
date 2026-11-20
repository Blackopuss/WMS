/**
 * How a production report turns «Hice N» into what it takes and makes
 * (WMS-29, ADR 0087). Pure: no database.
 *
 * Everything is cumulative over the reports of the order that were not
 * reversed, so several partial reports never leave residues: a material
 * consumes, in all, ceil_step(recipe × (good + bad so far) ÷ base); an
 * output makes, in all, floor_step(output × good so far ÷ base). Each
 * report takes the difference with what was already taken or made.
 */
import { dec, type Decimal } from "@/lib";

import { scaleInput, scaleOutput } from "./order-rules";

type Amount = Decimal | string;

const zeroFloor = (value: Decimal) => (value.isNegative() ? dec(0) : value);

/** What a material line consumes in this report. */
export function consumeNow(input: {
  recipeQuantity: Amount;
  baseQuantity: Amount;
  step: Amount;
  /** Good + bad of every report, this one included. */
  cumulative: Amount;
  /** What the reports so far consumed of this line. */
  consumed: Amount;
}): Decimal {
  const target = scaleInput(
    input.recipeQuantity,
    input.cumulative,
    input.baseQuantity,
    input.step,
  );
  return zeroFloor(target.minus(dec(input.consumed.toString())));
}

/** What an output makes in this report. */
export function produceNow(input: {
  outputQuantity: Amount;
  baseQuantity: Amount;
  step: Amount;
  /** Good of every report, this one included. */
  cumulativeGood: Amount;
  /** What the reports so far made of this output. */
  produced: Amount;
}): Decimal {
  const target = scaleOutput(
    input.outputQuantity,
    input.cumulativeGood,
    input.baseQuantity,
    input.step,
  );
  return zeroFloor(target.minus(dec(input.produced.toString())));
}

/**
 * The most the cumulative good + bad can reach with what is within reach
 * of one material: the largest C (a multiple of the order's step) whose
 * consumption ceil_step(recipe × C ÷ base) fits in consumed + reachable.
 */
export function cumulativeThatFits(input: {
  recipeQuantity: Amount;
  baseQuantity: Amount;
  /** Step of the material. */
  step: Amount;
  /** Step of the order's product. */
  orderStep: Amount;
  consumed: Amount;
  reachable: Amount;
}): Decimal {
  const recipe = dec(input.recipeQuantity.toString());
  if (!recipe.greaterThan(0)) return dec("999999999.999");
  const step = dec(input.step.toString());
  // ceil_step(x) ≤ A ⟺ x ≤ floor_step(A).
  const room = dec(input.consumed.toString())
    .plus(dec(input.reachable.toString()))
    .dividedBy(step)
    .floor()
    .times(step);
  const orderStep = dec(input.orderStep.toString());
  return room
    .times(dec(input.baseQuantity.toString()))
    .dividedBy(recipe)
    .dividedBy(orderStep)
    .floor()
    .times(orderStep);
}

/**
 * «Alcanza para»: how much more good can be reported, given the most the
 * cumulative may reach (the least among the materials), what was already
 * reported (good + bad) and the bad pieces of this report. Never negative.
 */
export function goodThatFits(input: {
  fits: Amount;
  before: Amount;
  bad: Amount;
}): Decimal {
  return zeroFloor(
    dec(input.fits.toString())
      .minus(dec(input.before.toString()))
      .minus(dec(input.bad.toString())),
  );
}
