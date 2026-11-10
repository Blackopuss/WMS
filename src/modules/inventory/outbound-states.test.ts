import { describe, expect, it } from "vitest";

import {
  OUTBOUND_ORDER_STATUSES,
  OUTBOUND_ORDER_TRANSITIONS,
  canOutboundTransition,
  formatOutboundNumber,
  outboundTransitionProblem,
} from "./outbound-states";

// WMS-13: an outbound order moves forward through its steps (spec 5.2).

describe("outbound order transitions", () => {
  it("goes draft → released → picking → picked → packed → shipped", () => {
    const path = [
      "DRAFT",
      "RELEASED",
      "PICKING",
      "PICKED",
      "PACKED",
      "SHIPPED",
    ] as const;
    for (let i = 0; i + 1 < path.length; i++) {
      expect(canOutboundTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("is cancelled only before picking starts", () => {
    expect(canOutboundTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(canOutboundTransition("RELEASED", "CANCELLED")).toBe(true);
    expect(canOutboundTransition("PICKING", "CANCELLED")).toBe(false);
    expect(outboundTransitionProblem("PICKING", "CANCELLED")).toMatch(
      /surtido de este pedido ya empezó/,
    );
  });

  it("never skips a step, and final states have no way out", () => {
    expect(canOutboundTransition("DRAFT", "SHIPPED")).toBe(false);
    expect(canOutboundTransition("RELEASED", "RELEASED")).toBe(false);
    expect(OUTBOUND_ORDER_TRANSITIONS.SHIPPED).toEqual([]);
    expect(OUTBOUND_ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("explains every refusal", () => {
    for (const from of OUTBOUND_ORDER_STATUSES) {
      for (const to of OUTBOUND_ORDER_STATUSES) {
        expect(outboundTransitionProblem(from, to) === null).toBe(
          canOutboundTransition(from, to),
        );
      }
    }
    expect(formatOutboundNumber(12)).toBe("PS-0012");
  });
});
