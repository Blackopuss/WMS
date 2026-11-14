import { describe, expect, it } from "vitest";

import { isPinShape, isTrivialPin, pinProblem } from "./pin-rules";

// WMS-38 (ADR 0061 §3): easy PINs are refused.

describe("PIN rules", () => {
  it("refuses repeated digits, staircases and repeated blocks", () => {
    for (const pin of [
      "00000",
      "999999",
      "12345",
      "123456",
      "654321",
      "890123",
      "43210",
      "121212",
      "123123",
      // Years and dates.
      "198712",
      "042019",
      "19850",
      "250388",
      "031288",
      "880325",
      // Shapes on the keypad and doubled staircases (WMS-38 review).
      "147258",
      "159753",
      "789456",
      "258369",
      "14725",
      "112233",
      "998877",
      "111222",
    ]) {
      expect(isTrivialPin(pin), pin).toBe(true);
    }
  });

  it("accepts PINs without a pattern", () => {
    for (const pin of ["48291", "482915", "73026", "849302"]) {
      expect(isTrivialPin(pin), pin).toBe(false);
    }
  });

  it("says what is wrong, ready to show", () => {
    expect(pinProblem("48a915", 6)).toBe("El PIN lleva solo números.");
    expect(pinProblem("48291", 6)).toBe("El PIN lleva 6 números.");
    expect(pinProblem("123456", 6)).toMatch(/fácil de adivinar/);
    expect(pinProblem("482915", 6)).toBeNull();
    expect(pinProblem("48291", 5)).toBeNull();
  });

  it("a terminal takes 5 to 6 digits", () => {
    expect(isPinShape("4829")).toBe(false);
    expect(isPinShape("48291")).toBe(true);
    expect(isPinShape("482915")).toBe(true);
    expect(isPinShape("482")).toBe(false);
    expect(isPinShape("4829156")).toBe(false);
    expect(isPinShape("48 29")).toBe(false);
  });
});
