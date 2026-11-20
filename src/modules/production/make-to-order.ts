import "server-only";

import { dec, newId } from "@/lib";
import {
  formatStock,
  waitingOrderOf,
  type InventoryActor,
  type MakeToOrder,
  type MakeToOrderLine,
} from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { isFacilityInScope, locationsOutOfScope } from "@/platform/locations";
import { getEntitlements, readModuleStates } from "@/platform/entitlements";
import { notify } from "@/platform/notifications";
import { forOrganization, type TenantDb } from "@/server";

import { OUTBOUND_WAITING_NOTICE, REQUEST_TO_DECIDE_NOTICE } from "./notices";
import {
  OPEN_PRODUCTION_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  formatProductionNumber,
} from "./order-states";
import {
  PRODUCTION_REQUEST_STATUS_LABELS,
  formatProductionRequestNumber,
} from "./request-states";

/**
 * Producción's side of an outbound order that waits for it (WMS-79, ADR
 * 0094). Inventario does not import Producción: the app hands
 * `makeToOrder` to the services of the outbound order, and they call it
 * inside their transaction, under the lock of the order.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

type AreaReader = Pick<Client, "recipe" | "location">;

/**
 * The production area of each product in this warehouse: the area of its
 * recipe when it belongs to the warehouse, is of use «Producción» and is
 * not archived; without one, the only production area of the warehouse;
 * none when there are several or none. Only products with a recipe in
 * force.
 */
async function areasOf(
  client: AreaReader & Pick<Client, "recipeVersion">,
  facilityId: string,
  productIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(productIds)];
  const areas = new Map<string, string>();
  if (ids.length === 0) return areas;
  const recipes = await client.recipe.findMany({
    where: {
      productId: { in: ids },
      versions: { some: { status: "ACTIVE" } },
    },
    select: { productId: true, areaLocationId: true },
  });
  if (recipes.length === 0) return areas;
  const places = await client.location.findMany({
    where: { facilityId, type: "PRODUCTION", archivedAt: null },
    select: { id: true },
  });
  const inFacility = new Set(places.map((place) => place.id));
  const only = places.length === 1 ? places[0]!.id : null;
  for (const recipe of recipes) {
    const area =
      recipe.areaLocationId && inFacility.has(recipe.areaLocationId)
        ? recipe.areaLocationId
        : recipe.areaLocationId
          ? null
          : only;
    if (area) areas.set(recipe.productId, area);
  }
  return areas;
}

async function productionActive(
  tx: Tx,
  organizationId: string,
): Promise<boolean> {
  const states = await readModuleStates(tx, organizationId);
  return states.modules.has("production");
}

/** Requests still in force for a wait: asked, or accepted with an open order. */
export async function activeRequestWaits(
  tx: Tx | Client,
  waitIds: readonly string[],
): Promise<Set<string>> {
  if (waitIds.length === 0) return new Set();
  const rows = await tx.productionRequest.findMany({
    where: {
      lineWaitId: { in: [...waitIds] },
      OR: [
        { status: "SUBMITTED" },
        {
          status: "ACCEPTED",
          orders: { some: { status: { in: [...OPEN_PRODUCTION_STATUSES] } } },
        },
      ],
    },
    select: { lineWaitId: true },
  });
  return new Set(
    rows.flatMap((row) => (row.lineWaitId ? [row.lineWaitId] : [])),
  );
}

