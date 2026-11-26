import { describe, expect, it } from "vitest";

import { documentNumber, documentNumberQuery } from "./numbers";

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

/** Whether `n` fits the query (for the tests). */
const fits = (query: ReturnType<typeof documentNumberQuery>, n: number) =>
  query !== null &&
  (query.any ||
    query.exact === n ||
    query.ranges.some((range) => n >= range.from && n <= range.to));

describe("documentNumberQuery", () => {
  it("takes the numbers whose shown digits start with what was typed", () => {
    const query = documentNumberQuery("INC", "INC-000");
    expect(query?.exact).toBeNull();
    for (const n of [1, 5, 9]) expect(fits(query, n)).toBe(true);
    for (const n of [10, 100, 1000]) expect(fits(query, n)).toBe(false);

    const twelve = documentNumberQuery("PS", "ps 12");
    expect(twelve?.exact).toBe(12);
    expect(twelve?.complete).toBe(false);
    for (const n of [12, 1200, 1299, 12000, 12999]) {
      expect(fits(twelve, n)).toBe(true);
    }
    for (const n of [13, 120, 1300, 13000]) expect(fits(twelve, n)).toBe(false);
  });

  it("knows a complete number, as printed", () => {
    const query = documentNumberQuery("PS", "PS-0012");
    expect(query?.exact).toBe(12);
    expect(query?.complete).toBe(true);
    expect(fits(query, 120)).toBe(false);
    expect(fits(query, 12)).toBe(true);
  });

  it("takes only the letters as every document of that kind", () => {
    expect(documentNumberQuery("INC", "inc")?.any).toBe(true);
    expect(documentNumberQuery("T", "T-")?.any).toBe(true);
    // A single letter alone is too common as a word.
    expect(documentNumberQuery("T", "t")).toBeNull();
  });

  it("refuses what is not a number of that kind", () => {
    expect(documentNumberQuery("PS", "OC-0012")).toBeNull();
    expect(documentNumberQuery("PS", "PS-12a")).toBeNull();
    expect(documentNumberQuery("T", "TR-0001")).toBeNull();
    expect(documentNumberQuery("PS", "PS-99999999999")).toBeNull();
  });
});
