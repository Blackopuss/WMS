import "server-only";

import { isAppError } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { normalizeSearch } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  isFacilityInScope,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { containerName, normalizeContainerCode } from "./container-rules";
import { formatLotDay, lotDayOf, normalizeLotCode } from "./lot-rules";
import { formatOutboundNumber } from "./outbound-states";
import { formatStock, type InventoryActor } from "./movements";
import { normalizeSerial } from "./serial-rules";
import { formatShipmentNumber } from "./shipment-states";
import {
  CUSTOMER_RETURN_STATUS_LABELS,
  formatCustomerReturnNumber,
  parseCustomerReturnNumber,
} from "./customer-return-states";
import {
  FACILITY_TRANSFER_STATUS_LABELS,
  formatFacilityTransferNumber,
  parseFacilityTransferNumber,
} from "./facility-transfer-states";
import { STOCK_STATUS_LABELS } from "./stock-status";
import { formatTaskNumber } from "./task-states";

/**
 * Traceability (WMS-21B, ADR 0041): «where it came from and where it went»
 * for a lot, a unit by serial or an outbound order. Read only.
 *
 * - One search box takes a lot, a serial, an order «PS-0001» or a purchase
 *   order «OC-0007» (`findTraceMatches`).
 * - The movements of a lot or a unit are those of `listMovements` (filter
 *   `lotId` or `serialUnitId`); where a lot is today, `getLot`. This file
 *   adds what the history does not say: which receipt (purchase order and
 *   supplier) brought it and which orders it was picked for.
 * - Scope (WMS-20): a lot or a unit with no movement in the person's
 *   warehouses or zones does not exist for them; an order of a warehouse
 *   closed to them neither. Purchasing data (order, supplier) only for who
 *   may read purchase orders, with the module active.
 */

export type TraceMatch =
  | {
      kind: "lot";
      id: string;
      code: string;
      productName: string;
      sku: string;
    }
  | {
      kind: "serial";
      id: string;
      serial: string;
      productName: string;
      sku: string;
    }
  | { kind: "order"; id: string; numberText: string; recipient: string }
  | {
      kind: "purchase_order";
      id: string;
      numberText: string;
      supplierName: string;
    }
  /** WMS-53: a pallet or box by its label. */
  | { kind: "container"; id: string; code: string; name: string }
  /** WMS-16: a shipment by its number. */
  | {
      kind: "shipment";
      id: string;
      numberText: string;
      statusLabel: string;
    }
  /** WMS-17: a customer return by its number. */
  | {
      kind: "customer_return";
      id: string;
      numberText: string;
      returnedBy: string;
      statusLabel: string;
    }
  /** WMS-19: a transfer between warehouses by its number. */
  | {
      kind: "facility_transfer";
      id: string;
      numberText: string;
      route: string;
      statusLabel: string;
    };

const MATCHES_SHOWN = 20;

/** Whether this person may see purchase orders (and their suppliers). */
async function mayReadPurchasing(actor: InventoryActor): Promise<boolean> {
  try {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      "purchasing.order.read",
    );
    return true;
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return false;
    throw error;
  }
}

async function mayRead(
  actor: InventoryActor,
  permission:
    | "inventory.outbound.read"
    | "inventory.stock.read"
    | "inventory.shipment.read"
    | "inventory.customer_return.read"
    | "inventory.facility_transfer.read",
): Promise<boolean> {
  try {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      permission,
    );
    return true;
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return false;
    throw error;
  }
}

