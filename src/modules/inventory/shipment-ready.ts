import "server-only";

import { readSetting } from "@/platform/settings";

import type { DayWindow } from "./calendar-day";
import type { OutboundOrderStatus } from "./outbound-states";
import { PACKING_MODE } from "./settings";

/**
 * Which outbound orders may leave (WMS-16, ADR 0045), shared by the
 * shipments, the list of orders and the summary of the day. Without
 * imports of the services that use it, so none of them depends on another.
 */

type Reader = Parameters<typeof readSetting>[0];

/**
 * The states of an order ready to leave: PACKED when the company packs
 * («no se despacha sin empacar»); also PICKED when it does not. Read
 * inside the transaction that decides with it.
 */
export async function readyStatuses(
  client: Reader,
): Promise<OutboundOrderStatus[]> {
  return (await readSetting(client, PACKING_MODE)) === "on"
    ? ["PACKED"]
    : ["PICKED", "PACKED"];
}

/** The value of `status` that lists the orders ready to leave. */
export const TO_SHIP = "por-despachar";

/** An order that is in a shipment not cancelled (a draft or one that left). */
export const IN_OPEN_SHIPMENT = {
  shipments: { some: { openOrderId: { not: null } } },
} as const;

/** An order that is in no shipment, or only in cancelled ones. */
export const IN_NO_SHIPMENT = {
  shipments: { none: { openOrderId: { not: null } } },
} as const;

/**
 * Orders of a warehouse shipped on a day: their shipment left that day.
 * The same condition for the list (`/pedidos?salio=…`) and for the summary
 * of the day (WMS-73).
 */
export function shippedOnWhere(facilityId: string, window: DayWindow) {
  return {
    facilityId,
    status: "SHIPPED" as const,
    shipments: {
      some: {
        openOrderId: { not: null },
        shipment: { status: "SHIPPED" as const, shippedAt: window.range },
      },
    },
  };
}
