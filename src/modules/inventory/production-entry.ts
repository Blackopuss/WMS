import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import { lockRows, type TenantDb } from "@/server";

import { containedAt } from "./contained";
import { heldStock } from "./holds";
import { LOT_RULE_SELECT, lotForEntry } from "./lot-resolve";
import { lotDayOf } from "./lot-rules";
import { MAX_BALANCE, formatStock, type InventoryActor } from "./movements";
import { pickSources } from "./picking";
import { checkPlacement } from "./placement";
import { PRODUCTION_ORDER_LINE_SOURCE } from "./reservation-sources";
import { consumeReservation, freeToTake, reserveStock } from "./reservations";
import { parseSerialList, serialCountProblem } from "./serial-rules";
import {
  heldByTasks,
  serialKey,
  serialsForEntry,
  serialsForTake,
  serialsOfLines,
  writeSerialMoves,
  type SerialPick,
} from "./serials";
import { lotColumns } from "./stock-status";
import { OPEN_TASK_STATUSES } from "./task-states";
import { lineCost, openCostBook } from "./valuation";

/**
 * The stock side of a production report (WMS-29, ADR 0087): where each
 * material is taken from, the PRODUCTION movement (materials out, what was
 * made in inspection in the area) and its reversal. Inventario does not
 * know Producción: it receives plain data. Everything runs inside the
 * caller's transaction, after its locks of products and of the order
 * (taking the products again here is harmless); locations are locked here,
 * then the capacity of the area.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const minOf = (a: Decimal, b: Decimal) => (a.lessThan(b) ? a : b);

export type MaterialTake = {
  productId: string;
  locationId: string;
  lotId: string | null;
  quantity: Decimal;
  units: SerialPick[];
  /** The reservations of the order line this take uses up. */
  reservations: { id: string; quantity: Decimal }[];
  /** Out of `quantity`, how much was set aside for the order. */
  reserved: Decimal;
};

export type MaterialPlan =
  | { ok: true; takes: MaterialTake[] }
  | {
      ok: false;
      /** What the person reaches of this material (set aside + free). */
      reachable: Decimal;
      /** A problem with the serials typed (not a shortage). */
      error?: string;
    };

export type MaterialPlanInput = {
  /** The production order line (source of its reservations). */
  lineId: string;
  product: { id: string; name: string; unitCode: string; tracking: string };
  quantity: Decimal;
  facilityId: string;
  /** The scope of who reports (`locationScopeWhere`), or null: no limit. */
  within: object | null;
  /**
   * With `production.materials.mode = issue`: what is FREE is taken only in
   * the area (and inside it). Null: wherever it is. What is set aside for
   * the line does not depend on it (ADR 0087, «De dónde, sin depender del
   * ajuste»): it is taken wherever it is, except what an open ISSUE task
   * still has to carry.
   */
  onlyIn: ReadonlySet<string> | null;
  /** The area and what is inside it: set aside there is taken first. */
  area: ReadonlySet<string>;
  /** For a material by serial: the serials used. */
  serials?: unknown;
};

const placeWhere = (input: MaterialPlanInput) => ({
  facilityId: input.facilityId,
  archivedAt: null,
  isTransit: null,
  ...(input.within ?? {}),
});

type LineReservation = {
  id: string;
  locationId: string;
  lotId: string | null;
  /** What is left of it that no open ISSUE task still has to carry. */
  usable: Decimal;
  expiresOn: Date | null;
};

/**
 * What is set aside for an order line within reach, minus what its open
 * ISSUE tasks still have to carry from there (their origin, product and
 * lot). Decided by what the order has, never by the company's current
 * `production.materials.mode`: an order released in either mode keeps
 * producing after the setting changes, and an ISSUE task always finds what
 * it carries when it is delivered.
 */
