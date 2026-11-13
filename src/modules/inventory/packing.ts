import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { activeFacilityOf, isFacilityInScope } from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import {
  DEFAULT_PACKAGE_KIND,
  containerName,
  normalizeContainerKind,
  parseWeightKg,
  theContainer,
  weightText,
} from "./container-rules";
import {
  createContainer,
  isContainerNumberClash,
  putIn,
  takeOut,
} from "./containers";
import { foldName } from "./import-validation";
import { lotDayOf, lotLabel, normalizeLotCode } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import {
  OUTBOUND_ORDER_STATUS_LABELS,
  formatOutboundNumber,
  outboundTransitionProblem,
  type OutboundOrderStatus,
} from "./outbound-states";
import { OUTBOUND_LINE_SOURCE } from "./picking";
import { releaseReservationPart } from "./reservations";
import { normalizeSerial, serialsText } from "./serial-rules";
import { serialsForTake } from "./serials";
import { PACKING_MODE } from "./settings";

/**
 * Verifying and packing an outbound order (WMS-15, ADR 0044). In the
 * staging place, who packs scans what was picked; each scan goes into the
 * order's open package — a container (WMS-53) with purpose PACKING and its
 * order. «Verified» and «packed» are the same figure: what its packages
 * hold. Nothing moves and no balance changes: the packages say which part
 * of the stock of the staging place they hold, and that stock stays set
 * aside for the order (its reservation does not change).
 *
 * Never more than what was picked goes in: what can still be packed of a
 * line, product and lot in a place is what the order's reservation holds
 * there minus what its packages already hold. What is missing is written
 * as a shortage with its reason, and that much of the reservation is
 * released: the stock stays loose in the staging place for an adjustment
 * or a count (packing never fixes balances).
 *
 * Locks: the order's products → the places where its stock waits → the
 * order → its open packages. Everything is read again under the order's
 * lock.
 */

type Tx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];
type Client = ReturnType<typeof forOrganization>;

export type PackField =
  "code" | "quantity" | "kind" | "weight" | "reason" | "serials";

type Failure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  fieldErrors?: Partial<Record<PackField, string>>;
  formError?: string;
};

export type PackResult =
  | {
      ok: true;
      orderId: string;
      summary: string;
      repeated?: true;
      /** The package it touched, when one. */
      packageId?: string;
    }
  | Failure;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("packing rejected");
  }
}

