import "server-only";

import { dec, newId } from "@/lib";
import { resolveConversion, type Capture } from "@/platform/catalog";
import { activeFacilityOf, assertLocationsInScope } from "@/platform/locations";
import { lockRows, type TenantDb } from "@/server";

import { MAX_BALANCE, formatStock, type InventoryActor } from "./movements";
import { checkPlacement } from "./placement";
import { createContainerPutawayTask, createPutawayTasks } from "./putaway";
import {
  packReceived,
  prepareReceiptContainer,
  type ReceiptContainer,
  type ReceiptContainerInput,
} from "./containers";
import { costPerUnit, lineCost, openCostBook } from "./valuation";
import {
  lockCrossDockOrders,
  sendToWaitingOrders,
  type CrossDockLock,
  type CrossDockSent,
} from "./cross-docking";
import { lotColumns } from "./stock-status";
import { LOT_RULE_SELECT, lotForEntry } from "./lot-resolve";
import {
  serialKey,
  serialsForEntry,
  writeSerialMoves,
  type SerialPick,
} from "./serials";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Decimal = ReturnType<typeof dec>;

/**
 * The entry of stock of a purchase receipt (CMP-07): the movement
 * (`RECEIPT`), its lines and the balances, written inside the transaction
 * of the receipt so that the document and the stock exist together or not
 * at all. Compras calls it after checking its own permission
 * (`purchasing.receipt.create`): receiving does not need the permission of
 * manual entries, nor grants it (matrix, «efectos entre módulos»).
 *
 * Like every movement, it takes the locks of its products and then of the
 * location (the caller may have taken them already: taking them again is
 * harmless) and converts each capture with the content in force now.
 *
 * Each line comes in at its cost (VAL-02, ADR 0031): the cost of one
 * captured unit (one box, from the order line) ÷ the factor in force, and
 * moves the product's average cost. The inventory is valued whoever
 * receives: the cost was set by whoever could record it on the order.
 */
export type ReceiptEntryInput = {
  /** Where it is put; null = the default location, «General». */
  locationId: string | null;
  /**
   * A line may go somewhere else than the rest (CMP-09). `unitCost`: cost
   * of one captured unit (one box) before taxes; null when unknown.
   */
  lines: {
    productId: string;
    capture: Capture;
    locationId?: string | null;
    unitCost?: { toString(): string } | null;
    /**
     * WMS-21: the lot the line arrives in (and its expiry, «2027-03-05»),
     * for a product by lot. Created the first time it is seen.
     */
    lotCode?: string | null;
    lotExpiresOn?: string | null;
    /**
     * WMS-21B: the serial of each unit that arrives (text with one per
     * line, or a list), for a product by serial.
     */
    serials?: unknown;
    /**
     * WMS-54 (ADR 0052): the part that arrived damaged is its own line, in
     * DAMAGED: it is not available, is not put away (no task, not in the
     * container) and never goes to an order. Absent = AVAILABLE.
     */
    status?: "AVAILABLE" | "DAMAGED";
  }[];
  /** «OC-0007 · Remisión 4411»: what people see in the history. */
  reference: string | null;
  reason: string | null;
  /**
   * The person saw that what arrives goes over a capacity the company only
   * warns about, and receives it anyway (WMS-22B).
   */
  acceptCapacity?: boolean;
  /**
   * WMS-53 (ADR 0043): everything arrived in one container (a pallet):
   * its label when it has one (an open one with that code in the same
   * place gets it added), and its kind. Null = loose.
   */
  container?: ReceiptContainerInput | null;
};

export type ReceiptEntryLine = {
  lineNumber: number;
  productId: string;
  locationId: string;
  locationName: string;
  unitCode: string;
  capturedQuantity: Decimal;
  presentationId: string | null;
  presentationVersionId: string | null;
  factor: Decimal;
  baseQuantity: Decimal;
  /** Cost of one unit of the product it came in at (VAL-02); null if unknown. */
  unitCost: Decimal | null;
  /** The lot it came in, for a product by lot (WMS-21). */
  lotId: string | null;
  lotCode: string | null;
  /** The units that came in, for a product by serial (WMS-21B). */
  units: SerialPick[];
  /** AVAILABLE, or DAMAGED for the part that arrived damaged (WMS-54). */
  status: "AVAILABLE" | "DAMAGED";
  /** «3 cajas × 100 = 300 piezas», or «25 piezas». */
  text: string;
};