async function lineReservations(
  tx: Tx,
  input: MaterialPlanInput,
): Promise<LineReservation[]> {
  const [reservations, tasks] = await Promise.all([
    tx.stockReservation.findMany({
      where: {
        sourceType: PRODUCTION_ORDER_LINE_SOURCE,
        sourceId: input.lineId,
        state: "ACTIVE",
        productId: input.product.id,
        location: placeWhere(input),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        locationId: true,
        lotId: true,
        remaining: true,
        lot: { select: { expiresOn: true } },
      },
    }),
    tx.warehouseTask.findMany({
      where: {
        kind: "ISSUE",
        productionOrderLineId: input.lineId,
        status: { in: [...OPEN_TASK_STATUSES] },
      },
      select: { fromLocationId: true, lotId: true, quantity: true },
    }),
  ]);
  const carried = new Map<string, Decimal>();
  for (const task of tasks) {
    const slot = `${task.fromLocationId} ${task.lotId ?? ""}`;
    carried.set(
      slot,
      (carried.get(slot) ?? dec(0)).plus((task.quantity ?? 0).toString()),
    );
  }
  const rows: LineReservation[] = [];
  for (const reservation of reservations) {
    const slot = `${reservation.locationId} ${reservation.lotId ?? ""}`;
    let usable = dec(reservation.remaining.toString());
    const backing = carried.get(slot);
    if (backing?.greaterThan(0)) {
      const kept = minOf(usable, backing);
      carried.set(slot, backing.minus(kept));
      usable = usable.minus(kept);
    }
    if (!usable.greaterThan(0)) continue;
    rows.push({
      id: reservation.id,
      locationId: reservation.locationId!,
      lotId: reservation.lotId,
      usable,
      expiresOn: reservation.lot?.expiresOn ?? null,
    });
  }
  return rows;
}

/**
 * Where a quantity of one material is taken from: first what is set aside
 * for its order line within reach (what expires first first, then in the
 * area), never what is in a storage container; then what is free
 * (`pickSources`). A material by serial: the units typed decide. Reads
 * only: under the product's lock it decides, outside it it answers a
 * preview.
 */
export async function planMaterialTakes(
  tx: Tx,
  input: MaterialPlanInput,
): Promise<MaterialPlan> {
  if (input.product.tracking === "SERIAL") return planSerialTakes(tx, input);
  const wanted = input.quantity;
  const reservations = await lineReservations(tx, input);
  reservations.sort((a, b) => {
    const ea = lotDayOf(a.expiresOn) ?? "9999-99-99";
    const eb = lotDayOf(b.expiresOn) ?? "9999-99-99";
    if (ea !== eb) return ea < eb ? -1 : 1;
    const ia = input.area.has(a.locationId) ? 0 : 1;
    const ib = input.area.has(b.locationId) ? 0 : 1;
    if (ia !== ib) return ia - ib;
    return a.locationId < b.locationId
      ? -1
      : a.locationId > b.locationId
        ? 1
        : a.id < b.id
          ? -1
          : 1;
  });
  const takes = new Map<string, MaterialTake>();
  const looseLeft = new Map<string, Decimal>();
  let left = wanted;
  let reachable = dec(0);
  for (const reservation of reservations) {
    const locationId = reservation.locationId;
    const slot = `${locationId} ${reservation.lotId ?? ""}`;
    if (!looseLeft.has(slot)) {
      const balance = await tx.stockBalance.findFirst({
        where: {
          productId: input.product.id,
          locationId,
          status: "AVAILABLE",
          lotKey: reservation.lotId ?? "",
        },
        select: { quantity: true },
      });
      const contained = await containedAt(
        tx,
        input.product.id,
        locationId,
        reservation.lotId,
        { storageOnly: true },
      );
      const loose = dec(balance?.quantity.toString() ?? 0).minus(contained);
      looseLeft.set(slot, loose.isNegative() ? dec(0) : loose);
    }
    const usable = minOf(reservation.usable, looseLeft.get(slot)!);
    if (!usable.greaterThan(0)) continue;
    reachable = reachable.plus(usable);
    if (!left.greaterThan(0)) continue;
    const take = minOf(usable, left);
    looseLeft.set(slot, looseLeft.get(slot)!.minus(take));
    left = left.minus(take);
    const current = takes.get(slot) ?? {
      productId: input.product.id,
      locationId,
      lotId: reservation.lotId,
      quantity: dec(0),
      units: [],
      reservations: [],
      reserved: dec(0),
    };
    current.quantity = current.quantity.plus(take);
    current.reserved = current.reserved.plus(take);
    current.reservations.push({ id: reservation.id, quantity: take });
    takes.set(slot, current);
  }
  // Then what is free, by the rule of picking (what expires first first).
  const staging = await tx.location.findFirst({
    where: { facilityId: input.facilityId, isStaging: true },
    select: { id: true },
  });
  const within = {
    AND: [
      input.within ?? {},
      input.onlyIn ? { id: { in: [...input.onlyIn] } } : {},
    ],
  };
  if (left.greaterThan(0)) {
    const free = await pickSources(tx, input.product.id, left, {
      stagingId: staging?.id ?? "",
      facilityId: input.facilityId,
      within,
    });
    for (const source of free) {
      const slot = `${source.locationId} ${source.lotId ?? ""}`;
      const current = takes.get(slot) ?? {
        productId: input.product.id,
        locationId: source.locationId,
        lotId: source.lotId,
        quantity: dec(0),
        units: [],
        reservations: [],
        reserved: dec(0),
      };
      current.quantity = current.quantity.plus(source.quantity);
      takes.set(slot, current);
      reachable = reachable.plus(source.quantity);
      left = left.minus(source.quantity);
    }
  }
  if (left.greaterThan(0)) {
    // What else is free (beyond what was asked) does not matter: short.
    return { ok: false, reachable };
  }
  return { ok: true, takes: [...takes.values()] };
}

