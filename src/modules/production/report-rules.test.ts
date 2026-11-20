import { describe, expect, it } from "vitest";

import { dec, type Decimal } from "@/lib";

import {
  consumeNow,
  cumulativeThatFits,
  goodThatFits,
  produceNow,
} from "./report-rules";

// WMS-29 (ADR 0087): what a report consumes and makes is cumulative over
// the reports of the order, so partial reports never leave residues.

describe("consumeNow", () => {
  it("consumes the recipe for good + bad, rounded up to the material's step", () => {
    expect(
      consumeNow({
        recipeQuantity: "4",
        baseQuantity: "1",
        step: "1",
        cumulative: "3",
        consumed: "0",
      }).toString(),
    ).toBe("12");
    // 0.5 per piece with step 1: the first piece takes 1, the second 0.
    expect(
      consumeNow({
        recipeQuantity: "1",
        baseQuantity: "2",
        step: "1",
        cumulative: "1",
        consumed: "0",
      }).toString(),
    ).toBe("1");
    expect(
      consumeNow({
        recipeQuantity: "1",
        baseQuantity: "2",
        step: "1",
        cumulative: "2",
        consumed: "1",
      }).toString(),
    ).toBe("0");
  });

  it("never answers a negative amount", () => {
    expect(
      consumeNow({
        recipeQuantity: "1",
        baseQuantity: "1",
        step: "1",
        cumulative: "1",
        consumed: "5",
      }).toString(),
    ).toBe("0");
  });
});

describe("produceNow", () => {
  it("makes for good only, rounded down to the output's step", () => {
    expect(
      produceNow({
        outputQuantity: "3",
        baseQuantity: "2",
        step: "1",
        cumulativeGood: "1",
        produced: "0",
      }).toString(),
    ).toBe("1");
    expect(
      produceNow({
        outputQuantity: "3",
        baseQuantity: "2",
        step: "1",
        cumulativeGood: "2",
        produced: "1",
      }).toString(),
    ).toBe("2");
  });
});

/** Several partial reports, each with what is left of the cumulative. */
function inParts(
  parts: string[],
  rule: { recipe: string; base: string; step: string },
  kind: "consume" | "produce",
): Decimal {
  let done = dec(0);
  let cumulative = dec(0);
  for (const part of parts) {
    cumulative = cumulative.plus(part);
    const now =
      kind === "consume"
        ? consumeNow({
            recipeQuantity: rule.recipe,
            baseQuantity: rule.base,
            step: rule.step,
            cumulative,
            consumed: done,
          })
        : produceNow({
            outputQuantity: rule.recipe,
            baseQuantity: rule.base,
            step: rule.step,
            cumulativeGood: cumulative,
            produced: done,
          });
    done = done.plus(now);
  }
  return done;
}

describe("partial reports add up to one single report", () => {
  const rules = [
    { recipe: "4", base: "1", step: "1" },
    { recipe: "1", base: "2", step: "1" },
    { recipe: "0.333", base: "1", step: "0.001" },
    { recipe: "2.5", base: "3", step: "0.5" },
    { recipe: "7", base: "10", step: "1" },
    { recipe: "1.25", base: "0.5", step: "0.25" },
  ];
  const splits = [
    ["1", "1", "1", "1", "1", "1", "1"],
    ["3", "4"],
    ["0.5", "0.5", "2", "4"],
    ["0.25", "0.75", "6"],
    ["7"],
  ];
  for (const rule of rules) {
    for (const parts of splits) {
      const total = parts.reduce((sum, part) => sum.plus(part), dec(0));
      it(`recipe ${rule.recipe} per ${rule.base} (step ${rule.step}) in ${parts.join("+")}`, () => {
        for (const kind of ["consume", "produce"] as const) {
          expect(inParts(parts, rule, kind).toString()).toBe(
            inParts([total.toString()], rule, kind).toString(),
          );
        }
      });
    }
  }
});

describe("cumulativeThatFits", () => {
  it("is the most whose consumption fits in what was consumed + what is within reach", () => {
    // 4 per piece, 10 within reach: 2 pieces (8), not 3 (12).
    expect(
      cumulativeThatFits({
        recipeQuantity: "4",
        baseQuantity: "1",
        step: "1",
        orderStep: "1",
        consumed: "0",
        reachable: "10",
      }).toString(),
    ).toBe("2");
    // Already consumed counts: 8 + 4 = 12 → 3 pieces in all.
    expect(
      cumulativeThatFits({
        recipeQuantity: "4",
        baseQuantity: "1",
        step: "1",
        orderStep: "1",
        consumed: "8",
        reachable: "4",
      }).toString(),
    ).toBe("3");
  });

  it("agrees with consumeNow: what it says fits does fit, and one more step does not", () => {
    const cases = [
      { recipe: "1", base: "2", step: "1", orderStep: "1", reach: "3" },
      { recipe: "2.5", base: "3", step: "0.5", orderStep: "0.5", reach: "7" },
      { recipe: "0.333", base: "1", step: "0.001", orderStep: "1", reach: "2" },
    ];
    for (const each of cases) {
      const fits = cumulativeThatFits({
        recipeQuantity: each.recipe,
        baseQuantity: each.base,
        step: each.step,
        orderStep: each.orderStep,
        consumed: "0",
        reachable: each.reach,
      });
      const at = (cumulative: Decimal) =>
        consumeNow({
          recipeQuantity: each.recipe,
          baseQuantity: each.base,
          step: each.step,
          cumulative,
          consumed: "0",
        });
      expect(at(fits).lessThanOrEqualTo(each.reach)).toBe(true);
      expect(at(fits.plus(each.orderStep)).greaterThan(each.reach)).toBe(true);
    }
  });

  it("a material the recipe does not use never limits", () => {
    expect(
      cumulativeThatFits({
        recipeQuantity: "0",
        baseQuantity: "1",
        step: "1",
        orderStep: "1",
        consumed: "0",
        reachable: "0",
      }).greaterThan(1000),
    ).toBe(true);
  });
});

describe("goodThatFits", () => {
  it("is what the cumulative still allows, minus the bad pieces, never negative", () => {
    expect(goodThatFits({ fits: "10", before: "3", bad: "2" }).toString()).toBe(
      "5",
    );
    expect(goodThatFits({ fits: "4", before: "3", bad: "2" }).toString()).toBe(
      "0",
    );
  });
});
