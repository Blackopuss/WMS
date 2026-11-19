import { describe, expect, it } from "vitest";

import {
  KPI_MAX_DAYS,
  daysOfInventory,
  durationText,
  percentile,
  resolvePeriod,
  rotationOf,
  shareOf,
  timeFigures,
} from "./indicator-rules";

// WMS-32 (ADR 0082): the pure rules of the warehouse indicators.

describe("resolvePeriod", () => {
  it("presets end today; the default is 30 days", () => {
    expect(resolvePeriod("2026-11-19", {})).toMatchObject({
      from: "2026-10-21",
      to: "2026-11-19",
      next: "2026-11-20",
      days: 30,
      preset: "30",
    });
    expect(resolvePeriod("2026-11-19", { preset: "7" })).toMatchObject({
      from: "2026-11-13",
      to: "2026-11-19",
      days: 7,
    });
    expect(resolvePeriod("2026-11-19", { preset: "mes" })).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-19",
      days: 19,
    });
    expect(resolvePeriod("2026-03-10", { preset: "anterior" })).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
      next: "2026-03-01",
      days: 28,
    });
    expect(resolvePeriod("2026-11-19", { preset: "999" }).preset).toBe("30");
  });

  it("days written by hand win only when they make sense", () => {
    expect(
      resolvePeriod("2026-11-19", { from: "2026-11-01", to: "2026-11-10" }),
    ).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-10",
      days: 10,
      preset: null,
      clipped: false,
    });
    // After today, backwards or not a day: the preset.
    for (const asked of [
      { from: "2026-11-01", to: "2026-11-20" },
      { from: "2026-11-10", to: "2026-11-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "ayer", to: "2026-11-01" },
    ]) {
      expect(resolvePeriod("2026-11-19", asked).preset).toBe("30");
    }
    // Longer than the cap: the last days up to the end.
    const long = resolvePeriod("2026-11-19", {
      from: "2025-01-01",
      to: "2026-11-19",
    });
    expect(long).toMatchObject({ to: "2026-11-19", clipped: true });
    expect(long.days).toBe(KPI_MAX_DAYS);
  });
});

describe("rotation", () => {
  it("is what left over the average stock", () => {
    expect(rotationOf("40", "120", "100")).toBe("0.36");
    expect(rotationOf("50", "0", "50")).toBe("2.00");
    expect(rotationOf("10", "0", "0")).toBeNull();
    expect(daysOfInventory("2.00", 30)).toBe("15");
    expect(daysOfInventory("0.36", 7)).toBe("19");
    expect(daysOfInventory(null, 7)).toBeNull();
    expect(daysOfInventory("0.00", 7)).toBeNull();
  });
});

describe("times and shares", () => {
  it("median and 90th percentile by nearest rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(timeFigures([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({
      count: 10,
      medianMs: 50,
      p90Ms: 90,
    });
    expect(shareOf(1, 3)).toBe("33.3");
    expect(shareOf(0, 0)).toBeNull();
  });

  it("durations read like a person says them", () => {
    expect(durationText(null)).toBe("—");
    expect(durationText(20_000)).toBe("menos de 1 min");
    expect(durationText(35 * 60_000)).toBe("35 min");
    expect(durationText(80 * 60_000)).toBe("1 h 20 min");
    expect(durationText(2 * 3_600_000)).toBe("2 h");
    expect(durationText(52 * 3_600_000)).toBe("2 d 4 h");
  });
});
