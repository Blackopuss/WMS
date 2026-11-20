import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { isFacilityInScope } from "@/platform/locations";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { notify } from "@/platform/notifications";

import { formatStock, type InventoryActor } from "./movements";
import { OUTBOUND_WAIT_DROPPED_NOTICE } from "./notices";
import { formatOutboundNumber } from "./outbound-states";
import { createPickTasks, nextTaskNumber, settlePickedOrder } from "./picking";
import { OUTBOUND_LINE_SOURCE } from "./reservation-sources";
import { freeToTake } from "./reservations";
import { formatTaskNumber } from "./task-states";
import {
  OUTBOUND_WAIT_STATUS_LABELS,
  type OutboundWaitStatus,
} from "./wait-states";

/**
 * What an outbound line waits from production (WMS-79, ADR 0094).
 *
 * With `inventory.outbound.make_to_order = on`, releasing an order opens a
 * wait for each line that falls short and whose product production can
 * make, and production gets a request linked to it. While a wait is open
 * the order does not become «Surtido» (`settlePickedOrder`), so it is not
 * packed nor shipped incomplete by accident. What production makes for it
 * is set aside for the line at the verification (`sendProducedToWait`).
 *
 * Every write of a wait happens under the lock of its order: release, ask
 * again, stop waiting, cancel, cross-docking and the verification. That
 * lock keeps one open wait per line and one active request per wait.
 *
 * Inventario does not import Producción: what it needs from production is
 * handed to it by the app as a `MakeToOrder` (implemented in
 * `src/modules/production/make-to-order.ts`, exposed by the registry).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

/** A line production is asked to make for. */
export type MakeToOrderLine = {
  waitId: string;
  lineId: string;
  productId: string;
  /** In the product's unit. */
  quantity: Decimal;
  unitCode: string;
  areaLocationId: string;
};

/** What production does for the waits of an order; see the ADR. */
export type MakeToOrder = {
  /**
   * Before any lock: the production areas these products would use in
   * this warehouse, to lock them (shared) before the order.
   */
  areasFor(
    client: Client,
    facilityId: string,
    productIds: readonly string[],
  ): Promise<string[]>;
  /**
   * Under the locks: the products production can make here and their area
   * (nothing when Producción is not in use). `changed` when an area is not
   * one of the locked ones (the recipe changed since `areasFor`).
   */
  makeable(
    tx: Tx,
    input: {
      organizationId: string;
      facilityId: string;
      productIds: readonly string[];
      lockedAreaIds: ReadonlySet<string>;
    },
  ): Promise<{ areas: Map<string, string>; changed: boolean }>;
  /**
   * Under the lock of the order: asks production for each line (skips the
   * waits with an active request). Answers the requests made.
   */
  ask(
    tx: Tx,
    actor: InventoryActor,
    input: { facilityId: string; lines: MakeToOrderLine[] },
  ): Promise<{ waitId: string; requestId: string; numberText: string }[]>;
  /**
   * Under the lock of the order: these waits closed; what was still asked
   * of them is cancelled. Answers how many requests were cancelled.
   */
  closed(
    tx: Tx,
    actor: InventoryActor,
    waitIds: readonly string[],
    why: string,
  ): Promise<number>;
};

// ── Inside the transaction of the caller (order locked) ─────────────────

/** Opens a wait for each line; the caller locked the order. */
export async function openProductionWaits(
  tx: Tx,
  actor: InventoryActor,
  input: {
    orderId: string;
    lines: {
      lineId: string;
      productId: string;
      quantity: Decimal;
      unitCode: string;
    }[];
  },
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const line of input.lines) {
    const id = newId();
    await tx.outboundLineWait.create({
      data: {
        id,
        organizationId: actor.organizationId,
        orderId: input.orderId,
        lineId: line.lineId,
        productId: line.productId,
        quantity: line.quantity.toString(),
        unitCode: line.unitCode,
        openLineId: line.lineId,
        openedByUserId: actor.userId,
      },
    });
    ids.set(line.lineId, id);
  }
  return ids;
}

/**
 * What was set aside for these lines after their order was released
 * (cross-docking, production): adds it to their open waits, which close
 * once complete. The caller locked the orders.
 */
