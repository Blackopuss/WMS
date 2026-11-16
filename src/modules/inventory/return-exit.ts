import "server-only";

import { dec, newId } from "@/lib";
import { assertLocationsInScope } from "@/platform/locations";
import { lockRows, type TenantDb } from "@/server";

import { formatStock, type InventoryActor } from "./movements";
import { costPerUnit, lineCost, openCostBook } from "./valuation";
import { STOCK_STATUS_LABELS, lotColumns } from "./stock-status";
import { holdProblem } from "./holds";
import { blockedMessage, freeToTake } from "./reservations";
import {
  serialKey,
  serialsForTake,
  writeSerialMoves,
  type SerialPick,
} from "./serials";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Decimal = ReturnType<typeof dec>;

/**
 * The exit of stock of a return to the supplier (CMP-12): the movement
 * (`RETURN`), its lines and the balances, written inside the transaction
 * of the return so that the document and the stock exist together or not
 * at all. Compras calls it after checking `purchasing.return.create`:
 * returning does not need the permission of manual exits, nor grants it.
 *
 * Unlike an exit, nothing is converted with the content in force: each
 * line leaves with the factor it was received with (what entered for that
 * box is what goes back), given by the caller from the receipt line, and
 * at the cost it came in with (VAL-02, ADR 0031): the average of what stays
 * moves accordingly.
 */
export type ReturnExitLine = {
  productId: string;
  locationId: string;
  /** In the terms of the receipt line: 1 box. */
  capturedQuantity: Decimal;
  presentationId: string | null;
  presentationVersionId: string | null;
  factor: Decimal;
  unitCode: string;
  /** Cost of one captured unit (one box) it was received at; null if unknown. */
  unitCost: { toString(): string } | null;
  /** The lot it was received in (WMS-21): it goes back from that lot. */
  lotId?: string | null;
  /**
   * WMS-21B: the units that go back, for a product by serial (text with
   * one serial per line, or a list), and the units that arrived with that
   * receipt line: only those can go back with it.
   */
  serials?: unknown;
  receivedUnitIds?: ReadonlySet<string>;
  /**
   * WMS-54 (ADR 0052), WMS-30-0 (ADR 0068): the state it leaves from. By
   * default the one its receipt line came in; it may also be what it
   * became after a decision (rejected, damaged). Absent = AVAILABLE.
   */
  status?: ReturnableStatus;
};

/** States stock may go back to the supplier from (WMS-30-0, ADR 0068). */
export const RETURNABLE_STATUSES = [
  "AVAILABLE",
  "INSPECTION",
  "DAMAGED",
  "REJECTED",
] as const;
export type ReturnableStatus = (typeof RETURNABLE_STATUSES)[number];

export const isReturnableStatus = (value: unknown): value is ReturnableStatus =>
  typeof value === "string" &&
  (RETURNABLE_STATUSES as readonly string[]).includes(value);

export type ReturnExitResult =
  | { ok: true; movementId: string; texts: string[] }
  | {
      ok: false;
      /** Position of the line with the problem. */
      line: number;
      error: string;
    };

