import { describe, expect, it } from "vitest";

import { documentNumber } from "./numbers";

describe("documentNumber", () => {
  it("reads the number however it is typed", () => {
    expect(documentNumber("PS", "PS-0012")).toBe(12);
    expect(documentNumber("PS", " ps 12 ")).toBe(12);
    expect(documentNumber("PS", "PS12")).toBe(12);
    expect(documentNumber("INC", "inc-0003")).toBe(3);
  });

  it("refuses what is not a number of that kind", () => {
    expect(documentNumber("PS", "OC-0012")).toBeNull();
    expect(documentNumber("PS", "PS-")).toBeNull();
    expect(documentNumber("PS", "PS-0")).toBeNull();
    expect(documentNumber("PS", "PS-12a")).toBeNull();
    expect(documentNumber("PS", "PS-99999999999")).toBeNull();
    expect(documentNumber("T", "TR-0001")).toBeNull();
    expect(documentNumber("P.S", "P.S1")).toBeNull();
  });
});
