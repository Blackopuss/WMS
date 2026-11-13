import { describe, expect, it } from "vitest";

import {
  containerName,
  formatContainerNumber,
  newContainerCode,
  normalizeContainerCode,
  normalizeContainerKind,
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
});
