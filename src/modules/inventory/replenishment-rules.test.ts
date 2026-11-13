import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import {
  floorToMultiple,
  isBelowMinimum,
  largestThatFits,
  replenishQuantity,
  replenishmentStateOf,
  splitAmongSources,
} from "./replenishment-rules";
import { rankStockSources } from "./stock-sources";

// WMS-23/24 (ADR 0051): the pure pieces of the decision.

const rule = { min: dec(10), max: dec(40), multiple: dec(12) };

describe("replenishQuantity", () => {
  it("brings nothing while what is there reaches the minimum", () => {
    expect(replenishQuantity(rule, dec(10), dec(0)).toString()).toBe("0");
    expect(isBelowMinimum(rule, dec(10), dec(0))).toBe(false);
  });

  it("fills up to the maximum in whole multiples", () => {
    // 40 − 4 = 36 → three boxes of 12.
    expect(replenishQuantity(rule, dec(4), dec(0)).toString()).toBe("36");
    // 40 − 7 = 33 → two boxes (24), never above the maximum.
    expect(replenishQuantity(rule, dec(7), dec(0)).toString()).toBe("24");
  });

  it("counts what is already on its way", () => {
    expect(replenishQuantity(rule, dec(2), dec(12)).toString()).toBe("0");
    expect(replenishQuantity(rule, dec(0), dec(5)).toString()).toBe("24");
  });

  it("without a multiple, exactly what is missing", () => {
    const loose = { ...rule, multiple: null };
    expect(replenishQuantity(loose, dec(3), dec(0)).toString()).toBe("37");
  });

  it("rounds down to a multiple, never below zero", () => {
    expect(floorToMultiple(dec(35), dec(12)).toString()).toBe("24");
    expect(floorToMultiple(dec(5), dec(12)).toString()).toBe("0");
    expect(floorToMultiple(dec(-3), dec(12)).toString()).toBe("0");
    expect(floorToMultiple(dec("2.5"), null).toString()).toBe("2.5");
  });
});

describe("largestThatFits", () => {
  it("finds the largest amount a capacity admits", async () => {
    const asked: number[] = [];
    const fits = async (k: number) => {
      asked.push(k);
      return k * 12 <= 30;
    };
    expect(await largestThatFits(3, fits)).toBe(2);
    expect(asked.length).toBeLessThanOrEqual(3);
  });

  it("asks once when everything fits, and gives 0 when nothing does", async () => {
    let calls = 0;
    expect(
      await largestThatFits(1_000, async () => {
        calls += 1;
        return true;
      }),
    ).toBe(1_000);
    expect(calls).toBe(1);
    expect(await largestThatFits(1_000, async () => false)).toBe(0);
    expect(await largestThatFits(0, async () => true)).toBe(0);
  });
});

describe("splitAmongSources", () => {
  const source = (place: string, free: string) => ({
    place,
    free: dec(free),
  });
  const byPlace = (s: { place: string }) => s.place;

  it("takes whole multiples from each origin, in order", () => {
    const parts = splitAmongSources(
      [source("A", "18"), source("B", "30")],
      dec(36),
      dec(12),
      byPlace,
      new Map(),
    );
    expect(parts.map((p) => [p.source.place, p.quantity.toString()])).toEqual([
      ["A", "12"],
      ["B", "24"],
    ]);
  });

  it("shares what a place can give between its lots", () => {
    const parts = splitAmongSources(
      [source("A", "10"), source("A", "10")],
      dec(20),
      null,
      byPlace,
      new Map([["A", dec(12)]]),
    );
    expect(parts.map((p) => p.quantity.toString())).toEqual(["10", "2"]);
  });

  it("takes what there is when no origin has a whole multiple", () => {
    const parts = splitAmongSources(
      [source("A", "5"), source("B", "3")],
      dec(24),
      dec(12),
      byPlace,
      new Map(),
    );
    expect(parts.map((p) => p.quantity.toString())).toEqual(["5", "3"]);
  });

  it("gives nothing without stock", () => {
    expect(splitAmongSources([], dec(24), dec(12), byPlace, new Map())).toEqual(
      [],
    );
  });
});

describe("replenishmentStateOf", () => {
  const facts = {
    valid: true,
    rule,
    here: dec(4),
    coming: dec(0),
    bring: dec(0),
    blockedBy: null,
  } as const;

  it("names each case", () => {
    expect(replenishmentStateOf({ ...facts, valid: false })).toBe("review");
    expect(replenishmentStateOf({ ...facts, here: dec(10) })).toBe("ok");
    expect(replenishmentStateOf({ ...facts, coming: dec(12) })).toBe("coming");
    expect(replenishmentStateOf({ ...facts, bring: dec(36) })).toBe("due");
    expect(replenishmentStateOf({ ...facts, blockedBy: "room" })).toBe(
      "no_room",
    );
    expect(replenishmentStateOf({ ...facts, blockedBy: "stock" })).toBe(
      "no_stock",
    );
  });
});

describe("rankStockSources", () => {
  const row = (
    locationId: string,
    quantity: string,
    lotId: string | null = null,
    expiresOn: string | null = null,
  ) => ({ locationId, lotId, expiresOn, quantity: dec(quantity) });

  it("what expires first leaves first, whatever the company chose", () => {
    const rows = [
      row("full", "90", "lot-b", "2027-06-01"),
      row("small", "5", "lot-a", "2027-01-01"),
      row("nodate", "200", "lot-c", null),
    ];
    for (const strategy of ["fullest", "emptiest", "fifo"]) {
      expect(rankStockSources(rows, strategy).map((r) => r.locationId)).toEqual(
        ["small", "full", "nodate"],
      );
    }
  });

  it("follows the company's choice for the rest", () => {
    const rows = [row("a", "10"), row("b", "50"), row("c", "30")];
    expect(rankStockSources(rows, "fullest").map((r) => r.locationId)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(rankStockSources(rows, "emptiest").map((r) => r.locationId)).toEqual(
      ["a", "c", "b"],
    );
    // An unknown value reads as the default (fullest).
    expect(rankStockSources(rows, "x").map((r) => r.locationId)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("FIFO takes the oldest lot first", () => {
    const rows = [row("a", "50", "lot-2"), row("b", "10", "lot-1")];
    expect(rankStockSources(rows, "fifo").map((r) => r.locationId)).toEqual([
      "b",
      "a",
    ]);
  });
});
