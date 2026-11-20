import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import {
  consolidationPlan,
  fastClassesOf,
  inWalkingOrder,
  isSlottingKind,
  rankFastProducts,
  slottingLimitOf,
  slottingReason,
} from "./slotting-rules";

describe("slotting rules (WMS-65)", () => {
  it("reads the settings safely", () => {
    expect([...fastClassesOf("a")]).toEqual(["A"]);
    expect([...fastClassesOf("ab")]).toEqual(["A", "B"]);
    expect([...fastClassesOf("zzz")]).toEqual(["A"]);
    expect(slottingLimitOf("10")).toBe(10);
    expect(slottingLimitOf("50")).toBe(50);
    expect(slottingLimitOf("7")).toBe(20);
    expect(isSlottingKind("closer")).toBe(true);
    expect(isSlottingKind("other")).toBe(false);
    expect(isSlottingKind(undefined)).toBe(false);
  });

  it("orders fast products: class A first, then by name", () => {
    const ranked = rankFastProducts([
      { productId: "3", abcClass: "B", name: "Arandela" },
      { productId: "2", abcClass: "A", name: "Tornillo" },
      { productId: "1", abcClass: "A", name: "clavo" },
    ]);
    expect(ranked.map((row) => row.productId)).toEqual(["1", "2", "3"]);
  });

  it("walks places by code in natural order; without a code, by path", () => {
    const order = inWalkingOrder([
      { id: "c", code: "A-10", path: "" },
      { id: "a", code: "A-2", path: "" },
      { id: "b", code: null, path: "A-3" },
      { id: "d", code: "a-02", path: "" },
    ]);
    expect(order.map((place) => place.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("joins from the place holding least into the one holding most", () => {
    expect(
      consolidationPlan([
        { locationId: "x", quantity: "10", movable: true },
        { locationId: "y", quantity: "3", movable: true },
        { locationId: "z", quantity: "6", movable: true },
      ]),
    ).toEqual([
      { fromId: "y", targets: ["x", "z"] },
      { fromId: "z", targets: ["x", "y"] },
      { fromId: "x", targets: ["z", "y"] },
    ]);
  });

  it("a place that cannot empty is never an origin, but can receive", () => {
    expect(
      consolidationPlan([
        { locationId: "x", quantity: dec(10), movable: true },
        { locationId: "y", quantity: dec(3), movable: false },
      ]),
    ).toEqual([{ fromId: "x", targets: ["y"] }]);
    expect(
      consolidationPlan([{ locationId: "x", quantity: "1", movable: true }]),
    ).toEqual([]);
  });

  it("says why in one line", () => {
    expect(slottingReason("closer", { abcClass: "B" })).toBe(
      "Sale seguido (clase B) y no tiene lugar de surtido.",
    );
    expect(slottingReason("idle", { idleDays: 60 })).toBe(
      "No ha tenido movimiento en 60 días y ocupa un lugar de surtido.",
    );
    expect(slottingReason("consolidate", { places: 4 })).toBe(
      "Está repartido en 4 ubicaciones de almacenaje.",
    );
  });
});
