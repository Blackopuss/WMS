import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import {
  activationProblems,
  costSharesProblem,
  findRecipeCycle,
  parsePercent,
} from "./recipe-rules";

// WMS-27 (ADR 0066): the rules of a recipe that need no database.

describe("percents", () => {
  const scrap = { optional: true, max: 100, below: true, what: "la merma" };
  const share = { optional: false, max: 100, what: "la parte del costo" };

  it("reads up to two decimals, exactly", () => {
    const parsed = parsePercent("2.5", scrap);
    expect(parsed.ok && parsed.value?.toString()).toBe("2.5");
    const third = parsePercent("33.33 %", share);
    expect(third.ok && third.value?.toString()).toBe("33.33");
  });

  it("empty is nothing when optional, and an error when not", () => {
    expect(parsePercent(" ", scrap)).toEqual({ ok: true, value: null });
    expect(parsePercent("", share)).toEqual({
      ok: false,
      error: "Escribe la parte del costo.",
    });
  });

  it("refuses letters, negatives, three decimals and what is too much", () => {
    for (const text of ["abc", "-1", "1.234", "1e2"]) {
      expect(parsePercent(text, share).ok, text).toBe(false);
    }
    expect(parsePercent("100", share).ok).toBe(true);
    expect(parsePercent("100.01", share).ok).toBe(false);
    // Scrap stays under 100: losing everything is not a recipe.
    expect(parsePercent("100", scrap).ok).toBe(false);
    expect(parsePercent("99.99", scrap).ok).toBe(true);
    expect(parsePercent("0", scrap).ok).toBe(true);
  });
});

describe("shares of the cost", () => {
  it("must add up to exactly 100, without floating point", () => {
    expect(costSharesProblem(["100"])).toBeNull();
    expect(costSharesProblem(["33.33", "33.33", "33.34"])).toBeNull();
    expect(costSharesProblem(["70", "30", "0"])).toBeNull();
    // 0.1 + 0.2 is not 0.3 in floating point; here it is.
    expect(costSharesProblem(["99.7", "0.1", "0.2"])).toBeNull();
    expect(costSharesProblem(["33.33", "33.33", "33.33"])).toMatch(
      /suman 99.99 %/,
    );
    expect(costSharesProblem(["60", "60"])).toMatch(/suman 120 %/);
  });

  it("«0.25 kg por 100 piezas» is kept exact", () => {
    // The recipe goes by base quantity: per piece it would not fit in
    // three decimals, and multiplying back gives exactly what was written.
    const perPiece = dec("0.25").dividedBy(100);
    expect(perPiece.toString()).toBe("0.0025");
    expect(perPiece.decimalPlaces()).toBeGreaterThan(3);
    expect(dec("0.25").times(dec(1000).dividedBy(100)).toString()).toBe("2.5");
  });
});

describe("what stops a draft from being activated", () => {
  const line = (productId: string, extra = {}) => ({
    productId,
    name: productId.toUpperCase(),
    archived: false,
    unitChanged: false,
    ...extra,
  });
  const base = {
    ownerProductId: "crate",
    ownerName: "Crate",
    ownerUnitChanged: false,
    inputs: [line("tabla"), line("pija")],
    outputs: [{ ...line("crate"), costShare: "100" }],
  };

  it("a complete recipe has no problems", () => {
    expect(activationProblems(base)).toEqual([]);
  });

  it("asks for materials, outputs and the product of the card", () => {
    expect(activationProblems({ ...base, inputs: [] })).toContain(
      "Agrega al menos un material.",
    );
    expect(activationProblems({ ...base, outputs: [] }).join(" ")).toMatch(
      /Lo que sale/,
    );
    expect(
      activationProblems({
        ...base,
        outputs: [{ ...line("otro"), costShare: "100" }],
      }),
    ).toContain("Crate debe estar en los materiales o en «Lo que sale».");
  });

  it("allows taking apart: the product of the card is the material", () => {
    expect(
      activationProblems({
        ...base,
        ownerProductId: "kit",
        ownerName: "Kit",
        inputs: [line("kit")],
        outputs: [
          { ...line("a"), costShare: "40" },
          { ...line("b"), costShare: "60" },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses archived products, changed units, a product on both sides and shares", () => {
    const problems = activationProblems({
      ...base,
      ownerUnitChanged: true,
      inputs: [
        line("tabla", { archived: true }),
        line("pija", { unitChanged: true }),
        line("crate"),
      ],
      outputs: [{ ...line("crate"), costShare: "90" }],
    });
    expect(problems).toEqual([
      "La unidad de Crate cambió: vuelve a escribir «Para cuánto».",
      "CRATE no puede ser material y salir de la misma receta.",
      "TABLA está archivado: quítalo de la receta o reactívalo.",
      "La unidad de PIJA cambió: vuelve a escribir su cantidad.",
      "Las partes del costo de lo que sale suman 90 %: deben sumar 100 %.",
    ]);
  });
});

describe("cycles", () => {
  it("a product on both sides is a cycle by itself", () => {
    expect(findRecipeCycle(["a"], ["a"], [])).toEqual(["a", "a"]);
  });

  it("finds a direct cycle: B with A while A is made with B", () => {
    expect(findRecipeCycle(["a"], ["b"], [{ from: "b", to: "a" }])).toEqual([
      "a",
      "b",
      "a",
    ]);
  });

  it("finds an indirect one and gives the whole chain", () => {
    const edges = [
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "d", to: "a" },
      { from: "x", to: "y" },
    ];
    expect(findRecipeCycle(["a", "z"], ["b"], edges)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  it("a chain without a way back is not a cycle", () => {
    const edges = [
      { from: "b", to: "c" },
      { from: "a", to: "x" },
    ];
    expect(findRecipeCycle(["a"], ["b"], edges)).toBeNull();
    expect(findRecipeCycle([], ["b"], edges)).toBeNull();
  });

  it("taking a kit apart is not a cycle with assembling something else", () => {
    // kit → A and B (take apart); C is made with A: no way back to kit.
    const edges = [{ from: "a", to: "c" }];
    expect(findRecipeCycle(["kit"], ["a", "b"], edges)).toBeNull();
    // But making the kit with C closes kit → A → C → kit.
    expect(
      findRecipeCycle(["c"], ["kit"], [...edges, { from: "kit", to: "a" }]),
    ).toEqual(["c", "kit", "a", "c"]);
  });

  it("does not loop forever on cycles already in force", () => {
    const edges = [
      { from: "p", to: "q" },
      { from: "q", to: "p" },
    ];
    expect(findRecipeCycle(["a"], ["p"], edges)).toBeNull();
  });
});
