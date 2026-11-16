import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { emitWebhookEvent } from "@/platform/api";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { activeFacilityOf, isFacilityInScope } from "@/platform/locations";
import {
  ProcessStagesPending,
  assertStagesDone,
  completeOperationStage,
  doneStagesAt,
  operationWaits,
  reachMilestone,
  startProcess,
} from "@/platform/processes";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { SHIPMENT_DISPATCHED_EVENT } from "./webhooks";
import { containerName, weightText } from "./container-rules";
import { lotDayOf, lotLabel } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import {
  OUTBOUND_ORDER_STATUS_LABELS,
  formatOutboundNumber,
  type OutboundOrderStatus,
} from "./outbound-states";
import { OUTBOUND_LINE_SOURCE } from "./picking";
import { blockedMessage, consumeReservation, freeToTake } from "./reservations";
import { serialsText } from "./serial-rules";
import { serialsForTake, writeSerialMoves, type SerialPick } from "./serials";
import { SHIPMENT_DETAILS } from "./settings";
import {
  SHIPMENT_DISPATCHED_OPERATION,
  SHIPMENT_PROCESS,
} from "./shipment-process";
import { IN_NO_SHIPMENT, readyStatuses } from "./shipment-ready";
import {
  SHIPMENT_STATUS_LABELS,
  formatShipmentNumber,
  isShipmentStatus,
  shipmentTransitionProblem,
  type ShipmentStatus,
} from "./shipment-states";
import { lotColumns } from "./stock-status";
import { lineCost, openCostBook } from "./valuation";

/**
 * Shipments (WMS-16, ADR 0045): one or several outbound orders that leave
 * the warehouse together. A draft takes orders ready to leave (PACKED, or
 * also PICKED when the company does not pack) and the data of who carries
 * them. Confirming its exit is one transaction that empties the orders'
 * packages, writes ONE exit (`SHIPMENT`, key `ship:<id>`) with exactly what
 * the orders hold in the staging place, consumes those reservations and
 * ships the orders. What left, for which order, stays in `shipment_line`.
 *
 * Locks: products → locations (where the orders' stock waits) → shipment →
 * orders → packages → progress of the process (WMS-74B, ADR 0071). Adding
 * or removing orders locks shipment → orders; cancelling, shipment →
 * progress.
 */

type Tx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];
type Client = ReturnType<typeof forOrganization>;

export const SHIPMENT_PAGE_SIZE = 25;
export const READY_PAGE_SIZE = 50;
/** Orders one shipment may take: a truck, not the whole warehouse. */
export const SHIPMENT_MAX_ORDERS = 100;

export type ShipmentField =
  | "orders"
  | "carrier"
  | "trackingNumber"
  | "vehiclePlate"
  | "driverName"
  | "note"
  | "reason";

type Failure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  fieldErrors?: Partial<Record<ShipmentField, string>>;
  formError?: string;
};

export type ShipmentResult =
  { ok: true; shipmentId: string; summary: string; repeated?: true } | Failure;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("shipment rejected");
  }
}

/** What the shipment holds changed before its locks: try again. */
class ShipmentChanged extends Error {
  constructor() {
    super("shipment changed before its locks");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: ShipmentField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Este embarque no existe.";

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

/**
 * Runs a shipment step: one transaction with its locks, tried again when
 * what it planned changed before them or two shipments took the same number.
 */
async function inShipment(
  organizationId: string,
  work: (tx: Tx) => Promise<ShipmentResult>,
  before?: () => Promise<void>,
): Promise<ShipmentResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      await before?.();
      return await forOrganization(organizationId).$transaction(
        work,
        LOCKING_TRANSACTION,
      );
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      // WMS-74B: a stage of the process was missing after all (the exit
      // asks first, so it should not happen): everything rolled back.
      if (error instanceof ProcessStagesPending) {
        return { ok: false, reason: "not_allowed", formError: error.message };
      }
      if (
        (error instanceof ShipmentChanged ||
          (isClash(error, "number") && !isClash(error, "openOrderId"))) &&
        attempt < 4
      ) {
        continue;
      }
      if (error instanceof ShipmentChanged) {
        return {
          ok: false,
          reason: "not_allowed",
          formError:
            "El embarque cambió mientras lo confirmabas. Vuelve a intentarlo.",
        };
      }
      // Another shipment took one of these orders at the same moment.
      if (isClash(error, "openOrderId")) {
        return {
          ok: false,
          reason: "not_allowed",
          formError:
            "Uno de esos pedidos acaba de entrar a otro embarque. Revisa la lista.",
        };
      }
      throw error;
    }
  }
}

