import { describe, expect, it } from "vitest";

import {
  judgeAnswer,
  parsePoint,
  parseRangeValue,
  resolveSampling,
  sampleSize,
  type PlanPoint,
} from "./plan-rules";

describe("sampling with the company setting (D6)", () => {
  it("a plan that says full or sample rules over the setting", () => {
    const rule = { kind: "FIXED" as const, quantity: "5" };
    expect(resolveSampling({ sampling: "FULL", rule: null }, "sample")).toEqual(
      { mode: "full" },
    );
    expect(resolveSampling({ sampling: "SAMPLE", rule }, "full")).toEqual({
      mode: "sample",
      rule,
    });
  });

  it("«as the setting» and no plan follow the setting; sample has no size", () => {
    for (const plan of [{ sampling: "DEFAULT" as const, rule: null }, null]) {
      expect(resolveSampling(plan, "full")).toEqual({ mode: "full" });
      expect(resolveSampling(plan, "sample")).toEqual({
        mode: "sample",
        rule: null,
      });
    }
    // An unknown stored value reads as the default (full).
    expect(resolveSampling(null, "otra")).toEqual({ mode: "full" });
  });
});

describe("size of a sample", () => {
  it("a fixed amount, never more than there is", () => {
    const rule = { kind: "FIXED" as const, quantity: "10" };
    expect(sampleSize(rule, "500", "1").toString()).toBe("10");
    expect(sampleSize(rule, "4", "1").toString()).toBe("4");
    expect(sampleSize(rule, "0", "1").toString()).toBe("0");
  });

  it("a percentage rounded up to the step, between minimum and cap", () => {
    const rule = {
      kind: "PERCENT" as const,
      percent: 10,
      min: "5",
      max: "30",
    };
    expect(sampleSize(rule, "500", "1").toString()).toBe("30"); // 50 → cap
    expect(sampleSize(rule, "101", "1").toString()).toBe("11"); // 10.1 → 11
    expect(sampleSize(rule, "20", "1").toString()).toBe("5"); // 2 → minimum
    expect(sampleSize(rule, "3", "1").toString()).toBe("3"); // all there is
    const noCap = { ...rule, max: null };
    expect(sampleSize(noCap, "1000", "1").toString()).toBe("100");
  });

  it("measures keep the step of the product, exactly", () => {
    const rule = {
      kind: "PERCENT" as const,
      percent: 2,
      min: "0.5",
      max: null,
    };
    // 2 % of 512.3 kg = 10.246 → 10.25 with a step of 0.01.
    expect(sampleSize(rule, "512.3", "0.01").toString()).toBe("10.25");
    expect(sampleSize(rule, "10", "0.01").toString()).toBe("0.5");
  });
});

describe("check points as typed", () => {
  it("needs a name and a kind", () => {
    expect(parsePoint({ label: " ", kind: "CHECK" })).toMatchObject({
      ok: false,
      field: "label",
    });
    expect(parsePoint({ label: "x".repeat(81), kind: "CHECK" })).toMatchObject({
      ok: false,
      field: "label",
    });
    expect(parsePoint({ label: "Color", kind: "OTRO" })).toMatchObject({
      ok: false,
      field: "kind",
    });
  });

  it("yes or no and text carry nothing else", () => {
    expect(
      parsePoint({
        label: "  Sin   golpes ",
        kind: "CHECK",
        required: true,
        photo: true,
        minValue: "3",
        passOptions: "A",
      }),
    ).toEqual({
      ok: true,
      point: {
        label: "Sin golpes",
        kind: "CHECK",
        required: true,
        photo: true,
        minValue: null,
        maxValue: null,
        unitLabel: null,
        options: [],
      },
    });
  });

  it("a number has a minimum, a maximum or both, in order", () => {
    expect(parsePoint({ label: "Largo", kind: "NUMBER" })).toMatchObject({
      ok: false,
      field: "range",
    });
    expect(
      parsePoint({
        label: "Largo",
        kind: "NUMBER",
        minValue: "5",
        maxValue: "2",
      }),
    ).toMatchObject({ ok: false, field: "range" });
    expect(
      parsePoint({ label: "Largo", kind: "NUMBER", minValue: "1.23456" }),
    ).toMatchObject({ ok: false, field: "range" });
    expect(
      parsePoint({
        label: "Temperatura",
        kind: "NUMBER",
        minValue: "-18",
        maxValue: "-2.5",
        unitLabel: "°C",
      }),
    ).toMatchObject({
      ok: true,
      point: { minValue: "-18", maxValue: "-2.5", unitLabel: "°C" },
    });
    expect(
      parsePoint({ label: "Peso", kind: "NUMBER", maxValue: "10" }),
    ).toMatchObject({ ok: true, point: { minValue: null, maxValue: "10" } });
  });

  it("a list has two options or more, at least one that passes", () => {
    expect(
      parsePoint({
        label: "Acabado",
        kind: "CHOICE",
        failOptions: "Malo\nRoto",
      }),
    ).toMatchObject({ ok: false, field: "options" });
    expect(
      parsePoint({ label: "Acabado", kind: "CHOICE", passOptions: "Bueno" }),
    ).toMatchObject({ ok: false, field: "options" });
    const many = Array.from({ length: 21 }, (_, i) => `Opción ${i}`).join("\n");
    expect(
      parsePoint({ label: "Acabado", kind: "CHOICE", passOptions: many }),
    ).toMatchObject({ ok: false, field: "options" });
    // Repeated options (without capitals or accents) count once.
    expect(
      parsePoint({
        label: "Acabado",
        kind: "CHOICE",
        passOptions: "Bueno\n\nbueno\nRegular",
        failOptions: "Malo\nmalo",
      }),
    ).toMatchObject({
      ok: true,
      point: {
        options: [
          { label: "Bueno", acceptable: true },
          { label: "Regular", acceptable: true },
          { label: "Malo", acceptable: false },
        ],
      },
    });
  });

  it("reads range numbers without floating point", () => {
    expect(parseRangeValue("")).toEqual({ ok: true, value: null });
    expect(parseRangeValue("0.1")).toEqual({ ok: true, value: "0.1" });
    expect(parseRangeValue("abc")).toMatchObject({ ok: false });
  });
});