/**
 * What a person reaches of a material (set aside for the line + free), to
 * say «alcanza para». Reads only.
 */
export async function reachableMaterial(
  tx: Tx,
  input: Omit<MaterialPlanInput, "quantity" | "serials">,
): Promise<Decimal> {
  const asked = await planMaterialTakes(tx, {
    ...input,
    product: { ...input.product, tracking: "NONE" },
    quantity: dec("999999999.999"),
  });
  return asked.ok
    ? asked.takes.reduce((sum, take) => sum.plus(take.quantity), dec(0))
    : asked.reachable;
}

async function planSerialTakes(
  tx: Tx,
  input: MaterialPlanInput,
): Promise<MaterialPlan> {
  const fail = (error: string): MaterialPlan => ({
    ok: false,
    reachable: dec(0),
    error,
  });
  const list = parseSerialList(input.serials);
  if (!list.ok) return fail(`${input.product.name}: ${list.error}`);
  const count = serialCountProblem(
    list.serials.length,
    input.quantity,
    "salen",
  );
  if (count) return fail(`${input.product.name}: ${count}`);
  // Set aside for the line (minus what open ISSUE tasks carry) is taken
  // wherever it is; free units, only in the area with `issue`.
  const setAside = await lineReservations(tx, input);
  const allowed = input.onlyIn
    ? [...new Set([...input.onlyIn, ...setAside.map((row) => row.locationId)])]
    : null;
  const units = await tx.serialUnit.findMany({
    where: {
      productId: input.product.id,
      serial: { in: list.serials },
      status: "AVAILABLE",
      location: {
        ...placeWhere(input),
        ...(allowed ? { id: { in: allowed } } : {}),
      },
    },
    select: { id: true, serial: true, locationId: true },
  });
  const found = new Map(units.map((unit) => [serialKey(unit.serial), unit]));
  const missing = list.serials.find((serial) => !found.has(serialKey(serial)));
  if (missing) {
    return fail(
      `La serie ${missing} de ${input.product.name} no está disponible ${input.onlyIn ? "en el área de producción" : "a tu alcance"}. Revisa la etiqueta.`,
    );
  }
  const byPlace = new Map<string, string[]>();
  for (const serial of list.serials) {
    const unit = found.get(serialKey(serial))!;
    const group = byPlace.get(unit.locationId!) ?? [];
    group.push(unit.serial);
    byPlace.set(unit.locationId!, group);
  }
  const takes: MaterialTake[] = [];
  let freeTotal = dec(0);
  for (const [locationId, serials] of byPlace) {
    const place = await tx.location.findFirst({
      where: { id: locationId },
      select: { name: true },
    });
    const quantity = dec(serials.length);
    const answer = await serialsForTake(
      tx,
      input.product,
      serials,
      quantity,
      { locationId, locationName: place?.name ?? "", status: "AVAILABLE" },
      { verb: "salen" },
    );
    if (!answer.ok) return fail(answer.error);
    const reservations = setAside.filter(
      (row) => row.locationId === locationId,
    );
    let left = quantity;
    const used: { id: string; quantity: Decimal }[] = [];
    for (const reservation of reservations) {
      if (!left.greaterThan(0)) break;
      const take = minOf(reservation.usable, left);
      used.push({ id: reservation.id, quantity: take });
      left = left.minus(take);
    }
    if (left.greaterThan(0) && input.onlyIn && !input.onlyIn.has(locationId)) {
      // With `issue`, outside the area only what is set aside there with no
      // task behind it is taken; free units only in the area. Short, like a
      // material without serials (ADR 0087).
      return { ok: false, reachable: input.quantity.minus(left) };
    }
    if (left.greaterThan(0)) {
      const free = await freeToTake(tx, input.product.id, locationId, null);
      if (free.lessThan(left)) {
        return fail(
          `Las series de ${input.product.name} en ${place?.name ?? "esa ubicación"} están apartadas para otro documento: usa otras unidades.`,
        );
      }
      freeTotal = freeTotal.plus(left);
    }
    takes.push({
      productId: input.product.id,
      locationId,
      lotId: null,
      quantity,
      units: answer.units ?? [],
      reservations: used,
      reserved: quantity.minus(left),
    });
  }
  if (
    freeTotal.greaterThan(0) &&
    (await freeToTake(tx, input.product.id, null)).lessThan(freeTotal)
  ) {
    return fail(
      `Parte de ${input.product.name} está apartada para otros documentos: usa unidades apartadas para esta orden.`,
    );
  }
  return { ok: true, takes };
}

