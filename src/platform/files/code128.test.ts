import { describe, expect, it } from "vitest";

import {
  CODE128_MAX_LENGTH,
  CODE128_PATTERNS,
  CODE128_STOP,
  decodeCode128,
  encodeCode128,
} from "./code128";

// WMS-26 (ADR 0047): Code 128 written here, read back here.

const encoded = (text: string) => {
  const result = encodeCode128(text);
  if (!result.ok) throw new Error(result.reason);
  return result;
};

describe("the widths table", () => {
  it("has 106 different symbols of 11 modules and a stop of 13", () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
    for (const pattern of CODE128_PATTERNS) {
      expect(pattern).toMatch(/^[1-4]{6}$/);
      expect([...pattern].reduce((sum, width) => sum + Number(width), 0)).toBe(
        11,
      );
    }
    expect([...CODE128_STOP].reduce((sum, w) => sum + Number(w), 0)).toBe(13);
  });
});

describe("encodeCode128", () => {
  it("follows the standard: start, symbols, check modulo 103, stop", () => {
    // Set B: «A» is 33, «1» is 17. Check = (104 + 33·1 + 17·2) mod 103.
    expect(encoded("A1").values).toEqual([
      104,
      33,
      17,
      (104 + 33 + 34) % 103,
      106,
    ]);
    // Set C from the start: pairs of digits.
    expect(encoded("12345678").values).toEqual([
      105,
      12,
      34,
      56,
      78,
      (105 + 12 + 34 * 2 + 56 * 3 + 78 * 4) % 103,
      106,
    ]);
    // Start B, value 1 every symbol: the first and second symbol of the
    // standard's table, bar first.
    const modules = encoded("!").modules;
    // Start B (211214), «!» (222122), check, stop (2331112).
    expect(modules.slice(0, 11).map(Number).join("")).toBe("11010010000");
    expect(modules.slice(11, 22).map(Number).join("")).toBe("11001101100");
    expect(modules.slice(-13).map(Number).join("")).toBe("1100011101011");
    // Each symbol 11 modules, the stop 13.
    expect(modules).toHaveLength(11 * 3 + 13);
  });

  it("uses set C for long runs of digits and set B around them", () => {
    // Three digits stay in set B; four at the end go to set C.
    expect(encoded("T-001").values.slice(0, -2)).toEqual([
      104, 52, 13, 16, 16, 17,
    ]);
    expect(encoded("C-0001").values.slice(0, -2)).toEqual([
      104, 35, 13, 99, 0, 1,
    ]);
    // Six digits in the middle switch to C (99) and back to B (100).
    expect(encoded("AB123456CD").values.slice(0, -2)).toEqual([
      104, 33, 34, 99, 12, 34, 56, 100, 35, 36,
    ]);
    // Four digits at the end are worth it; an odd run leaves one in B.
    expect(encoded("PS-12345").values.slice(0, -2)).toEqual([
      104, 48, 51, 13, 17, 99, 23, 45,
    ]);
    // A barcode of 13 digits: C for the first twelve, B for the last.
    expect(encoded("7501234567890").values.slice(0, -2)).toEqual([
      105, 75, 1, 23, 45, 67, 89, 100, 16,
    ]);
    // Shorter than the same text in set B.
    expect(encoded("7501234567890").modules.length).toBeLessThan(
      11 * (13 + 3) + 2,
    );
  });

  it("rejects what Code 128 sets B and C cannot hold, with a message", () => {
    expect(encodeCode128("")).toEqual({
      ok: false,
      reason: "El código está vacío.",
    });
    expect(encodeCode128("LOTE-Ñ")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("«Ñ»"),
    });
    expect(encodeCode128("café")).toMatchObject({ ok: false });
    expect(encodeCode128("A\tB")).toMatchObject({ ok: false });
    expect(encodeCode128("A".repeat(CODE128_MAX_LENGTH))).toMatchObject({
      ok: true,
    });
    expect(encodeCode128("A".repeat(CODE128_MAX_LENGTH + 1))).toMatchObject({
      ok: false,
      reason: expect.stringContaining(String(CODE128_MAX_LENGTH)),
    });
  });
});

describe("decodeCode128", () => {
  it("reads back everything it writes", () => {
    for (const text of [
      "C-0001",
      "PS-0012",
      "EM-0003",
      "A-01-03",
      "7501234567890",
      "12",
      "123",
      "1234",
      "12345",
      "TOR-001",
      "lote 2026/03 (b)",
      "AB123456CD",
      "~!@#$%^&*()_+{}|:\"<>?`-=[]\\;',./",
      "0".repeat(CODE128_MAX_LENGTH),
      "A1B2C3D4E5F6G7H8",
      "SN-000123456789",
    ]) {
      const { modules } = encoded(text);
      // With quiet zones around it, as it is drawn.
      const drawn = [
        ...Array(10).fill(false),
        ...modules,
        ...Array(10).fill(false),
      ];
      expect(decodeCode128(drawn), text).toBe(text);
    }
  });

  it("refuses a damaged symbol: wrong check, a changed bar, no stop", () => {
    const { modules } = encoded("C-0001");
    expect(decodeCode128([])).toBeNull();
    // One module flipped in the middle breaks a pattern or the check.
    const flipped = [...modules];
    flipped[30] = !flipped[30];
    expect(decodeCode128(flipped)).toBeNull();
    // Without its stop.
    expect(decodeCode128(modules.slice(0, -13))).toBeNull();
    // A data symbol swapped for another keeps the patterns but not the check.
    const other = encoded("C-0002").modules;
    const swapped = [
      ...modules.slice(0, 66),
      ...other.slice(66, 77),
      ...modules.slice(77),
    ];
    expect(decodeCode128(swapped)).toBeNull();
  });
});