// ── Header ───────────────────────────────────────────────────────────────

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}: usa como máximo ${max} caracteres.`)
    .transform((value) => (value === "" ? null : value.replace(/\s+/g, " ")));

const headerSchema = z.object({
  carrier: optionalText(120, "Transportista").default(""),
  trackingNumber: optionalText(120, "Guía").default(""),
  vehiclePlate: optionalText(20, "Placas")
    .default("")
    .transform((value) => (value ? value.toUpperCase() : null)),
  driverName: optionalText(160, "Quién se lo lleva").default(""),
  note: optionalText(500, "Notas").default(""),
});

export type ShipmentHeaderInput = z.input<typeof headerSchema>;

function readHeader(input: ShipmentHeaderInput) {
  const parsed = headerSchema.safeParse({
    carrier: String(input.carrier ?? ""),
    trackingNumber: String(input.trackingNumber ?? ""),
    vehiclePlate: String(input.vehiclePlate ?? ""),
    driverName: String(input.driverName ?? ""),
    note: String(input.note ?? ""),
  });
  if (parsed.success) return { ok: true as const, data: parsed.data };
  const fieldErrors: Partial<Record<ShipmentField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as ShipmentField;
    fieldErrors[field] ??= issue.message;
  }
  return { ok: false as const, fieldErrors };
}

const idList = (ids: unknown): string[] =>
  [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => String(id ?? "").slice(0, 36))
        .filter(Boolean),
    ),
  ].slice(0, SHIPMENT_MAX_ORDERS + 1);

// ── Locks and checks ─────────────────────────────────────────────────────

/**
 * The shipment under its lock. One of a warehouse outside the scope of who
 * asks does not exist for them (WMS-20).
 */
async function lockShipment(tx: Tx, shipmentId: string, userId: string) {
  const [id] = await lockRows(tx, "shipment", [
    String(shipmentId ?? "").slice(0, 36),
  ]);
  const shipment = id
    ? await tx.shipment.findFirst({
        where: { id },
        select: {
          id: true,
          number: true,
          status: true,
          facilityId: true,
          carrier: true,
          driverName: true,
          trackingNumber: true,
        },
      })
    : null;
  if (
    !shipment ||
    !(await isFacilityInScope(tx, userId, shipment.facilityId))
  ) {
    return stop("not_found", NOT_FOUND);
  }
  return shipment;
}

function draftOnly(status: ShipmentStatus): void {
  if (status !== "DRAFT") {
    stop("not_allowed", shipmentTransitionProblem(status, "SHIPPED")!);
  }
}

/**
 * WMS-74B (review): once a stage of «Por confirmar» was done (the loading,
 * with its photo), the orders of the shipment stay as they were: what
 * leaves is what was checked. «Regresar» that stage (if it allows it) or
 * cancelling the shipment opens them again. Under the lock of the process,
 * after the shipment's (and the orders') locks.
 */
async function ordersFixed(tx: Tx, shipmentId: string): Promise<void> {
  const done = await doneStagesAt(tx, SHIPMENT_PROCESS, shipmentId, {
    lock: true,
  });
  if (done.length > 0) stop("not_allowed", ordersFixedMessage(done));
}

function ordersFixedMessage(done: readonly string[]): string {
  const names = done.map((name) => `«${name}»`).join(", ");
  // «Regresar» only exists from a later manual stage that allows it, so
  // the way out that always exists is said too.
  return `${done.length === 1 ? "Ya se hizo" : "Ya se hicieron"} ${names}: para cambiar los pedidos de este embarque, regresa el proceso a esa etapa (si lo permite) o cancela el embarque y ármalo otra vez.`;
}

/**
 * Locks the orders to add and checks each one may join: of the shipment's
 * warehouse, ready to leave, in no other open shipment.
 */
async function joinable(
  tx: Tx,
  orderIds: string[],
  facilityId: string,
  userId: string,
) {
  if (orderIds.length === 0) {
    return stop("invalid", "Elige al menos un pedido.", "orders");
  }
  if (orderIds.length > SHIPMENT_MAX_ORDERS) {
    return stop(
      "invalid",
      `Un embarque lleva como máximo ${SHIPMENT_MAX_ORDERS} pedidos.`,
      "orders",
    );
  }
  await lockRows(tx, "outboundOrder", orderIds);
  const orders = await tx.outboundOrder.findMany({
    where: { id: { in: orderIds } },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      status: true,
      facilityId: true,
      shipments: {
        where: { openOrderId: { not: null } },
        select: { shipment: { select: { number: true } } },
      },
    },
  });
  const statuses = await readyStatuses(tx);
  for (const id of orderIds) {
    const order = orders.find((each) => each.id === id);
    if (
      !order ||
      order.facilityId !== facilityId ||
      !(await isFacilityInScope(tx, userId, order.facilityId))
    ) {
      return stop(
        "not_found",
        "Uno de esos pedidos no existe en este almacén.",
        "orders",
      );
    }
    const number = formatOutboundNumber(order.number);
    const other = order.shipments[0]?.shipment;
    if (other) {
      return stop(
        "not_allowed",
        `${number} ya está en el embarque ${formatShipmentNumber(other.number)}.`,
        "orders",
      );
    }
    const problem = readyProblem(order.status, statuses);
    if (problem) return stop("not_allowed", `${number}: ${problem}`, "orders");
  }
  return orders;
}

/** Why an order in this state cannot leave now; null when it can. */
function readyProblem(
  status: OutboundOrderStatus,
  statuses: readonly OutboundOrderStatus[],
): string | null {
  if (statuses.includes(status)) return null;
  if (status === "PICKED")
    return "falta empacarlo: con el empaque encendido solo salen pedidos empacados.";
  if (status === "PACKING")
    return "se está empacando: termina el empaque antes de que salga.";
  if (status === "SHIPPED") return "ya salió del almacén.";
  if (status === "CANCELLED") return "está cancelado.";
  return "todavía no termina de surtirse.";
}

// ── Creating and changing a draft ────────────────────────────────────────

/**
 * «Armar embarque»: a draft in the warehouse the person works in, with the
 * orders chosen and the data of who carries it.
 */
export async function createShipment(
  actor: InventoryActor,
  input: ShipmentHeaderInput & { orderIds: unknown },
): Promise<ShipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.shipment.create",
  );
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  const orderIds = idList(input.orderIds);
  const facility = await activeFacilityOf(
    forOrganization(organizationId),
    userId,
  );
  return inShipment(organizationId, async (tx) => {
    const orders = await joinable(tx, orderIds, facility.id, userId);
    const last = await tx.shipment.findFirst({
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const id = newId();
    const number = (last?.number ?? 0) + 1;
    await tx.shipment.create({
      data: {
        id,
        organizationId,
        number,
        facilityId: facility.id,
        ...header.data,
        createdByUserId: userId,
      },
    });
    await tx.shipmentOrder.createMany({
      data: orders.map((order) => ({
        id: newId(),
        organizationId,
        shipmentId: id,
        orderId: order.id,
        openOrderId: order.id,
        createdByUserId: userId,
      })),
    });
    // WMS-74B: the process of the company, if it has one (lock: progress
    // after the shipment).
    await startProcess(tx, SHIPMENT_PROCESS, actor, {
      documentId: id,
      facilityId: facility.id,
      label: formatShipmentNumber(number),
      milestone: "DRAFT",
    });
    return {
      ok: true,
      shipmentId: id,
      summary: `Se armó el embarque ${formatShipmentNumber(number)} con ${orders.length === 1 ? "1 pedido" : `${orders.length} pedidos`}.`,
    };
  });
}

/** Changes the transport data of a draft. */
export async function updateShipment(
  actor: InventoryActor,
  shipmentId: string,
  input: ShipmentHeaderInput,
): Promise<ShipmentResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.create",
  );
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  return inShipment(actor.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, shipmentId, actor.userId);
    draftOnly(shipment.status);
    await tx.shipment.update({
      where: { id: shipment.id },
      data: header.data,
    });
    return {
      ok: true,
      shipmentId: shipment.id,
      summary: "Se guardaron los datos del transporte.",
    };
  });
}

/** Adds orders ready to leave to a draft. */
export async function addShipmentOrders(
  actor: InventoryActor,
  shipmentId: string,
  orderIdsInput: unknown,
): Promise<ShipmentResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.create",
  );
  const orderIds = idList(orderIdsInput);
  return inShipment(actor.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, shipmentId, actor.userId);
    draftOnly(shipment.status);
    const already = await tx.shipmentOrder.count({
      where: { shipmentId: shipment.id },
    });
    if (already + orderIds.length > SHIPMENT_MAX_ORDERS) {
      return stop(
        "invalid",
        `Un embarque lleva como máximo ${SHIPMENT_MAX_ORDERS} pedidos.`,
        "orders",
      );
    }
    const orders = await joinable(
      tx,
      orderIds,
      shipment.facilityId,
      actor.userId,
    );
    await ordersFixed(tx, shipment.id);
    await tx.shipmentOrder.createMany({
      data: orders.map((order) => ({
        id: newId(),
        organizationId: actor.organizationId,
        shipmentId: shipment.id,
        orderId: order.id,
        openOrderId: order.id,
        createdByUserId: actor.userId,
      })),
    });
    return {
      ok: true,
      shipmentId: shipment.id,
      summary:
        orders.length === 1
          ? `Se agregó ${formatOutboundNumber(orders[0]!.number)} al embarque.`
          : `Se agregaron ${orders.length} pedidos al embarque.`,
    };
  });
}

/** Takes an order out of a draft: it stays ready to leave. */
export async function removeShipmentOrder(
  actor: InventoryActor,
  shipmentId: string,
  orderId: string,
): Promise<ShipmentResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.create",
  );
  return inShipment(actor.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, shipmentId, actor.userId);
    draftOnly(shipment.status);
    await ordersFixed(tx, shipment.id);
    const row = await tx.shipmentOrder.findFirst({
      where: {
        shipmentId: shipment.id,
        orderId: String(orderId ?? "").slice(0, 36),
      },
      select: { id: true, order: { select: { number: true } } },
    });
    if (!row) {
      return {
        ok: true,
        shipmentId: shipment.id,
        repeated: true,
        summary: "Ese pedido ya no estaba en el embarque.",
      };
    }
    await tx.shipmentOrder.delete({ where: { id: row.id } });
    return {
      ok: true,
      shipmentId: shipment.id,
      summary: `Se quitó ${formatOutboundNumber(row.order.number)} del embarque: sigue listo para salir.`,
    };
  });
}

const reasonSchema = z
  .string()
  .trim()
  .min(3, "Escribe por qué se cancela.")
  .max(300, "Usa como máximo 300 caracteres.");

/** Cancels a draft with a reason; its orders stay ready to leave. */
export async function cancelShipment(
  actor: InventoryActor,
  shipmentId: string,
  reasonInput: string,
): Promise<ShipmentResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.create",
  );
  const why = reasonSchema.safeParse(String(reasonInput ?? ""));
  if (!why.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: why.error.issues[0]!.message },
    };
  }
  return inShipment(actor.organizationId, async (tx) => {
    const shipment = await lockShipment(tx, shipmentId, actor.userId);
    if (shipment.status === "CANCELLED") {
      return {
        ok: true,
        shipmentId: shipment.id,
        repeated: true,
        summary: "Este embarque ya estaba cancelado.",
      };
    }
    draftOnly(shipment.status);
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: actor.userId,
        cancelReason: why.data,
      },
    });
    // Its orders are let go: they may join another shipment.
    await tx.shipmentOrder.updateMany({
      where: { shipmentId: shipment.id, openOrderId: { not: null } },
      data: { openOrderId: null },
    });
    // WMS-74B: its process ends; what was to do disappears.
    await reachMilestone(tx, SHIPMENT_PROCESS, actor, shipment.id, "CANCELLED");
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "inventory.shipment_cancelled",
      target: { type: "shipment", id: shipment.id },
      reason: why.data,
      metadata: { embarque: formatShipmentNumber(shipment.number) },
    });
    return {
      ok: true,
      shipmentId: shipment.id,
      summary: `Se canceló el embarque ${formatShipmentNumber(shipment.number)}. Sus pedidos siguen listos para salir.`,
    };
  });
}

// ── What leaves ──────────────────────────────────────────────────────────

const LINE_SELECT = {
  id: true,
  lineNumber: true,
  productId: true,
  quantity: true,
  product: {
    select: { name: true, sku: true, unitCode: true, tracking: true },
  },
} as const;

const ORDER_SELECT = {
  id: true,
  number: true,
  status: true,
  facilityId: true,
  recipient: true,
  address: true,
  reference: true,
  lines: { orderBy: { lineNumber: "asc" as const }, select: LINE_SELECT },
} as const;

type OrderRow = {
  id: string;
  number: number;
  status: OutboundOrderStatus;
  facilityId: string;
  recipient: string;
  address: string | null;
  reference: string | null;
  lines: {
    id: string;
    lineNumber: number;
    productId: string;
    quantity: { toString(): string };
    product: { name: string; sku: string; unitCode: string; tracking: string };
  }[];
};

const BOX_SELECT = {
  id: true,
  number: true,
  code: true,
  kind: true,
  locationId: true,
  outboundOrderId: true,
  sealedAt: true,
  weightKg: true,
  items: {
    orderBy: { id: "asc" as const },
    select: { id: true, productId: true, lotId: true, quantity: true },
  },
} as const;

/** One line of what leaves (a package's item, or what waits loose). */
type Draft = {
  orderId: string;
  lineId: string;
  productId: string;
  productName: string;
  unitCode: string;
  tracking: string;
  locationId: string;
  locationName: string;
  lotId: string | null;
  containerId: string | null;
  quantity: Decimal;
  units: SerialPick[];
};

/**
 * What the orders of a shipment would take out now: each package's items
 * and what waits loose of each line in the staging place (what its
 * reservation holds and no package does), with the units by serial. The
 * same reading for the dispatch (under its locks) and for the screens;
 * `problems` says, by order, why it cannot leave as it is.
 */
async function loadOf(client: Client | Tx, orders: OrderRow[]) {
  const orderIds = orders.map((order) => order.id);
  const lineIds = orders.flatMap((order) => order.lines.map((l) => l.id));
  const [boxes, reservations, tasks] = await Promise.all([
    client.container.findMany({
      where: { outboundOrderId: { in: orderIds }, status: "OPEN" },
      orderBy: { number: "asc" },
      select: BOX_SELECT,
    }),
    client.stockReservation.findMany({
      where: {
        sourceType: OUTBOUND_LINE_SOURCE,
        sourceId: { in: lineIds },
        state: "ACTIVE",
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        sourceId: true,
        productId: true,
        locationId: true,
        lotId: true,
        remaining: true,
      },
    }),
    client.warehouseTask.findMany({
      where: {
        kind: "PICK",
        status: "DELIVERED",
        outboundLineId: { in: lineIds },
      },
      select: {
        outboundLineId: true,
        serials: { select: { serialUnitId: true } },
      },
    }),
  ]);
  const boxUnits = await client.serialUnit.findMany({
    where: { containerId: { in: boxes.map((box) => box.id) } },
    orderBy: { serial: "asc" },
    select: { id: true, serial: true, productId: true, containerId: true },
  });
  const located = reservations.filter((row) => row.locationId !== null);
  const places = await client.location.findMany({
    where: {
      id: {
        in: [
          ...new Set([
            ...located.map((row) => row.locationId!),
            ...boxes.map((box) => box.locationId),
          ]),
        ],
      },
    },
    select: { id: true, name: true },
  });
  const placeName = new Map(places.map((place) => [place.id, place.name]));
  const pickedUnits = new Map<string, Set<string>>();
  for (const task of tasks) {
    const set = pickedUnits.get(task.outboundLineId!) ?? new Set<string>();
    for (const row of task.serials) set.add(row.serialUnitId);
    pickedUnits.set(task.outboundLineId!, set);
  }

  const problems = new Map<string, string>();
  const drafts: Draft[] = [];
  for (const order of orders) {
    const number = formatOutboundNumber(order.number);
    const lineOf = new Map(order.lines.map((line) => [line.id, line]));
    const lineOfProduct = new Map(
      order.lines.map((line) => [line.productId, line]),
    );
    // What the order's reservations hold, by line, place and lot.
    const held = new Map<string, Decimal>();
    const spot = (lineId: string, locationId: string, lotId: string | null) =>
      `${lineId}|${locationId}|${lotId ?? ""}`;
    for (const row of located) {
      if (!lineOf.has(row.sourceId)) continue;
      const key = spot(row.sourceId, row.locationId!, row.lotId);
      held.set(key, (held.get(key) ?? dec(0)).plus(row.remaining.toString()));
    }
    const packed = new Map<string, Decimal>();
    const ownBoxes = boxes.filter((box) => box.outboundOrderId === order.id);
    for (const box of ownBoxes) {
      if (!box.sealedAt) {
        problems.set(
          order.id,
          `${containerName(box)} de ${number} sigue abierto: termina el empaque.`,
        );
      }
      for (const item of box.items) {
        const line = lineOfProduct.get(item.productId);
        const key = line ? spot(line.id, box.locationId, item.lotId) : "";
        const quantity = dec(item.quantity.toString());
        const total = (packed.get(key) ?? dec(0)).plus(quantity);
        packed.set(key, total);
        if (!line || total.greaterThan(held.get(key) ?? 0)) {
          problems.set(
            order.id,
            `${containerName(box)} de ${number} trae algo que ya no está apartado para el pedido: revisa el empaque.`,
          );
          continue;
        }
        const units = boxUnits
          .filter(
            (unit) =>
              unit.containerId === box.id && unit.productId === item.productId,
          )
          .map((unit) => ({ id: unit.id, serial: unit.serial }));
        if (
          line.product.tracking === "SERIAL" &&
          !dec(units.length).equals(quantity)
        ) {
          problems.set(
            order.id,
            `Las series de ${line.product.name} en ${containerName(box)} no coinciden con lo que trae: revisa el empaque.`,
          );
        }
        drafts.push({
          orderId: order.id,
          lineId: line.id,
          productId: line.productId,
          productName: line.product.name,
          unitCode: line.product.unitCode,
          tracking: line.product.tracking,
          locationId: box.locationId,
          locationName: placeName.get(box.locationId) ?? "",
          lotId: item.lotId,
          containerId: box.id,
          quantity,
          units,
        });
      }
    }
    // What waits loose: held and in no package. A packed order has none.
    for (const [key, quantity] of held) {
      const loose = quantity.minus(packed.get(key) ?? 0);
      if (!loose.greaterThan(0)) continue;
      const [lineId = "", locationId = "", lotKey = ""] = key.split("|");
      const line = lineOf.get(lineId)!;
      if (order.status === "PACKED" || order.status === "PACKING") {
        problems.set(
          order.id,
          `Lo empacado de ${line.product.name} en ${number} no coincide con lo apartado: revisa el empaque.`,
        );
        continue;
      }
      let units: SerialPick[] = [];
      if (line.product.tracking === "SERIAL") {
        const there = await client.serialUnit.findMany({
          where: {
            id: { in: [...(pickedUnits.get(line.id) ?? [])] },
            locationId,
            status: "AVAILABLE",
            containerId: null,
          },
          orderBy: { serial: "asc" },
          select: { id: true, serial: true },
        });
        if (dec(there.length).lessThan(loose)) {
          problems.set(
            order.id,
            `De ${line.product.name} en ${number} no están todas las series surtidas en ${placeName.get(locationId) ?? "preparación"}: revisa lo surtido.`,
          );
        }
        units = there.slice(0, loose.toNumber());
      }
      drafts.push({
        orderId: order.id,
        lineId,
        productId: line.productId,
        productName: line.product.name,
        unitCode: line.product.unitCode,
        tracking: line.product.tracking,
        locationId,
        locationName: placeName.get(locationId) ?? "",
        lotId: lotKey || null,
        containerId: null,
        quantity: loose,
        units,
      });
    }
  }
  return { boxes, reservations, drafts, problems };
}

// ── Confirming the exit ──────────────────────────────────────────────────

/** What to lock, read before the transaction. */
type DispatchPlan = {
  orderIds: string[];
  productIds: string[];
  locationIds: string[];
};

async function dispatchPlanOf(
  client: Client,
  shipmentId: string,
): Promise<DispatchPlan | null> {
  const shipment = await client.shipment.findFirst({
    where: { id: String(shipmentId ?? "").slice(0, 36) },
    select: {
      orders: {
        where: { openOrderId: { not: null } },
        select: {
          orderId: true,
          order: {
            select: { lines: { select: { id: true, productId: true } } },
          },
        },
      },
    },
  });
  if (!shipment) return null;
  const lines = shipment.orders.flatMap((row) => row.order.lines);
  const held = await client.stockReservation.findMany({
    where: {
      sourceType: OUTBOUND_LINE_SOURCE,
      sourceId: { in: lines.map((line) => line.id) },
      state: "ACTIVE",
      locationId: { not: null },
    },
    select: { locationId: true },
  });
  const boxes = await client.container.findMany({
    where: {
      outboundOrderId: { in: shipment.orders.map((row) => row.orderId) },
      status: "OPEN",
    },
    select: { locationId: true },
  });
  return {
    orderIds: shipment.orders.map((row) => row.orderId).sort(),
    productIds: [...new Set(lines.map((line) => line.productId))],
    locationIds: [
      ...new Set([
        ...held.map((row) => row.locationId!),
        ...boxes.map((box) => box.locationId),
      ]),
    ],
  };
}

/**
 * «Confirmar salida»: the shipment leaves. In one transaction: its
 * packages are emptied, ONE exit takes out exactly what its orders hold in
 * the staging place (key `ship:<id>`), those reservations are consumed and
 * the orders and the shipment are SHIPPED. Repeating it answers
 * `repeated`; two at once write it once.
 */
export async function dispatchShipment(
  actor: InventoryActor,
  shipmentId: string,
): Promise<ShipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.shipment.dispatch",
  );
  const client = forOrganization(organizationId);
  let plan: DispatchPlan | null = null;
  return inShipment(
    organizationId,
    async (tx) => {
      if (!plan) return stop("not_found", NOT_FOUND);
      await lockRows(tx, "product", plan.productIds);
      await lockRows(tx, "location", plan.locationIds);
      const shipment = await lockShipment(tx, shipmentId, userId);
      const numberText = formatShipmentNumber(shipment.number);
      if (shipment.status === "SHIPPED") {
        return {
          ok: true,
          shipmentId: shipment.id,
          repeated: true,
          summary: `El embarque ${numberText} ya había salido. No se registró de nuevo.`,
        };
      }
      draftOnly(shipment.status);
      const rows = await tx.shipmentOrder.findMany({
        where: { shipmentId: shipment.id, openOrderId: { not: null } },
        select: { orderId: true },
      });
      const orderIds = rows.map((row) => row.orderId).sort();
      if (orderIds.join() !== plan.orderIds.join()) throw new ShipmentChanged();
      if (orderIds.length === 0) {
        return stop("not_allowed", "Agrega al menos un pedido al embarque.");
      }
      if (
        (await readSetting(tx, SHIPMENT_DETAILS)) === "required" &&
        (!shipment.carrier || !shipment.driverName)
      ) {
        return stop(
          "not_allowed",
          "Escribe el transportista y quién se lo lleva antes de confirmar la salida.",
        );
      }
      await lockRows(tx, "outboundOrder", orderIds);
      const orders: OrderRow[] = await tx.outboundOrder.findMany({
        where: { id: { in: orderIds } },
        orderBy: { number: "asc" },
        select: ORDER_SELECT,
      });
      const lockedProducts = new Set(plan.productIds);
      if (
        orders.some((order) =>
          order.lines.some((line) => !lockedProducts.has(line.productId)),
        )
      ) {
        throw new ShipmentChanged();
      }
      // Each order, again under its lock.
      const statuses = await readyStatuses(tx);
      for (const order of orders) {
        const number = formatOutboundNumber(order.number);
        if (order.facilityId !== shipment.facilityId) {
          return stop("not_allowed", `${number} es de otro almacén.`);
        }
        const problem = readyProblem(order.status, statuses);
        if (problem) return stop("not_allowed", `${number}: ${problem}`);
        const open = await tx.warehouseTask.count({
          where: {
            kind: "PICK",
            outboundLine: { orderId: order.id },
            status: { notIn: ["DELIVERED", "CANCELLED"] },
          },
        });
        if (open > 0) {
          return stop(
            "not_allowed",
            `${number} tiene tareas de surtido abiertas: termínalas antes de que salga.`,
          );
        }
      }
      const boxIds = (
        await tx.container.findMany({
          where: { outboundOrderId: { in: orderIds }, status: "OPEN" },
          select: { id: true },
        })
      ).map((box) => box.id);
      await lockRows(tx, "container", boxIds);
      // WMS-74B: when confirming the exit is a stage of the company's
      // process, it waits for the earlier stages of this shipment (lock:
      // the progress, after every lock of the shipment).
      const stages = await assertStagesDone(
        tx,
        SHIPMENT_PROCESS,
        shipment.id,
        SHIPMENT_DISPATCHED_OPERATION,
      );
      if (!stages.ok) return stop("not_allowed", stages.message);
      const load = await loadOf(tx, orders);
      const firstProblem = [...load.problems.values()][0];
      if (firstProblem) return stop("not_allowed", firstProblem);
      const lockedPlaces = new Set(plan.locationIds);
      if (
        load.drafts.some((draft) => !lockedPlaces.has(draft.locationId)) ||
        load.boxes.some((box) => !boxIds.includes(box.id))
      ) {
        throw new ShipmentChanged();
      }
      const drafts = load.drafts;

      // 1. The header of the exit, so the packages' history can name it.
      const movementId = drafts.length > 0 ? newId() : null;
      const orderList = orders
        .map(
          (order) => `${formatOutboundNumber(order.number)} ${order.recipient}`,
        )
        .join("; ");
      if (movementId) {
        await tx.stockMovement.create({
          data: {
            id: movementId,
            organizationId,
            type: "SHIPMENT",
            reason: `Salida del embarque: ${orderList}`.slice(0, 500),
            reference: numberText,
            idempotencyKey: `ship:${shipment.id}`,
            createdByUserId: userId,
          },
        });
      }
      // 2. Empty the packages: the base never lets a balance go below what
      // its containers hold. What each held stays in its history.
      for (const box of load.boxes) {
        for (const item of box.items) {
          const units = drafts.find(
            (draft) =>
              draft.containerId === box.id &&
              draft.productId === item.productId &&
              draft.lotId === item.lotId,
          )?.units;
          await tx.containerItem.delete({ where: { id: item.id } });
          const unitIds = (units ?? []).map((unit) => unit.id!);
          if (unitIds.length > 0) {
            await tx.serialUnit.updateMany({
              where: { id: { in: unitIds }, containerId: box.id },
              data: { containerId: null },
            });
          }
          await tx.containerEvent.create({
            data: {
              id: newId(),
              organizationId,
              containerId: box.id,
              kind: "SHIPPED",
              locationId: box.locationId,
              productId: item.productId,
              lotId: item.lotId,
              quantity: item.quantity.toString(),
              serials:
                units && units.length > 0
                  ? serialsText(
                      units.map((unit) => unit.serial),
                      units.length,
                    )
                  : null,
              movementId,
              createdByUserId: userId,
            },
          });
        }
        await tx.container.update({
          where: { id: box.id },
          data: {
            status: "CLOSED",
            closedAt: new Date(),
            closedByUserId: userId,
          },
        });
      }
      // 3. What the orders held is used now; an old reservation without a
      // place (orders released before picking existed) is let go.
      for (const reservation of load.reservations) {
        const remaining = dec(reservation.remaining.toString());
        if (remaining.greaterThan(0)) {
          await consumeReservation(tx, reservation.id, remaining);
        }
      }
      // 4. What leaves takes nothing that belongs to someone else.
      const slotKey = (draft: Draft) =>
        `${draft.productId}|${draft.locationId}|${draft.lotId ?? ""}`;
      const taken = new Map<string, Decimal>();
      const byProduct = new Map<string, Decimal>();
      for (const draft of drafts) {
        const key = slotKey(draft);
        taken.set(key, (taken.get(key) ?? dec(0)).plus(draft.quantity));
        byProduct.set(
          draft.productId,
          (byProduct.get(draft.productId) ?? dec(0)).plus(draft.quantity),
        );
      }
      for (const [key, quantity] of taken) {
        const draft = drafts.find((each) => slotKey(each) === key)!;
        const free = await freeToTake(
          tx,
          draft.productId,
          draft.locationId,
          draft.lotId,
        );
        const freeAnywhere = await freeToTake(tx, draft.productId, null);
        if (
          free.lessThan(quantity) ||
          freeAnywhere.lessThan(byProduct.get(draft.productId)!)
        ) {
          return stop(
            "not_allowed",
            `${draft.productName}: ${await blockedMessage(
              tx,
              free.lessThan(freeAnywhere) ? free : freeAnywhere,
              draft.unitCode,
              "sacar",
              {
                productId: draft.productId,
                locationId: draft.locationId,
                locationName: draft.locationName,
                lotId: draft.lotId,
              },
            )}`,
          );
        }
      }
      // 5. The units by serial, checked where they are now (loose, there).
      for (const draft of drafts) {
        if (draft.tracking !== "SERIAL") continue;
        const answer = await serialsForTake(
          tx,
          {
            id: draft.productId,
            name: draft.productName,
            tracking: draft.tracking,
          },
          draft.units.map((unit) => unit.serial),
          draft.quantity,
          {
            locationId: draft.locationId,
            locationName: draft.locationName,
            status: "AVAILABLE",
          },
          { verb: "salen" },
        );
        if (!answer.ok) return stop("not_allowed", answer.error);
        draft.units = answer.units ?? [];
      }
      // 6. The exit: average cost, serials, lines and balances.
      if (movementId) {
        const costs = await openCostBook(
          tx,
          organizationId,
          drafts.map((draft) => draft.productId),
        );
        const unitCosts = drafts.map((draft) =>
          costs.exit(draft.productId, draft.quantity),
        );
        const lineIds = drafts.map(() => newId());
        await writeSerialMoves(
          tx,
          actor,
          drafts.map((draft, index) => ({
            lineId: lineIds[index]!,
            productId: draft.productId,
            locationId: draft.locationId,
            status: "AVAILABLE" as const,
            direction: "OUT" as const,
            units: draft.units,
          })),
        );
        await tx.stockMovementLine.createMany({
          data: drafts.map((draft, index) => ({
            id: lineIds[index]!,
            organizationId,
            movementId,
            lineNumber: index + 1,
            productId: draft.productId,
            locationId: draft.locationId,
            direction: "OUT" as const,
            capturedQuantity: draft.quantity.toString(),
            factor: "1",
            baseQuantity: draft.quantity.toString(),
            unitCode: draft.unitCode,
            ...lotColumns(draft.lotId),
            unitCost: lineCost(unitCosts[index]!),
          })),
        });
        await costs.save();
        for (const [key, quantity] of taken) {
          const draft = drafts.find((each) => slotKey(each) === key)!;
          const balance = await tx.stockBalance.findFirst({
            where: {
              productId: draft.productId,
              locationId: draft.locationId,
              status: "AVAILABLE",
              lotKey: draft.lotId ?? "",
            },
            select: { id: true },
          });
          // Conditioned like every exit; the CHECK is the last defense.
          const changed = await tx.stockBalance.updateMany({
            where: {
              id: balance?.id ?? "",
              quantity: { gte: quantity.toString() },
            },
            data: { quantity: { decrement: quantity.toString() } },
          });
          if (changed.count !== 1) {
            throw new Error(`Balance of ${key} changed under its lock`);
          }
        }
        // 7. What left, for which order.
        await tx.shipmentLine.createMany({
          data: drafts.map((draft, index) => ({
            id: newId(),
            organizationId,
            shipmentId: shipment.id,
            orderId: draft.orderId,
            orderLineId: draft.lineId,
            productId: draft.productId,
            locationId: draft.locationId,
            lotId: draft.lotId,
            containerId: draft.containerId,
            quantity: draft.quantity.toString(),
            unitCode: draft.unitCode,
            serials:
              draft.units.length > 0
                ? draft.units.map((unit) => unit.serial).join(", ")
                : null,
            movementLineId: lineIds[index]!,
          })),
        });
      }
      // 8. The orders and the shipment left.
      for (const order of orders) {
        await tx.outboundOrder.update({
          where: { id: order.id },
          data: { status: "SHIPPED" },
        });
      }
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: "SHIPPED",
          shippedAt: new Date(),
          shippedByUserId: userId,
          movementId,
        },
      });
      // WMS-74B: the process reaches «Despachado» first (the operation
      // changed the fixed state), then its stage is done by itself and the
      // next one falls to its area. Neither moves stock.
      await reachMilestone(tx, SHIPMENT_PROCESS, actor, shipment.id, "SHIPPED");
      await completeOperationStage(
        tx,
        SHIPMENT_PROCESS,
        actor,
        shipment.id,
        SHIPMENT_DISPATCHED_OPERATION,
      );
      // WMS-60: who listens by webhook hears of it, inside this transaction.
      await emitWebhookEvent(tx, SHIPMENT_DISPATCHED_EVENT, {
        organizationId,
        data: {
          shipmentId: shipment.id,
          number: numberText,
          movementId,
          trackingNumber: shipment.trackingNumber ?? null,
          orders: orders.map((order) => ({
            id: order.id,
            number: formatOutboundNumber(order.number),
            lines: drafts
              .filter((draft) => draft.orderId === order.id)
              .map((draft) => ({
                productId: draft.productId,
                lotId: draft.lotId ?? null,
                quantity: draft.quantity.toString(),
                unitCode: draft.unitCode,
                serials: draft.units.map((unit) => unit.serial),
              })),
          })),
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.shipment_dispatched",
        target: { type: "shipment", id: shipment.id },
        metadata: {
          embarque: numberText,
          pedidos: orders
            .map((order) => formatOutboundNumber(order.number))
            .join(", ")
            .slice(0, 300),
          bultos: load.boxes.length,
          ...(shipment.trackingNumber ? { guia: shipment.trackingNumber } : {}),
        },
      });
      const packages = load.boxes.length;
      return {
        ok: true,
        shipmentId: shipment.id,
        summary: `Salió el embarque ${numberText}: ${orders.length === 1 ? "1 pedido" : `${orders.length} pedidos`}${packages > 0 ? `, ${packages === 1 ? "1 bulto" : `${packages} bultos`}` : ""}.`,
      };
    },
    async () => {
      plan = await dispatchPlanOf(client, shipmentId);
    },
  );
}

// ── Reading ──────────────────────────────────────────────────────────────

export type ShipmentSummary = {
  id: string;
  numberText: string;
  status: ShipmentStatus;
  statusLabel: string;
  orders: number;
  carrier: string | null;
  trackingNumber: string | null;
  createdAt: Date;
  shippedAt: Date | null;
};

export type ShipmentPage = {
  items: ShipmentSummary[];
  total: number;
  page: number;
  pageCount: number;
  status: ShipmentStatus | null;
};

/** Shipments of the warehouse the person works in, newest first. */
export async function listShipments(
  actor: InventoryActor,
  options: { status?: unknown; page?: number } = {},
): Promise<ShipmentPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const status = isShipmentStatus(options.status) ? options.status : null;
  const where = { facilityId: facility.id, ...(status ? { status } : {}) };
  const total = await client.shipment.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / SHIPMENT_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.shipment.findMany({
    where,
    orderBy: { number: "desc" },
    skip: (page - 1) * SHIPMENT_PAGE_SIZE,
    take: SHIPMENT_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      carrier: true,
      trackingNumber: true,
      createdAt: true,
      shippedAt: true,
      _count: { select: { orders: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatShipmentNumber(row.number),
      status: row.status,
      statusLabel: SHIPMENT_STATUS_LABELS[row.status],
      orders: row._count.orders,
      carrier: row.carrier,
      trackingNumber: row.trackingNumber,
      createdAt: row.createdAt,
      shippedAt: row.shippedAt,
    })),
    total,
    page,
    pageCount,
    status,
  };
}

export type ReadyOrder = {
  id: string;
  numberText: string;
  recipient: string;
  reference: string | null;
  statusLabel: string;
  urgent: boolean;
  dueOn: string | null;
  lines: number;
};

export type ReadyPage = {
  items: ReadyOrder[];
  total: number;
  page: number;
  pageCount: number;
};

const ymd = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * Orders of the warehouse the person works in that are ready to leave and
 * in no open shipment, oldest first: what a shipment can take.
 */
export async function listReadyOrders(
  actor: InventoryActor,
  options: { page?: number } = {},
): Promise<ReadyPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const where = {
    facilityId: facility.id,
    status: { in: await readyStatuses(client) },
    ...IN_NO_SHIPMENT,
  };
  const total = await client.outboundOrder.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / READY_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.outboundOrder.findMany({
    where,
    orderBy: [{ priority: "desc" }, { number: "asc" }],
    skip: (page - 1) * READY_PAGE_SIZE,
    take: READY_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      recipient: true,
      reference: true,
      dueOn: true,
      _count: { select: { lines: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatOutboundNumber(row.number),
      recipient: row.recipient,
      reference: row.reference,
      statusLabel: OUTBOUND_ORDER_STATUS_LABELS[row.status],
      urgent: row.priority === "URGENT",
      dueOn: ymd(row.dueOn),
      lines: row._count.lines,
    })),
    total,
    page,
    pageCount,
  };
}

/**
 * Orders of the warehouse the person works in ready to leave (in a draft
 * shipment or not); for the notice of Inicio.
 */
export async function countOrdersToShip(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.outboundOrder.count({
    where: {
      facilityId: facility.id,
      status: { in: await readyStatuses(client) },
    },
  });
}

export type ShipmentLineView = {
  /** WMS-60: exact data for the API. */
  productId: string;
  quantity: string;
  unitCode: string;
  productName: string;
  sku: string;
  /** «12 piezas». */
  quantityText: string;
  lotText: string | null;
  lotId: string | null;
  serials: string[];
  /** The package it goes in, «C-0012»; null when loose. */
  packageCode: string | null;
};

export type ShipmentPackageView = {
  id: string;
  code: string;
  kind: string;
  weightText: string | null;
};

export type ShipmentOrderView = {
  id: string;
  numberText: string;
  recipient: string;
  address: string | null;
  reference: string | null;
  status: OutboundOrderStatus;
  statusLabel: string;
  /** Why it cannot leave as it is (a draft only); null when it can. */
  problem: string | null;
  lines: ShipmentLineView[];
  packages: ShipmentPackageView[];
};

export type ShipmentView = {
  id: string;
  numberText: string;
  status: ShipmentStatus;
  statusLabel: string;
  facilityName: string;
  carrier: string | null;
  trackingNumber: string | null;
  vehiclePlate: string | null;
  driverName: string | null;
  note: string | null;
  createdAt: Date;
  authorName: string | null;
  shippedAt: Date | null;
  shippedByName: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  movementId: string | null;
  orders: ShipmentOrderView[];
  packageCount: number;
  /** «35.5 kg», of the packages weighed; null when none was. */
  weightText: string | null;
  /** Packages without a weight, said next to the total. */
  unweighed: number;
  /** A draft whose every order can leave now. */
  ready: boolean;
  /** The company asks for the carrier and who takes it (setting). */
  detailsRequired: boolean;
  /**
   * WMS-74B: why the exit cannot be confirmed yet — an earlier stage of
   * the company's process for this shipment («Esperando: …»); null when
   * nothing waits. The exit decides again under its locks.
   */
  dispatchWaits: string | null;
  /**
   * WMS-74B: why its orders cannot change now — a stage of «Por confirmar»
   * already done; null when they can.
   */
  ordersFixed: string | null;
};

/**
 * One shipment: for a draft, what each order would take out now (and why
 * one cannot leave); once shipped, what left. Null when it does not exist
 * for the person (another company, or a warehouse outside their scope).
 */
export async function getShipment(
  actor: InventoryActor,
  shipmentId: string,
): Promise<ShipmentView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.shipment.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = await client.shipment.findFirst({
    where: { id: String(shipmentId ?? "").slice(0, 36) },
    select: {
      id: true,
      number: true,
      status: true,
      facilityId: true,
      facility: { select: { name: true } },
      carrier: true,
      trackingNumber: true,
      vehiclePlate: true,
      driverName: true,
      note: true,
      createdAt: true,
      createdByUserId: true,
      shippedAt: true,
      shippedByUserId: true,
      cancelledAt: true,
      cancelReason: true,
      movementId: true,
      // A cancelled shipment still shows the orders it had.
      orders: {
        orderBy: { order: { number: "asc" } },
        select: { order: { select: ORDER_SELECT } },
      },
    },
  });
  if (!row || !(await isFacilityInScope(client, actor.userId, row.facilityId)))
    return null;
  const orders: OrderRow[] = row.orders.map((each) => each.order);
  const people = [
    ...new Set(
      [row.createdByUserId, row.shippedByUserId].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const members = await client.membership.findMany({
    where: { userId: { in: people } },
    select: { userId: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));
  const lotIds = new Set<string>();
  let views: ShipmentOrderView[];
  let packages: PackageRow[];

  if (row.status === "SHIPPED") {
    const lines = await client.shipmentLine.findMany({
      where: { shipmentId: row.id },
      orderBy: { id: "asc" },
      select: {
        orderId: true,
        orderLineId: true,
        lotId: true,
        quantity: true,
        unitCode: true,
        serials: true,
        containerId: true,
        productId: true,
        product: { select: { name: true, sku: true } },
      },
    });
    for (const line of lines) if (line.lotId) lotIds.add(line.lotId);
    const boxIds = [
      ...new Set(lines.map((line) => line.containerId).filter(Boolean)),
    ] as string[];
    packages = await client.container.findMany({
      where: { id: { in: boxIds } },
      orderBy: { number: "asc" },
      select: {
        id: true,
        code: true,
        kind: true,
        weightKg: true,
        outboundOrderId: true,
      },
    });
    const lots = await lotsOf(client, [...lotIds]);
    const codeOf = new Map(packages.map((box) => [box.id, box.code]));
    views = orders.map((order) => ({
      ...orderHead(order),
      problem: null,
      lines: lines
        .filter((line) => line.orderId === order.id)
        .map((line) => ({
          productId: line.productId,
          quantity: line.quantity.toString(),
          unitCode: line.unitCode,
          productName: line.product.name,
          sku: line.product.sku,
          quantityText: formatStock(line.quantity.toString(), line.unitCode),
          lotText: line.lotId ? (lots.get(line.lotId) ?? null) : null,
          lotId: line.lotId,
          serials: line.serials ? line.serials.split(", ") : [],
          packageCode: line.containerId
            ? (codeOf.get(line.containerId) ?? null)
            : null,
        })),
      packages: packages
        .filter((box) => box.outboundOrderId === order.id)
        .map(packageView),
    }));
  } else if (row.status === "DRAFT") {
    const load = await loadOf(client, orders);
    const statuses = await readyStatuses(client);
    for (const draft of load.drafts) if (draft.lotId) lotIds.add(draft.lotId);
    const lots = await lotsOf(client, [...lotIds]);
    const productOf = new Map(
      orders.flatMap((order) =>
        order.lines.map((line) => [line.productId, line.product] as const),
      ),
    );
    const codeOf = new Map(load.boxes.map((box) => [box.id, box.code]));
    packages = load.boxes;
    views = orders.map((order) => ({
      ...orderHead(order),
      problem: (() => {
        const status = readyProblem(order.status, statuses);
        return status
          ? `${formatOutboundNumber(order.number)}: ${status}`
          : (load.problems.get(order.id) ?? null);
      })(),
      lines: load.drafts
        .filter((draft) => draft.orderId === order.id)
        .map((draft) => ({
          productId: draft.productId,
          quantity: draft.quantity.toString(),
          unitCode: draft.unitCode,
          productName: draft.productName,
          sku: productOf.get(draft.productId)?.sku ?? "",
          quantityText: formatStock(draft.quantity.toString(), draft.unitCode),
          lotText: draft.lotId ? (lots.get(draft.lotId) ?? null) : null,
          lotId: draft.lotId,
          serials: draft.units.map((unit) => unit.serial),
          packageCode: draft.containerId
            ? (codeOf.get(draft.containerId) ?? null)
            : null,
        })),
      packages: load.boxes
        .filter((box) => box.outboundOrderId === order.id)
        .map(packageView),
    }));
  } else {
    packages = [];
    views = orders.map((order) => ({
      ...orderHead(order),
      problem: null,
      lines: [],
      packages: [],
    }));
  }
  const weighed = packages.filter((box) => box.weightKg !== null);
  const weight = weighed.reduce(
    (sum, box) => sum.plus(box.weightKg!.toString()),
    dec(0),
  );
  return {
    id: row.id,
    numberText: formatShipmentNumber(row.number),
    status: row.status,
    statusLabel: SHIPMENT_STATUS_LABELS[row.status],
    facilityName: row.facility.name,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    vehiclePlate: row.vehiclePlate,
    driverName: row.driverName,
    note: row.note,
    createdAt: row.createdAt,
    authorName: nameOf.get(row.createdByUserId) ?? null,
    shippedAt: row.shippedAt,
    shippedByName: row.shippedByUserId
      ? (nameOf.get(row.shippedByUserId) ?? null)
      : null,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    movementId: row.movementId,
    orders: views,
    packageCount: packages.length,
    weightText: weighed.length > 0 ? weightText(weight.toString()) : null,
    unweighed: packages.length - weighed.length,
    ready:
      row.status === "DRAFT" &&
      views.length > 0 &&
      views.every((order) => order.problem === null),
    detailsRequired:
      (await readSetting(client, SHIPMENT_DETAILS)) === "required",
    dispatchWaits:
      row.status === "DRAFT"
        ? await operationWaits(
            client,
            SHIPMENT_PROCESS,
            row.id,
            SHIPMENT_DISPATCHED_OPERATION,
          )
        : null,
    ordersFixed:
      row.status === "DRAFT"
        ? await doneStagesAt(client, SHIPMENT_PROCESS, row.id).then((done) =>
            done.length > 0 ? ordersFixedMessage(done) : null,
          )
        : null,
  };
}

type PackageRow = {
  id: string;
  code: string;
  kind: string;
  outboundOrderId: string | null;
  weightKg: { toString(): string } | null;
};

function orderHead(order: OrderRow) {
  return {
    id: order.id,
    numberText: formatOutboundNumber(order.number),
    recipient: order.recipient,
    address: order.address,
    reference: order.reference,
    status: order.status,
    statusLabel: OUTBOUND_ORDER_STATUS_LABELS[order.status],
  };
}

const packageView = (box: {
  id: string;
  code: string;
  kind: string;
  weightKg: { toString(): string } | null;
}): ShipmentPackageView => ({
  id: box.id,
  code: box.code,
  kind: box.kind,
  weightText: box.weightKg ? weightText(box.weightKg.toString()) : null,
});

async function lotsOf(
  client: Client,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const lots = await client.lot.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, expiresOn: true },
  });
  return new Map(
    lots.map((lot) => [
      lot.id,
      lotLabel({ code: lot.code, expiresOn: lotDayOf(lot.expiresOn) }),
    ]),
  );
}

/** Whether the company asks for the carrier and who takes it (setting). */
export async function shipmentDetailsRequired(
  actor: InventoryActor,
): Promise<boolean> {
  return (
    (await readSetting(
      forOrganization(actor.organizationId),
      SHIPMENT_DETAILS,
    )) === "required"
  );
}

/**
 * The open shipment of an order (a draft or the one it left in), for the
 * order's card; null when it is in none.
 */
export async function shipmentOfOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<{
  id: string;
  numberText: string;
  status: ShipmentStatus;
  statusLabel: string;
} | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const row = await forOrganization(
    actor.organizationId,
  ).shipmentOrder.findFirst({
    where: {
      orderId: String(orderId ?? "").slice(0, 36),
      openOrderId: { not: null },
    },
    select: { shipment: { select: { id: true, number: true, status: true } } },
  });
  if (!row) return null;
  return {
    id: row.shipment.id,
    numberText: formatShipmentNumber(row.shipment.number),
    status: row.shipment.status,
    statusLabel: SHIPMENT_STATUS_LABELS[row.shipment.status],
  };
}
