import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import {
  planCrossDock,
  rankWaitingLines,
  type CrossDockArrival,
  type WaitingLine,
} from "./cross-dock-rules";

const line = (
  lineId: string,
  facts: Omit<Partial<WaitingLine>, "waiting"> & { waiting: string },
): WaitingLine => ({
  orderId: `o-${lineId}`,
  lineId,
  productId: "p",
  urgent: false,
  dueOn: null,
  releasedAt: 0,
  number: 1,
  ...facts,
  waiting: dec(facts.waiting),
});

const arrival = (
  quantity: string,
  facts: Omit<Partial<CrossDockArrival>, "quantity"> = {},
): CrossDockArrival => ({
  productId: "p",
  lotId: null,
  expiresOn: null,
  ...facts,
  quantity: dec(quantity),
});

const plain = (plan: ReturnType<typeof planCrossDock>) => ({
  shares: plan.shares.map((share) => ({
    ...share,
    quantity: share.quantity.toString(),
  })),
  left: plan.left.map((value) => value.toString()),
});

describe("planCrossDock (WMS-54)", () => {
  it("serves the urgent order first and sends what is left to put-away", () => {
    // A known scenario: two orders wait 8 and 6; 10 arrive.
    const plan = planCrossDock(
      [arrival("10")],
      [
        line("normal", { waiting: "8", releasedAt: 1, number: 1 }),
        line("urgent", {
          waiting: "6",
          urgent: true,
          releasedAt: 2,
          number: 2,
        }),
      ],
    );
    expect(plain(plan)).toEqual({
      shares: [
        { arrival: 0, orderId: "o-urgent", lineId: "urgent", quantity: "6" },
        { arrival: 0, orderId: "o-normal", lineId: "normal", quantity: "4" },
      ],
      left: ["0"],
    });
  });

  it("keeps what nobody waits for", () => {
    const plan = planCrossDock(
      [arrival("10"), arrival("3", { productId: "other" })],
      [line("a", { waiting: "4" })],
    );
    expect(plain(plan).left).toEqual(["6", "3"]);
  });

  it("orders by day to leave, then release, then number", () => {
    const ranked = rankWaitingLines([
      line("late", { waiting: "1", dueOn: "2026-12-01" }),
      line("none", { waiting: "1" }),
      line("soon", { waiting: "1", dueOn: "2026-11-20", releasedAt: 5 }),
      line("soon-older", { waiting: "1", dueOn: "2026-11-20", releasedAt: 2 }),
      line("urgent", { waiting: "1", urgent: true, dueOn: "2027-01-01" }),
    ]);
    expect(ranked.map((row) => row.lineId)).toEqual([
      "urgent",
      "soon-older",
      "soon",
      "late",
      "none",
    ]);
  });

  it("takes what expires first among the arrivals of a product", () => {
    const plan = planCrossDock(
      [
        arrival("5", { lotId: "B", expiresOn: "2027-06-01" }),
        arrival("5", { lotId: "A", expiresOn: "2027-03-01" }),
        arrival("5", { lotId: "N" }),
      ],
      [line("a", { waiting: "7" })],
    );
    expect(plain(plan)).toEqual({
      shares: [
        { arrival: 1, orderId: "o-a", lineId: "a", quantity: "5" },
        { arrival: 0, orderId: "o-a", lineId: "a", quantity: "2" },
      ],
      left: ["3", "0", "5"],
    });
  });

  it("never gives a line more than it waits for", () => {
    const plan = planCrossDock(
      [arrival("2.5"), arrival("4")],
      [line("a", { waiting: "3" })],
    );
    expect(plain(plan).left).toEqual(["0", "3.5"]);
    expect(plain(plan).shares.map((s) => s.quantity)).toEqual(["2.5", "0.5"]);
  });
});