export type ProductionOutputInput = {
  productId: string;
  quantity: Decimal;
  /** Its share of the cost in the recipe (percent). */
  costShare: string;
  /** For a product by lot: the code the report gives it. */
  lotCode: string | null;
  lotExpiresOn: string | null;
  serials?: unknown;
};

export type ProductionEntryResult =
  | {
      ok: true;
      movementId: string;
      /** Ids of the lines of the takes, in their order. */
      takeLineIds: string[];
      outputs: {
        lineId: string | null;
        lotId: string | null;
        lotCode: string | null;
        units: SerialPick[];
        unitCost: Decimal | null;
      }[];
      /** Value of the materials (null when one had no known cost). */
      value: Decimal | null;
      notes: string[];
    }
  | {
      ok: false;
      error: string;
      /** The output with the problem, if it is one. */
      output?: number;
      field?: "lotExpiresOn" | "serials";
    };

/**
 * Writes the PRODUCTION movement of a report: every take out (available,
 * using up its reservations first) and every output with a quantity in, in
 * inspection, in the area, with its lot and serials; values the outputs
 * with the materials (ADR 0087, section «Costo»). Nothing is written when
 * something is refused.
 */
export async function postProduction(
  tx: Tx,
  actor: InventoryActor,
  input: {
    takes: MaterialTake[];
    outputs: ProductionOutputInput[];
    areaId: string;
    reference: string;
    idempotencyKey: string;
    /**
     * The codes of the lots made, by product, asked after the locations
     * and the capacity (the caller's numbering lock goes there).
     */
    lotCodes?: () => Promise<Map<string, string>>;
  },
): Promise<ProductionEntryResult> {
  const { organizationId, userId } = actor;
  const productIds = [
    ...input.takes.map((take) => take.productId),
    ...input.outputs.map((output) => output.productId),
  ];
  await lockRows(tx, "product", productIds);
  // WMS-82: every location stock enters or leaves is locked, then read.
  await lockRows(tx, "location", [
    input.areaId,
    ...input.takes.map((take) => take.locationId),
  ]);
  const places = await tx.location.findMany({
    where: {
      id: { in: [input.areaId, ...input.takes.map((t) => t.locationId)] },
    },
    select: { id: true, name: true, archivedAt: true },
  });
  const placeOf = new Map(places.map((place) => [place.id, place]));
  const area = placeOf.get(input.areaId);
  if (!area || area.archivedAt) {
    return {
      ok: false,
      error: "El área de producción está archivada: no entra nada ahí.",
    };
  }
  for (const take of input.takes) {
    const place = placeOf.get(take.locationId);
    if (!place || place.archivedAt) {
      return {
        ok: false,
        error: `${place?.name ?? "Una ubicación"} está archivada: no sale material de ahí.`,
      };
    }
  }

  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(productIds)] } },
    select: {
      id: true,
      name: true,
      unitCode: true,
      status: true,
      ...LOT_RULE_SELECT,
    },
  });
  const productOf = new Map(products.map((row) => [row.id, row]));

  // What comes in: its lot (born with the report) and its serials.
  const entering = input.outputs
    .map((output, index) => ({ output, index }))
    .filter(({ output }) => output.quantity.greaterThan(0));
  const outputs: {
    lineId: string | null;
    lotId: string | null;
    lotCode: string | null;
    units: SerialPick[];
    unitCost: Decimal | null;
  }[] = input.outputs.map(() => ({
    lineId: null,
    lotId: null,
    lotCode: null,
    units: [],
    unitCost: null,
  }));
  for (const { output, index } of entering) {
    const product = productOf.get(output.productId);
    if (!product) return { ok: false, error: "Un producto ya no existe." };
    if (product.status !== "ACTIVE") {
      return {
        ok: false,
        output: index,
        error: `${product.name} está archivado: no entra al almacén.`,
      };
    }
    const units = await serialsForEntry(
      tx,
      product,
      output.serials,
      output.quantity,
    );
    if (!units.ok) {
      return { ok: false, output: index, field: "serials", error: units.error };
    }
    outputs[index]!.units = units.units ?? [];
  }

  // WMS-22B: the area must admit what comes in (restrictions stop); the
  // capacity is only said (lock: capacity after the locations).
  const placed = await checkPlacement(
    tx,
    entering.map(({ output }) => ({
      productId: output.productId,
      quantity: output.quantity,
      toLocationId: input.areaId,
      status: "INSPECTION" as const,
    })),
    { mode: "report" },
  );
  if (!placed.ok) {
    return {
      ok: false,
      output: entering[placed.index]?.index,
      error: placed.message,
    };
  }

  // The codes of the lots, as late as possible (ADR 0087: the caller may
  // take the lock of the company's numbering here, after the capacity).
  const codes = input.lotCodes ? await input.lotCodes() : null;
  for (const { output, index } of entering) {
    const product = productOf.get(output.productId)!;
    const lot = await lotForEntry(tx, actor, product, {
      lotCode:
        product.tracking === "LOT"
          ? (codes?.get(output.productId) ?? output.lotCode)
          : null,
      lotExpiresOn: product.tracking === "LOT" ? output.lotExpiresOn : null,
    });
    if (!lot.ok) {
      return {
        ok: false,
        output: index,
        field: "lotExpiresOn",
        error: lot.error,
      };
    }
    outputs[index]!.lotId = lot.lot?.id ?? null;
    outputs[index]!.lotCode = lot.lot?.code ?? null;
    const balance = await tx.stockBalance.findFirst({
      where: {
        productId: product.id,
        locationId: input.areaId,
        status: "INSPECTION",
        lotKey: lot.lot?.id ?? "",
      },
      select: { quantity: true },
    });
    if (
      dec(balance?.quantity.toString() ?? 0)
        .plus(output.quantity)
        .greaterThan(MAX_BALANCE)
    ) {
      return {
        ok: false,
        output: index,
        error: "Con esa cantidad el saldo sería demasiado grande.",
      };
    }
  }

  // Cost (ADR 0031, 0087): read before any balance changes.
  const costs = await openCostBook(tx, organizationId, productIds);
  let value: Decimal | null = dec(0);
  const takeCosts = input.takes.map((take) => {
    const cost = costs.exit(take.productId, take.quantity);
    if (cost === null) value = null;
    else if (value !== null) value = value.plus(cost.times(take.quantity));
    return cost;
  });
  const shareTotal = entering.reduce(
    (sum, { output }) => sum.plus(dec(output.costShare)),
    dec(0),
  );
  for (const [position, { output, index }] of entering.entries()) {
    let unitCost: Decimal | null = null;
    if (value !== null) {
      const part = shareTotal.isZero()
        ? position === 0
          ? value
          : dec(0)
        : (value as Decimal).times(dec(output.costShare)).dividedBy(shareTotal);
      unitCost = part.dividedBy(output.quantity);
    }
    outputs[index]!.unitCost = costs.entry(
      output.productId,
      output.quantity,
      unitCost,
    );
  }

  // What was set aside is used up first (the order's reservations).
  for (const take of input.takes) {
    for (const reservation of take.reservations) {
      await consumeReservation(tx, reservation.id, reservation.quantity);
    }
  }

  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "PRODUCTION",
      reference: input.reference.slice(0, 120),
      idempotencyKey: input.idempotencyKey,
      createdByUserId: userId,
    },
  });
  const takeLineIds = input.takes.map(() => newId());
  for (const { index } of entering) outputs[index]!.lineId = newId();
  await writeSerialMoves(tx, actor, [
    ...input.takes.map((take, index) => ({
      lineId: takeLineIds[index]!,
      productId: take.productId,
      locationId: take.locationId,
      status: "AVAILABLE" as const,
      direction: "OUT" as const,
      units: take.units,
    })),
    ...entering.map(({ output, index }) => ({
      lineId: outputs[index]!.lineId!,
      productId: output.productId,
      locationId: input.areaId,
      status: "INSPECTION" as const,
      direction: "IN" as const,
      units: outputs[index]!.units,
    })),
  ]);
  let lineNumber = 0;
  await tx.stockMovementLine.createMany({
    data: [
      ...input.takes.map((take, index) => ({
        id: takeLineIds[index]!,
        organizationId,
        movementId,
        lineNumber: ++lineNumber,
        productId: take.productId,
        locationId: take.locationId,
        direction: "OUT" as const,
        capturedQuantity: take.quantity.toString(),
        factor: "1",
        baseQuantity: take.quantity.toString(),
        unitCode: productOf.get(take.productId)!.unitCode,
        ...lotColumns(take.lotId),
        status: "AVAILABLE" as const,
        unitCost: lineCost(takeCosts[index]!),
      })),
      ...entering.map(({ output, index }) => ({
        id: outputs[index]!.lineId!,
        organizationId,
        movementId,
        lineNumber: ++lineNumber,
        productId: output.productId,
        locationId: input.areaId,
        direction: "IN" as const,
        capturedQuantity: output.quantity.toString(),
        factor: "1",
        baseQuantity: output.quantity.toString(),
        unitCode: productOf.get(output.productId)!.unitCode,
        ...lotColumns(outputs[index]!.lotId),
        status: "INSPECTION" as const,
        unitCost: lineCost(outputs[index]!.unitCost),
      })),
    ],
  });
  await costs.save();
  // Balances: out, conditioned like every exit (the CHECK is the last line).
  const out = new Map<string, Decimal>();
  for (const take of input.takes) {
    const slot = `${take.productId} ${take.locationId} ${take.lotId ?? ""}`;
    out.set(slot, (out.get(slot) ?? dec(0)).plus(take.quantity));
  }
  for (const [slot, quantity] of out) {
    const [productId, locationId, lotKey = ""] = slot.split(" ") as [
      string,
      string,
      string,
    ];
    const updated = await tx.stockBalance.updateMany({
      where: {
        productId,
        locationId,
        status: "AVAILABLE",
        lotKey,
        quantity: { gte: quantity.toString() },
      },
      data: { quantity: { decrement: quantity.toString() } },
    });
    if (updated.count !== 1) {
      throw new Error(`Balance changed under its lock: ${slot}`);
    }
  }
  for (const { output, index } of entering) {
    await addBalance(tx, organizationId, {
      productId: output.productId,
      locationId: input.areaId,
      lotId: outputs[index]!.lotId,
      status: "INSPECTION",
      quantity: output.quantity,
    });
  }
  return {
    ok: true,
    movementId,
    takeLineIds,
    outputs,
    value,
    notes: placed.notes,
  };
}

