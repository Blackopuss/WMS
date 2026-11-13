import { describe, expect, it } from "vitest";

import {
  SHIPMENT_STATUSES,
  SHIPMENT_TRANSITIONS,
  canShipmentTransition,
  formatShipmentNumber,
  shipmentTransitionProblem,
} from "./shipment-states";

// WMS-16 (ADR 0045): a shipment is put together as a draft and then either
// leaves or is cancelled; both are final.

describe("shipment transitions", () => {
  it("a draft ships or is cancelled", () => {
    expect(canShipmentTransition("DRAFT", "SHIPPED")).toBe(true);
    expect(canShipmentTransition("DRAFT", "CANCELLED")).toBe(true);
  });

  it("what shipped or was cancelled never changes", () => {
    expect(SHIPMENT_TRANSITIONS.SHIPPED).toEqual([]);
    expect(SHIPMENT_TRANSITIONS.CANCELLED).toEqual([]);
    expect(shipmentTransitionProblem("SHIPPED", "CANCELLED")).toMatch(
      /ya salió/,
    );
    expect(shipmentTransitionProblem("CANCELLED", "SHIPPED")).toMatch(
      /cancelado/,
    );
  });

  it("explains every refusal", () => {
    for (const from of SHIPMENT_STATUSES) {
      for (const to of SHIPMENT_STATUSES) {
        expect(shipmentTransitionProblem(from, to) === null).toBe(
          canShipmentTransition(from, to),
        );
      }
    }
    expect(formatShipmentNumber(7)).toBe("EM-0007");
  });
});
