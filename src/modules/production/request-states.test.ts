import { describe, expect, it } from "vitest";

import {
  PRODUCTION_REQUEST_STATUSES,
  PRODUCTION_REQUEST_TRANSITIONS,
  canProductionRequestTransition,
  formatProductionRequestNumber,
  isProductionRequestStatus,
  productionRequestProblem,
} from "./request-states";

describe("production request states (WMS-28B)", () => {
  it("only these moves exist (the trigger repeats them)", () => {
    const moves = PRODUCTION_REQUEST_STATUSES.flatMap((from) =>
      PRODUCTION_REQUEST_TRANSITIONS[from].map((to) => `${from}->${to}`),
    );
    expect(moves.sort()).toEqual(
      [
        "SUBMITTED->ACCEPTED",
        "SUBMITTED->REJECTED",
        "SUBMITTED->CANCELLED",
      ].sort(),
    );
  });

  it("explains what cannot be done", () => {
    expect(productionRequestProblem("SUBMITTED", "ACCEPTED")).toBeNull();
    expect(productionRequestProblem("ACCEPTED", "REJECTED")).toMatch(/aceptó/);
    expect(productionRequestProblem("REJECTED", "ACCEPTED")).toMatch(/rechazó/);
    expect(productionRequestProblem("CANCELLED", "ACCEPTED")).toMatch(
      /canceló/,
    );
    expect(canProductionRequestTransition("ACCEPTED", "CANCELLED")).toBe(false);
  });

  it("numbers requests", () => {
    expect(formatProductionRequestNumber(12)).toBe("SP-0012");
    expect(isProductionRequestStatus("SUBMITTED")).toBe(true);
    expect(isProductionRequestStatus("DRAFT")).toBe(false);
  });
});