/** «PS-12», «ps 0012» → 12; null when it is not that kind of number. */
function numberOf(prefix: "PS" | "OC" | "EM", text: string): number | null {
  const match = new RegExp(`^${prefix}[\\s-]*0*(\\d{1,9})$`, "i").exec(
    text.trim(),
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

type FoundLot = Extract<TraceMatch, { kind: "lot" }>;
type FoundSerial = Extract<TraceMatch, { kind: "serial" }>;

/**
 * Lots whose code is exactly the text (any product), with some movement in
 * the person's scope (WMS-20). Shared by the trace and the global search
 * (WMS-66); the caller checks the permission.
 */
export async function findLotsByCode(
  actor: InventoryActor,
  text: string,
  take: number,
): Promise<FoundLot[]> {
  const lotCode = normalizeLotCode(text);
  if (!lotCode.ok) return [];
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const lots = await client.lot.findMany({
    where: {
      code: lotCode.code,
      ...(isLimited(scoped) ? { lines: { some: { location: scoped } } } : {}),
    },
    orderBy: { id: "asc" },
    take,
    select: {
      id: true,
      code: true,
      product: { select: { name: true, sku: true } },
    },
  });
  return lots.map((lot) => ({
    kind: "lot" as const,
    id: lot.id,
    code: lot.code,
    productName: lot.product.name,
    sku: lot.product.sku,
  }));
}

/**
 * Units whose serial is exactly the text (any product), with some
 * movement in the person's scope. Shared by the trace and the global
 * search; the caller checks the permission.
 */
export async function findSerialsBySerial(
  actor: InventoryActor,
  text: string,
  take: number,
): Promise<FoundSerial[]> {
  const serial = normalizeSerial(text);
  if (!serial.ok) return [];
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const units = await client.serialUnit.findMany({
    where: {
      serial: serial.serial,
      ...(isLimited(scoped) ? { moves: { some: { location: scoped } } } : {}),
    },
    orderBy: { id: "asc" },
    take,
    select: {
      id: true,
      serial: true,
      product: { select: { name: true, sku: true } },
    },
  });
  return units.map((unit) => ({
    kind: "serial" as const,
    id: unit.id,
    serial: unit.serial,
    productName: unit.product.name,
    sku: unit.product.sku,
  }));
}

/**
 * What a search names: lots and units by serial with exactly that code
 * (any product), an outbound order or a purchase order by its number.
 */
export async function findTraceMatches(
  actor: InventoryActor,
  query: string,
): Promise<{ query: string; matches: TraceMatch[] }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  const text = String(query ?? "")
    .trim()
    .slice(0, 100);
  if (text === "") return { query: "", matches: [] };
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const limited = isLimited(scoped);
  const matches: TraceMatch[] = [];

  matches.push(...(await findLotsByCode(actor, text, MATCHES_SHOWN)));
  matches.push(...(await findSerialsBySerial(actor, text, MATCHES_SHOWN)));
  const orderNumber = numberOf("PS", text);
  if (orderNumber && (await mayRead(actor, "inventory.outbound.read"))) {
    const order = await client.outboundOrder.findFirst({
      where: { number: orderNumber },
      select: { id: true, number: true, recipient: true, facilityId: true },
    });
    if (
      order &&
      (await isFacilityInScope(client, actor.userId, order.facilityId))
    ) {
      matches.push({
        kind: "order",
        id: order.id,
        numberText: formatOutboundNumber(order.number),
        recipient: order.recipient,
      });
    }
  }
  const purchaseNumber = numberOf("OC", text);
  if (purchaseNumber && (await mayReadPurchasing(actor))) {
    const order = await client.purchaseOrder.findFirst({
      where: { number: purchaseNumber },
      select: {
        id: true,
        number: true,
        facilityId: true,
        contact: { select: { name: true } },
      },
    });
    // WMS-57: an order of a warehouse outside the scope does not exist.
    if (
      order &&
      (order.facilityId === null ||
        (await isFacilityInScope(client, actor.userId, order.facilityId)))
    ) {
      matches.push({
        kind: "purchase_order",
        id: order.id,
        numberText: `OC-${String(order.number).padStart(4, "0")}`,
        supplierName: order.contact.name,
      });
    }
  }
  // WMS-16: a shipment by its number, of a warehouse the person may see.
  const shipmentNumber = numberOf("EM", text);
  if (shipmentNumber && (await mayRead(actor, "inventory.shipment.read"))) {
    const shipment = await client.shipment.findFirst({
      where: { number: shipmentNumber },
      select: { id: true, number: true, status: true, facilityId: true },
    });
    if (
      shipment &&
      (await isFacilityInScope(client, actor.userId, shipment.facilityId))
    ) {
      matches.push({
        kind: "shipment",
        id: shipment.id,
        numberText: formatShipmentNumber(shipment.number),
        statusLabel: SHIPMENT_STATUS_TEXT[shipment.status],
      });
    }
  }
  // WMS-17: a customer return by its number, of a warehouse in scope.
  const returnNumber = parseCustomerReturnNumber(text);
  if (
    returnNumber &&
    (await mayRead(actor, "inventory.customer_return.read"))
  ) {
    const back = await client.customerReturn.findFirst({
      where: { number: returnNumber },
      select: {
        id: true,
        number: true,
        status: true,
        returnedBy: true,
        facilityId: true,
      },
    });
    if (
      back &&
      (await isFacilityInScope(client, actor.userId, back.facilityId))
    ) {
      matches.push({
        kind: "customer_return",
        id: back.id,
        numberText: formatCustomerReturnNumber(back.number),
        returnedBy: back.returnedBy,
        statusLabel: CUSTOMER_RETURN_STATUS_LABELS[back.status],
      });
    }
  }
  // WMS-19: a transfer by its number, for who reaches one of its sides.
  const transferNumber = parseFacilityTransferNumber(text);
  if (
    transferNumber &&
    (await mayRead(actor, "inventory.facility_transfer.read"))
  ) {
    const transfer = await client.facilityTransfer.findFirst({
      where: { number: transferNumber },
      select: {
        id: true,
        number: true,
        status: true,
        fromFacilityId: true,
        toFacilityId: true,
        fromFacility: { select: { name: true } },
        toFacility: { select: { name: true } },
      },
    });
    if (
      transfer &&
      ((await isFacilityInScope(
        client,
        actor.userId,
        transfer.fromFacilityId,
      )) ||
        (await isFacilityInScope(client, actor.userId, transfer.toFacilityId)))
    ) {
      matches.push({
        kind: "facility_transfer",
        id: transfer.id,
        numberText: formatFacilityTransferNumber(transfer.number),
        route: `${transfer.fromFacility.name} a ${transfer.toFacility.name}`,
        statusLabel: FACILITY_TRANSFER_STATUS_LABELS[transfer.status],
      });
    }
  }
  // WMS-53: a container by its label, where the person may see it now.
  const containerCode = normalizeContainerCode(text);
  if (containerCode.ok && (await mayRead(actor, "inventory.stock.read"))) {
    const box = await client.container.findFirst({
      where: {
        code: containerCode.code,
        ...(limited ? { location: scoped } : {}),
      },
      select: { id: true, code: true, kind: true },
    });
    if (box) {
      matches.push({
        kind: "container",
        id: box.id,
        code: box.code,
        name: containerName(box),
      });
    }
  }
  return { query: text, matches };
}

/** A receipt of a purchase order that brought the lot or the unit. */
export type TraceOrigin = {
  movementId: string;
  receivedAt: Date;
  /** Null for who may not read purchase orders: only «Recepción». */
  purchase: {
    orderId: string;
    numberText: string;
    supplierName: string;
  } | null;
};

/** An outbound order the lot or the unit was picked for. */
export type TraceOrder = {
  orderId: string;
  numberText: string;
  recipient: string;
  taskNumberText: string;
  /** «Entregada», «Recogida»… of the picking task. */
  taskStatus: string;
  delivered: boolean;
};

async function originsOf(
  actor: InventoryActor,
  movementIds: string[],
): Promise<TraceOrigin[]> {
  if (movementIds.length === 0) return [];
  const client = forOrganization(actor.organizationId);
  const purchasing = await mayReadPurchasing(actor);
  const receipts = await client.purchaseReceipt.findMany({
    where: { movementId: { in: movementIds } },
    orderBy: { id: "asc" },
    take: 50,
    select: {
      movementId: true,
      createdAt: true,
      order: {
        select: { id: true, number: true, contact: { select: { name: true } } },
      },
    },
  });
  return receipts.map((receipt) => ({
    movementId: receipt.movementId,
    receivedAt: receipt.createdAt,
    purchase: purchasing
      ? {
          orderId: receipt.order.id,
          numberText: `OC-${String(receipt.order.number).padStart(4, "0")}`,
          supplierName: receipt.order.contact.name,
        }
      : null,
  }));
}

const TASK_STATUS_TEXT: Record<string, string> = {
  PENDING: "Pendiente",
  ASSIGNED: "Asignada",
  ACCEPTED: "Tomada",
  PICKED_UP: "Surtida, por entregar",
  DELIVERED: "Entregada en preparación",
  BLOCKED: "Con problema",
  CANCELLED: "Cancelada",
};

async function ordersOf(
  actor: InventoryActor,
  where: { lotId: string } | { serialUnitId: string },
): Promise<TraceOrder[]> {
  if (!(await mayRead(actor, "inventory.outbound.read"))) return [];
  const client = forOrganization(actor.organizationId);
  const tasks = await client.warehouseTask.findMany({
    where: {
      kind: "PICK",
      status: { not: "CANCELLED" },
      ...("lotId" in where
        ? { lotId: where.lotId }
        : { serials: { some: { serialUnitId: where.serialUnitId } } }),
    },
    orderBy: { number: "asc" },
    take: 100,
    select: {
      number: true,
      status: true,
      outboundLine: {
        select: {
          order: {
            select: {
              id: true,
              number: true,
              recipient: true,
              facilityId: true,
            },
          },
        },
      },
    },
  });
  const facilities = new Map<string, boolean>();
  const result: TraceOrder[] = [];
  for (const task of tasks) {
    const order = task.outboundLine?.order;
    if (!order) continue;
    if (!facilities.has(order.facilityId)) {
      facilities.set(
        order.facilityId,
        await isFacilityInScope(client, actor.userId, order.facilityId),
      );
    }
    if (!facilities.get(order.facilityId)) continue;
    result.push({
      orderId: order.id,
      numberText: formatOutboundNumber(order.number),
      recipient: order.recipient,
      taskNumberText: formatTaskNumber(task.number),
      taskStatus: TASK_STATUS_TEXT[task.status] ?? task.status,
      delivered: task.status === "DELIVERED",
    });
  }
  return result;
}

const SHIPMENT_STATUS_TEXT = {
  DRAFT: "Por confirmar",
  SHIPPED: "Despachado",
  CANCELLED: "Cancelado",
} as const;

/** A shipment the lot or the unit left the warehouse with (WMS-16). */
export type TraceShipment = {
  shipmentId: string;
  numberText: string;
  shippedAt: Date | null;
  orderId: string;
  orderNumberText: string;
  recipient: string;
  carrier: string | null;
  trackingNumber: string | null;
  /** «12 piezas». */
  quantityText: string;
};

async function shipmentsOf(
  actor: InventoryActor,
  where: { lotId: string } | { movementLineIds: string[] },
): Promise<TraceShipment[]> {
  if (!(await mayRead(actor, "inventory.shipment.read"))) return [];
  if ("movementLineIds" in where && where.movementLineIds.length === 0) {
    return [];
  }
  const client = forOrganization(actor.organizationId);
  const lines = await client.shipmentLine.findMany({
    where:
      "lotId" in where
        ? { lotId: where.lotId }
        : { movementLineId: { in: where.movementLineIds } },
    orderBy: { id: "asc" },
    take: 100,
    select: {
      quantity: true,
      unitCode: true,
      shipment: {
        select: {
          id: true,
          number: true,
          shippedAt: true,
          carrier: true,
          trackingNumber: true,
          facilityId: true,
        },
      },
      order: { select: { id: true, number: true, recipient: true } },
    },
  });
  const facilities = new Map<string, boolean>();
  const result: TraceShipment[] = [];
  for (const line of lines) {
    const { facilityId } = line.shipment;
    if (!facilities.has(facilityId)) {
      facilities.set(
        facilityId,
        await isFacilityInScope(client, actor.userId, facilityId),
      );
    }
    if (!facilities.get(facilityId)) continue;
    result.push({
      shipmentId: line.shipment.id,
      numberText: formatShipmentNumber(line.shipment.number),
      shippedAt: line.shipment.shippedAt,
      orderId: line.order.id,
      orderNumberText: formatOutboundNumber(line.order.number),
      recipient: line.order.recipient,
      carrier: line.shipment.carrier,
      trackingNumber: line.shipment.trackingNumber,
      quantityText: formatStock(line.quantity.toString(), line.unitCode),
    });
  }
  return result;
}

/** A customer return that brought the lot or the unit back (WMS-17). */
export type TraceReturn = {
  returnId: string;
  numberText: string;
  receivedAt: Date;
  returnedBy: string;
  orderNumberText: string | null;
  /** «2 piezas». */
  quantityText: string;
  statusLabel: string;
};

async function returnsOf(
  actor: InventoryActor,
  where: { lotId: string } | { movementLineIds: string[] },
): Promise<TraceReturn[]> {
  if (!(await mayRead(actor, "inventory.customer_return.read"))) return [];
  if ("movementLineIds" in where && where.movementLineIds.length === 0) {
    return [];
  }
  const client = forOrganization(actor.organizationId);
  const lines = await client.customerReturnLine.findMany({
    where:
      "lotId" in where
        ? { lotId: where.lotId }
        : { movementLineId: { in: where.movementLineIds } },
    orderBy: { id: "asc" },
    take: 100,
    select: {
      quantity: true,
      unitCode: true,
      return: {
        select: {
          id: true,
          number: true,
          status: true,
          createdAt: true,
          returnedBy: true,
          facilityId: true,
          order: { select: { number: true } },
        },
      },
    },
  });
  const facilities = new Map<string, boolean>();
  const result: TraceReturn[] = [];
  for (const line of lines) {
    const { facilityId } = line.return;
    if (!facilities.has(facilityId)) {
      facilities.set(
        facilityId,
        await isFacilityInScope(client, actor.userId, facilityId),
      );
    }
    if (!facilities.get(facilityId)) continue;
    result.push({
      returnId: line.return.id,
      numberText: formatCustomerReturnNumber(line.return.number),
      receivedAt: line.return.createdAt,
      returnedBy: line.return.returnedBy,
      orderNumberText: line.return.order
        ? formatOutboundNumber(line.return.order.number)
        : null,
      quantityText: formatStock(line.quantity.toString(), line.unitCode),
      statusLabel: CUSTOMER_RETURN_STATUS_LABELS[line.return.status],
    });
  }
  return result;
}

export type LotTrace = {
  origins: TraceOrigin[];
  orders: TraceOrder[];
  /** Where it left the warehouse to (WMS-16). */
  shipments: TraceShipment[];
  /** What of it customers brought back (WMS-17). */
  returns: TraceReturn[];
};

/**
 * What the card of a lot does not say: the receipts that brought it and
 * the orders it was picked for. Null when the lot does not exist for this
 * person (none of its movements in their scope).
 */
export async function traceLot(
  actor: InventoryActor,
  lotId: string,
): Promise<LotTrace | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const lines = await client.stockMovementLine.findMany({
    where: {
      lotId: String(lotId ?? "").slice(0, 36),
      direction: "IN",
      ...(isLimited(scoped) ? { location: scoped } : {}),
    },
    orderBy: { id: "asc" },
    take: 500,
    select: { movementId: true },
  });
  const anyLine = await client.stockMovementLine.findFirst({
    where: {
      lotId: String(lotId ?? "").slice(0, 36),
      ...(isLimited(scoped) ? { location: scoped } : {}),
    },
    select: { id: true },
  });
  if (!anyLine) return null;
  const [origins, orders, shipments, returns] = await Promise.all([
    originsOf(actor, [...new Set(lines.map((line) => line.movementId))]),
    ordersOf(actor, { lotId: String(lotId).slice(0, 36) }),
    shipmentsOf(actor, { lotId: String(lotId).slice(0, 36) }),
    returnsOf(actor, { lotId: String(lotId).slice(0, 36) }),
  ]);
  return { origins, orders, shipments, returns };
}

