import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import { fitsLine, scaleInput, scaleOutput } from "./order-rules";

const input = (recipe: string, order: string, base: string, step: string) =>
  scaleInput(recipe, order, base, step).toString();
const output = (recipe: string, order: string, base: string, step: string) =>
  scaleOutput(recipe, order, base, step).toString();

describe("scaling a recipe for an order (WMS-28)", () => {
  it("multiplies exactly when it fits", () => {
    expect(input("5", "30", "1", "1")).toBe("150");
    expect(input("0.2", "30", "1", "0.01")).toBe("6");
    expect(output("1", "30", "1", "1")).toBe("30");
  });

  it("keeps «0.25 kg for 100 pieces» exact for any quantity of pieces", () => {
    expect(input("0.25", "300", "100", "0.001")).toBe("0.75");
  });

  it("is exact when the base does not divide (multiply, then divide)", () => {
    // Recipe for 6 with 6 of a material: an order of 7 needs 7, not 8.
    expect(input("6", "7", "6", "1")).toBe("7");
    // Recipe for 3 that makes 3: an order of 1 makes 1, of 10 makes 10.
    expect(output("3", "1", "3", "1")).toBe("1");
    expect(output("3", "10", "3", "1")).toBe("10");
    expect(input("3", "10", "3", "1")).toBe("10");
    // Base 7 and decimal steps.
    expect(input("7", "5", "7", "0.01")).toBe("5");
    expect(output("14", "3", "7", "0.1")).toBe("6");
    expect(input("2.1", "10", "7", "0.001")).toBe("3");
    expect(output("0.6", "5", "6", "0.01")).toBe("0.5");
    expect(input("1.5", "4", "6", "0.1")).toBe("1");
  });

  it("rounds a material up to its step and an output down", () => {
    // 1 of 3 kits: a third of a screw is a whole screw.
    expect(input("1", "1", "3", "1")).toBe("1");
    expect(input("2", "1", "3", "0.01")).toBe("0.67");
    expect(output("2", "1", "3", "0.01")).toBe("0.66");
    expect(output("1", "1", "3", "1")).toBe("0");
  });

  it("refuses what does not fit a line", () => {
    expect(fitsLine(dec("999999999.999"))).toBe(true);
    expect(fitsLine(dec("1000000000"))).toBe(false);
  });
});