export async function creditLineWaits(
  tx: Tx,
  amounts: ReadonlyMap<string, Decimal>,
): Promise<string[]> {
  const lineIds = [...amounts.keys()].filter((id) =>
    amounts.get(id)!.greaterThan(0),
  );
  if (lineIds.length === 0) return [];
  const waits = await tx.outboundLineWait.findMany({
    where: { openLineId: { in: lineIds } },
    select: { id: true, lineId: true, quantity: true, received: true },
  });
  const done: string[] = [];
  for (const wait of waits) {
    const received = dec(wait.received.toString()).plus(
      amounts.get(wait.lineId)!,
    );
    const complete = received.greaterThanOrEqualTo(wait.quantity.toString());
    await tx.outboundLineWait.update({
      where: { id: wait.id },
      data: complete
        ? {
            received: received.toString(),
            status: "DONE",
            openLineId: null,
            closedAt: new Date(),
          }
        : { received: received.toString() },
    });
    if (complete) done.push(wait.id);
  }
  return done;
}

/**
 * Closes the open waits of an order (the order was cancelled, or someone
 * stopped waiting). The caller locked the order. Answers their ids.
 */
export async function closeOrderWaits(
  tx: Tx,
  actor: InventoryActor,
  orderId: string,
  status: Extract<OutboundWaitStatus, "DROPPED" | "CANCELLED">,
  why: string,
): Promise<string[]> {
  const open = await tx.outboundLineWait.findMany({
    where: { orderId, status: "OPEN" },
    select: { id: true },
  });
  if (open.length === 0) return [];
  await tx.outboundLineWait.updateMany({
    where: { id: { in: open.map((wait) => wait.id) }, status: "OPEN" },
    data: {
      status,
      openLineId: null,
      closedAt: new Date(),
      closedByUserId: actor.userId,
      closeReason: why.slice(0, 300),
    },
  });
  return open.map((wait) => wait.id);
}

export type ProducedArrival = {
  productId: string;
  locationId: string;
  lotId: string | null;
  /** In the product's unit, available where it is. */
  quantity: Decimal;
  /** The movement that made it available (the verification's). */
  movementId?: string | null;
};

/**
 * What production made for a line, once it is available (the
 * verification): set aside for the line where it is, with its picking
 * task to the staging location, up to what the wait and the line still
 * lack. Answers what went to the order of each arrival (by position); the
 * rest follows to put-away. The caller locked product → locations → the
 * order of the wait (`lockOrderOfWait`).
 */