export type SerialTrace = {
  id: string;
  serial: string;
  product: { id: string; name: string; sku: string };
  /**
   * Where it is today: a place of the person's scope, «out» when it left
   * the warehouse, «elsewhere» when it is in a warehouse or zone closed to
   * them (named nowhere).
   */
  now:
    | { kind: "here"; path: string; statusLabel: string }
    | { kind: "out" }
    | { kind: "elsewhere" };
  origins: TraceOrigin[];
  orders: TraceOrder[];
  /** The shipments it left with (WMS-16). */
  shipments: TraceShipment[];
  /** The customer returns it came back with (WMS-17). */
  returns: TraceReturn[];
};

/**
 * The card of a unit by serial; its movements are `listMovements` with
 * `serialUnitId`. Null when it does not exist for this person.
 */
export async function traceSerial(
  actor: InventoryActor,
  serialUnitId: string,
): Promise<SerialTrace | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  const client = forOrganization(actor.organizationId);
  const id = String(serialUnitId ?? "").slice(0, 36);
  const scoped = await locationScopeWhere(client, actor.userId);
  const unit = await client.serialUnit.findFirst({
    where: {
      id,
      ...(isLimited(scoped) ? { moves: { some: { location: scoped } } } : {}),
    },
    select: {
      id: true,
      serial: true,
      locationId: true,
      status: true,
      product: { select: { id: true, name: true, sku: true } },
      location: { select: { name: true, parent: LOCATION_PARENTS } },
    },
  });
  if (!unit) return null;
  const moves = await client.serialMove.findMany({
    where: {
      serialUnitId: unit.id,
      direction: "IN",
      ...(isLimited(scoped) ? { location: scoped } : {}),
    },
    orderBy: { id: "asc" },
    take: 500,
    select: { movementLineId: true },
  });
  const lines = await client.stockMovementLine.findMany({
    where: { id: { in: moves.map((move) => move.movementLineId) } },
    select: { movementId: true },
  });
  let now: SerialTrace["now"] = { kind: "out" };
  if (unit.locationId && unit.location && unit.status) {
    const outside = await locationsOutOfScope(client, actor.userId, [
      unit.locationId,
    ]);
    now =
      outside.length > 0
        ? { kind: "elsewhere" }
        : {
            kind: "here",
            path: locationPath(unit.location),
            statusLabel: STOCK_STATUS_LABELS[unit.status],
          };
  }
  // WMS-16: the lines that took it out, for the shipments it left with.
  const exits = await client.serialMove.findMany({
    where: { serialUnitId: unit.id, direction: "OUT" },
    orderBy: { id: "asc" },
    take: 500,
    select: { movementLineId: true },
  });
  const [origins, orders, shipments, returns] = await Promise.all([
    originsOf(actor, [...new Set(lines.map((line) => line.movementId))]),
    ordersOf(actor, { serialUnitId: unit.id }),
    shipmentsOf(actor, {
      movementLineIds: exits.map((move) => move.movementLineId),
    }),
    // WMS-17: the lines that brought it back (all its entries, any place).
    returnsOf(actor, {
      movementLineIds: (
        await client.serialMove.findMany({
          where: { serialUnitId: unit.id, direction: "IN" },
          orderBy: { id: "asc" },
          take: 500,
          select: { movementLineId: true },
        })
      ).map((move) => move.movementLineId),
    }),
  ]);
  return {
    id: unit.id,
    serial: unit.serial,
    product: unit.product,
    now,
    origins,
    orders,
    shipments,
    returns,
  };
}

