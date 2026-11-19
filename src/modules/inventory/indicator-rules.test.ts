import { describe, expect, it } from "vitest";

import {
  KPI_MAX_DAYS,
  countChange,
  previousPeriod,
  shareChange,
  timeChange,
  daysOfInventory,
  durationText,
  percentile,
  resolvePeriod,
  shippedOnTime,
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
    expect(rotationOf("0", "5", "5")).toBe("0.00");
    // Slow products: above zero never reads as 0.00.
    expect(rotationOf("1", "2000", "2000")).toBe("0.0005");
    expect(rotationOf("3", "200", "200")).toBe("0.02");
  });

  it("days of inventory come from exact decimals, not the rounded rotation", () => {
    expect(daysOfInventory(30, "60", "0", "60")).toBe("15");
    expect(daysOfInventory(7, "40", "120", "100")).toBe("19");
    // Worked out by hand: 30 × 2000 ÷ 1 = 60,000; 30 × 200 ÷ 3 = 2,000;
    // 30 × 1000 ÷ 7 = 4,285.7.
    expect(daysOfInventory(30, "1", "2000", "2000")).toBe("60000");
    expect(daysOfInventory(30, "3", "200", "200")).toBe("2000");
    expect(daysOfInventory(30, "7", "1000", "1000")).toBe("4286");
    expect(daysOfInventory(7, "0", "5", "5")).toBeNull();
    expect(daysOfInventory(7, "3", "0", "0")).toBeNull();
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

describe("on time", () => {
  it("compares days of the company's calendar, not of UTC", () => {
    // 03:00 UTC of the 13th is the 12th at 21:00 in Mexico City.
    const night = new Date("2026-11-13T03:00:00Z");
    expect(shippedOnTime(night, "2026-11-12", "America/Mexico_City")).toBe(
      true,
    );
    expect(shippedOnTime(night, "2026-11-12", "UTC")).toBe(false);
    expect(shippedOnTime(night, "2026-11-11", "America/Mexico_City")).toBe(
      false,
    );
    expect(shippedOnTime(null, "2026-11-12", "America/Mexico_City")).toBe(
      false,
    );
  });
});

// WMS-34 (ADR 0085): the period compared and how a change is told.
describe("previousPeriod", () => {
  it("days and written days: the same days right before", () => {
    expect(
      previousPeriod(resolvePeriod("2026-11-19", { preset: "7" })),
    ).toMatchObject({ from: "2026-11-06", to: "2026-11-12", days: 7 });
    expect(
      previousPeriod(
        resolvePeriod("2026-11-19", { from: "2026-11-01", to: "2026-11-10" }),
      ),
    ).toMatchObject({ from: "2026-10-22", to: "2026-10-31", days: 10 });
  });

  it("last month: the whole month before it", () => {
    expect(
      previousPeriod(resolvePeriod("2026-03-15", { preset: "anterior" })),
    ).toMatchObject({ from: "2026-01-01", to: "2026-01-31", days: 31 });
  });

  it("this month: the same days of the month before, never past its end", () => {
    expect(
      previousPeriod(resolvePeriod("2026-11-19", { preset: "mes" })),
    ).toMatchObject({ from: "2026-10-01", to: "2026-10-19", days: 19 });
    expect(
      previousPeriod(resolvePeriod("2026-03-31", { preset: "mes" })),
    ).toMatchObject({ from: "2026-02-01", to: "2026-02-28", days: 28 });
  });
});

describe("changes", () => {
  it("counts with their share when the one before is not zero", () => {
    expect(countChange(15, 12)).toBe("+3 (+25.0 %)");
    expect(countChange(9, 12)).toBe("−3 (−25.0 %)");
    expect(countChange(4, 0)).toBe("+4");
    expect(countChange(7, 7)).toBe("Sin cambio");
  });

  it("shares in points, times faster or slower", () => {
    expect(shareChange("80.0", "75.0")).toBe("+5.0 puntos");
    expect(shareChange("70.0", "75.5")).toBe("−5.5 puntos");
    expect(shareChange(null, "75.0")).toBe("—");
    expect(timeChange(30 * 60_000, 45 * 60_000)).toBe("15 min más rápido");
    expect(timeChange(2 * 3_600_000, 3_600_000)).toBe("1 h más lento");
    expect(timeChange(null, 1)).toBe("—");
    expect(timeChange(60_000, 90_000)).toBe("Sin cambio");
  });
});
