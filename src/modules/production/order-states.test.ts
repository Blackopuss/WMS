import { describe, expect, it } from "vitest";

import {
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_ORDER_TRANSITIONS,
  canProductionTransition,
  formatProductionNumber,
  isProductionOrderStatus,
  productionTransitionProblem,
} from "./order-states";

describe("production order states (WMS-28)", () => {
  it("only these moves exist (the trigger repeats them)", () => {
    const moves = PRODUCTION_ORDER_STATUSES.flatMap((from) =>
      PRODUCTION_ORDER_TRANSITIONS[from].map((to) => `${from}->${to}`),
    );
    expect(moves.sort()).toEqual(
      [
        "DRAFT->RELEASED",
        "DRAFT->CANCELLED",
        "RELEASED->IN_PROGRESS",
        "RELEASED->CANCELLED",
        "IN_PROGRESS->CLOSED",
      ].sort(),
    );
  });

  it("explains what cannot be done", () => {
    expect(productionTransitionProblem("DRAFT", "RELEASED")).toBeNull();
    expect(productionTransitionProblem("IN_PROGRESS", "CANCELLED")).toMatch(
      /se cierra/,
    );
    expect(productionTransitionProblem("RELEASED", "RELEASED")).toMatch(
      /ya se liberó/,
    );
    expect(productionTransitionProblem("CANCELLED", "RELEASED")).toMatch(
      /cancelada/,
    );
    expect(canProductionTransition("RELEASED", "CLOSED")).toBe(false);
  });

  it("numbers orders", () => {
    expect(formatProductionNumber(7)).toBe("OP-0007");
    expect(isProductionOrderStatus("DRAFT")).toBe(true);
    expect(isProductionOrderStatus("SHIPPED")).toBe(false);
  });
});