export type PurchaseTrace = {
  orderId: string;
  numberText: string;
  supplierName: string;
  receipts: {
    receivedAt: Date;
    lines: {
      productName: string;
      sku: string;
      lot: { id: string; code: string; expiresLabel: string | null } | null;
      serials: { id: string; serial: string }[];
    }[];
  }[];
};

/**
 * What a purchase order brought, receipt by receipt: the lots and the
 * units by serial of each line. Only for who may read purchase orders;
 * receipts into locations outside the scope are left out.
 */
export async function tracePurchaseOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<PurchaseTrace | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  if (!(await mayReadPurchasing(actor))) return null;
  const client = forOrganization(actor.organizationId);
  const order = await client.purchaseOrder.findFirst({
    where: { id: String(orderId ?? "").slice(0, 36) },
    select: {
      id: true,
      number: true,
      facilityId: true,
      contact: { select: { name: true } },
      receipts: {
        orderBy: { id: "asc" },
        take: 50,
        select: {
          createdAt: true,
          movementId: true,
          lines: {
            orderBy: { lineNumber: "asc" },
            select: {
              lineNumber: true,
              locationId: true,
              product: { select: { name: true, sku: true } },
              lot: { select: { id: true, code: true, expiresOn: true } },
            },
          },
        },
      },
    },
  });
  // WMS-57: an order of a warehouse outside the scope does not exist.
  if (
    !order ||
    (order.facilityId !== null &&
      !(await isFacilityInScope(client, actor.userId, order.facilityId)))
  ) {
    return null;
  }
  const outside = new Set(
    await locationsOutOfScope(
      client,
      actor.userId,
      order.receipts.flatMap((receipt) =>
        receipt.lines.map((line) => line.locationId),
      ),
    ),
  );
  const movementLines = await client.stockMovementLine.findMany({
    where: { movementId: { in: order.receipts.map((r) => r.movementId) } },
    select: { id: true, movementId: true, lineNumber: true },
  });
  const moves = await client.serialMove.findMany({
    where: { movementLineId: { in: movementLines.map((line) => line.id) } },
    orderBy: { id: "asc" },
    select: {
      movementLineId: true,
      serialUnit: { select: { id: true, serial: true } },
    },
  });
  const unitsOf = new Map<string, { id: string; serial: string }[]>();
  for (const move of moves) {
    const list = unitsOf.get(move.movementLineId) ?? [];
    list.push(move.serialUnit);
    unitsOf.set(move.movementLineId, list);
  }
  const lineOf = new Map(
    movementLines.map((line) => [
      `${line.movementId} ${line.lineNumber}`,
      line.id,
    ]),
  );
  return {
    orderId: order.id,
    numberText: `OC-${String(order.number).padStart(4, "0")}`,
    supplierName: order.contact.name,
    receipts: order.receipts
      .map((receipt) => ({
        receivedAt: receipt.createdAt,
        lines: receipt.lines
          .filter((line) => !outside.has(line.locationId))
          .map((line) => {
            const expiresOn = line.lot ? lotDayOf(line.lot.expiresOn) : null;
            return {
              productName: line.product.name,
              sku: line.product.sku,
              lot: line.lot
                ? {
                    id: line.lot.id,
                    code: line.lot.code,
                    expiresLabel: expiresOn ? formatLotDay(expiresOn) : null,
                  }
                : null,
              serials:
                unitsOf.get(
                  lineOf.get(`${receipt.movementId} ${line.lineNumber}`) ?? "",
                ) ?? [],
            };
          }),
      }))
      .filter((receipt) => receipt.lines.length > 0),
  };
}

