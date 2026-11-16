import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import type { TenantDb } from "@/server";

import { formatStock, type InventoryActor } from "./movements";
import { heldForReturns } from "./return-holds";
import {
  STOCK_STATUS_LABELS,
  lotColumns,
  type StockStatus,
} from "./stock-status";

/**
 * Generic hold of stock that is NOT available (WMS-30-0, ADR 0068). While
 * an open document decides something (a customer return, WMS-17; a
 * verification of Calidad, WMS-30B), what it holds stays where it is, in
 * its state: no change of state, reversal, disposal or return to the
 * supplier takes it.
 *
 * Two sources, read together by `heldStock` (the only read the operations
 * use):
 * - customer returns, derived as before (`heldForReturns`: received −
 *   decided of the open returns, in inspection);
 * - `stock_hold`, written only by `holdStock`/`releaseHold` of this file,
 *   inside the document's transaction and after its locks (products →
 *   locations → document). The product's lock is what keeps two documents
 *   from holding the same stock, as with reservations; hold rows are not
 *   locked.
 *
 * Holds never cover available stock: that is what reservations are for.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<
  Tx,
  "customerReturnLine" | "stockMovementLine" | "serialMove" | "stockHold"
>;

export type HoldSlot = {
  productId: string;
  locationId: string;
  status: StockStatus;
  lotId: string | null;
};

/** The document a hold belongs to. */
export type HoldSource = { sourceType: string; sourceId: string };

export type HeldStock = {
  /** In the product's unit. */
  quantity: Decimal;
  /** Units by serial held. */
  unitIds: Set<string>;
  /** «la devolución DV-0003», «IN-0004»: the first document holding; null when none. */
  firstText: string | null;
};

/** What the operation itself may take although it is held. */
export type HoldExcept = {
  /** The customer return line being decided (WMS-17). */
  returnLineId?: string | null;
  /** The document deciding its own hold (WMS-30B). */
  holdSource?: HoldSource | null;
};

/**
 * What open documents hold of a product, in a location, state and lot.
 * Read under the caller's product lock.
 */
export async function heldStock(
  client: Reader,
  slot: HoldSlot,
  except: HoldExcept = {},
): Promise<HeldStock> {
  let quantity = dec(0);
  let firstText: string | null = null;
  const unitIds = new Set<string>();
  if (slot.status === "INSPECTION") {
    const returns = await heldForReturns(client, slot, except.returnLineId);
    quantity = quantity.plus(returns.quantity);
    for (const id of returns.unitIds) unitIds.add(id);
    if (returns.firstNumberText) {
      firstText = `la devolución ${returns.firstNumberText}`;
    }
  }
  const holds = await client.stockHold.findMany({
    where: {
      productId: slot.productId,
      locationId: slot.locationId,
      status: slot.status,
      lotKey: slot.lotId ?? "",
      state: "ACTIVE",
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      remaining: true,
      sourceType: true,
      sourceId: true,
      sourceText: true,
      units: { where: { releasedAt: null }, select: { serialUnitId: true } },
    },
  });
  for (const hold of holds) {
    if (
      except.holdSource &&
      hold.sourceType === except.holdSource.sourceType &&
      hold.sourceId === except.holdSource.sourceId
    ) {
      continue;
    }
    quantity = quantity.plus(hold.remaining.toString());
    for (const unit of hold.units) unitIds.add(unit.serialUnitId);
    firstText ??= hold.sourceText;
  }
  return { quantity, unitIds, firstText };
}

/** The sentence when what someone wants to take is held by a document. */
export function heldSentence(
  held: HeldStock,
  free: Decimal,
  unitCode: string,
  status: StockStatus,
): string {
  const where = held.firstText ?? "un documento abierto";
  const state = STOCK_STATUS_LABELS[status].toLowerCase();
  return free.greaterThan(0)
    ? `Solo ${formatStock(free.toString(), unitCode)} ${state} aquí no están retenidas; lo demás es de ${where}: decídelo desde ahí.`
    : `Lo que está ${state} aquí es de ${where}: decídelo desde ahí.`;
}

