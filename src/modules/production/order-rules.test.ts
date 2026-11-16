import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import { fitsLine, recipeFactor, scaleInput, scaleOutput } from "./order-rules";

describe("scaling a recipe for an order (WMS-28)", () => {
  it("multiplies exactly when it fits", () => {
    const factor = recipeFactor("30", "1");
    expect(scaleInput("5", factor, "1").toString()).toBe("150");
    expect(scaleInput("0.2", factor, "0.01").toString()).toBe("6");
    expect(scaleOutput("1", factor, "1").toString()).toBe("30");
  });

  it("keeps «0.25 kg for 100 pieces» exact for any quantity of pieces", () => {
    const factor = recipeFactor("300", "100");
    expect(scaleInput("0.25", factor, "0.001").toString()).toBe("0.75");
  });

  it("rounds a material up to its step and an output down", () => {
    // 1 of 3 kits: a third of a screw is a whole screw.
    const factor = recipeFactor("1", "3");
    expect(scaleInput("1", factor, "1").toString()).toBe("1");
    expect(scaleInput("2", factor, "0.01").toString()).toBe("0.67");
    expect(scaleOutput("2", factor, "0.01").toString()).toBe("0.66");
    expect(scaleOutput("1", factor, "1").toString()).toBe("0");
  });

  it("refuses what does not fit a line", () => {
    expect(fitsLine(dec("999999999.999"))).toBe(true);
    expect(fitsLine(dec("1000000000"))).toBe(false);
  });
});
