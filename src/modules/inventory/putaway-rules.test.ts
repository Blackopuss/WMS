import { describe, expect, it } from "vitest";

import {
  putawayPreferenceOf,
  rankPutawayPlaces,
  type PlaceFacts,
} from "./putaway-rules";

const place = (id: string, facts: Partial<PlaceFacts> = {}): PlaceFacts => ({
  id,
  readingOrder: 0,
  units: "0",
  sameProduct: false,
  sameLot: false,
  sameCategory: false,
  ...facts,
});

// A known scenario (WMS-52): an empty shelf, one with the same lot, one
// with another lot of the product, one with its category, one full.
const scenario = [
  place("empty", { readingOrder: 0, units: "0" }),
  place("full", { readingOrder: 1, units: "900" }),
  place("category", { readingOrder: 2, units: "40", sameCategory: true }),
  place("otherLot", { readingOrder: 3, units: "70", sameProduct: true }),
  place("sameLot", {
    readingOrder: 4,
    units: "120",
    sameProduct: true,
    sameLot: true,
  }),
];

describe("rankPutawayPlaces", () => {
  it("together: same lot, same product, category, then the emptiest", () => {
    expect(rankPutawayPlaces(scenario, "together").map((p) => p.id)).toEqual([
      "sameLot",
      "otherLot",
      "category",
      "empty",
      "full",
    ]);
  });

  it("emptiest: only by what each place holds", () => {
    expect(rankPutawayPlaces(scenario, "emptiest").map((p) => p.id)).toEqual([
      "empty",
      "category",
      "otherLot",
      "sameLot",
      "full",
    ]);
  });

  it("inside a group, more room first; then reading order, then id", () => {
    const ranked = rankPutawayPlaces(
      [
        place("b", { readingOrder: 2, units: "10", sameProduct: true }),
        place("a", { readingOrder: 1, units: "10", sameProduct: true }),
        place("c", { readingOrder: 1, units: "10", sameProduct: true }),
        place("d", { readingOrder: 0, units: "5.5", sameProduct: true }),
      ],
      "together",
    );
    expect(ranked.map((p) => p.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("does not change the list it receives", () => {
    const list = [place("x", { units: "2" }), place("y", { units: "1" })];
    rankPutawayPlaces(list, "emptiest");
    expect(list.map((p) => p.id)).toEqual(["x", "y"]);
  });

  it("an unknown stored preference reads as the default", () => {
    expect(putawayPreferenceOf("emptiest")).toBe("emptiest");
    expect(putawayPreferenceOf("fefo")).toBe("together");
  });
});