async function askLines(
  tx: Tx,
  actor: InventoryActor,
  input: { facilityId: string; lines: MakeToOrderLine[] },
): Promise<{ waitId: string; requestId: string; numberText: string }[]> {
  const { organizationId, userId } = actor;
  if (!(await productionActive(tx, organizationId))) return [];
  const active = await activeRequestWaits(
    tx,
    input.lines.map((line) => line.waitId),
  );
  const lines = input.lines.filter(
    (line) => !active.has(line.waitId) && line.quantity.greaterThan(0),
  );
  if (lines.length === 0) return [];
  const products = await tx.product.findMany({
    where: { id: { in: lines.map((line) => line.productId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(products.map((row) => [row.id, row.name]));
  const last = await tx.productionRequest.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  let number = last?.number ?? 0;
  const made: { waitId: string; requestId: string; numberText: string }[] = [];
  for (const line of lines) {
    number += 1;
    const id = newId();
    const numberText = formatProductionRequestNumber(number);
    await tx.productionRequest.create({
      data: {
        id,
        organizationId,
        number,
        facilityId: input.facilityId,
        areaLocationId: line.areaLocationId,
        productId: line.productId,
        quantity: line.quantity.toString(),
        unitCode: line.unitCode,
        requestedByUserId: userId,
        lineWaitId: line.waitId,
      },
    });
    const quantityText = formatStock(line.quantity.toString(), line.unitCode);
    const name = nameOf.get(line.productId) ?? "un producto";
    const order = await waitingOrderOf(tx, line.waitId);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.request_created",
      target: { type: "production_request", id },
      metadata: {
        solicitud: numberText,
        producto: name,
        cantidad: quantityText,
        ...(order ? { pedido: order.orderNumber } : {}),
      },
    });
    // The same people who decide a request asked by hand; the text names
    // neither the order nor its recipient (one text for everybody).
    const notice = {
      organizationId,
      actorUserId: userId,
      text: `Hay que producir ${quantityText} de ${name} para un pedido (${numberText}).`,
      href: `/produccion/solicitudes/${id}`,
      key: `production_request:${id}:to_decide`,
    };
    const sent = await notify(tx, REQUEST_TO_DECIDE_NOTICE, {
      ...notice,
      to: {
        permissions: ["production.request.decide"],
        roles: ["production_supervisor", "warehouse", "supervisor"],
        ownerByRole: false,
        locationId: line.areaLocationId,
      },
    });
    if (sent.sent === 0) {
      await notify(tx, REQUEST_TO_DECIDE_NOTICE, {
        ...notice,
        to: {
          permissions: ["production.request.decide"],
          roles: ["administrator"],
          locationId: line.areaLocationId,
        },
      });
    }
    made.push({ waitId: line.waitId, requestId: id, numberText });
  }
  return made;
}

async function closeWaitRequests(
  tx: Tx,
  actor: InventoryActor,
  waitIds: readonly string[],
  why: string,
): Promise<number> {
  const { organizationId, userId } = actor;
  if (waitIds.length === 0) return 0;
  // In read-only Producción nothing is written: accepting it is refused
  // because its wait is closed.
  if (!(await productionActive(tx, organizationId))) return 0;
  const asked = await tx.productionRequest.findMany({
    where: { lineWaitId: { in: [...waitIds] }, status: "SUBMITTED" },
    select: { id: true, number: true },
  });
  let cancelled = 0;
  for (const row of asked) {
    // Conditional: a decision that got there first keeps its result.
    const changed = await tx.productionRequest.updateMany({
      where: { id: row.id, status: "SUBMITTED" },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: userId,
      },
    });
    if (changed.count === 0) continue;
    cancelled += 1;
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.request_cancelled",
      target: { type: "production_request", id: row.id },
      reason: why.slice(0, 300),
      metadata: { solicitud: formatProductionRequestNumber(row.number) },
    });
  }
  return cancelled;
}

/** What the app hands to the services of the outbound order. */
export const makeToOrder: MakeToOrder = {
  areasFor: async (client, facilityId, productIds) => [
    ...new Set((await areasOf(client, facilityId, productIds)).values()),
  ],
  makeable: async (tx, input) => {
    if (!(await productionActive(tx, input.organizationId))) {
      return { areas: new Map(), changed: false };
    }
    const areas = await areasOf(tx, input.facilityId, input.productIds);
    const changed = [...areas.values()].some(
      (area) => !input.lockedAreaIds.has(area),
    );
    return { areas, changed };
  },
  ask: askLines,
  closed: closeWaitRequests,
};

/**
 * Tells who released an order (and who releases orders in its warehouse)
 * that it still waits for production, and why. Inside the transaction of
 * what happened; nothing when the wait is closed or got everything.
 */
export async function noticeOrderStillWaits(
  tx: Tx,
  actor: InventoryActor,
  waitId: string | null,
  cause: string,
): Promise<void> {
  const wait = await waitingOrderOf(tx, waitId);
  if (!wait || wait.status !== "OPEN" || !wait.left.greaterThan(dec(0))) {
    return;
  }
  // Who releases orders in its warehouse (who released it among them).
  await notify(tx, OUTBOUND_WAITING_NOTICE, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    to: {
      permissions: ["inventory.outbound.release"],
      facilityId: wait.facilityId,
    },
    text: `${cause} El pedido ${wait.orderNumber} sigue esperando ${wait.leftText} de ${wait.productName}: pide producción de nuevo o deja de esperar.`.slice(
      0,
      300,
    ),
    href: `/pedidos/${wait.orderId}`,
    key: `outbound_wait:${wait.waitId}:${newId()}`,
  });
}

/**
 * WMS-79: the wait of the outbound line a production report was made for
 * (report → order → request); null when it has none. Never changes.
 */
export async function lineWaitOfReport(
  client: Tx | Client,
  reportId: string,
): Promise<string | null> {
  const row = await client.productionReport.findFirst({
    where: { id: reportId },
    select: {
      order: { select: { request: { select: { lineWaitId: true } } } },
    },
  });
  return row?.order.request?.lineWaitId ?? null;
}