describe("judging an answer (for WMS-30B)", () => {
  const point = (over: Partial<PlanPoint>): PlanPoint => ({
    id: "p",
    label: "Punto",
    kind: "CHECK",
    required: true,
    photo: false,
    minValue: null,
    maxValue: null,
    unitLabel: null,
    options: [],
    ...over,
  });

  it("yes or no", () => {
    expect(judgeAnswer(point({}), "yes")).toEqual({ ok: true, result: "pass" });
    expect(judgeAnswer(point({}), "no")).toEqual({ ok: true, result: "fail" });
    expect(judgeAnswer(point({}), "tal vez")).toMatchObject({ ok: false });
  });

  it("a number inside its range, ends included", () => {
    const range = point({ kind: "NUMBER", minValue: "2", maxValue: "2.5" });
    expect(judgeAnswer(range, "2")).toEqual({ ok: true, result: "pass" });
    expect(judgeAnswer(range, "2.5")).toEqual({ ok: true, result: "pass" });
    expect(judgeAnswer(range, "2.5001")).toEqual({ ok: true, result: "fail" });
    expect(judgeAnswer(range, "1.9999")).toEqual({ ok: true, result: "fail" });
    expect(judgeAnswer(range, "")).toMatchObject({ ok: false });
    const atMost = point({ kind: "NUMBER", maxValue: "10" });
    expect(judgeAnswer(atMost, "-50")).toEqual({ ok: true, result: "pass" });
  });

  it("an option, and a text is only noted", () => {
    const list = point({
      kind: "CHOICE",
      options: [
        { id: "a", label: "Bueno", acceptable: true },
        { id: "b", label: "Malo", acceptable: false },
      ],
    });
    expect(judgeAnswer(list, "a")).toEqual({ ok: true, result: "pass" });
    expect(judgeAnswer(list, "b")).toEqual({ ok: true, result: "fail" });
    expect(judgeAnswer(list, "c")).toMatchObject({ ok: false });
    expect(judgeAnswer(point({ kind: "TEXT" }), "Sin novedad")).toEqual({
      ok: true,
      result: "noted",
    });
  });
});

describe("findings of the review (WMS-30A)", () => {
  const point = (over: Partial<PlanPoint>): PlanPoint => ({
    id: "p",
    label: "Punto",
    kind: "CHECK",
    required: true,
    photo: false,
    minValue: null,
    maxValue: null,
    unitLabel: null,
    options: [],
    ...over,
  });

  it("a fixed sample and the minimum go up to the step of the product", () => {
    expect(
      sampleSize({ kind: "FIXED", quantity: "2.5" }, "100", "1").toString(),
    ).toBe("3");
    expect(
      sampleSize(
        { kind: "PERCENT", percent: 1, min: "1.5", max: "4.2" },
        "100",
        "1",
      ).toString(),
    ).toBe("2");
    expect(
      sampleSize(
        { kind: "PERCENT", percent: 100, min: "1", max: "4.2" },
        "100",
        "1",
      ).toString(),
    ).toBe("5");
  });

  it("an empty answer: refused when required, skipped when not", () => {
    for (const kind of ["CHECK", "NUMBER", "CHOICE", "TEXT"] as const) {
      expect(judgeAnswer(point({ kind }), "  "), kind).toEqual({
        ok: false,
        error: "Este punto es obligatorio.",
      });
      expect(judgeAnswer(point({ kind, required: false }), ""), kind).toEqual({
        ok: true,
        result: "skipped",
      });
    }
  });

  it("answers keep up to 10 decimals and never read a comma", () => {
    const range = point({ kind: "NUMBER", minValue: "0.5", maxValue: "0.5" });
    expect(judgeAnswer(range, "0.50000001")).toEqual({
      ok: true,
      result: "fail",
    });
    expect(judgeAnswer(range, "0,500")).toMatchObject({ ok: false });
    expect(parseRangeValue("1,250")).toMatchObject({ ok: false });
  });

  it("the same option in both lists is refused", () => {
    expect(
      parsePoint({
        label: "Color",
        kind: "CHOICE",
        passOptions: "Azul\nVerde",
        failOptions: "AZUL",
      }),
    ).toMatchObject({ ok: false, field: "options" });
  });
});
