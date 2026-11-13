import { describe, expect, it } from "vitest";

import {
  PURCHASE_REQUEST_STATUSES,
  PURCHASE_REQUEST_TRANSITIONS,
  canRequestTransition,
  isPurchaseRequestStatus,
  requestTransitionProblem,
} from "./request-states";

// WMS-57 (ADR 0055): draft → waiting for authorization → to attend →
// converted, with cancel and reject; anything else is refused.

describe("states of a purchase request", () => {
  it("allows exactly the moves of the flow", () => {
    const allowed = PURCHASE_REQUEST_STATUSES.flatMap((from) =>
      PURCHASE_REQUEST_STATUSES.filter((to) =>
        canRequestTransition(from, to),
      ).map((to) => `${from} → ${to}`),
    );
    expect(allowed).toEqual([
      "DRAFT → SUBMITTED",
      "DRAFT → APPROVED",
      "DRAFT → CANCELLED",
      "SUBMITTED → APPROVED",
      "SUBMITTED → REJECTED",
      "SUBMITTED → CANCELLED",
      "APPROVED → REJECTED",
      "APPROVED → CONVERTED",
    ]);
  });

  it("nothing leaves a final state, goes back, or stays where it is", () => {
    for (const final of ["REJECTED", "CONVERTED", "CANCELLED"] as const) {
      expect(PURCHASE_REQUEST_TRANSITIONS[final]).toEqual([]);
    }
    for (const status of PURCHASE_REQUEST_STATUSES) {
      expect(canRequestTransition(status, status), status).toBe(false);
      expect(canRequestTransition(status, "DRAFT"), status).toBe(false);
    }
  });

  it("says why a move is refused", () => {
    expect(requestTransitionProblem("DRAFT", "SUBMITTED")).toBeNull();
    expect(requestTransitionProblem("CONVERTED", "REJECTED")).toMatch(
      /ya se convirtió/,
    );
    expect(requestTransitionProblem("APPROVED", "CANCELLED")).toMatch(
      /Compras/,
    );
    expect(requestTransitionProblem("SUBMITTED", "CONVERTED")).toMatch(
      /espera autorización/,
    );
  });

  it("knows its states", () => {
    expect(isPurchaseRequestStatus("APPROVED")).toBe(true);
    expect(isPurchaseRequestStatus("SENT")).toBe(false);
    expect(isPurchaseRequestStatus(null)).toBe(false);
  });
});