export async function sendProducedToWait(
  tx: Tx,
  actor: InventoryActor,
  input: { waitId: string; arrivals: readonly ProducedArrival[] },
): Promise<{ sent: Decimal[]; notes: string[] }> {
  const sent = input.arrivals.map(() => dec(0));
  const wait = await tx.outboundLineWait.findFirst({
    where: { id: input.waitId },
    select: {
      id: true,
      status: true,
      quantity: true,
      received: true,
      productId: true,
      unitCode: true,
      line: { select: { id: true, productId: true, quantity: true } },
      order: {
        select: {
          id: true,
          number: true,
          recipient: true,
          priority: true,
          status: true,
          facilityId: true,
        },
      },
    },
  });
  if (
    !wait ||
    wait.status !== "OPEN" ||
    (wait.order.status !== "RELEASED" && wait.order.status !== "PICKING")
  ) {
    return { sent, notes: [] };
  }
  const staging = await tx.location.findFirst({
    where: { facilityId: wait.order.facilityId, isStaging: true },
    select: { id: true },
  });
  if (!staging) return { sent, notes: [] };
  const held = await tx.stockReservation.aggregate({
    where: {
      sourceType: OUTBOUND_LINE_SOURCE,
      sourceId: wait.line.id,
      state: "ACTIVE",
    },
    _sum: { remaining: true },
  });
  const lineLeft = dec(wait.line.quantity.toString()).minus(
    (held._sum.remaining ?? 0).toString(),
  );
  const waitLeft = dec(wait.quantity.toString()).minus(
    wait.received.toString(),
  );
  let budget = lineLeft.lessThan(waitLeft) ? lineLeft : waitLeft;
  if (!budget.greaterThan(0)) return { sent, notes: [] };

  const usedAt = new Map<string, Decimal>();
  let next = await nextTaskNumber(tx);
  const first = next;
  let total = dec(0);
  for (const [index, arrival] of input.arrivals.entries()) {
    if (!budget.greaterThan(0)) break;
    if (
      arrival.productId !== wait.productId ||
      !arrival.quantity.greaterThan(0)
    ) {
      continue;
    }
    const slot = `${arrival.locationId} ${arrival.lotId ?? ""}`;
    const used = usedAt.get(slot) ?? dec(0);
    const free = (
      await freeToTake(tx, arrival.productId, arrival.locationId, arrival.lotId)
    ).minus(used);
    let take = arrival.quantity;
    if (free.lessThan(take)) take = free;
    if (budget.lessThan(take)) take = budget;
    if (!take.greaterThan(0)) continue;
    next = await createPickTasks(tx, actor, {
      order: {
        number: formatOutboundNumber(wait.order.number),
        recipient: wait.order.recipient,
        priority: wait.order.priority,
      },
      line: {
        id: wait.line.id,
        productId: wait.line.productId,
        unitCode: wait.unitCode,
      },
      sources: [
        {
          locationId: arrival.locationId,
          lotId: arrival.lotId,
          quantity: take,
        },
      ],
      stagingId: staging.id,
      nextNumber: next,
      // What made it available: it tells «llegaron con IN-0001» and keeps
      // it out of «aprobadas en el área sin tarea» (WMS-31).
      crossDockMovementId: arrival.movementId ?? null,
    });
    usedAt.set(slot, used.plus(take));
    sent[index] = take;
    budget = budget.minus(take);
    total = total.plus(take);
  }
  if (!total.greaterThan(0)) return { sent, notes: [] };
  await creditLineWaits(tx, new Map([[wait.line.id, total]]));
  const tasks: string[] = [];
  for (let number = first; number < next; number++) {
    tasks.push(formatTaskNumber(number));
  }
  return {
    sent,
    notes: [
      `${formatStock(total.toString(), wait.unitCode)} ${total.equals(1) ? "va" : "van"} directo al pedido ${formatOutboundNumber(wait.order.number)} (${tasks.length === 1 ? `tarea ${tasks[0]}` : `tareas ${tasks.join(", ")}`}).`,
    ],
  };
}

// ── Reading ─────────────────────────────────────────────────────────────

export type OutboundWaitView = {
  id: string;
  lineId: string;
  status: OutboundWaitStatus;
  statusLabel: string;
  /** «20 piezas». */
  quantityText: string;
  receivedText: string;
  /** What it still waits for, while open. */
  leftText: string | null;
  closeReason: string | null;
};

/**
 * The waits of an order, the most recent of each line first. The caller
 * already checked that the person reaches the order.
 */
export async function waitsOfOrder(
  client: Client | Tx,
  orderId: string,
): Promise<OutboundWaitView[]> {
  const rows = await client.outboundLineWait.findMany({
    where: { orderId },
    orderBy: { id: "desc" },
    select: {
      id: true,
      lineId: true,
      status: true,
      quantity: true,
      received: true,
      unitCode: true,
      closeReason: true,
    },
  });
  return rows.map((row) => {
    const left = dec(row.quantity.toString()).minus(row.received.toString());
    return {
      id: row.id,
      lineId: row.lineId,
      status: row.status,
      statusLabel: OUTBOUND_WAIT_STATUS_LABELS[row.status],
      quantityText: formatStock(row.quantity.toString(), row.unitCode),
      receivedText: formatStock(row.received.toString(), row.unitCode),
      leftText:
        row.status === "OPEN"
          ? formatStock(left.toString(), row.unitCode)
          : null,
      closeReason: row.closeReason,
    };
  });
}

export type WaitingOrder = {
  waitId: string;
  status: OutboundWaitStatus;
  orderId: string;
  /** «PS-0001». */
  orderNumber: string;
  recipient: string;
  facilityId: string;
  openedByUserId: string;
  productName: string;
  /** What it still waits for, while open; «0 piezas» once closed. */
  leftText: string;
  left: Decimal;
};

