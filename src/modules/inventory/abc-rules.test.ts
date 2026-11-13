import { describe, expect, it } from "vitest";

import { classifyAbc, locationClass, parseAbcCuts } from "./abc-rules";

// WMS-55 (ADR 0050): the ABC split of a known scenario.

describe("ABC classification", () => {
  it("splits a known scenario 80/15/5", () => {
    const classes = classifyAbc(
      [
        { productId: "p1", amount: "16" },
        { productId: "p2", amount: "3" },
        { productId: "p3", amount: "1" },
        { productId: "p4", amount: "0" },
      ],
      [80, 15],
    );
    expect(Object.fromEntries(classes)).toEqual({ p1: "A", p2: "B", p3: "C" });
  });

  it("keeps the product that crosses a cut in the upper class", () => {
    const classes = classifyAbc(
      [
        { productId: "a", amount: "50" },
        { productId: "b", amount: "40" },
        { productId: "c", amount: "10" },
      ],
      [80, 15],
    );
    expect(classes.get("a")).toBe("A");
    expect(classes.get("b")).toBe("A");
    expect(classes.get("c")).toBe("B");
  });

  it("gives nothing when nothing left", () => {
    expect(classifyAbc([{ productId: "x", amount: "0" }], [80, 15]).size).toBe(
      0,
    );
  });

  it("reads the cuts of the setting and falls back on anything else", () => {
    expect(parseAbcCuts("70_20_10")).toEqual([70, 20]);
    expect(parseAbcCuts("90_20_10")).toEqual([80, 15]);
    expect(parseAbcCuts("x")).toEqual([80, 15]);
  });

  it("classes a location by the best of what it holds", () => {
    const classes = new Map([
      ["a", "A" as const],
      ["b", "B" as const],
    ]);
    expect(locationClass(["z", "b"], classes)).toBe("B");
    expect(locationClass(["b", "a"], classes)).toBe("A");
    expect(locationClass([], classes)).toBe("C");
  });
});
