import { describe, expect, it } from "vitest";

import { API_CAPABILITIES } from "./capabilities";

// WMS-60 (ADR 0058): an existing key gains whatever permission its
// capability gains. Changing this table must be on purpose: update the
// ADR and this test together.
describe("capabilities of an API key", () => {
  it("give exactly these permissions", () => {
    expect(
      Object.fromEntries(
        API_CAPABILITIES.map((each) => [each.key, [...each.permissions]]),
      ),
    ).toEqual({
      "products.read": ["inventory.product.read"],
      "stock.read": ["inventory.product.read", "inventory.stock.read"],
      "movements.read": ["inventory.movement.read"],
      "outbound.read": ["inventory.outbound.read"],
      "outbound.create": [
        "inventory.outbound.read",
        "inventory.outbound.create",
      ],
      "shipments.read": ["inventory.shipment.read"],
      "purchase_orders.read": ["purchasing.order.read"],
      "receipts.read": ["purchasing.order.read", "purchasing.receipt.read"],
      "costs.read": ["inventory.cost.read", "purchasing.cost.read"],
    });
  });

  it("never give a permission of the platform", () => {
    for (const each of API_CAPABILITIES) {
      for (const permission of each.permissions) {
        expect(permission.startsWith("platform.")).toBe(false);
      }
    }
  });
});
