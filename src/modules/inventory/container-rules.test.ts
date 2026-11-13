import { describe, expect, it } from "vitest";

import {
  containerName,
  formatContainerNumber,
  newContainerCode,
  normalizeContainerCode,
  normalizeContainerKind,
  parseWeightKg,
  weightText,
  theContainer,
} from "./container-rules";

describe("container rules (WMS-53)", () => {
  it("numbers containers like tasks and orders, with their own prefix", () => {
    expect(formatContainerNumber(1)).toBe("C-0001");
    expect(formatContainerNumber(12345)).toBe("C-12345");
  });

  it("reads a label as scanned or typed", () => {
    expect(normalizeContainerCode("  lpn  77 ")).toEqual({
      ok: true,
      code: "LPN 77",
    });
    expect(normalizeContainerCode("c-0001")).toEqual({
      ok: true,
      code: "C-0001",
    });
    expect(normalizeContainerCode("")).toMatchObject({ ok: false });
    expect(normalizeContainerCode("A".repeat(41))).toMatchObject({
      ok: false,
    });
    expect(normalizeContainerCode("<tarima>")).toMatchObject({ ok: false });
  });

  it("a typed label never takes the shape of the system's codes", () => {
    expect(newContainerCode("C-0099")).toMatchObject({ ok: false });
    expect(newContainerCode("C-9A")).toEqual({ ok: true, code: "C-9A" });
    expect(newContainerCode("PAL-0099")).toEqual({
      ok: true,
      code: "PAL-0099",
    });
  });

  it("the kind is free text, «Tarima» by default", () => {
    expect(normalizeContainerKind("")).toEqual({ ok: true, kind: "Tarima" });
    expect(normalizeContainerKind("  caja  chica ")).toEqual({
      ok: true,
      kind: "Caja chica",
    });
    expect(normalizeContainerKind("x".repeat(41))).toMatchObject({
      ok: false,
    });
    expect(containerName({ kind: "Caja", code: "C-0002" })).toBe("Caja C-0002");
    expect(theContainer({ kind: "Tarima", code: "C-0001" })).toBe(
      "la tarima C-0001",
    );
    expect(theContainer({ kind: "Contenedor", code: "X" })).toBe(
      "el contenedor X",
    );
  });

  it("a package weighs kilos with up to three decimals, or nothing (WMS-15)", () => {
    expect(parseWeightKg("")).toEqual({ ok: true, weight: null });
    expect(parseWeightKg(" 12,50 kg")).toEqual({ ok: true, weight: "12.5" });
    expect(parseWeightKg("007.250")).toEqual({ ok: true, weight: "7.25" });
    expect(parseWeightKg("0")).toMatchObject({ ok: false });
    expect(parseWeightKg("0.000")).toMatchObject({ ok: false });
    expect(parseWeightKg("1.2345")).toMatchObject({ ok: false });
    expect(parseWeightKg("-3")).toMatchObject({ ok: false });
    expect(parseWeightKg("1e3")).toMatchObject({ ok: false });
    expect(weightText("1250.5")).toBe("1,250.5 kg");
    expect(weightText("12.500")).toBe("12.5 kg");
  });
});
