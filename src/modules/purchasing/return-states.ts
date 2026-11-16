import "server-only";

import { dec, type Decimal } from "@/lib";
import type { ReturnableStatus } from "@/modules/inventory";
import type { TenantDb } from "@/server";

/**
 * From which state a receipt line may go back to the supplier (WMS-30-0,
 * ADR 0068). Conservative on purpose (integrity and traceability first; the
 * founder may change it):
 * - what arrived damaged goes back only from «Dañado»;
 * - what arrived in inspection goes back from inspection or from what was
 *   decided of it (available, rejected, damaged);
 * - what arrived available goes back from available and, from damaged or
 *   rejected, only when that product (and lot) changed to that state in
 *   that warehouse after the receipt.
 * And what a line that did not arrive damaged takes from «Dañado» never
 * eats what other receipt lines received damaged there and still owe
 * (`damagedOwed`). The screen offers only what this allows.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "stockMovementLine" | "purchaseReceiptLine">;

export function returnStatesFor(received: string): {
  always: ReturnableStatus[];
  ifChanged: ReturnableStatus[];
} {
  if (received === "DAMAGED") return { always: ["DAMAGED"], ifChanged: [] };
  if (received === "INSPECTION") {
    return {
      always: ["INSPECTION", "AVAILABLE", "REJECTED", "DAMAGED"],
      ifChanged: [],
    };
  }
  return { always: ["AVAILABLE"], ifChanged: ["DAMAGED", "REJECTED"] };
}

/**
 * The states that product (and lot) changed to in a warehouse after a
 * moment, among `statuses`.
 */
export async function changedToAfter(
  client: Reader,
  input: {
    productId: string;
    lotId: string | null;
    facilityId: string;
    since: Date;
    statuses: readonly ReturnableStatus[];
  },
): Promise<Set<string>> {
  if (input.statuses.length === 0) return new Set();
  const rows = await client.stockMovementLine.findMany({
    where: {
      productId: input.productId,
      lotKey: input.lotId ?? "",
      direction: "IN",
      status: { in: [...input.statuses] },
      location: { facilityId: input.facilityId },
      movement: { type: "STATUS_CHANGE", createdAt: { gt: input.since } },
    },
    distinct: ["status"],
    select: { status: true },
  });
  return new Set(rows.map((row) => row.status));
}

/**
 * What receipt lines that arrived damaged in a location (product and lot)
 * still owe their returns, in the product's unit: received − returned.
 * Read under the caller's product lock.
 */
export async function damagedOwed(
  client: Reader,
  slot: { productId: string; locationId: string; lotId: string | null },
): Promise<Decimal> {
  const lines = await client.purchaseReceiptLine.findMany({
    where: {
      productId: slot.productId,
      locationId: slot.locationId,
      lotId: slot.lotId,
      status: "DAMAGED",
    },
    select: {
      baseQuantity: true,
      returnLines: { select: { baseQuantity: true } },
    },
  });
  let owed = dec(0);
  for (const line of lines) {
    const back = line.returnLines.reduce(
      (sum, row) => sum.plus(row.baseQuantity.toString()),
      dec(0),
    );
    const left = dec(line.baseQuantity.toString()).minus(back);
    if (left.greaterThan(0)) owed = owed.plus(left);
  }
  return owed;
}
