import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import { exceedsThreshold } from "./approval-rules";

describe("adjustment threshold (WMS-41)", () => {
  it("«any» asks for every correction; nothing changed never asks", () => {
    expect(exceedsThreshold("any", dec(100), dec(1))).toBe(true);
    expect(exceedsThreshold("any", dec(100), dec(0))).toBe(false);
  });

  it("a percent compares the change with what the system has", () => {
    expect(exceedsThreshold("10", dec(100), dec(10))).toBe(false);
    expect(exceedsThreshold("10", dec(100), dec("10.001"))).toBe(true);
    expect(exceedsThreshold("25", dec(100), dec(-30))).toBe(true);
    expect(exceedsThreshold("50", dec(100), dec(50))).toBe(false);
  });

  it("when the system had nothing, anything found is big", () => {
    expect(exceedsThreshold("50", dec(0), dec(1))).toBe(true);
  });

  it("an unknown value asks rather than lets it pass", () => {
    expect(exceedsThreshold("x", dec(100), dec(1))).toBe(true);
  });
});
