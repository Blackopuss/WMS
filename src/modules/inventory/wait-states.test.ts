import { describe, expect, it } from "vitest";

import {
  OUTBOUND_WAIT_STATUSES,
  OUTBOUND_WAIT_TRANSITIONS,
  canOutboundWaitTransition,
} from "./wait-states";

describe("outbound line waits (WMS-79)", () => {
  it("closes only from open, once", () => {
    for (const to of ["DONE", "DROPPED", "CANCELLED"] as const) {
      expect(canOutboundWaitTransition("OPEN", to)).toBe(true);
    }
    for (const from of OUTBOUND_WAIT_STATUSES) {
      if (from === "OPEN") continue;
      expect(OUTBOUND_WAIT_TRANSITIONS[from]).toEqual([]);
    }
    expect(canOutboundWaitTransition("OPEN", "OPEN")).toBe(false);
  });
});