async function addBalance(
  tx: Tx,
  organizationId: string,
  slot: {
    productId: string;
    locationId: string;
    lotId: string | null;
    status: "AVAILABLE" | "INSPECTION";
    quantity: Decimal;
  },
) {
  const row = await tx.stockBalance.findFirst({
    where: {
      productId: slot.productId,
      locationId: slot.locationId,
      status: slot.status,
      lotKey: slot.lotId ?? "",
    },
    select: { id: true },
  });
  if (row) {
    await tx.stockBalance.updateMany({
      where: { id: row.id },
      data: { quantity: { increment: slot.quantity.toString() } },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        id: newId(),
        organizationId,
        productId: slot.productId,
        locationId: slot.locationId,
        ...lotColumns(slot.lotId),
        status: slot.status,
        quantity: slot.quantity.toString(),
      },
    });
  }
}

export type ProductionReversalResult =
  | { ok: true; movementId: string; notes: string[] }
  | { ok: false; error: string };

/**
 * Undoes the PRODUCTION movement of a report (ADR 0087, «Reversa»): only
 * while everything it made is still untouched in inspection in the area
 * (no hold, nothing taken out of that stock after it). The materials go
 * back available to where they left, at the cost they left with, and what
 * came out of the order's reservations is set aside again (`rereserve`).
 */
