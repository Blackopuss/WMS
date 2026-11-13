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

import { formatLotDay, lotDayOf, normalizeLotCode } from "./lot-rules";
import type { InventoryActor } from "./movements";
import { formatOutboundNumber } from "./outbound-states";
import { normalizeSerial } from "./serial-rules";
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
  permission: "inventory.outbound.read" | "inventory.stock.read",
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
function numberOf(prefix: "PS" | "OC", text: string): number | null {
  const match = new RegExp(`^${prefix}[\\s-]*0*(\\d{1,9})$`, "i").exec(
    text.trim(),
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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

  const lotCode = normalizeLotCode(text);
  if (lotCode.ok) {
    const lots = await client.lot.findMany({
      where: {
        code: lotCode.code,
        ...(limited ? { lines: { some: { location: scoped } } } : {}),
      },
      orderBy: { id: "asc" },
      take: MATCHES_SHOWN,
      select: {
        id: true,
        code: true,
        product: { select: { name: true, sku: true } },
      },
    });
    matches.push(
      ...lots.map((lot) => ({
        kind: "lot" as const,
        id: lot.id,
        code: lot.code,
        productName: lot.product.name,
        sku: lot.product.sku,
      })),
    );
  }
  const serial = normalizeSerial(text);
  if (serial.ok) {
    const units = await client.serialUnit.findMany({
      where: {
        serial: serial.serial,
        ...(limited ? { moves: { some: { location: scoped } } } : {}),
      },
      orderBy: { id: "asc" },
      take: MATCHES_SHOWN,
      select: {
        id: true,
        serial: true,
        product: { select: { name: true, sku: true } },
      },
    });
    matches.push(
      ...units.map((unit) => ({
        kind: "serial" as const,
        id: unit.id,
        serial: unit.serial,
        productName: unit.product.name,
        sku: unit.product.sku,
      })),
    );
  }
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
      select: { id: true, number: true, contact: { select: { name: true } } },
    });
    if (order) {
      matches.push({
        kind: "purchase_order",
        id: order.id,
        numberText: `OC-${String(order.number).padStart(4, "0")}`,
        supplierName: order.contact.name,
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

export type LotTrace = {
  origins: TraceOrigin[];
  orders: TraceOrder[];
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
  const [origins, orders] = await Promise.all([
    originsOf(actor, [...new Set(lines.map((line) => line.movementId))]),
    ordersOf(actor, { lotId: String(lotId).slice(0, 36) }),
  ]);
  return { origins, orders };
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
  const [origins, orders] = await Promise.all([
    originsOf(actor, [...new Set(lines.map((line) => line.movementId))]),
    ordersOf(actor, { serialUnitId: unit.id }),
  ]);
  return {
    id: unit.id,
    serial: unit.serial,
    product: unit.product,
    now,
    origins,
    orders,
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
  if (!order) return null;
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