export type ReceiptEntryResult =
  | {
      ok: true;
      movementId: string;
      locationId: string;
      locationName: string;
      lines: ReceiptEntryLine[];
      /**
       * Locations left above their capacity (WMS-22B), one sentence each,
       * and the put-away tasks created (WMS-52).
       */
      notes: string[];
      /** Put-away tasks created for what arrived (WMS-52). */
      putawayTasks: number;
      /** The container it arrived in (WMS-53), if any. */
      containerId: string | null;
      /** What went straight to waiting orders (WMS-54), by order. */
      crossDock: CrossDockSent[];
    }
  | {
      ok: false;
      /** Position of the line with the problem, or null for the location of the receipt. */
      line: number | null;
      error: string;
      /** The problem is with the lot or its expiry date of that line (WMS-21), or its serials (WMS-21B). */
      field?: "lotCode" | "lotExpiresOn" | "serials";
      /**
       * It only goes over a capacity the company warns about (WMS-22B):
       * the same receipt with `acceptCapacity` goes through.
       */
      overCapacity?: true;
    };

export async function postReceiptEntry(
  tx: Tx,
  actor: InventoryActor,
  input: ReceiptEntryInput,
): Promise<ReceiptEntryResult> {
  const { organizationId, userId } = actor;
  if (input.lines.length === 0) {
    return { ok: false, line: null, error: "No hay nada que recibir." };
  }
  await lockRows(
    tx,
    "product",
    input.lines.map((line) => line.productId),
  );
  // Every location of the receipt at once: lockRows keeps the id order.
  const chosen = [
    ...new Set(
      [input.locationId, ...input.lines.map((line) => line.locationId)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  await lockRows(tx, "location", chosen);

  // Without a location, General of the warehouse the person works in.
  const active = await activeFacilityOf(tx, userId);
  const places = await tx.location.findMany({
    where: {
      OR: [{ id: { in: chosen } }, { isDefault: true, facilityId: active.id }],
    },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      isDefault: true,
      isStaging: true,
      type: true,
      facilityId: true,
    },
  });
  const placeOf = (id: string | null | undefined) =>
    id
      ? places.find((place) => place.id === id)
      : places.find(
          (place) => place.isDefault === true && place.facilityId === active.id,
        );
  const problemOf = (place: (typeof places)[number] | undefined) =>
    !place
      ? "Esa ubicación ya no existe. Elige otra."
      : place.archivedAt
        ? `«${place.name}» está archivada. Elige otra ubicación.`
        : null;
  const location = placeOf(input.locationId);
  // WMS-20: nothing is received into a location outside the person's scope.
  await assertLocationsInScope(tx, userId, [...chosen, location?.id]);
  const locationProblem = problemOf(location);
  if (locationProblem || !location) {
    return {
      ok: false,
      line: null,
      error: locationProblem ?? "Esa ubicación ya no existe. Elige otra.",
    };
  }

  // WMS-54 (ADR 0052): the outbound orders that may wait for what arrives
  // loose and healthy are locked now — after the locations and the
  // purchase order of the caller, before the container and the capacity.
  // What arrives on a pallet goes to put-away whole.
  let crossDock: CrossDockLock = null;
  if (!input.container) {
    const healthy = input.lines.filter((line) => line.status !== "DAMAGED");
    crossDock = await lockCrossDockOrders(tx, actor, {
      productIds: healthy.map((line) => line.productId),
      facilityIds: [
        ...new Set(
          healthy.flatMap((line) => {
            const place = line.locationId ? placeOf(line.locationId) : location;
            return place ? [place.facilityId] : [];
          }),
        ),
      ],
    });
  }

  // WMS-53: a container is in one place, so everything goes there. It is
  // decided (and an existing one locked) before the capacity, whose lock
  // is always the last.
  let box: ReceiptContainer | null = null;
  if (input.container) {
    const elsewhere = input.lines.findIndex(
      (line) => line.locationId && line.locationId !== location.id,
    );
    if (elsewhere >= 0) {
      return {
        ok: false,
        line: elsewhere,
        error:
          "Lo que llega en una tarima va a un solo lugar: recibe esta línea por separado o en el mismo lugar.",
      };
    }
    if (input.lines.every((line) => line.status === "DAMAGED")) {
      return {
        ok: false,
        line: null,
        error:
          "Lo que llega dañado no va en la tarima: recibe sin tarima o con algo sano.",
      };
    }
    const prepared = await prepareReceiptContainer(
      tx,
      actor,
      input.container,
      location,
    );
    if ("error" in prepared) {
      return { ok: false, line: null, error: prepared.error };
    }
    box = prepared;
  }

  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(input.lines.map((l) => l.productId))] } },
    select: {
      id: true,
      name: true,
      sku: true,
      status: true,
      ...LOT_RULE_SELECT,
    },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  const lines: ReceiptEntryLine[] = [];
  // What enters each product in each location: `<product> <location>`.
  const added = new Map<string, Decimal>();
  const arriving = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    const place = line.locationId ? placeOf(line.locationId) : location;
    const placeProblem = problemOf(place);
    if (placeProblem || !place) {
      return {
        ok: false,
        line: index,
        error: placeProblem ?? "Esa ubicación ya no existe. Elige otra.",
      };
    }
    const product = byId.get(line.productId);
    if (!product) {
      return { ok: false, line: index, error: "Este producto ya no existe." };
    }
    if (product.status !== "ACTIVE") {
      return {
        ok: false,
        line: index,
        error: `${product.name} (${product.sku}) está archivado. Reactívalo para recibirlo.`,
      };
    }
    // The content in force now: what entered is what the box holds today.
    const resolved = await resolveConversion(tx, product.id, line.capture);
    if (!resolved.ok) {
      return {
        ok: false,
        line: index,
        error: `${product.name}: ${resolved.error}`,
      };
    }
    const { conversion } = resolved;
    const base = conversion.baseQuantity;
    // WMS-21: under the product's lock; a new lot is born with the receipt.
    const lotAnswer = await lotForEntry(tx, actor, product, line);
    if (!lotAnswer.ok) {
      return {
        ok: false,
        line: index,
        error: lotAnswer.error,
        field: lotAnswer.field === "lotExpiresOn" ? "lotExpiresOn" : "lotCode",
      };
    }
    const lot = lotAnswer.lot;
    // WMS-21B: a product by serial names each unit that arrives; a serial
    // already in stock (or twice in this receipt) is refused by name.
    const serialAnswer = await serialsForEntry(tx, product, line.serials, base);
    if (!serialAnswer.ok) {
      return {
        ok: false,
        line: index,
        error: serialAnswer.error,
        field: "serials",
      };
    }
    const units = serialAnswer.units ?? [];
    const twice = units.find((unit) =>
      arriving.has(`${product.id} ${serialKey(unit.serial)}`),
    );
    if (twice) {
      return {
        ok: false,
        line: index,
        error: `La serie ${twice.serial} ya está en otra línea de esta recepción.`,
        field: "serials",
      };
    }
    for (const unit of units) {
      arriving.add(`${product.id} ${serialKey(unit.serial)}`);
    }
    const status = line.status === "DAMAGED" ? "DAMAGED" : "AVAILABLE";
    const slot = `${product.id} ${place.id} ${lot?.id ?? ""} ${status}`;
    added.set(slot, (added.get(slot) ?? dec(0)).plus(base));
    lines.push({
      lineNumber: index + 1,
      productId: product.id,
      locationId: place.id,
      locationName: place.name,
      unitCode: resolved.product.unitCode,
      capturedQuantity: conversion.capturedQuantity,
      presentationId: conversion.presentation?.id ?? null,
      presentationVersionId: conversion.presentation?.versionId ?? null,
      factor: conversion.factor,
      baseQuantity: base,
      unitCost: costPerUnit(line.unitCost?.toString(), conversion.factor),
      lotId: lot?.id ?? null,
      lotCode: lot?.code ?? null,
      units,
      status,
      text: conversion.presentation
        ? conversion.preview
        : formatStock(base.toString(), resolved.product.unitCode),
    });
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
  const slotOf = (line: {
    productId: string;
    locationId: string;
    lotId: string | null;
    status: string;
  }) =>
    `${line.productId} ${line.locationId} ${line.lotId ?? ""} ${line.status}`;
  const current = new Map(
    balances.map((row) => [
      `${row.productId} ${row.locationId} ${row.lotKey} ${row.status}`,
      row,
    ]),
  );
  for (const [slot, quantity] of added) {
    const before = dec(current.get(slot)?.quantity.toString() ?? 0);
    if (before.plus(quantity).greaterThan(MAX_BALANCE)) {
      return {
        ok: false,
        line: lines.findIndex((line) => slotOf(line) === slot),
        error:
          "Con esa cantidad el saldo sería demasiado grande. Revisa lo recibido.",
      };
    }
  }

  // WMS-22B: every destination must admit its product (always) and have
  // room for what arrives (as the company decided). All the lines at once:
  // two lines to the same place count together.
  const placed = await checkPlacement(
    tx,
    lines.map((line) => ({
      productId: line.productId,
      quantity: line.baseQuantity,
      toLocationId: line.locationId,
      status: line.status,
    })),
    { mode: "ask", accepted: input.acceptCapacity === true },
  );
  if (!placed.ok) {
    return {
      ok: false,
      line: placed.index,
      error: placed.message,
      ...(placed.reason === "over_capacity" && !placed.blocked
        ? { overCapacity: true as const }
        : {}),
    };
  }

  // Read before any balance changes: the stock all locations had.
  const costs = await openCostBook(
    tx,
    organizationId,
    lines.map((line) => line.productId),
  );
  for (const line of lines) {
    line.unitCost = costs.entry(
      line.productId,
      line.baseQuantity,
      line.unitCost,
    );
  }

  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "RECEIPT",
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
      direction: "IN" as const,
      units: line.units,
    })),
  );
  await tx.stockMovementLine.createMany({
    data: lines.map((line, index) => ({
      id: lineIds[index]!,
      organizationId,
      movementId,
      lineNumber: line.lineNumber,
      productId: line.productId,
      locationId: line.locationId,
      direction: "IN" as const,
      capturedQuantity: line.capturedQuantity.toString(),
      presentationId: line.presentationId,
      presentationVersionId: line.presentationVersionId,
      factor: line.factor.toString(),
      baseQuantity: line.baseQuantity.toString(),
      unitCode: line.unitCode,
      ...lotColumns(line.lotId),
      status: line.status,
      unitCost: lineCost(line.unitCost),
    })),
  });
  await costs.save();
  for (const [slot, quantity] of added) {
    const row = current.get(slot);
    const [productId, locationId, lotKey = "", status] = slot.split(" ") as [
      string,
      string,
      string,
      "AVAILABLE" | "DAMAGED",
    ];
    if (row) {
      await tx.stockBalance.updateMany({
        where: { id: row.id },
        data: { quantity: { increment: quantity.toString() } },
      });
    } else {
      await tx.stockBalance.create({
        data: {
          id: newId(),
          organizationId,
          productId,
          locationId,
          ...lotColumns(lotKey || null),
          status,
          quantity: quantity.toString(),
        },
      });
    }
  }
  // WMS-53: everything that arrived goes into its container, now that its
  // balances exist; and the container is what gets put away (one task).
  if (box) {
    const packed = await packReceived(
      tx,
      actor,
      box,
      location.id,
      // WMS-54: what arrived damaged stays loose, out of the pallet.
      lines
        .filter((line) => line.status === "AVAILABLE")
        .map((line) => ({
          productId: line.productId,
          lotId: line.lotId,
          quantity: line.baseQuantity,
          units: line.units,
        })),
    );
    const task = await createContainerPutawayTask(
      tx,
      actor,
      packed.containerId,
    );
    return {
      ok: true,
      movementId,
      locationId: location.id,
      locationName: location.name,
      lines,
      notes: [...placed.notes, packed.note, ...(task ? [task.note] : [])],
      putawayTasks: task ? 1 : 0,
      containerId: packed.containerId,
      crossDock: [],
    };
  }
  // WMS-54: what waiting orders take goes straight to them, before the
  // put-away tasks, which cover only what is left.
  const sentToOrders = await sendToWaitingOrders(
    tx,
    actor,
    crossDock,
    lines.map((line) => ({
      productId: line.productId,
      locationId: line.locationId,
      lotId: line.lotId,
      quantity: line.baseQuantity,
      status: line.status,
    })),
    movementId,
  );
  // WMS-52: what arrived at a place «de paso» gets its put-away tasks,
  // when the company works that way: nothing stays there without one.
  const putaway = await createPutawayTasks(
    tx,
    actor,
    lines.map((line, index) => ({
      productId: line.productId,
      locationId: line.locationId,
      lotId: line.lotId,
      quantity: line.baseQuantity.minus(sentToOrders.sent[index]!),
      status: line.status,
    })),
  );
  return {
    ok: true,
    movementId,
    locationId: location.id,
    locationName: location.name,
    lines,
    notes: [
      ...placed.notes,
      ...sentToOrders.notes,
      ...(putaway.note ? [putaway.note] : []),
    ],
    putawayTasks: putaway.tasks.length,
    containerId: null,
    crossDock: sentToOrders.orders,
  };
}
