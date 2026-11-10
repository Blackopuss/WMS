import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEVEL_NAMES,
  canContain,
  compareLocationNames,
  fitProblem,
  formatLocationPath,
  isLocationType,
  levelsInside,
  locationPath,
  normalizeLevelName,
  normalizeLocationCode,
} from "./levels";

// WMS-22A (ADR 0036): levels named by each warehouse, in order.

const six = ["Nave", "Zona", "Pasillo", "Rack", "Nivel", "Posición"].map(
  (name, index) => ({ depth: index + 1, name }),
);
const [nave, , pasillo, rack, , posicion] = six;

describe("levels", () => {
  it("a location only goes inside a wider level, never in General", () => {
    expect(canContain(nave!, rack!)).toBe(true);
    expect(canContain(rack!, pasillo!)).toBe(false);
    expect(canContain(rack!, rack!)).toBe(false);
    expect(canContain(null, rack!)).toBe(false);
  });

  it("offers what fits: everything in the warehouse, finer levels inside", () => {
    expect(levelsInside(six, "warehouse")).toHaveLength(6);
    expect(levelsInside(six, rack!).map((level) => level.name)).toEqual([
      "Nivel",
      "Posición",
    ]);
    expect(levelsInside(six, posicion!)).toEqual([]);
    expect(levelsInside(six, null)).toEqual([]);
  });

  it("explains why something does not fit", () => {
    expect(fitProblem(rack!, posicion!, 6)).toBeNull();
    expect(fitProblem(null, rack!, 6)).toMatch(/General/);
    expect(fitProblem(posicion!, rack!, 6)).toMatch(/último nivel/);
    expect(fitProblem(rack!, pasillo!, 6)).toMatch(
      /nivel «Pasillo» no puede ir dentro de una de nivel «Rack»/,
    );
  });

  it("starts a warehouse with the usual three", () => {
    expect(DEFAULT_LEVEL_NAMES).toEqual(["Zona", "Pasillo", "Estante"]);
  });

  it("checks level names", () => {
    expect(normalizeLevelName("  Rack ")).toEqual({ ok: true, name: "Rack" });
    expect(normalizeLevelName("")).toMatchObject({ ok: false });
    expect(normalizeLevelName("a\tb")).toMatchObject({ ok: false });
    expect(normalizeLevelName("x".repeat(41))).toMatchObject({ ok: false });
  });
});

describe("codes and types", () => {
  it("keeps codes in upper case, without spaces", () => {
    expect(normalizeLocationCode(" a-01-03 ")).toEqual({
      ok: true,
      code: "A-01-03",
    });
    expect(normalizeLocationCode("")).toEqual({ ok: true, code: null });
    expect(normalizeLocationCode("A 01")).toMatchObject({ ok: false });
    expect(normalizeLocationCode("-A")).toMatchObject({ ok: false });
    expect(normalizeLocationCode("A".repeat(31))).toMatchObject({ ok: false });
  });

  it("knows the kinds of use", () => {
    expect(isLocationType("STAGING")).toBe(true);
    expect(isLocationType("staging")).toBe(false);
    expect(isLocationType(undefined)).toBe(false);
  });
});

describe("paths", () => {
  it("joins the names from the root, as deep as needed", () => {
    expect(formatLocationPath(["Zona A", "Pasillo 2"])).toBe(
      "Zona A › Pasillo 2",
    );
    const chain = six.reduce<{ name: string; parent: unknown } | null>(
      (parent, level) => ({ name: `${level.name} 1`, parent }),
      null,
    );
    expect(locationPath(chain as never)).toBe(
      "Nave 1 › Zona 1 › Pasillo 1 › Rack 1 › Nivel 1 › Posición 1",
    );
  });

  it("orders names like people do", () => {
    expect(compareLocationNames("Pasillo 2", "Pasillo 10")).toBeLessThan(0);
  });
});
