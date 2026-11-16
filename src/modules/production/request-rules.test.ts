import { describe, expect, it } from "vitest";

import { isNearMinimum, reachableQuantity } from "./request-rules";

describe("production request rules (WMS-28B)", () => {
  it("offers a product at or below minimum × (1 + margin)", () => {
    expect(isNearMinimum("24", "24", "0")).toBe(true);
    expect(isNearMinimum("25", "24", "0")).toBe(false);
    expect(isNearMinimum("30", "24", "25")).toBe(true);
    expect(isNearMinimum("30.001", "24", "25")).toBe(false);
    expect(isNearMinimum("26.4", "24", "10")).toBe(true);
    expect(isNearMinimum("36", "24", "50")).toBe(true);
    expect(isNearMinimum("36.5", "24", "50")).toBe(false);
    expect(isNearMinimum("0", "0", "25")).toBe(true);
    expect(isNearMinimum("1", "0", "25")).toBe(false);
  });

  it("says how much the free material reaches for", () => {
    // 4 boards and 5 screws per crate; 64 boards free → 16 crates.
    expect(
      reachableQuantity("20", "1", "1", [
        { recipeQuantity: "4", step: "1", free: "64" },
        { recipeQuantity: "5", step: "1", free: "500" },
      ]).toString(),
    ).toBe("16");
    // Everything reaches.
    expect(
      reachableQuantity("20", "1", "1", [
        { recipeQuantity: "4", step: "1", free: "80" },
      ]).toString(),
    ).toBe("20");
    // Nothing free.
    expect(
      reachableQuantity("20", "1", "1", [
        { recipeQuantity: "4", step: "1", free: "0" },
      ]).toString(),
    ).toBe("0");
    // A recipe for 6 with 1 screw (rounded up): 2 screws free → 7 pieces
    // need 2 screws (7/6 → 2), 12 pieces need 2 too, 13 need 3.
    expect(
      reachableQuantity("20", "1", "6", [
        { recipeQuantity: "1", step: "1", free: "2" },
      ]).toString(),
    ).toBe("12");
  });
});
