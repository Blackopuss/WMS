import "server-only";

import { dec, newId } from "@/lib";
import { parseQuantity } from "@/platform/catalog";
import { locationsOutOfScope } from "@/platform/locations";
import type { TenantDb } from "@/server";

import { checkPlacement, type PlacementRules } from "./placement";
import { lineCost, openCostBook } from "./valuation";
import { availableOfLot, lotColumns } from "./stock-status";
import { LOT_RULE_SELECT, checkLotEntry, lotForEntry } from "./lot-resolve";

/**
 * Initial stock that comes in the file of an import (IMP-09). Each row
 * with stock becomes an `INITIAL` movement with its line and its balance,
 * like a balance captured by hand (INV-18) and with the same two rules:
 * it comes before any other movement of the product, and each location
 * gets it once.
 *
 * Quantities are the ones fixed when the import was confirmed — what was
 * written, the content of the presentation and the result in the
 * product's unit — so a presentation changed while the import runs does
 * not change what enters. Both functions run inside the transaction of
 * the batch, with the product and its locations already locked; nothing
 * here opens another connection.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

export type ImportedStockLine = {
  /** Row of the file. */
  row: number;
  /** Quantity in the product's unit. */
  base: string;
  /** As written in the file. */
  captured: string;
  /** Written in the presentation of the row, not in the unit. */
  inPresentation: boolean;
  locationId: string;
  /** Cost of one unit of the product, before taxes (VAL-03B). */
  unitCost?: string | null;
  /**
   * WMS-21 (ADR 0040): the lot of this stock («L-01») and its expiry
   * («2027-03-05»), for a product by lot. Created the first time it is seen.
   */
  lotCode?: string | null;
  lotExpiresOn?: string | null;
};

/**
 * The expiry of each lot of a product's rows: a lot has one date, and a
 * row may leave it empty when another row gives it (WMS-21).
 */
function lotExpiries(lines: readonly ImportedStockLine[]) {
  const dates = new Map<string, string>();
  for (const line of lines) {
    if (line.lotCode && line.lotExpiresOn && !dates.has(line.lotCode)) {
      dates.set(line.lotCode, line.lotExpiresOn);
    }
  }
  return (line: ImportedStockLine) =>
    line.lotCode ? (dates.get(line.lotCode) ?? null) : null;
}

/** Largest quantity a movement line keeps, captured or in the unit. */
const MAX_BALANCE = "999999999.999";

/**
 * Says why the stock of a product of the file can no longer enter as
 * initial, or null when it can. It writes nothing, and is asked before
 * the product itself is touched: a product whose stock cannot enter is
 * left as it was, whole.
 */
