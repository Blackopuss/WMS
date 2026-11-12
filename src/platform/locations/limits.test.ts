import { describe, expect, it } from "vitest";

import {
  describeCapacity,
  foldCode,
  formatCapacityAmount,
  formatCapacityUse,
  isUnlimited,
  parseCapacity,
  scaleToTell,
  splitProductCodes,
} from "./limits";

// WMS-22B: the pure rules of capacity (ADR 0039).

describe("parseCapacity", () => {
  it("empty is no limit", () => {
    expect(parseCapacity("")).toEqual({ ok: true, value: null });
    expect(parseCapacity("   ")).toEqual({ ok: true, value: null });
    expect(parseCapacity(undefined)).toEqual({ ok: true, value: null });
  });

  it("takes exact amounts greater than zero, with thousands commas", () => {
    expect(parseCapacity("500")).toEqual({ ok: true, value: "500" });
    expect(parseCapacity("1,250.5")).toEqual({ ok: true, value: "1250.5" });
    expect(parseCapacity("0.001")).toEqual({ ok: true, value: "0.001" });
    expect(parseCapacity("250.500")).toEqual({ ok: true, value: "250.5" });
  });

  it("rejects zero, negatives, text, too many decimals and absurd sizes", () => {
    for (const bad of ["0", "-1", "mucho", "1.2345", "1e3", "9999999999999"]) {
      expect(parseCapacity(bad).ok, bad).toBe(false);
    }
  });
});

describe("texts", () => {
  it("say each measure in its unit", () => {
    expect(formatCapacityAmount("units", "1")).toBe("1 unidad");
    expect(formatCapacityAmount("units", "1500")).toBe("1,500 unidades");
    expect(formatCapacityAmount("weight", "250.5")).toBe("250.5 kg");
    expect(formatCapacityAmount("volume", "2.4")).toBe("2.4 m³");
    // Rounded for people, without zeros that say nothing.
    expect(formatCapacityAmount("weight", "100.5004")).toBe("100.5 kg");
  });

  it("describe a capacity, or nothing when there is no limit", () => {
    expect(
      describeCapacity({ units: "500", weight: "1000", volume: null }),
    ).toBe("500 unidades · 1,000 kg");
    expect(
      describeCapacity({ units: null, weight: null, volume: null }),
    ).toBeNull();
    expect(isUnlimited({ units: null, weight: null, volume: null })).toBe(true);
    expect(isUnlimited({ units: null, weight: null, volume: "1" })).toBe(false);
  });

  it("never show a little over as exactly full", () => {
    expect(formatCapacityUse("units", "120", "500")).toBe(
      "120 de 500 unidades",
    );
    expect(formatCapacityUse("weight", "100", "100")).toBe("100 de 100 kg");
    expect(scaleToTell("1.0005", "1")).toBe(4);
    expect(formatCapacityUse("volume", "1.0005", "1")).toBe("1.0005 de 1 m³");
    expect(formatCapacityUse("volume", "0.95", "1")).toBe("0.95 de 1 m³");
  });
});

describe("splitProductCodes", () => {
  it("reads one code per line or between commas, without repeats", () => {
    expect(splitProductCodes("TOR-1\nCLA-2, cab-3;TOR-1\r\n\n tor-1 ")).toEqual(
      ["TOR-1", "CLA-2", "cab-3"],
    );
    expect(splitProductCodes("")).toEqual([]);
    expect(splitProductCodes(null)).toEqual([]);
  });

  it("compares codes without capitals or accents", () => {
    expect(foldCode(" Ñandú-1 ")).toBe("nandu-1");
  });
});
