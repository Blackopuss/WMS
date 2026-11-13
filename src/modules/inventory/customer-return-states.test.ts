import { describe, expect, it } from "vitest";

import {
  CUSTOMER_RETURN_STATUSES,
  CUSTOMER_RETURN_TRANSITIONS,
  canCustomerReturnTransition,
  formatCustomerReturnNumber,
  isReturnOutcome,
  parseCustomerReturnNumber,
} from "./customer-return-states";

// WMS-17 (ADR 0046): a customer return is received and, once every line
// is decided, resolved; nothing else.

describe("customer return transitions", () => {
  it("a received return is resolved, and nothing more", () => {
    expect(canCustomerReturnTransition("RECEIVED", "RESOLVED")).toBe(true);
    expect(CUSTOMER_RETURN_TRANSITIONS.RESOLVED).toEqual([]);
    for (const from of CUSTOMER_RETURN_STATUSES) {
      expect(canCustomerReturnTransition(from, from)).toBe(false);
    }
  });

  it("decides only available, damaged or rejected", () => {
    expect(isReturnOutcome("AVAILABLE")).toBe(true);
    expect(isReturnOutcome("DAMAGED")).toBe(true);
    expect(isReturnOutcome("REJECTED")).toBe(true);
    expect(isReturnOutcome("INSPECTION")).toBe(false);
    expect(isReturnOutcome("QUARANTINE")).toBe(false);
  });

  it("writes and reads its number", () => {
    expect(formatCustomerReturnNumber(7)).toBe("DV-0007");
    expect(parseCustomerReturnNumber("dv 0012")).toBe(12);
    expect(parseCustomerReturnNumber("DV-3")).toBe(3);
    expect(parseCustomerReturnNumber("PS-3")).toBeNull();
    expect(parseCustomerReturnNumber("DV-0")).toBeNull();
  });
});
