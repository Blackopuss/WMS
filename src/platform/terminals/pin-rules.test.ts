import { describe, expect, it } from "vitest";

import { isPinShape, isTrivialPin, pinProblem } from "./pin-rules";

// WMS-38 (ADR 0061 §3): easy PINs are refused.

describe("PIN rules", () => {
  it("refuses repeated digits, staircases and repeated blocks", () => {
    for (const pin of [
      "0000",
      "999999",
      "1234",
      "123456",
      "654321",
      "890123",
      "3210",
      "1212",
      "121212",
      "123123",
    ]) {
      expect(isTrivialPin(pin), pin).toBe(true);
    }
  });

  it("accepts PINs without a pattern", () => {
    for (const pin of ["4829", "482915", "73026", "102938"]) {
      expect(isTrivialPin(pin), pin).toBe(false);
    }
  });

  it("says what is wrong, ready to show", () => {
    expect(pinProblem("48a915", 6)).toBe("El PIN lleva solo números.");
    expect(pinProblem("4829", 6)).toBe("El PIN lleva 6 números.");
    expect(pinProblem("123456", 6)).toMatch(/fácil de adivinar/);
    expect(pinProblem("482915", 6)).toBeNull();
    expect(pinProblem("4829", 4)).toBeNull();
  });

  it("a terminal takes 4 to 6 digits", () => {
    expect(isPinShape("4829")).toBe(true);
    expect(isPinShape("482915")).toBe(true);
    expect(isPinShape("482")).toBe(false);
    expect(isPinShape("4829156")).toBe(false);
    expect(isPinShape("48 29")).toBe(false);
  });
});