/** The order a wait belongs to, for production's notices and screens. */
export async function waitingOrderOf(
  client: Client | Tx,
  waitId: string | null,
): Promise<WaitingOrder | null> {
  if (!waitId) return null;
  const row = await client.outboundLineWait.findFirst({
    where: { id: waitId },
    select: {
      id: true,
      status: true,
      quantity: true,
      received: true,
      unitCode: true,
      openedByUserId: true,
      product: { select: { name: true } },
      order: {
        select: { id: true, number: true, recipient: true, facilityId: true },
      },
    },
  });
  if (!row) return null;
  const left =
    row.status === "OPEN"
      ? dec(row.quantity.toString()).minus(row.received.toString())
      : dec(0);
  return {
    waitId: row.id,
    status: row.status,
    orderId: row.order.id,
    orderNumber: formatOutboundNumber(row.order.number),
    recipient: row.order.recipient,
    facilityId: row.order.facilityId,
    openedByUserId: row.openedByUserId,
    productName: row.product.name,
    leftText: formatStock(left.toString(), row.unitCode),
    left,
  };
}

// ── Services of the order screen ────────────────────────────────────────

export type WaitResult =
  | { ok: true; orderId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors?: { reason?: string };
      formError?: string;
    };

class WaitRejected extends Error {
  constructor(readonly result: Extract<WaitResult, { ok: false }>) {
    super("outbound wait rejected");
  }
}

const NOT_FOUND = "Este pedido no existe.";

async function inWait(
  organizationId: string,
  work: (tx: Tx) => Promise<WaitResult>,
): Promise<WaitResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await forOrganization(organizationId).$transaction(
        work,
        LOCKING_TRANSACTION,
      );
    } catch (error) {
      if (error instanceof WaitRejected) return error.result;
      // A request made at once took the same number: again.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

async function lockedOrder(tx: Tx, orderId: string, userId: string) {
  const [id] = await lockRows(tx, "outboundOrder", [
    String(orderId ?? "").slice(0, 36),
  ]);
  const order = id
    ? await tx.outboundOrder.findFirst({
        where: { id },
        select: { id: true, number: true, status: true, facilityId: true },
      })
    : null;
  if (!order || !(await isFacilityInScope(tx, userId, order.facilityId))) {
    throw new WaitRejected({
      ok: false,
      reason: "not_found",
      formError: NOT_FOUND,
    });
  }
  return order;
}

/**
 * «Dejar de esperar»: the order stops waiting for production. Its open
 * waits close, what was still asked is cancelled (the orders already made
 * go on without the link) and, when nothing is left to pick, the order is
 * picked with what it has.
 */
export async function stopWaitingForProduction(
  actor: InventoryActor,
  orderId: string,
  reason: string,
  options: { makeToOrder?: MakeToOrder } = {},
): Promise<WaitResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.release",
  );
  const why = String(reason ?? "").trim();
  if (why.length < 3 || why.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          why.length < 3
            ? "Escribe por qué ya no se espera."
            : "Usa como máximo 300 caracteres.",
      },
    };
  }
  return inWait(organizationId, async (tx) => {
    const order = await lockedOrder(tx, orderId, userId);
    const numberText = formatOutboundNumber(order.number);
    const closed = await closeOrderWaits(tx, actor, order.id, "DROPPED", why);
    if (closed.length === 0) {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: `El pedido ${numberText} ya no espera producción.`,
      };
    }
    const cancelled = options.makeToOrder
      ? await options.makeToOrder.closed(tx, actor, closed, why)
      : 0;
    // Nothing left to pick: it is picked with what it has.
    await settlePickedOrder(tx, order.id);
    // Who released it hears about it (unless it was them).
    const openers = await tx.outboundLineWait.findMany({
      where: { id: { in: closed } },
      select: { openedByUserId: true },
      distinct: ["openedByUserId"],
    });
    await notify(tx, OUTBOUND_WAIT_DROPPED_NOTICE, {
      organizationId,
      actorUserId: userId,
      to: {
        userIds: openers.map((row) => row.openedByUserId),
        permissions: ["inventory.outbound.read"],
        facilityId: order.facilityId,
      },
      text: `El pedido ${numberText} ya no espera producción: ${why}`.slice(
        0,
        300,
      ),
      href: `/pedidos/${order.id}`,
      key: `outbound_wait_dropped:${order.id}:${closed[0]}`,
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "inventory.outbound_wait_dropped",
      target: { type: "outbound_order", id: order.id },
      reason: why,
      metadata: {
        pedido: numberText,
        esperas: closed.length,
        solicitudesCanceladas: cancelled,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `El pedido ${numberText} ya no espera producción${cancelled > 0 ? " y se cancelaron las solicitudes que seguían por atender" : ""}.`,
    };
  });
}

