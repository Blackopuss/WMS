import "server-only";

import { dec, type Decimal } from "@/lib";
import type { TenantDb } from "@/server";

import { formatCustomerReturnNumber } from "./customer-return-states";

/**
 * What customer returns hold in inspection (WMS-17, ADR 0046, PC-5). What
 * an open return still has to decide stays in its place, in INSPECTION,
 * until someone decides it from the return: no other change of state and
 * no reversal may take it. Derived on every read (received − decided of
 * the open returns), never stored.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<
  Tx,
  "customerReturnLine" | "stockMovementLine" | "serialMove"
>;

export type ReturnHold = {
  /** In the product's unit. */
  quantity: Decimal;
  /** Units by serial still to decide. */
  unitIds: Set<string>;
  /** «DV-0003», the first return holding something; null when none. */
  firstNumberText: string | null;
};

/**
 * What open customer returns hold of a product, in a location and lot, in
 * inspection. `exceptLineId`: the line being decided does not hold
 * against itself.
 */
export async function heldForReturns(
  client: Reader,
  slot: { productId: string; locationId: string; lotId: string | null },
  exceptLineId?: string | null,
): Promise<ReturnHold> {
  const lines = await client.customerReturnLine.findMany({
    where: {
      productId: slot.productId,
      lotId: slot.lotId ?? null,
      return: { status: "RECEIVED", locationId: slot.locationId },
      ...(exceptLineId ? { id: { not: exceptLineId } } : {}),
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      quantity: true,
      movementLineId: true,
      return: { select: { number: true } },
      decisions: { select: { quantity: true, movementId: true } },
    },
  });
  let quantity = dec(0);
  let firstNumberText: string | null = null;
  const unitIds = new Set<string>();
  for (const line of lines) {
    const decided = line.decisions.reduce(
      (sum, decision) => sum.plus(decision.quantity.toString()),
      dec(0),
    );
    const pending = dec(line.quantity.toString()).minus(decided);
    if (!pending.greaterThan(0)) continue;
    quantity = quantity.plus(pending);
    firstNumberText ??= formatCustomerReturnNumber(line.return.number);
    for (const id of await pendingUnits(client, line)) unitIds.add(id);
  }
  return { quantity, unitIds, firstNumberText };
}

/**
 * Units by serial of a return line not decided yet: those its entry
 * brought in, minus those its decisions already moved.
 */
export async function pendingUnits(
  client: Reader,
  line: { movementLineId: string; decisions: { movementId: string }[] },
): Promise<string[]> {
  const entered = await client.serialMove.findMany({
    where: { movementLineId: line.movementLineId },
    select: { serialUnitId: true },
  });
  if (entered.length === 0) return [];
  const decidedLines =
    line.decisions.length > 0
      ? await client.stockMovementLine.findMany({
          where: {
            movementId: { in: line.decisions.map((d) => d.movementId) },
            direction: "OUT",
          },
          select: { id: true },
        })
      : [];
  const decided = new Set(
    decidedLines.length > 0
      ? (
          await client.serialMove.findMany({
            where: { movementLineId: { in: decidedLines.map((l) => l.id) } },
            select: { serialUnitId: true },
          })
        ).map((move) => move.serialUnitId)
      : [],
  );
  return entered
    .map((move) => move.serialUnitId)
    .filter((id) => !decided.has(id));
}

/** The sentence when what someone wants to take is held by a return. */
export function heldMessage(
  free: Decimal,
  hold: ReturnHold,
  freeText: string,
): string {
  const number = hold.firstNumberText ?? "una devolución";
  return free.greaterThan(0)
    ? `Solo ${freeText} en inspección aquí no son de una devolución; lo demás es de la devolución ${number}: decídelo desde la devolución.`
    : `Lo que está en inspección aquí es de la devolución ${number}: decídelo desde la devolución.`;
}