export async function reverseProduction(
  tx: Tx,
  actor: InventoryActor,
  input: {
    movementId: string;
    reason: string;
    /** Per line of the movement: set aside again for this order line. */
    rereserve: {
      movementLineId: string;
      sourceId: string;
      quantity: Decimal;
    }[];
  },
): Promise<ProductionReversalResult> {
  const { organizationId, userId } = actor;
  const original = await tx.stockMovement.findFirst({
    where: { id: input.movementId, type: "PRODUCTION" },
    select: {
      id: true,
      reference: true,
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          locationId: true,
          direction: true,
          status: true,
          lotId: true,
          baseQuantity: true,
          unitCode: true,
          unitCost: true,
        },
      },
    },
  });
  if (!original) return { ok: false, error: "Ese movimiento no existe." };
  const lines = original.lines;
  await lockRows(
    tx,
    "product",
    lines.map((line) => line.productId),
  );
  await lockRows(
    tx,
    "location",
    lines.map((line) => line.locationId),
  );
  const places = await tx.location.findMany({
    where: { id: { in: lines.map((line) => line.locationId) } },
    select: { id: true, name: true, archivedAt: true },
  });
  const placeOf = new Map(places.map((place) => [place.id, place]));
  const products = await tx.product.findMany({
    where: { id: { in: lines.map((line) => line.productId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(products.map((row) => [row.id, row.name]));
  const lastLineId = lines.reduce(
    (max, line) => (line.id > max ? line.id : max),
    "",
  );
  const serialsOf = await serialsOfLines(
    tx,
    lines.map((line) => line.id),
  );
  for (const line of lines) {
    const place = placeOf.get(line.locationId);
    const name = nameOf.get(line.productId) ?? "un producto";
    if (!place || place.archivedAt) {
      return {
        ok: false,
        error: `${place?.name ?? "Una ubicación"} está archivada: el reporte ya no se puede revertir.`,
      };
    }
    const units = serialsOf.get(line.id) ?? [];
    if (line.direction === "IN") {
      // What was made: untouched, in inspection, right there.
      const slot = {
        productId: line.productId,
        locationId: line.locationId,
        status: line.status,
        lotId: line.lotId,
      };
      const later = await tx.stockMovementLine.count({
        where: {
          productId: line.productId,
          locationId: line.locationId,
          status: line.status,
          lotKey: line.lotId ?? "",
          direction: "OUT",
          id: { gt: lastLineId },
        },
      });
      const balance = await tx.stockBalance.findFirst({
        where: {
          productId: line.productId,
          locationId: line.locationId,
          status: line.status,
          lotKey: line.lotId ?? "",
        },
        select: { quantity: true },
      });
      const held = await heldStock(tx, slot);
      if (
        later > 0 ||
        dec(balance?.quantity.toString() ?? 0).lessThan(
          line.baseQuantity.toString(),
        ) ||
        held.quantity.greaterThan(0) ||
        held.unitIds.size > 0
      ) {
        return {
          ok: false,
          error: `Lo producido de ${name} ya se movió, se verificó o está retenido: el reporte ya no se revierte. La diferencia la corrige quien verifica.`,
        };
      }
      if (units.length > 0) {
        const now = await tx.serialUnit.findMany({
          where: { id: { in: units.map((unit) => unit.id) } },
          select: {
            serial: true,
            locationId: true,
            status: true,
            containerId: true,
          },
        });
        const gone = now.find(
          (unit) =>
            unit.locationId !== line.locationId ||
            unit.status !== line.status ||
            unit.containerId !== null,
        );
        const taken = await heldByTasks(
          tx,
          units.map((unit) => unit.id),
          null,
        );
        if (gone || taken.length > 0) {
          return {
            ok: false,
            error: `La serie ${gone?.serial ?? taken[0]!.serial} de ${name} ya se movió: el reporte ya no se revierte.`,
          };
        }
      }
    } else if (units.length > 0) {
      const back = await tx.serialUnit.findFirst({
        where: {
          id: { in: units.map((unit) => unit.id) },
          locationId: { not: null },
        },
        select: { serial: true },
      });
      if (back) {
        return {
          ok: false,
          error: `La serie ${back.serial} de ${name} volvió a entrar después: el reporte ya no se revierte.`,
        };
      }
    }
  }
  // What returns must still be admitted where it returns (a restriction
  // stops it; a capacity is only said).
  const placed = await checkPlacement(
    tx,
    lines
      .filter((line) => line.direction === "OUT")
      .map((line) => ({
        productId: line.productId,
        quantity: dec(line.baseQuantity.toString()),
        toLocationId: line.locationId,
        status: "AVAILABLE" as const,
      })),
    { mode: "report" },
  );
  if (!placed.ok) return { ok: false, error: placed.message };

  const costs = await openCostBook(
    tx,
    organizationId,
    lines.map((line) => line.productId),
  );
  const unitCosts = lines.map((line) => {
    const base = dec(line.baseQuantity.toString());
    const at = line.unitCost ? dec(line.unitCost.toString()) : null;
    return line.direction === "IN"
      ? costs.exitAt(line.productId, base, at)
      : costs.entry(line.productId, base, at);
  });
  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "REVERSAL",
      reason: input.reason,
      reference: original.reference,
      reversesMovementId: original.id,
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
      direction: line.direction === "IN" ? ("OUT" as const) : ("IN" as const),
      units: (serialsOf.get(line.id) ?? []).map((unit) => ({
        id: unit.id,
        serial: unit.serial,
      })),
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
      direction: line.direction === "IN" ? ("OUT" as const) : ("IN" as const),
      capturedQuantity: line.baseQuantity.toString(),
      factor: "1",
      baseQuantity: line.baseQuantity.toString(),
      unitCode: line.unitCode,
      ...lotColumns(line.lotId),
      status: line.status,
      unitCost: lineCost(unitCosts[index]!),
    })),
  });
  await costs.save();
  for (const line of lines) {
    const quantity = dec(line.baseQuantity.toString());
    if (line.direction === "IN") {
      const updated = await tx.stockBalance.updateMany({
        where: {
          productId: line.productId,
          locationId: line.locationId,
          status: line.status,
          lotKey: line.lotId ?? "",
          quantity: { gte: quantity.toString() },
        },
        data: { quantity: { decrement: quantity.toString() } },
      });
      if (updated.count !== 1) {
        throw new Error(`Balance changed under its lock: ${line.id}`);
      }
    } else {
      await addBalance(tx, organizationId, {
        productId: line.productId,
        locationId: line.locationId,
        lotId: line.lotId,
        status: "AVAILABLE",
        quantity,
      });
    }
  }
  // Set aside again for the order what came out of its reservations.
  for (const again of input.rereserve) {
    const line = lines.find((each) => each.id === again.movementLineId);
    if (!line || !again.quantity.greaterThan(0)) continue;
    const kept = await reserveStock(tx, actor, {
      productId: line.productId,
      locationId: line.locationId,
      lotId: line.lotId,
      quantity: again.quantity,
      source: { type: PRODUCTION_ORDER_LINE_SOURCE, id: again.sourceId },
    });
    if (!kept.ok) {
      throw new Error(`Returned stock of ${line.productId} not free`);
    }
  }
  return {
    ok: true,
    movementId,
    notes: [
      ...placed.notes,
      ...lines.map(
        (line) =>
          `${line.direction === "IN" ? "salieron" : "volvieron"} ${formatStock(line.baseQuantity.toString(), line.unitCode)} de ${nameOf.get(line.productId) ?? ""}`,
      ),
    ],
  };
}