/** Where the order's stock waits changed before the locks: try again. */
class PackChanged extends Error {
  constructor() {
    super("packing changed before its locks");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: PackField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Este pedido no existe.";

/** What to lock, read before the transaction. */
type Plan = { productIds: string[]; locationIds: string[] };

async function planOf(client: Client, orderId: string): Promise<Plan | null> {
  const order = await client.outboundOrder.findFirst({
    where: { id: String(orderId ?? "").slice(0, 36) },
    select: { lines: { select: { id: true, productId: true } } },
  });
  if (!order) return null;
  const held = await client.stockReservation.findMany({
    where: {
      sourceType: OUTBOUND_LINE_SOURCE,
      sourceId: { in: order.lines.map((line) => line.id) },
      state: "ACTIVE",
      locationId: { not: null },
    },
    select: { locationId: true },
  });
  return {
    productIds: order.lines.map((line) => line.productId),
    locationIds: [...new Set(held.map((row) => row.locationId!))],
  };
}

/**
 * Runs a packing step: one transaction with the locks, tried again when
 * where the stock waits changed before them or two new packages took the
 * same number at once.
 */
async function inPacking(
  actor: InventoryActor,
  orderId: string,
  work: (tx: Tx, order: LockedOrder, plan: Plan) => Promise<PackResult>,
): Promise<PackResult> {
  const client = forOrganization(actor.organizationId);
  for (let attempt = 0; ; attempt++) {
    try {
      const plan = await planOf(client, orderId);
      if (!plan)
        return { ok: false, reason: "not_found", formError: NOT_FOUND };
      return await client.$transaction(async (tx) => {
        await lockRows(tx, "product", plan.productIds);
        await lockRows(tx, "location", plan.locationIds);
        const order = await lockOrder(tx, orderId, actor.userId);
        return work(tx, order, plan);
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (
        (error instanceof PackChanged || isContainerNumberClash(error)) &&
        attempt < 4
      ) {
        continue;
      }
      if (error instanceof PackChanged) {
        return {
          ok: false,
          reason: "not_allowed",
          formError:
            "El pedido cambió mientras lo empacabas. Vuelve a intentarlo.",
        };
      }
      throw error;
    }
  }
}

const LINE_SELECT = {
  id: true,
  lineNumber: true,
  productId: true,
  quantity: true,
  unitCode: true,
  product: {
    select: {
      name: true,
      sku: true,
      barcode: true,
      unitCode: true,
      quantityStep: true,
      tracking: true,
    },
  },
} as const;

/**
 * The order under its lock. One of a warehouse outside the scope of who
 * asks does not exist for them (WMS-20).
 */
async function lockOrder(tx: Tx, orderId: string, userId: string) {
  const [id] = await lockRows(tx, "outboundOrder", [
    String(orderId ?? "").slice(0, 36),
  ]);
  const order = id
    ? await tx.outboundOrder.findFirst({
        where: { id },
        select: {
          id: true,
          number: true,
          status: true,
          facilityId: true,
          lines: { orderBy: { lineNumber: "asc" }, select: LINE_SELECT },
        },
      })
    : null;
  if (!order || !(await isFacilityInScope(tx, userId, order.facilityId))) {
    return stop("not_found", NOT_FOUND);
  }
  return order;
}

type LockedOrder = Awaited<ReturnType<typeof lockOrder>>;
type Line = LockedOrder["lines"][number];

// ── What the order has to pack ───────────────────────────────────────────

/** What waits of a line, product and lot in one place. */
type Spot = {
  lineId: string;
  productId: string;
  locationId: string;
  locationName: string;
  lotId: string | null;
  lotCode: string | null;
  lotExpiresOn: string | null;
  /** What the order's reservation holds there. */
  held: Decimal;
  /** What its packages hold there. */
  packed: Decimal;
  /** Its reservations there, oldest first (to release a shortage). */
  reservations: { id: string; remaining: Decimal }[];
};

const spotKey = (productId: string, locationId: string, lotId: string | null) =>
  `${productId}|${locationId}|${lotId ?? ""}`;

const BOX_SELECT = {
  id: true,
  number: true,
  code: true,
  kind: true,
  locationId: true,
  sealedAt: true,
  weightKg: true,
  location: { select: { name: true } },
  items: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      productId: true,
      lotId: true,
      quantity: true,
      lot: { select: { code: true, expiresOn: true } },
    },
  },
} as const;

/**
 * What the order holds, has packed and has left to pack — by line,
 * place and lot — with its open packages and its picked units by serial.
 * The same reading for the steps (under the locks) and for the screens.
 */
async function packState(
  client: Client | Tx,
  order: { id: string; lines: Line[] },
) {
  const lineIds = order.lines.map((line) => line.id);
  const [reservations, boxes, tasks, shortages] = await Promise.all([
    client.stockReservation.findMany({
      where: {
        sourceType: OUTBOUND_LINE_SOURCE,
        sourceId: { in: lineIds },
        state: "ACTIVE",
        locationId: { not: null },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        sourceId: true,
        productId: true,
        locationId: true,
        lotId: true,
        remaining: true,
        location: { select: { name: true } },
        lot: { select: { code: true, expiresOn: true } },
      },
    }),
    client.container.findMany({
      where: { outboundOrderId: order.id, status: "OPEN" },
      orderBy: { number: "asc" },
      select: BOX_SELECT,
    }),
    client.warehouseTask.findMany({
      where: {
        kind: "PICK",
        status: "DELIVERED",
        outboundLineId: { in: lineIds },
      },
      select: {
        outboundLineId: true,
        lotId: true,
        pickedQuantity: true,
        serials: { select: { serialUnitId: true } },
      },
    }),
    client.outboundPackShortage.findMany({
      where: { orderId: order.id },
      orderBy: { id: "asc" },
      select: {
        id: true,
        lineId: true,
        lotId: true,
        quantity: true,
        serials: true,
        reason: true,
        createdByUserId: true,
        createdAt: true,
        lot: { select: { code: true, expiresOn: true } },
      },
    }),
  ]);
  const spots = new Map<string, Spot>();
  for (const row of reservations) {
    const key = spotKey(row.productId, row.locationId!, row.lotId);
    const spot = spots.get(key) ?? {
      lineId: row.sourceId,
      productId: row.productId,
      locationId: row.locationId!,
      locationName: row.location?.name ?? "",
      lotId: row.lotId,
      lotCode: row.lot?.code ?? null,
      lotExpiresOn: lotDayOf(row.lot?.expiresOn),
      held: dec(0),
      packed: dec(0),
      reservations: [],
    };
    const remaining = dec(row.remaining.toString());
    spot.held = spot.held.plus(remaining);
    spot.reservations.push({ id: row.id, remaining });
    spots.set(key, spot);
  }
  for (const box of boxes) {
    for (const item of box.items) {
      const spot = spots.get(
        spotKey(item.productId, box.locationId, item.lotId),
      );
      // A package never holds what its order does not set aside there
      // (the reconciliation says so if it ever did).
      if (spot) spot.packed = spot.packed.plus(item.quantity.toString());
    }
  }
  const picked = new Map<string, Decimal>();
  const pickedUnits = new Map<string, Set<string>>();
  for (const task of tasks) {
    const lineId = task.outboundLineId!;
    picked.set(
      lineId,
      (picked.get(lineId) ?? dec(0)).plus(task.pickedQuantity?.toString() ?? 0),
    );
    const units = pickedUnits.get(lineId) ?? new Set<string>();
    for (const row of task.serials) units.add(row.serialUnitId);
    pickedUnits.set(lineId, units);
  }
  return { spots, boxes, picked, pickedUnits, shortages };
}

type PackState = Awaited<ReturnType<typeof packState>>;

const leftOf = (spot: Spot) => spot.held.minus(spot.packed);

/** The spots of a line with something left to pack. */
const leftSpots = (state: PackState, lineId: string) =>
  [...state.spots.values()].filter(
    (spot) => spot.lineId === lineId && leftOf(spot).greaterThan(0),
  );

/** The open (not closed) package of the order: one at a time. */
const openBox = (state: PackState) =>
  state.boxes.find((box) => box.sealedAt === null) ?? null;

function packing(order: LockedOrder): void {
  if (order.status !== "PACKING") {
    stop(
      "not_allowed",
      order.status === "PICKED"
        ? "Primero toca «Empacar» para empezar."
        : order.status === "PACKED"
          ? "Este pedido ya está empacado."
          : `Este pedido está ${OUTBOUND_ORDER_STATUS_LABELS[order.status].toLowerCase()}: no se empaca ahora.`,
    );
  }
}

/** Every place the order's stock waits in was locked before the order. */
function lockedAll(state: PackState, plan: Plan): void {
  const locked = new Set(plan.locationIds);
  for (const spot of state.spots.values()) {
    if (!locked.has(spot.locationId)) throw new PackChanged();
  }
}

async function lockBoxes(tx: Tx, state: PackState): Promise<void> {
  await lockRows(
    tx,
    "container",
    state.boxes.map((box) => box.id),
  );
}

const unitOf = (line: Line) => line.product.unitCode;
const amount = (quantity: Decimal | string, line: Line) =>
  formatStock(quantity.toString(), unitOf(line));

// ── Starting ─────────────────────────────────────────────────────────────

/**
 * «Empacar»: a picked order starts being packed (PICKED → PACKING), when
 * the company packs (`PACKING_MODE`).
 */
export async function startPacking(
  actor: InventoryActor,
  orderId: string,
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  return inPacking(actor, orderId, async (tx, order) => {
    if (order.status === "PACKING") {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: "Este pedido ya se está empacando.",
      };
    }
    const problem = outboundTransitionProblem(order.status, "PACKING");
    if (problem) return stop("not_allowed", problem);
    if ((await readSetting(tx, PACKING_MODE)) !== "on") {
      return stop(
        "not_allowed",
        "El empaque está apagado. Enciéndelo en Configuración › Operación.",
      );
    }
    await tx.outboundOrder.update({
      where: { id: order.id },
      data: { status: "PACKING" },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `Empieza a empacar el pedido ${formatOutboundNumber(order.number)}: escanea lo surtido.`,
    };
  });
}

// ── Scanning ─────────────────────────────────────────────────────────────

export type PackScanInput = {
  /** Scanned or typed: a serial, the product's key or barcode, or a lot. */
  code: string;
  /** How many, in the product's unit; empty = 1. Not for serials. */
  quantity?: string;
  /** The lot, when the product has several left (a second scan). */
  lotCode?: string;
};

/** What a scan stands for, among the order's lines. */
type Scanned = {
  line: Line;
  /** The lot it must be; null = any (a product without lots). */
  lotId: string | null | undefined;
  /** A unit by serial. */
  unit: { id: string; serial: string; locationId: string } | null;
};

/**
 * Says what a code is that is not of the order: a product or a serial of
 * the company, or nothing known.
 */
async function notOfOrder(tx: Tx, typed: string): Promise<never> {
  const byCode = await tx.product.findFirst({
    where: { OR: [{ sku: typed }, { barcode: typed }] },
    select: { name: true, sku: true },
  });
  if (byCode) {
    return stop(
      "invalid",
      `${byCode.name} (${byCode.sku}) no es de este pedido. Apártalo.`,
      "code",
    );
  }
  const serial = normalizeSerial(typed);
  if (serial.ok) {
    const unit = await tx.serialUnit.findFirst({
      where: { serial: serial.serial },
      select: { product: { select: { name: true } } },
    });
    if (unit) {
      return stop(
        "invalid",
        `La serie ${serial.serial} es de ${unit.product.name} y no se surtió para este pedido. Apártala.`,
        "code",
      );
    }
  }
  return stop(
    "invalid",
    `No encontramos «${typed}» en este pedido. Revisa la etiqueta.`,
    "code",
  );
}

async function recognize(
  tx: Tx,
  order: LockedOrder,
  state: PackState,
  input: PackScanInput,
): Promise<Scanned> {
  const typed = String(input.code ?? "")
    .trim()
    .slice(0, 100);
  if (typed === "") {
    return stop("invalid", "Escanea el producto, su serie o su lote.", "code");
  }
  // 1. A unit by serial picked for one of its lines.
  const serialLines = order.lines.filter(
    (line) => line.product.tracking === "SERIAL",
  );
  const serial = normalizeSerial(typed);
  if (serialLines.length > 0 && serial.ok) {
    const unit = await tx.serialUnit.findFirst({
      where: {
        productId: { in: serialLines.map((line) => line.productId) },
        serial: serial.serial,
      },
      select: {
        id: true,
        serial: true,
        productId: true,
        locationId: true,
        status: true,
        containerId: true,
        container: { select: { kind: true, code: true } },
      },
    });
    if (unit) {
      const line = serialLines.find(
        (each) => each.productId === unit.productId,
      )!;
      if (!state.pickedUnits.get(line.id)?.has(unit.id)) {
        return stop(
          "invalid",
          `La serie ${unit.serial} de ${line.product.name} no se surtió para este pedido. Apártala.`,
          "code",
        );
      }
      if (unit.containerId) {
        return stop(
          "invalid",
          `La serie ${unit.serial} ya está en ${unit.container ? containerName(unit.container) : "un bulto"}.`,
          "code",
        );
      }
      const waiting = [...state.spots.values()].some(
        (spot) =>
          spot.lineId === line.id && spot.locationId === unit.locationId,
      );
      if (!waiting || unit.status !== "AVAILABLE" || !unit.locationId) {
        return stop(
          "invalid",
          `La serie ${unit.serial} ya no está donde espera el pedido. Revisa la etiqueta.`,
          "code",
        );
      }
      return {
        line,
        lotId: null,
        unit: { id: unit.id, serial: unit.serial, locationId: unit.locationId },
      };
    }
  }
  // 2. The key or barcode of one of its products.
  const folded = foldName(typed);
  const byProduct = order.lines.find(
    (line) =>
      folded === foldName(line.product.sku) ||
      (line.product.barcode !== null &&
        folded === foldName(line.product.barcode)),
  );
  if (byProduct) {
    if (byProduct.product.tracking === "SERIAL") {
      return stop(
        "invalid",
        `${byProduct.product.name} va por serie: escanea la serie de cada pieza.`,
        "code",
      );
    }
    if (byProduct.product.tracking !== "LOT") {
      return { line: byProduct, lotId: null, unit: null };
    }
    const lots = [
      ...new Map(
        leftSpots(state, byProduct.id).map((spot) => [
          spot.lotId,
          spot.lotCode,
        ]),
      ),
    ];
    if (input.lotCode) {
      const code = normalizeLotCode(input.lotCode);
      const match = code.ok
        ? lots.find(([, lotCode]) => lotCode === code.code)
        : undefined;
      if (!match) {
        return stop(
          "invalid",
          `Ese lote no está por empacar en este pedido. Lotes de ${byProduct.product.name} por empacar: ${lots.map(([, c]) => c).join(", ") || "ninguno"}.`,
          "code",
        );
      }
      return { line: byProduct, lotId: match[0], unit: null };
    }
    if (lots.length > 1) {
      return stop(
        "invalid",
        `${byProduct.product.name} tiene varios lotes por empacar (${lots.map(([, c]) => c).join(", ")}): escanea el lote.`,
        "code",
      );
    }
    // One lot left, or none (then «already packed» is said below).
    return { line: byProduct, lotId: lots[0]?.[0] ?? undefined, unit: null };
  }
  // 3. The code of a lot set aside for it.
  const lotCode = normalizeLotCode(typed);
  if (lotCode.ok) {
    const lines = new Map<string, string | null>();
    for (const spot of state.spots.values()) {
      if (spot.lotCode === lotCode.code) lines.set(spot.lineId, spot.lotId);
    }
    if (lines.size > 1) {
      return stop(
        "invalid",
        "Ese lote es de varios productos de este pedido: escanea primero el producto.",
        "code",
      );
    }
    const [found] = [...lines];
    if (found) {
      const line = order.lines.find((each) => each.id === found[0])!;
      return { line, lotId: found[1], unit: null };
    }
  }
  return notOfOrder(tx, typed);
}

/**
 * One scan: what the person has in hand goes into the order's open
 * package (a new one when there is none). Refuses what is not of the
 * order, and more than what was picked.
 */
export async function packScan(
  actor: InventoryActor,
  orderId: string,
  input: PackScanInput,
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  return inPacking(actor, orderId, async (tx, order, plan) => {
    packing(order);
    const state = await packState(tx, order);
    lockedAll(state, plan);
    await lockBoxes(tx, state);
    const scanned = await recognize(tx, order, state, input);
    const { line, unit } = scanned;
    let quantity: Decimal;
    if (unit) {
      const typed = String(input.quantity ?? "").trim();
      if (typed !== "" && typed !== "1") {
        return stop(
          "invalid",
          "Una serie es una pieza: escanea la de cada una.",
          "quantity",
        );
      }
      quantity = dec(1);
    } else {
      const parsed = parseQuantity(
        {
          unitCode: line.product.unitCode,
          quantityStep: line.product.quantityStep.toString(),
        },
        String(input.quantity ?? "").trim() || "1",
      );
      if (!parsed.ok) return stop("invalid", parsed.error, "quantity");
      quantity = parsed.quantity;
    }
    // Where it can go: the spots of that line (and lot, and place of the
    // unit) with something left.
    const candidates = leftSpots(state, line.id).filter(
      (spot) =>
        (scanned.lotId === undefined ||
          line.product.tracking !== "LOT" ||
          spot.lotId === scanned.lotId) &&
        (!unit || spot.locationId === unit.locationId),
    );
    const left = candidates.reduce(
      (sum, spot) => sum.plus(leftOf(spot)),
      dec(0),
    );
    const picked = state.picked.get(line.id) ?? dec(0);
    if (left.isZero()) {
      const packed = [...state.spots.values()]
        .filter((spot) => spot.lineId === line.id)
        .reduce((sum, spot) => sum.plus(spot.packed), dec(0));
      return stop(
        "invalid",
        `Ya empacaste todo lo surtido de ${line.product.name} (${amount(packed, line)} de ${amount(picked, line)}). Si sobra, no es del pedido: apártalo.`,
        "code",
      );
    }
    if (quantity.greaterThan(left)) {
      return stop(
        "invalid",
        `Solo falta empacar ${amount(left, line)} de ${line.product.name}: no empaques más de lo surtido.`,
        "quantity",
      );
    }
    let box = openBox(state);
    const spot =
      candidates.find(
        (each) =>
          (!box || each.locationId === box.locationId) &&
          !leftOf(each).lessThan(quantity),
      ) ?? null;
    if (!spot) {
      if (box && candidates.some((each) => !leftOf(each).lessThan(quantity))) {
        const other = candidates.find(
          (each) => !leftOf(each).lessThan(quantity),
        )!;
        return stop(
          "invalid",
          `Esto espera en ${other.locationName} y ${theContainer(box)} está en ${box.location.name}: cierra el bulto y vuelve a escanearlo.`,
          "code",
        );
      }
      return stop(
        "invalid",
        `Escanea de ${amount(leftOf(candidates[0]!), line)} en ${amount(leftOf(candidates[0]!), line)}: lo surtido de ${line.product.name} está en varios lugares.`,
        "quantity",
      );
    }
    let opened = false;
    if (!box) {
      const made = await createContainer(tx, actor, {
        kind: DEFAULT_PACKAGE_KIND,
        locationId: spot.locationId,
        outboundOrderId: order.id,
      });
      box = {
        ...made,
        number: 0,
        locationId: spot.locationId,
        sealedAt: null,
        weightKg: null,
        location: { name: spot.locationName },
        items: [],
      };
      opened = true;
    }
    await putIn(tx, actor, box.id, spot.locationId, {
      productId: line.productId,
      lotId: spot.lotId,
      quantity,
      unitIds: unit ? [unit.id] : [],
      serialsText: unit ? unit.serial : null,
    });
    const packedNow = [...state.spots.values()]
      .filter((each) => each.lineId === line.id)
      .reduce((sum, each) => sum.plus(each.packed), dec(0))
      .plus(quantity);
    const lotText = spot.lotCode ? ` del lote ${spot.lotCode}` : "";
    return {
      ok: true,
      orderId: order.id,
      packageId: box.id,
      summary: `${opened ? `Abriste ${theContainer(box)}. ` : ""}${unit ? `Serie ${unit.serial}` : amount(quantity, line)} de ${line.product.name}${lotText} en ${box.code}: van ${packedNow.toString()} de ${amount(picked, line)}.`,
    };
  });
}

// ── Taking out, closing and opening a package ─────────────────────────────

const packageInput = z.object({
  packageId: z.string().trim().min(1).max(36),
});

/** The package of this order under its lock (already taken by lockBoxes). */
function packageOf(state: PackState, packageId: string) {
  const box = state.boxes.find((each) => each.id === packageId);
  if (!box) return stop("not_found", "Ese bulto ya no es de este pedido.");
  return box;
}

export type UnpackPackageInput = {
  packageId: string;
  itemId: string;
  quantity: string;
  /** Units by serial taken out, one per line. */
  serials?: unknown;
};

/**
 * Takes something out of an open package: it stays loose in the staging
 * place, still set aside for the order, to be scanned again.
 */
export async function unpackFromPackage(
  actor: InventoryActor,
  orderId: string,
  input: UnpackPackageInput,
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  const parsed = packageInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", formError: "Elige un bulto." };
  }
  return inPacking(actor, orderId, async (tx, order, plan) => {
    packing(order);
    const state = await packState(tx, order);
    lockedAll(state, plan);
    await lockBoxes(tx, state);
    const box = packageOf(state, parsed.data.packageId);
    if (box.sealedAt) {
      return stop(
        "not_allowed",
        `${containerName(box)} está cerrado: ábrelo de nuevo para sacar algo.`,
      );
    }
    const item = box.items.find((each) => each.id === String(input.itemId));
    if (!item) {
      return stop("invalid", "Eso ya no está en el bulto. Revisa lo que trae.");
    }
    const line = order.lines.find((each) => each.productId === item.productId)!;
    const quantity = parseQuantity(
      {
        unitCode: line.product.unitCode,
        quantityStep: line.product.quantityStep.toString(),
      },
      String(input.quantity ?? ""),
    );
    if (!quantity.ok) return stop("invalid", quantity.error, "quantity");
    const inside = dec(item.quantity.toString());
    if (quantity.quantity.greaterThan(inside)) {
      return stop(
        "invalid",
        `El bulto solo trae ${amount(inside, line)} de ${line.product.name}.`,
        "quantity",
      );
    }
    const serials = await serialsForTake(
      tx,
      {
        id: line.productId,
        name: line.product.name,
        tracking: line.product.tracking,
      },
      input.serials,
      quantity.quantity,
      {
        locationId: box.locationId,
        locationName: box.location.name,
        status: "AVAILABLE",
      },
      { verb: "salen", containerId: box.id },
    );
    if (!serials.ok) return stop("invalid", serials.error, "serials");
    const units = serials.units ?? [];
    await takeOut(tx, actor, box, item, quantity.quantity, units);
    return {
      ok: true,
      orderId: order.id,
      packageId: box.id,
      summary: `Sacaste ${units.length > 0 ? `la serie ${serialsText(units.map((u) => u.serial))}` : amount(quantity.quantity, line)} de ${line.product.name} de ${theContainer(box)}. Vuelve a escanearlo para empacarlo.`,
    };
  });
}

export type SealPackageInput = {
  packageId: string;
  /** «Caja», «Tarima»…; empty keeps what it is. */
  kind?: string;
  /** Kilograms, optional. */
  weight?: string;
};

/**
 * «Cerrar bulto»: the open package is ready to leave, with its kind and,
 * if weighed, its weight. An empty one is taken apart instead. The next
 * scan opens another.
 */
export async function sealPackage(
  actor: InventoryActor,
  orderId: string,
  input: SealPackageInput,
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  const parsed = packageInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", formError: "Elige un bulto." };
  }
  const kindText = String(input.kind ?? "").trim();
  const kind = kindText === "" ? null : normalizeContainerKind(kindText);
  if (kind && !kind.ok) {
    return { ok: false, reason: "invalid", fieldErrors: { kind: kind.error } };
  }
  const weight = parseWeightKg(input.weight);
  if (!weight.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { weight: weight.error },
    };
  }
  return inPacking(actor, orderId, async (tx, order, plan) => {
    packing(order);
    const state = await packState(tx, order);
    lockedAll(state, plan);
    await lockBoxes(tx, state);
    const box = packageOf(state, parsed.data.packageId);
    if (box.sealedAt) {
      return {
        ok: true,
        orderId: order.id,
        packageId: box.id,
        repeated: true,
        summary: `${containerName(box)} ya estaba cerrado.`,
      };
    }
    if (box.items.length === 0) {
      await closeEmpty(tx, actor, box);
      return {
        ok: true,
        orderId: order.id,
        packageId: box.id,
        summary: `${containerName(box)} estaba vacío: se quitó.`,
      };
    }
    const label = kind?.ok ? kind.kind : box.kind;
    await tx.container.update({
      where: { id: box.id },
      data: {
        kind: label,
        weightKg: weight.weight,
        sealedAt: new Date(),
        sealedByUserId: actor.userId,
      },
    });
    await tx.containerEvent.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        containerId: box.id,
        kind: "SEALED",
        locationId: box.locationId,
        createdByUserId: actor.userId,
      },
    });
    const named = { kind: label, code: box.code };
    return {
      ok: true,
      orderId: order.id,
      packageId: box.id,
      summary: `Cerraste ${theContainer(named)}${weight.weight ? ` (${weightText(weight.weight)})` : ""}. Su etiqueta es ${box.code}.`,
    };
  });
}