/**
 * «Pedir producción de nuevo»: a new linked request for each open wait of
 * the order without an active one (rejected, or its order cancelled or
 * closed short), for what it still waits.
 */
export async function askProductionAgain(
  actor: InventoryActor,
  orderId: string,
  options: { makeToOrder?: MakeToOrder } = {},
): Promise<WaitResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.release",
  );
  const makeToOrder = options.makeToOrder;
  if (!makeToOrder) {
    return {
      ok: false,
      reason: "not_allowed",
      formError: "Producción no está disponible.",
    };
  }
  const id = String(orderId ?? "").slice(0, 36);
  const client = forOrganization(organizationId);
  // What waits and where, read first to lock in order: products → areas
  // (shared) → order. Checked again under the lock.
  const first = await client.outboundOrder.findFirst({
    where: { id },
    select: {
      facilityId: true,
      productionWaits: {
        where: { status: "OPEN" },
        select: { productId: true },
      },
    },
  });
  if (!first) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  const productIds = [
    ...new Set(first.productionWaits.map((wait) => wait.productId)),
  ];
  const areas = await makeToOrder.areasFor(
    client,
    first.facilityId,
    productIds,
  );
  return inWait(organizationId, async (tx) => {
    await lockRows(tx, "product", productIds);
    const locked = new Set(
      areas.length > 0
        ? await lockRows(tx, "location", areas, { mode: "share" })
        : [],
    );
    const order = await lockedOrder(tx, id, userId);
    const numberText = formatOutboundNumber(order.number);
    if (order.facilityId !== first.facilityId) {
      throw new WaitRejected({
        ok: false,
        reason: "not_allowed",
        formError: "El pedido cambió. Inténtalo de nuevo.",
      });
    }
    const waits = await tx.outboundLineWait.findMany({
      where: { orderId: order.id, status: "OPEN" },
      select: {
        id: true,
        lineId: true,
        productId: true,
        quantity: true,
        received: true,
        unitCode: true,
      },
    });
    if (waits.length === 0) {
      return {
        ok: false,
        reason: "not_allowed",
        formError: `El pedido ${numberText} no espera producción.`,
      };
    }
    if (waits.some((wait) => !productIds.includes(wait.productId))) {
      throw new WaitRejected({
        ok: false,
        reason: "not_allowed",
        formError: "El pedido cambió. Inténtalo de nuevo.",
      });
    }
    const made = await makeToOrder.makeable(tx, {
      organizationId,
      facilityId: order.facilityId,
      productIds,
      lockedAreaIds: locked,
    });
    if (made.changed) {
      throw new WaitRejected({
        ok: false,
        reason: "not_allowed",
        formError: "La receta cambió mientras se pedía. Inténtalo de nuevo.",
      });
    }
    const lines = waits.flatMap((wait) => {
      const area = made.areas.get(wait.productId);
      const left = dec(wait.quantity.toString()).minus(
        wait.received.toString(),
      );
      return area && left.greaterThan(0)
        ? [
            {
              waitId: wait.id,
              lineId: wait.lineId,
              productId: wait.productId,
              quantity: left,
              unitCode: wait.unitCode,
              areaLocationId: area,
            },
          ]
        : [];
    });
    if (lines.length === 0) {
      return {
        ok: false,
        reason: "not_allowed",
        formError:
          "Producción no puede hacer lo que falta ahora (sin receta vigente o sin área). Puedes dejar de esperar.",
      };
    }
    const asked = await makeToOrder.ask(tx, actor, {
      facilityId: order.facilityId,
      lines,
    });
    if (asked.length === 0) {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: `Lo que falta del pedido ${numberText} ya está pedido a producción.`,
      };
    }
    return {
      ok: true,
      orderId: order.id,
      summary: `Se pidió producir de nuevo lo que falta del pedido ${numberText} (${asked.map((row) => row.numberText).join(", ")}).`,
    };
  });
}
