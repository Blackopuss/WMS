import { describe, expect, it } from "vitest";

import {
  FACILITY_TRANSFER_STATUSES,
  FACILITY_TRANSFER_TRANSITIONS,
  canFacilityTransferTransition,
  formatFacilityTransferNumber,
  isTransferResolution,
  parseFacilityTransferNumber,
} from "./facility-transfer-states";

// WMS-19 (ADR 0048): a transfer is sent and received; only a draft is
// cancelled; nothing goes back.

describe("facility transfer transitions", () => {
  it("a draft is sent or cancelled; a sent one is only received", () => {
    expect(canFacilityTransferTransition("DRAFT", "SENT")).toBe(true);
    expect(canFacilityTransferTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(canFacilityTransferTransition("SENT", "RECEIVED")).toBe(true);
    expect(canFacilityTransferTransition("SENT", "CANCELLED")).toBe(false);
    expect(canFacilityTransferTransition("SENT", "DRAFT")).toBe(false);
    expect(canFacilityTransferTransition("DRAFT", "RECEIVED")).toBe(false);
    expect(FACILITY_TRANSFER_TRANSITIONS.RECEIVED).toEqual([]);
    expect(FACILITY_TRANSFER_TRANSITIONS.CANCELLED).toEqual([]);
    for (const from of FACILITY_TRANSFER_STATUSES) {
      expect(canFacilityTransferTransition(from, from)).toBe(false);
    }
  });

  it("settles what did not arrive only as lost or back at the origin", () => {
    expect(isTransferResolution("LOST")).toBe(true);
    expect(isTransferResolution("RETURNED")).toBe(true);
    expect(isTransferResolution("RECEIVED")).toBe(false);
  });

  it("writes and reads its number", () => {
    expect(formatFacilityTransferNumber(7)).toBe("TR-0007");
    expect(parseFacilityTransferNumber("tr 0012")).toBe(12);
    expect(parseFacilityTransferNumber("TR-3")).toBe(3);
    expect(parseFacilityTransferNumber("T-3")).toBeNull();
    expect(parseFacilityTransferNumber("TR-0")).toBeNull();
  });
});