/**
 * «Abrir de nuevo»: a closed package takes or gives something again,
 * while no other package of the order is open.
 */
export async function reopenPackage(
  actor: InventoryActor,
  orderId: string,
  packageId: string,
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  return inPacking(actor, orderId, async (tx, order, plan) => {
    packing(order);
    const state = await packState(tx, order);
    lockedAll(state, plan);
    await lockBoxes(tx, state);
    const box = packageOf(state, String(packageId ?? "").slice(0, 36));
    if (!box.sealedAt) {
      return {
        ok: true,
        orderId: order.id,
        packageId: box.id,
        repeated: true,
        summary: `${containerName(box)} ya estaba abierto.`,
      };
    }
    const other = openBox(state);
    if (other) {
      return stop(
        "not_allowed",
        `Primero cierra ${theContainer(other)}: solo un bulto abierto a la vez.`,
      );
    }
    await tx.container.update({
      where: { id: box.id },
      data: { sealedAt: null, sealedByUserId: null },
    });
    await tx.containerEvent.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        containerId: box.id,
        kind: "REOPENED",
        locationId: box.locationId,
        createdByUserId: actor.userId,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      packageId: box.id,
      summary: `Abriste otra vez ${theContainer(box)}: lo que escanees entra ahí.`,
    };
  });
}

