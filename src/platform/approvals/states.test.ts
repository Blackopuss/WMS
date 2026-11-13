import { describe, expect, it } from "vitest";

import {
  APPROVAL_STATUSES,
  APPROVAL_TRANSITIONS,
  canTransition,
} from "./states";

describe("approval states (WMS-56)", () => {
  it("a pending request goes to one final state, once", () => {
    for (const to of [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "EXPIRED",
    ] as const) {
      expect(canTransition("PENDING", to)).toBe(true);
    }
    expect(canTransition("PENDING", "PENDING")).toBe(false);
    for (const from of APPROVAL_STATUSES.filter((s) => s !== "PENDING")) {
      expect(APPROVAL_TRANSITIONS[from]).toEqual([]);
      for (const to of APPROVAL_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});