export async function checkImportedStock(
  tx: Tx,
  product: { id: string; unitCode: string; quantityStep: string } | null,
  lines: readonly ImportedStockLine[],
  hasPresentation: boolean,
  /** Who confirmed the file: its stock enters only in their scope (WMS-20). */
  userId: string,
  /**
   * WMS-22B: the rules of the locations of the batch (read once for all its
   * products) and what the row says of the product. Only restrictions are
   * asked — a quarantine location, one limited to other products — and
   * they stop the product; capacity is not: this stock is what there
   * already was, and nobody is there to accept a warning.
   */
  placement?: {
    rules: PlacementRules;
    /** Name of the product in the file, for the refusal. */
    name: string;
    /** Category the row gives the product; null = it does not say. */
    category: string | null;
  },
): Promise<string | null> {
  if (lines.length === 0) return null;
  const ids = [...new Set(lines.map((line) => line.locationId))];
  const slots = new Set(
    lines.map((line) => `${line.locationId}|${line.lotCode ?? ""}`),
  );
  if (slots.size !== lines.length) {
    return "El archivo da dos existencias para la misma ubicación y lote.";
  }
  if (lines.some((line) => line.inPresentation) && !hasPresentation) {
    return "La existencia viene en una presentación que la fila no tiene.";
  }
  const locations = await tx.location.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, archivedAt: true },
  });
  const byId = new Map(locations.map((location) => [location.id, location]));
  const outside = new Set(await locationsOutOfScope(tx, userId, ids));
  for (const line of lines) {
    const location = byId.get(line.locationId);
    if (!location) {
      return `La ubicación de la fila ${line.row} ya no existe.`;
    }
    if (outside.has(location.id)) {
      return `«${location.name}» (fila ${line.row}) ya no está entre los almacenes o zonas de quien confirmó el archivo.`;
    }
    if (location.archivedAt) {
      return `«${location.name}» se archivó después de confirmar: su existencia (fila ${line.row}) ya no puede entrar ahí.`;
    }
    if (
      !dec(line.base).isPositive() ||
      dec(line.base).greaterThan(MAX_BALANCE) ||
      !dec(line.captured).isPositive() ||
      dec(line.captured).greaterThan(MAX_BALANCE)
    ) {
      return `La existencia de la fila ${line.row} no es una cantidad válida.`;
    }
  }
  if (placement) {
    // The category the product will have: the one of the row, or the one
    // it has; a new product without one has none.
    let categoryId: string | null | undefined = product ? undefined : null;
    if (placement.category && placement.rules.restrictions.size > 0) {
      const category = await tx.productCategory.findFirst({
        where: { name: placement.category },
        select: { id: true },
      });
      categoryId = category?.id ?? null;
    }
    const placed = await checkPlacement(
      tx,
      lines.map((line) => ({
        productId: product?.id ?? null,
        categoryId,
        label: placement.name,
        quantity: dec(line.base),
        toLocationId: line.locationId,
        status: "AVAILABLE" as const,
      })),
      { mode: "skip" },
      placement.rules,
    );
    if (!placed.ok) {
      return `${placed.message} (Fila ${lines[placed.index]!.row}).`;
    }
  }
  if (!product) {
    // WMS-21: a product born from the file is without lots.
    const withLot = lines.find((line) => line.lotCode);
    return withLot
      ? `Un producto nuevo entra sin lote, pero la fila ${withLot.row} trae lote. Márcalo «por lote» en su ficha e importa después sus existencias.`
      : null;
  }

  // WMS-21 (ADR 0040): each stock of a product by lot names its lot; any
  // other product never takes one. Asked without writing: the lots are
  // created when the stock is posted.
  const ruled = await tx.product.findFirst({
    where: { id: product.id },
    select: { id: true, sku: true, ...LOT_RULE_SELECT },
  });
  if (!ruled) return "El producto ya no existe.";
  // WMS-21B (ADR 0041): its stock comes in by hand, with its serials.
  if (ruled.tracking === "SERIAL") {
    return "El producto se controla por número de serie: su existencia se captura a mano, con la serie de cada unidad.";
  }
  /** The lot each line goes to: its id, «new» for a lot to create. */
  const lotKeyOf = new Map<ImportedStockLine, string>();
  const expiryOf = lotExpiries(lines);
  for (const line of lines) {
    if (
      line.lotCode &&
      line.lotExpiresOn &&
      line.lotExpiresOn !== expiryOf(line)
    ) {
      return `El lote ${line.lotCode} trae dos caducidades distintas en el archivo (fila ${line.row}).`;
    }
    const checked = await checkLotEntry(
      tx,
      { ...ruled, name: ruled.sku },
      { lotCode: line.lotCode, lotExpiresOn: expiryOf(line) },
    );
    if (!checked.ok) {
      return ruled.tracking === "LOT" && !line.lotCode
        ? `El producto se controla por lote y la fila ${line.row} no dice de qué lote es su existencia.`
        : `Fila ${line.row}: ${checked.error}`;
    }
    lotKeyOf.set(line, checked.lot ? (checked.lot.existing?.id ?? "new") : "");
  }

  // The product is locked: what is read here cannot change under us.
  const moved = await tx.stockMovementLine.findFirst({
    where: { productId: product.id, movement: { type: { not: "INITIAL" } } },
    select: { id: true },
  });
  if (moved) {
    return "El producto ya tiene movimientos: su existencia ya no es «inicial». Corrige la cantidad con un ajuste o un conteo.";
  }
  // Only initial balances are left: one per location and lot, at most.
  const counted = await tx.stockMovementLine.findMany({
    where: { productId: product.id, locationId: { in: ids } },
    take: 500,
    select: { locationId: true, lotKey: true },
  });
  const taken = lines.find((line) =>
    counted.some(
      (earlier) =>
        earlier.locationId === line.locationId &&
        earlier.lotKey === lotKeyOf.get(line),
    ),
  );
  if (taken) {
    return taken.lotCode
      ? `El producto ya tiene saldo inicial del lote ${taken.lotCode} en «${byId.get(taken.locationId)!.name}» (fila ${taken.row}).`
      : `El producto ya tiene saldo inicial en «${byId.get(taken.locationId)!.name}» (fila ${taken.row}).`;
  }
  // The file was read with the rule a new product of that unit gets; a
  // product that exists may measure in other steps.
  for (const line of lines) {
    const parsed = parseQuantity(
      { unitCode: product.unitCode, quantityStep: product.quantityStep },
      line.base,
    );
    if (!parsed.ok) {
      return `Existencia de la fila ${line.row}: ${parsed.error}`;
    }
  }
  return null;
}