/** Takes an empty package apart (closed for good, with its history). */
async function closeEmpty(
  tx: Tx,
  actor: InventoryActor,
  box: { id: string; locationId: string },
): Promise<void> {
  await tx.container.update({
    where: { id: box.id },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      closedByUserId: actor.userId,
    },
  });
  await tx.containerEvent.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      containerId: box.id,
      kind: "CLOSED",
      locationId: box.locationId,
      createdByUserId: actor.userId,
    },
  });
}

// ── Differences ──────────────────────────────────────────────────────────

const reasonSchema = z
  .string()
  .trim()
  .min(3, "Escribe qué pasó.")
  .max(300, "Usa como máximo 300 caracteres.");

/**
 * «Falta»: what is left to pack of a line was not found. It is written
 * with its reason, released from the order's reservation and stays loose
 * in the staging place — for someone to find, adjust or count; packing
 * never fixes a balance. The order then closes with what there is.
 */
export async function reportPackShortage(
  actor: InventoryActor,
  orderId: string,
  input: { lineId: string; reason: string },
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  const why = reasonSchema.safeParse(input.reason ?? "");
  if (!why.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: why.error.issues[0]!.message },
    };
  }
  return inPacking(actor, orderId, async (tx, order, plan) => {
    packing(order);
    const state = await packState(tx, order);
    lockedAll(state, plan);
    await lockBoxes(tx, state);
    const line = order.lines.find((each) => each.id === String(input.lineId));
    if (!line) return stop("not_found", "Ese producto no es de este pedido.");
    const spots = leftSpots(state, line.id);
    if (spots.length === 0) {
      return stop(
        "not_allowed",
        `No falta nada de ${line.product.name}: todo lo surtido ya está en bultos.`,
      );
    }
    let total = dec(0);
    const missingSerials: string[] = [];
    for (const spot of spots) {
      const missing = leftOf(spot);
      // Release that much of its reservations there, oldest first.
      let rest = missing;
      for (const reservation of spot.reservations) {
        if (rest.isZero()) break;
        const part = reservation.remaining.lessThan(rest)
          ? reservation.remaining
          : rest;
        if (part.isZero()) continue;
        await releaseReservationPart(tx, reservation.id, part);
        rest = rest.minus(part);
      }
      // The units by serial left out of every package, picked for it.
      let serials: string[] = [];
      if (line.product.tracking === "SERIAL") {
        const units = await tx.serialUnit.findMany({
          where: {
            id: { in: [...(state.pickedUnits.get(line.id) ?? [])] },
            locationId: spot.locationId,
            status: "AVAILABLE",
            containerId: null,
          },
          orderBy: { serial: "asc" },
          select: { serial: true },
        });
        serials = units.map((unit) => unit.serial);
        missingSerials.push(...serials);
      }
      await tx.outboundPackShortage.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          orderId: order.id,
          lineId: line.id,
          productId: line.productId,
          lotId: spot.lotId,
          locationId: spot.locationId,
          quantity: missing.toString(),
          serials: serials.length > 0 ? serials.join(", ") : null,
          reason: why.data,
          createdByUserId: actor.userId,
        },
      });
      total = total.plus(missing);
    }
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "inventory.outbound_pack_short",
      target: { type: "outbound_order", id: order.id },
      reason: why.data,
      metadata: {
        pedido: formatOutboundNumber(order.number),
        producto: line.product.sku,
        falta: total.toString(),
        unidad: unitOf(line),
        ...(missingSerials.length > 0
          ? { series: serialsText(missingSerials, 20) }
          : {}),
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `Quedó registrado el faltante: ${amount(total, line)} de ${line.product.name}. Ya no está apartado para el pedido: si aparece, se corrige con un ajuste o un conteo.`,
    };
  });
}