/**
 * Whether `quantity` (and `units`) of a slot may be taken by an operation:
 * null when it may, the sentence otherwise. `there` is the balance read
 * under the caller's locks.
 */
export async function holdProblem(
  client: Tx,
  slot: HoldSlot,
  there: Decimal,
  quantity: Decimal,
  units: readonly { id: string | null; serial: string }[],
  unitCode: string,
  except: HoldExcept = {},
): Promise<{ message: string; serial: boolean } | null> {
  if (slot.status === "AVAILABLE") return null;
  const held = await heldStock(client, slot, except);
  if (held.quantity.isZero() && held.unitIds.size === 0) return null;
  const heldUnit = units.find((unit) => unit.id && held.unitIds.has(unit.id));
  if (heldUnit) {
    return {
      serial: true,
      message: `La serie ${heldUnit.serial} es de ${held.firstText ?? "un documento abierto"}: decídela desde ahí.`,
    };
  }
  const free = there.minus(held.quantity);
  if (free.lessThan(quantity)) {
    return {
      serial: false,
      message: heldSentence(
        held,
        free.greaterThan(0) ? free : dec(0),
        unitCode,
        slot.status,
      ),
    };
  }
  return null;
}

/**
 * States a document may hold (ADR 0068): never available (that is
 * reserved), nor in transit or receiving, which belong to their own
 * operations. Which locations a document may hold is for the caller to
 * check (its scope), like any operation.
 */
export const HOLDABLE_STATUSES: readonly StockStatus[] = [
  "INSPECTION",
  "QUARANTINE",
  "DAMAGED",
  "REJECTED",
  "BLOCKED",
  /** WMS-75 (ADR 0072): what a repair order (WMS-29B) works on. */
  "REPAIR",
];

export type HoldResult =
  { ok: true; holdId: string } | { ok: false; error: string };

/**
 * Holds part of a balance that is not available for an open document,
 * inside its transaction and after its locks (products → locations →
 * document). Refuses when the balance, minus what others hold, does not
 * reach, or when a unit is not there or is held already. A product by
 * serial names exactly its units (`unitIds`, as many as the quantity).
 */
export async function holdStock(
  tx: Tx,
  actor: InventoryActor,
  input: HoldSlot &
    HoldSource & {
      quantity: Decimal | string;
      sourceText: string;
      unitIds?: readonly string[];
    },
): Promise<HoldResult> {
  if (!HOLDABLE_STATUSES.includes(input.status)) {
    throw new Error(`Stock in ${input.status} is not held`);
  }
  const quantity = dec(input.quantity.toString());
  if (!quantity.greaterThan(0)) {
    return { ok: false, error: "Escribe cuánto se retiene." };
  }
  const product = await tx.product.findFirst({
    where: { id: input.productId },
    select: { unitCode: true, tracking: true },
  });
  if (!product) return { ok: false, error: "Este producto ya no existe." };
  const unitIds = [...new Set(input.unitIds ?? [])];
  if (product.tracking === "SERIAL" && !quantity.equals(unitIds.length)) {
    return { ok: false, error: "Nombra cada serie que se retiene." };
  }
  if (product.tracking !== "SERIAL" && unitIds.length > 0) {
    return { ok: false, error: "Este producto no lleva series." };
  }
  const balance = await tx.stockBalance.findFirst({
    where: {
      productId: input.productId,
      locationId: input.locationId,
      status: input.status,
      lotKey: input.lotId ?? "",
    },
    select: { quantity: true },
  });
  const there = dec(balance?.quantity.toString() ?? 0);
  const held = await heldStock(tx, input);
  const free = there.minus(held.quantity);
  if (free.lessThan(quantity)) {
    return {
      ok: false,
      error: free.greaterThan(0)
        ? `Solo hay ${formatStock(free.toString(), product.unitCode)} sin retener aquí.`
        : "No hay nada sin retener aquí.",
    };
  }
  if (unitIds.length > 0) {
    const found = await tx.serialUnit.findMany({
      where: {
        id: { in: unitIds },
        productId: input.productId,
        locationId: input.locationId,
        status: input.status,
      },
      select: { id: true, serial: true },
    });
    if (found.length !== unitIds.length) {
      return {
        ok: false,
        error: "Alguna de esas series ya no está ahí en ese estado.",
      };
    }
    const taken = found.find((unit) => held.unitIds.has(unit.id));
    if (taken) {
      return {
        ok: false,
        error: `La serie ${taken.serial} ya es de ${held.firstText ?? "otro documento"}.`,
      };
    }
  }
  const holdId = newId();
  await tx.stockHold.create({
    data: {
      id: holdId,
      organizationId: actor.organizationId,
      productId: input.productId,
      locationId: input.locationId,
      status: input.status,
      ...lotColumns(input.lotId),
      quantity: quantity.toString(),
      remaining: quantity.toString(),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceText: input.sourceText.slice(0, 40),
      createdByUserId: actor.userId,
    },
  });
  if (unitIds.length > 0) {
    await tx.stockHoldUnit.createMany({
      data: unitIds.map((serialUnitId) => ({
        id: newId(),
        organizationId: actor.organizationId,
        holdId,
        serialUnitId,
      })),
    });
  }
  return { ok: true, holdId };
}

