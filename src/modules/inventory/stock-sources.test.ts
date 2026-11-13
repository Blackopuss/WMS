import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import { rankStockSources, type StockSourceRow } from "./stock-sources";

// WMS-21A/24/25: what expires first leaves first, always; between equals,
// a picking location goes first (ADR 0054); then the company's choice.

const row = (
  locationId: string,
  quantity: string,
  extra: Partial<StockSourceRow> = {},
): StockSourceRow => ({
  locationId,
  lotId: null,
  expiresOn: null,
  quantity: dec(quantity),
  ...extra,
});

const order = (rows: StockSourceRow[], strategy = "fullest") =>
  rankStockSources(rows, strategy).map((r) => r.locationId);

describe("stock sources", () => {
  it("without picking locations, the order is the company's choice", () => {
    const rows = [row("a", "5"), row("b", "20"), row("c", "10")];
    expect(order(rows)).toEqual(["b", "c", "a"]);
    expect(order(rows, "emptiest")).toEqual(["a", "c", "b"]);
    const stored = rows.map((r) => ({ ...r, usage: "STORAGE" }));
    expect(order(stored)).toEqual(["b", "c", "a"]);
  });

  it("a picking location goes first between equals", () => {
    const rows = [
      row("rack", "50", { usage: "STORAGE" }),
      row("face", "4", { usage: "PICKING" }),
      row("rack2", "30", { usage: "STORAGE" }),
    ];
    expect(order(rows)).toEqual(["face", "rack", "rack2"]);
    expect(order(rows, "emptiest")).toEqual(["face", "rack2", "rack"]);
  });

  it("what expires first still leaves first", () => {
    const rows = [
      row("face", "10", {
        usage: "PICKING",
        lotId: "0002",
        expiresOn: "2027-06-01",
      }),
      row("rack", "10", {
        usage: "STORAGE",
        lotId: "0001",
        expiresOn: "2027-03-01",
      }),
      row("face-same", "3", {
        usage: "PICKING",
        lotId: "0001",
        expiresOn: "2027-03-01",
      }),
    ];
    // The lot of March first (in the picking place first), then June.
    expect(order(rows)).toEqual(["face-same", "rack", "face"]);
  });

  it("with FIFO the older lot goes first, then the picking place", () => {
    const rows = [
      row("face", "10", { usage: "PICKING", lotId: "0002" }),
      row("rack", "10", { usage: "STORAGE", lotId: "0001" }),
      row("face-old", "1", { usage: "PICKING", lotId: "0001" }),
    ];
    expect(order(rows, "fifo")).toEqual(["face-old", "rack", "face"]);
  });
});