/**
 * Writes the initial stock of a product of the file: one movement, one
 * line and the balance per location. Call it only after
 * `checkImportedStock` said it can enter, in the same transaction that
 * marks the item as applied — that mark is what keeps a retry from
 * writing it twice, and the key of each movement is the second guard.
 */
export async function postImportedStock(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  input: {
    /** Item of the import: with the line number, the key of each movement. */
    itemId: string;
    product: { id: string; unitCode: string };
    /** Presentation of the row and the version with the confirmed content. */
    presentation: { id: string; versionId: string; content: string } | null;
    lines: readonly ImportedStockLine[];
  },
): Promise<{ movements: number }> {
  const { organizationId, userId } = actor;
  const { product, presentation } = input;
  const ruled = await tx.product.findFirst({
    where: { id: product.id },
    select: { id: true, name: true, ...LOT_RULE_SELECT },
  });
  if (!ruled) throw new Error(`Imported product ${product.id} is gone`);
  // VAL-03B: read before any balance changes, under the product's lock.
  const costs = await openCostBook(tx, organizationId, [product.id]);
  const expiryOf = lotExpiries(input.lines);
  let number = 0;
  for (const line of input.lines) {
    number++;
    // WMS-21: `checkImportedStock` already said it can; a new lot is born
    // here, with the movement that brings its stock.
    const lotAnswer = await lotForEntry(tx, actor, ruled, {
      lotCode: line.lotCode,
      lotExpiresOn: expiryOf(line),
    });
    if (!lotAnswer.ok) {
      throw new Error(`Lot of imported row ${line.row}: ${lotAnswer.error}`);
    }
    const lotId = lotAnswer.lot?.id ?? null;
    const unitCost = costs.entry(product.id, line.base, line.unitCost ?? null);
    const inPresentation = line.inPresentation && presentation !== null;
    const movementId = newId();
    await tx.stockMovement.create({
      data: {
        id: movementId,
        organizationId,
        type: "INITIAL",
        reference: `Importación, fila ${line.row}`,
        idempotencyKey: `import:${input.itemId}:${number}`,
        createdByUserId: userId,
      },
    });
    await tx.stockMovementLine.create({
      data: {
        id: newId(),
        organizationId,
        movementId,
        lineNumber: 1,
        productId: product.id,
        locationId: line.locationId,
        direction: "IN",
        // What the file said, with the content it was confirmed with.
        capturedQuantity: inPresentation
          ? dec(line.captured).toString()
          : line.base,
        capturedUnitCode: null,
        presentationId: inPresentation ? presentation.id : null,
        presentationVersionId: inPresentation ? presentation.versionId : null,
        factor: inPresentation ? presentation.content : "1",
        baseQuantity: line.base,
        unitCode: product.unitCode,
        ...lotColumns(lotId),
        unitCost: lineCost(unitCost),
      },
    });
    const added = await tx.stockBalance.updateMany({
      where: {
        productId: product.id,
        locationId: line.locationId,
        ...availableOfLot(lotId),
      },
      data: { quantity: { increment: line.base } },
    });
    if (added.count === 0) {
      await tx.stockBalance.create({
        data: {
          id: newId(),
          organizationId,
          productId: product.id,
          locationId: line.locationId,
          ...lotColumns(lotId),
          quantity: line.base,
        },
      });
    }
  }
  await costs.save();
  return { movements: number };
}