/**
 * Lets go of part of a hold (what its document decided) or all of it
 * (`quantity` omitted: what remains), with the units that leave it.
 * Inside the document's transaction, after its locks. Closes it at 0. A
 * hold of units by serial lets go of part of it only naming exactly that
 * many of its units still held.
 */
export async function releaseHold(
  tx: Tx,
  holdId: string,
  release: { quantity?: Decimal | string; unitIds?: readonly string[] } = {},
): Promise<void> {
  const hold = await tx.stockHold.findFirst({
    where: { id: holdId },
    select: { id: true, remaining: true, state: true },
  });
  if (!hold || hold.state !== "ACTIVE") return;
  const remaining = dec(hold.remaining.toString());
  const quantity =
    release.quantity === undefined
      ? remaining
      : dec(release.quantity.toString());
  if (quantity.greaterThan(remaining) || quantity.lessThan(0)) {
    throw new Error(`Hold ${holdId} cannot release ${quantity.toString()}`);
  }
  const left = remaining.minus(quantity);
  const held = await tx.stockHoldUnit.findMany({
    where: { holdId: hold.id, releasedAt: null },
    select: { serialUnitId: true },
  });
  const named = [...new Set(release.unitIds ?? [])];
  if (held.length > 0 && release.quantity !== undefined) {
    const ids = new Set(held.map((unit) => unit.serialUnitId));
    if (!quantity.equals(named.length) || named.some((id) => !ids.has(id))) {
      throw new Error(`Hold ${holdId} releases units by name`);
    }
  }
  const now = new Date();
  const updated = await tx.stockHold.updateMany({
    where: { id: hold.id, remaining: { gte: quantity.toString() } },
    data: {
      remaining: { decrement: quantity.toString() },
      ...(left.isZero() ? { state: "CLOSED" as const, closedAt: now } : {}),
    },
  });
  if (updated.count !== 1) throw new Error(`Hold ${holdId} changed`);
  const unitWhere =
    release.quantity === undefined
      ? { holdId: hold.id, releasedAt: null }
      : named.length > 0
        ? {
            holdId: hold.id,
            serialUnitId: { in: named },
            releasedAt: null,
          }
        : null;
  if (unitWhere) {
    await tx.stockHoldUnit.updateMany({
      where: unitWhere,
      data: { releasedAt: now },
    });
  }
}

/** Lets go of everything a document still holds (it was cancelled). */
export async function releaseHoldsOf(
  tx: Tx,
  source: HoldSource,
): Promise<void> {
  const holds = await tx.stockHold.findMany({
    where: { ...source, state: "ACTIVE" },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  for (const hold of holds) await releaseHold(tx, hold.id);
}