export async function postReturnExit(
  tx: Tx,
  actor: InventoryActor,
  input: {
    lines: ReturnExitLine[];
    /** «OC-0007 · Devolución»: what people see in the history. */
    reference: string | null;
    reason: string;
  },
): Promise<ReturnExitResult> {
  const { organizationId, userId } = actor;
  if (input.lines.length === 0) {
    throw new Error("A return needs at least one line");
  }
  // Same order as every movement: products, then locations. The caller
  // may hold them already; taking them again is harmless.
  await lockRows(
    tx,
    "product",
    input.lines.map((line) => line.productId),
  );
  await lockRows(
    tx,
    "location",
    input.lines.map((line) => line.locationId),
  );
  // WMS-20: nothing leaves a location outside the person's scope.
  await assertLocationsInScope(
    tx,
    userId,
    input.lines.map((line) => line.locationId),
  );

  const lines = input.lines.map((line) => ({
    ...line,
    status: isReturnableStatus(line.status)
      ? line.status
      : ("AVAILABLE" as const),
    baseQuantity: line.capturedQuantity.times(line.factor),
  }));
  // WMS-21: each line leaves from the lot it was received in. A product
  // that changed how it is controlled since no longer has that stock.
  const tracked = await tx.product.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.productId))] } },
    select: { id: true, name: true, tracking: true },
  });
  const places = await tx.location.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.locationId))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(places.map((place) => [place.id, place.name]));
  const unitsOf: SerialPick[][] = [];
  const named = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const product = tracked.find((row) => row.id === line.productId);
    if (product && (product.tracking === "LOT") !== Boolean(line.lotId)) {
      return {
        ok: false,
        line: index,
        error: `${product.name} cambió su control por lote después de recibirlo: sácalo con una salida, eligiendo de dónde.`,
      };
    }
    // WMS-21B: a product by serial says which units go back: units that
    // arrived with that receipt line and are right there.
    const received = line.receivedUnitIds ?? new Set<string>();
    if (product?.tracking === "SERIAL" && received.size === 0) {
      return {
        ok: false,
        line: index,
        error: `${product.name} cambió su control por serie después de recibirlo: sácalo con una salida, con sus series.`,
      };
    }
    const answer = product
      ? await serialsForTake(
          tx,
          product,
          line.serials,
          line.baseQuantity,
          {
            locationId: line.locationId,
            locationName: nameOf.get(line.locationId) ?? "esa ubicación",
            status: line.status,
          },
          { verb: "regresan" },
        )
      : ({ ok: true, units: null } as const);
    if (!answer.ok) return { ok: false, line: index, error: answer.error };
    const units = answer.units ?? [];
    const foreign = units.find((unit) => !received.has(unit.id!));
    if (foreign) {
      return {
        ok: false,
        line: index,
        error: `La serie ${foreign.serial} no llegó en esta recepción: no se devuelve con ella.`,
      };
    }
    const twice = units.find((unit) =>
      named.has(`${line.productId} ${serialKey(unit.serial)}`),
    );
    if (twice) {
      return {
        ok: false,
        line: index,
        error: `La serie ${twice.serial} ya está en otra línea de esta devolución.`,
      };
    }
    for (const unit of units) {
      named.add(`${line.productId} ${serialKey(unit.serial)}`);
    }
    unitsOf.push(units);
  }
  // What leaves each product in each location: `<product> <location>`.
  const taken = new Map<string, Decimal>();
  const slotOf = (line: {
    productId: string;
    locationId: string;
    lotId?: string | null;
    status: string;
  }) =>
    `${line.productId} ${line.locationId} ${line.lotId ?? ""} ${line.status}`;
  for (const line of lines) {
    const slot = slotOf(line);
    taken.set(slot, (taken.get(slot) ?? dec(0)).plus(line.baseQuantity));
  }
  const balances = await tx.stockBalance.findMany({
    where: {
      productId: { in: [...new Set(lines.map((line) => line.productId))] },
      locationId: { in: [...new Set(lines.map((line) => line.locationId))] },
      status: { in: [...new Set(lines.map((line) => line.status))] },
      lotKey: { in: [...new Set(lines.map((line) => line.lotId ?? ""))] },
    },
    select: {
      id: true,
      productId: true,
      locationId: true,
      lotKey: true,
      status: true,
      quantity: true,
    },
  });
  const current = new Map(
    balances.map((row) => [
      `${row.productId} ${row.locationId} ${row.lotKey} ${row.status}`,
      row,
    ]),
  );
  // Never below zero: what is no longer there cannot go back.
  for (const [slot, quantity] of taken) {
    const before = dec(current.get(slot)?.quantity.toString() ?? 0);
    if (before.lessThan(quantity)) {
      const index = lines.findIndex((line) => slotOf(line) === slot);
      const line = lines[index]!;
      const where = nameOf.get(line.locationId) ?? "esa ubicación";
      return {
        ok: false,
        line: index,
        // WMS-54: what arrived damaged leaves from «Dañado»; if somebody
        // changed its state or moved it, it is said plainly.
        error:
          line.status !== "AVAILABLE"
            ? `En ${where} solo hay ${formatStock(before.toString(), line.unitCode)} de este producto en «${STOCK_STATUS_LABELS[line.status]}». Si ya cambió de estado o de lugar, elige de dónde sale o sácalo con una salida.`
            : `En ${where} solo hay ${formatStock(before.toString(), line.unitCode)}. Lo que ya salió o se movió de ahí no se puede devolver desde ahí.`,
      };
    }
  }
  // WMS-30-0 (ADR 0068): what an open document holds of stock that is not
  // available (a customer return, a verification) does not go back.
  for (const [slot, quantity] of taken) {
    const [productId = "", locationId = "", lotKey = "", status = ""] =
      slot.split(" ");
    if (status === "AVAILABLE") continue;
    const index = lines.findIndex((line) => slotOf(line) === slot);
    const line = lines[index]!;
    const held = await holdProblem(
      tx,
      {
        productId,
        locationId,
        status: line.status,
        lotId: lotKey || null,
      },
      dec(current.get(slot)?.quantity.toString() ?? 0),
      quantity,
      lines.flatMap((each, at) => (slotOf(each) === slot ? unitsOf[at]! : [])),
      line.unitCode,
    );
    if (held) return { ok: false, line: index, error: held.message };
  }
  // WMS-12: what is reserved for an order is not sent back.
  const byProduct = new Map<string, Decimal>();
  for (const [slot, quantity] of taken) {
    const [productId = "", locationId = "", lotKey = "", status] =
      slot.split(" ");
    // Only AVAILABLE stock is reserved or packed: damaged goods are not.
    if (status !== "AVAILABLE") continue;
    byProduct.set(
      productId,
      (byProduct.get(productId) ?? dec(0)).plus(quantity),
    );
    const free = await freeToTake(tx, productId, locationId, lotKey || null);
    const total = byProduct.get(productId)!;
    const freeAnywhere = await freeToTake(tx, productId, null);
    if (free.lessThan(quantity) || freeAnywhere.lessThan(total)) {
      const index = lines.findIndex((line) => slotOf(line) === slot);
      const line = lines[index]!;
      return {
        ok: false,
        line: index,
        error: await blockedMessage(
          tx,
          free.lessThan(freeAnywhere) ? free : freeAnywhere,
          line.unitCode,
          "devolver",
          { productId, locationId, lotId: lotKey || null },
        ),
      };
    }
  }

  // Read before any balance changes: the stock all locations had.
  const costs = await openCostBook(
    tx,
    organizationId,
    lines.map((line) => line.productId),
  );
  const unitCosts = lines.map((line) =>
    costs.exitAt(
      line.productId,
      line.baseQuantity,
      costPerUnit(line.unitCost?.toString(), line.factor),
    ),
  );

  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "RETURN",
      reason: input.reason,
      reference: input.reference,
      createdByUserId: userId,
    },
  });
  const lineIds = lines.map(() => newId());
  await writeSerialMoves(
    tx,
    actor,
    lines.map((line, index) => ({
      lineId: lineIds[index]!,
      productId: line.productId,
      locationId: line.locationId,
      status: line.status,
      direction: "OUT" as const,
      units: unitsOf[index]!,
    })),
  );
  await tx.stockMovementLine.createMany({
    data: lines.map((line, index) => ({
      id: lineIds[index]!,
      organizationId,
      movementId,
      lineNumber: index + 1,
      productId: line.productId,
      locationId: line.locationId,
      direction: "OUT" as const,
      capturedQuantity: line.capturedQuantity.toString(),
      presentationId: line.presentationId,
      presentationVersionId: line.presentationVersionId,
      factor: line.factor.toString(),
      baseQuantity: line.baseQuantity.toString(),
      unitCode: line.unitCode,
      ...lotColumns(line.lotId),
      status: line.status,
      unitCost: lineCost(unitCosts[index]!),
    })),
  });
  await costs.save();
  for (const [slot, quantity] of taken) {
    const row = current.get(slot)!;
    // Conditioned like every exit; the CHECK of the table is the last line.
    const updated = await tx.stockBalance.updateMany({
      where: { id: row.id, quantity: { gte: quantity.toString() } },
      data: { quantity: { decrement: quantity.toString() } },
    });
    if (updated.count !== 1) {
      throw new Error(`Balance changed under its lock: ${slot}`);
    }
  }
  return {
    ok: true,
    movementId,
    texts: lines.map((line) =>
      formatStock(line.baseQuantity.toString(), line.unitCode),
    ),
  };
}