// ── What the screens show (each one within the reach of who looks) ─────

export type OutboundLink =
  /** Who reads outbound orders and reaches its warehouse. */
  | {
      visible: true;
      orderId: string;
      numberText: string;
      recipient: string;
      waiting: boolean;
    }
  /** Anybody else: «Para un pedido de un cliente». */
  | { visible: false; waiting: boolean };

/**
 * The outbound order a production request, order or report was made for
 * (WMS-79); null when it was not made for one. Names the order only to
 * who reads outbound orders and reaches its warehouse. The caller already
 * checked that the person reaches the production document.
 */
export async function outboundOrderFor(
  actor: InventoryActor,
  of: { requestId?: string; orderId?: string; reportId?: string },
): Promise<OutboundLink | null> {
  const client = forOrganization(actor.organizationId);
  const entitled = await getEntitlements(actor.organizationId);
  if (entitled.moduleState("production") === "none") return null;
  let waitId: string | null = null;
  if (of.requestId) {
    waitId =
      (
        await client.productionRequest.findFirst({
          where: { id: of.requestId },
          select: { lineWaitId: true },
        })
      )?.lineWaitId ?? null;
  } else if (of.orderId) {
    waitId =
      (
        await client.productionOrder.findFirst({
          where: { id: of.orderId },
          select: { request: { select: { lineWaitId: true } } },
        })
      )?.request?.lineWaitId ?? null;
  } else if (of.reportId) {
    waitId = await lineWaitOfReport(client, of.reportId);
  }
  const wait = await waitingOrderOf(client, waitId);
  if (!wait) return null;
  const waiting = wait.status === "OPEN";
  const sees =
    (await isAllowed(
      actor.organizationId,
      actor.userId,
      "inventory.outbound.read",
    )) && (await isFacilityInScope(client, actor.userId, wait.facilityId));
  return sees
    ? {
        visible: true,
        orderId: wait.orderId,
        numberText: wait.orderNumber,
        recipient: wait.recipient,
        waiting,
      }
    : { visible: false, waiting };
}

export type LineProduction = {
  /** «SP-0004», with its state; only within reach. */
  request: { id: string; numberText: string; statusLabel: string } | null;
  order: { id: string; numberText: string; statusLabel: string } | null;
  /** Something is still asked or being made for it. */
  active: boolean;
};

/**
 * What production does for each line of an outbound order that waits
 * (WMS-79), by line id: its latest request and the order born from it.
 * Requests and orders are named only to who reads them and reaches their
 * area. The caller already checked that the person reaches the order.
 */
export async function productionForOutboundOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<Map<string, LineProduction>> {
  const client = forOrganization(actor.organizationId);
  const out = new Map<string, LineProduction>();
  // Without Producción (not even to read), nothing to say.
  const entitled = await getEntitlements(actor.organizationId);
  if (entitled.moduleState("production") === "none") return out;
  const requests = await client.productionRequest.findMany({
    where: { lineWait: { orderId: String(orderId ?? "").slice(0, 36) } },
    orderBy: { number: "desc" },
    select: {
      id: true,
      number: true,
      status: true,
      areaLocationId: true,
      lineWaitId: true,
      lineWait: { select: { lineId: true } },
      orders: {
        select: { id: true, number: true, status: true },
        take: 1,
      },
    },
  });
  if (requests.length === 0) return out;
  const active = await activeRequestWaits(client, [
    ...new Set(
      requests.flatMap((row) => (row.lineWaitId ? [row.lineWaitId] : [])),
    ),
  ]);
  const [readsRequests, readsOrders] = await Promise.all([
    isAllowed(actor.organizationId, actor.userId, "production.request.read"),
    isAllowed(actor.organizationId, actor.userId, "production.order.read"),
  ]);
  const outside = new Set(
    await locationsOutOfScope(client, actor.userId, [
      ...new Set(requests.map((row) => row.areaLocationId)),
    ]),
  );
  for (const row of requests) {
    const lineId = row.lineWait?.lineId;
    if (!lineId || out.has(lineId)) continue;
    const reach = !outside.has(row.areaLocationId);
    const order = row.orders[0] ?? null;
    out.set(lineId, {
      request:
        readsRequests && reach
          ? {
              id: row.id,
              numberText: formatProductionRequestNumber(row.number),
              statusLabel: PRODUCTION_REQUEST_STATUS_LABELS[row.status],
            }
          : null,
      order:
        order && readsOrders && reach
          ? {
              id: order.id,
              numberText: formatProductionNumber(order.number),
              statusLabel: PRODUCTION_ORDER_STATUS_LABELS[order.status],
            }
          : null,
      active: row.lineWaitId ? active.has(row.lineWaitId) : false,
    });
  }
  return out;
}