// ── Finishing ────────────────────────────────────────────────────────────

/**
 * «Terminar empaque»: everything picked is in packages or written as
 * missing. Open packages with something are closed (no weight), empty ones
 * are taken apart, and the order is PACKED.
 */
export async function finishPacking(
  actor: InventoryActor,
  orderId: string,
): Promise<PackResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.pack",
  );
  return inPacking(actor, orderId, async (tx, order, plan) => {
    if (order.status === "PACKED") {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: "Este pedido ya estaba empacado.",
      };
    }
    packing(order);
    const state = await packState(tx, order);
    lockedAll(state, plan);
    await lockBoxes(tx, state);
    const pending = order.lines.flatMap((line) => {
      const left = leftSpots(state, line.id).reduce(
        (sum, spot) => sum.plus(leftOf(spot)),
        dec(0),
      );
      return left.isZero()
        ? []
        : [`${amount(left, line)} de ${line.product.name}`];
    });
    if (pending.length > 0) {
      return stop(
        "not_allowed",
        `Falta empacar ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? "…" : ""}: escanéalo o márcalo como faltante.`,
      );
    }
    let packages = 0;
    for (const box of state.boxes) {
      if (box.items.length === 0) {
        await closeEmpty(tx, actor, box);
        continue;
      }
      packages++;
      if (box.sealedAt) continue;
      await tx.container.update({
        where: { id: box.id },
        data: { sealedAt: new Date(), sealedByUserId: actor.userId },
      });
      await tx.containerEvent.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          containerId: box.id,
          kind: "SEALED",
          locationId: box.locationId,
          createdByUserId: actor.userId,
        },
      });
    }
    await tx.outboundOrder.update({
      where: { id: order.id },
      data: { status: "PACKED" },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "inventory.outbound_packed",
      target: { type: "outbound_order", id: order.id },
      metadata: {
        pedido: formatOutboundNumber(order.number),
        bultos: packages,
        faltantes: state.shortages.length,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `El pedido ${formatOutboundNumber(order.number)} quedó empacado en ${packages === 1 ? "1 bulto" : `${packages} bultos`}.`,
    };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export type PackingLineView = {
  id: string;
  productName: string;
  sku: string;
  bySerial: boolean;
  byLot: boolean;
  /** «10 piezas». */
  askedText: string;
  pickedText: string;
  packedText: string;
  /** What was written as missing when packing, if any. */
  missingText: string | null;
  /** What is left to pack, «2 piezas»; null when nothing. */
  leftText: string | null;
  /** «9 de 10». */
  progressText: string;
  done: boolean;
  /** Lots with something left, for a product by lot. */
  leftLots: string[];
  /** Units by serial left to pack. */
  leftSerials: string[];
};

export type PackageView = {
  id: string;
  code: string;
  kind: string;
  /** «Caja C-0012». */
  name: string;
  /** Takes what is scanned (not closed to leave). */
  open: boolean;
  weightText: string | null;
  locationName: string;
  items: {
    id: string;
    productName: string;
    lotText: string | null;
    quantity: string;
    quantityText: string;
    bySerial: boolean;
    serials: string[];
  }[];
};

export type PackingView = {
  id: string;
  numberText: string;
  recipient: string;
  status: OutboundOrderStatus;
  statusLabel: string;
  lines: PackingLineView[];
  packages: PackageView[];
  /** The package scans go into now; null when none is open. */
  openPackageId: string | null;
  shortages: {
    id: string;
    productName: string;
    lotText: string | null;
    quantityText: string;
    serials: string | null;
    reason: string;
    authorName: string | null;
    createdAt: Date;
  }[];
  /** Nothing is left to pack: «Terminar empaque» can close it. */
  complete: boolean;
};

/**
 * What an order has picked, packed and left to pack, with its packages
 * and what was missing; null outside the scope of the person. For the
 * packing screen and the order's card.
 */
export async function getPackingView(
  actor: InventoryActor,
  orderId: string,
): Promise<PackingView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const client = forOrganization(actor.organizationId);
  const order = await client.outboundOrder.findFirst({
    where: { id: String(orderId ?? "").slice(0, 36) },
    select: {
      id: true,
      number: true,
      status: true,
      recipient: true,
      facilityId: true,
      lines: { orderBy: { lineNumber: "asc" }, select: LINE_SELECT },
    },
  });
  if (
    !order ||
    !(await isFacilityInScope(client, actor.userId, order.facilityId))
  ) {
    return null;
  }
  const state = await packState(client, order);
  const units = await client.serialUnit.findMany({
    where: { containerId: { in: state.boxes.map((box) => box.id) } },
    orderBy: { serial: "asc" },
    take: 5_000,
    select: { containerId: true, productId: true, serial: true },
  });
  const leftUnits = await client.serialUnit.findMany({
    where: {
      id: { in: [...state.pickedUnits.values()].flatMap((set) => [...set]) },
      containerId: null,
      status: "AVAILABLE",
      locationId: {
        in: [...new Set([...state.spots.values()].map((s) => s.locationId))],
      },
    },
    orderBy: { serial: "asc" },
    take: 5_000,
    select: { id: true, productId: true, serial: true },
  });
  const people = [
    ...new Set(state.shortages.map((row) => row.createdByUserId)),
  ];
  const members = people.length
    ? await client.membership.findMany({
        where: { userId: { in: people } },
        select: { userId: true, user: { select: { name: true } } },
      })
    : [];
  const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));
  const lotText = (lot: { code: string; expiresOn: Date | null } | null) =>
    lot
      ? lotLabel({ code: lot.code, expiresOn: lotDayOf(lot.expiresOn) })
      : null;
  const lines = order.lines.map((line): PackingLineView => {
    const spots = [...state.spots.values()].filter((s) => s.lineId === line.id);
    const packedInBoxes = state.boxes
      .flatMap((box) => box.items)
      .filter((item) => item.productId === line.productId)
      .reduce((sum, item) => sum.plus(item.quantity.toString()), dec(0));
    const left = spots.reduce((sum, s) => sum.plus(leftOf(s)), dec(0));
    const missing = state.shortages
      .filter((row) => row.lineId === line.id)
      .reduce((sum, row) => sum.plus(row.quantity.toString()), dec(0));
    const picked = state.picked.get(line.id) ?? dec(0);
    return {
      id: line.id,
      productName: line.product.name,
      sku: line.product.sku,
      bySerial: line.product.tracking === "SERIAL",
      byLot: line.product.tracking === "LOT",
      askedText: amount(line.quantity.toString(), line),
      pickedText: amount(picked, line),
      packedText: amount(packedInBoxes, line),
      missingText: missing.isZero() ? null : amount(missing, line),
      leftText: left.isZero() ? null : amount(left, line),
      progressText: `${packedInBoxes.toString()} de ${picked.toString()}`,
      done: left.isZero(),
      leftLots: [
        ...new Set(
          spots
            .filter((s) => leftOf(s).greaterThan(0) && s.lotCode)
            .map((s) => s.lotCode!),
        ),
      ],
      leftSerials: leftUnits
        .filter(
          (unit) =>
            unit.productId === line.productId &&
            state.pickedUnits.get(line.id)?.has(unit.id),
        )
        .map((unit) => unit.serial),
    };
  });
  const lineOf = new Map(order.lines.map((line) => [line.productId, line]));
  const packages = state.boxes
    .filter((box) => box.items.length > 0 || box.sealedAt === null)
    .map((box): PackageView => ({
      id: box.id,
      code: box.code,
      kind: box.kind,
      name: containerName(box),
      open: box.sealedAt === null,
      weightText: box.weightKg ? weightText(box.weightKg.toString()) : null,
      locationName: box.location.name,
      items: box.items.map((item) => {
        const line = lineOf.get(item.productId)!;
        return {
          id: item.id,
          productName: line.product.name,
          lotText: lotText(item.lot),
          quantity: item.quantity.toString(),
          quantityText: amount(item.quantity.toString(), line),
          bySerial: line.product.tracking === "SERIAL",
          serials: units
            .filter(
              (unit) =>
                unit.containerId === box.id &&
                unit.productId === item.productId,
            )
            .map((unit) => unit.serial),
        };
      }),
    }));
  return {
    id: order.id,
    numberText: formatOutboundNumber(order.number),
    recipient: order.recipient,
    status: order.status,
    statusLabel: OUTBOUND_ORDER_STATUS_LABELS[order.status],
    lines,
    packages,
    openPackageId: openBox(state)?.id ?? null,
    shortages: state.shortages.map((row) => {
      const line = order.lines.find((each) => each.id === row.lineId)!;
      return {
        id: row.id,
        productName: line.product.name,
        lotText: lotText(row.lot),
        quantityText: amount(row.quantity.toString(), line),
        serials: row.serials,
        reason: row.reason,
        authorName: nameOf.get(row.createdByUserId) ?? null,
        createdAt: row.createdAt,
      };
    }),
    complete: lines.every((line) => line.done),
  };
}

/** Whether the company verifies and packs its orders (`PACKING_MODE`). */
export async function packingEnabled(actor: InventoryActor): Promise<boolean> {
  return (
    (await readSetting(forOrganization(actor.organizationId), PACKING_MODE)) ===
    "on"
  );
}

/**
 * Orders of the warehouse the person works in that wait to be packed or
 * are being packed; 0 when the company does not pack.
 */
export async function countOrdersToPack(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const client = forOrganization(actor.organizationId);
  if ((await readSetting(client, PACKING_MODE)) !== "on") return 0;
  const facility = await activeFacilityOf(client, actor.userId);
  return client.outboundOrder.count({
    where: { facilityId: facility.id, status: { in: ["PICKED", "PACKING"] } },
  });
}