export const SERIAL_PAGE_SIZE = 25;

export type SerialPage = {
  items: {
    id: string;
    serial: string;
    path: string;
    statusLabel: string;
  }[];
  total: number;
  page: number;
  pageCount: number;
  search: string;
};

/**
 * The units by serial of a product that are inside, where the person may
 * work (WMS-20), by serial; each one opens its traceability. Paged in the
 * database; `search` is part of a serial.
 */
export async function listProductSerials(
  actor: InventoryActor,
  productId: string,
  options: { page?: number; search?: string } = {},
): Promise<SerialPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const search = normalizeSearch(options.search ?? "").toUpperCase();
  const where = {
    productId: String(productId ?? "").slice(0, 36),
    locationId: { not: null },
    ...(isLimited(scoped) ? { location: scoped } : {}),
    ...(search
      ? {
          AND: search.split(" ").map((word) => ({
            serial: { contains: word.replace(/[\\%_]/g, "\\$&") },
          })),
        }
      : {}),
  };
  const total = await client.serialUnit.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / SERIAL_PAGE_SIZE));
  const requested = Number.isInteger(options.page) ? Number(options.page) : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const units = await client.serialUnit.findMany({
    where,
    orderBy: [{ serial: "asc" }, { id: "asc" }],
    skip: (page - 1) * SERIAL_PAGE_SIZE,
    take: SERIAL_PAGE_SIZE,
    select: {
      id: true,
      serial: true,
      status: true,
      location: { select: { name: true, parent: LOCATION_PARENTS } },
    },
  });
  return {
    items: units.map((unit) => ({
      id: unit.id,
      serial: unit.serial,
      path: unit.location ? locationPath(unit.location) : "",
      statusLabel: unit.status ? STOCK_STATUS_LABELS[unit.status] : "",
    })),
    total,
    page,
    pageCount,
    search,
  };
}
