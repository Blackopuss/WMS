import "server-only";

import { z } from "zod";

import { dec, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  ensureStagingLocation,
  isFacilityInScope,
  locationPath,
  type LocationWithParents,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { lotDayOf, lotLabel } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import {
  lockedOutboundOrder,
  releaseUnderLock,
  type LockedOutboundOrder,
} from "./outbound-orders";
import type { MakeToOrder } from "./outbound-waits";
import {
  OUTBOUND_ORDER_STATUS_LABELS,
  formatOutboundNumber,
  type OutboundOrderStatus,
} from "./outbound-states";
import { inRouteOrder } from "./pick-route";
import { PICKING_MODE } from "./settings";
import { zonesOf } from "./zones";
import {
  OPEN_TASK_STATUSES,
  WAREHOUSE_TASK_STATUS_LABELS,
  formatTaskNumber,
  type WarehouseTaskStatus,
} from "./task-states";
import {
  assignTasks,
  confirmPickGroup,
  deliverPickGroup,
  taskScope,
  takeTasks,
  type TaskGroupResult,
} from "./tasks";
import {
  PICK_WAVE_STATUS_LABELS,
  formatWaveNumber,
  isPickWaveStatus,
  waveTransitionProblem,
  type PickWaveStatus,
} from "./wave-states";

/**
 * Picking waves (WMS-25, ADR 0054). A supervisor groups outbound orders of
 * the warehouse in a wave; the floor picks them together, in walking
 * order, and what several orders take of the same product, place and lot
 * is confirmed with one scan. A wave only groups, orders and shares out
 * the PICK tasks of its orders: every task stays of one line of one order
 * (its reservation, lot and serials), so what is picked in a wave adds up
 * by order, and cancelling an order releases only what is its.
 *
 * Locks: products → locations → orders → tasks → capacity → wave. A wave
 * is locked only to end it or cancel it.
 */

export const WAVE_MAX_ORDERS = 30;
/** Orders offered to start a wave, at most (narrow them by day). */
export const WAVE_CANDIDATES_MAX = 60;
export const WAVE_PAGE_SIZE = 25;
/** Groups of the wave shown a page at a time. */
export const WAVE_PICKS_PAGE_SIZE = 20;

type Tx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];

export type WaveField = "orderIds" | "reason";

export type WaveResult =
  | { ok: true; waveId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors?: Partial<Record<WaveField, string>>;
      formError?: string;
    };

type Failure = Extract<WaveResult, { ok: false }>;

class WaveRejected extends Error {
  constructor(readonly result: Failure) {
    super("wave rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: WaveField,
): never => {
  throw new WaveRejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const WAVES_OFF =
  "El surtido por olas está apagado. Se enciende en Configuración › Operación.";

/** Whether the company organizes picking in waves (`PICKING_MODE`). */
export async function wavesEnabled(actor: InventoryActor): Promise<boolean> {
  return (
    (await readSetting(forOrganization(actor.organizationId), PICKING_MODE)) ===
    "waves"
  );
}

const ymd = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/** Urgent first, then the day it leaves (none last), then its number. */
const byUrgency = <
  T extends {
    priority: "NORMAL" | "URGENT";
    dueOn: Date | null;
    number: number;
  },
>(
  a: T,
  b: T,
) =>
  (a.priority === b.priority ? 0 : a.priority === "URGENT" ? -1 : 1) ||
  (a.dueOn?.getTime() ?? Infinity) - (b.dueOn?.getTime() ?? Infinity) ||
  a.number - b.number;

// ── Creating ─────────────────────────────────────────────────────────────

export type WaveCandidate = {
  id: string;
  numberText: string;
  recipient: string;
  reference: string | null;
  status: OutboundOrderStatus;
  statusLabel: string;
  urgent: boolean;
  dueOn: string | null;
  lines: number;
};

/**
 * Orders of the warehouse the person works in that may go in a new wave:
 * in draft or released, in no open wave. Urgent first, then by the day
 * they leave and their number; `dueOn` narrows to a day, `urgent` to the
 * urgent ones. At most `WAVE_CANDIDATES_MAX` (`more` says there are more).
 */
export async function listWaveCandidates(
  actor: InventoryActor,
  options: { dueOn?: unknown; urgent?: unknown } = {},
): Promise<{ items: WaveCandidate[]; more: boolean; dueOn: string | null }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.release",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const dueOn =
    typeof options.dueOn === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(options.dueOn) &&
    !Number.isNaN(Date.parse(`${options.dueOn}T00:00:00.000Z`))
      ? options.dueOn
      : null;
  const rows = await client.outboundOrder.findMany({
    where: {
      facilityId: facility.id,
      status: { in: ["DRAFT", "RELEASED"] },
      waves: { none: { openOrderId: { not: null } } },
      lines: { some: {} },
      ...(dueOn ? { dueOn: new Date(`${dueOn}T00:00:00.000Z`) } : {}),
      ...(options.urgent === true ? { priority: "URGENT" as const } : {}),
    },
    orderBy: [{ priority: "desc" }, { dueOn: "asc" }, { number: "asc" }],
    take: WAVE_CANDIDATES_MAX + 1,
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
  // The database puts orders without a day first: they go last.
  const sorted = [...rows].sort(byUrgency);
  return {
    items: sorted.slice(0, WAVE_CANDIDATES_MAX).map((row) => ({
      id: row.id,
      numberText: formatOutboundNumber(row.number),
      recipient: row.recipient,
      reference: row.reference,
      status: row.status,
      statusLabel: OUTBOUND_ORDER_STATUS_LABELS[row.status],
      urgent: row.priority === "URGENT",
      dueOn: ymd(row.dueOn),
      lines: row._count.lines,
    })),
    more: rows.length > WAVE_CANDIDATES_MAX,
    dueOn,
  };
}

/**
 * Starts a wave with orders of the warehouse the person works in, in
 * draft or released and in no open wave. Drafts are released inside it
 * with the release of `releaseOutboundOrder` (urgent first, so they set
 * aside first); if one does not reach, nothing is created. Every order
 * must have something to pick.
 */
export async function createWave(
  actor: InventoryActor,
  input: { orderIds: readonly unknown[] },
  /**
   * WMS-79 (ADR 0094): releasing a draft in a wave asks production for
   * what falls short, like releasing it from its screen.
   */
  options: { makeToOrder?: MakeToOrder } = {},
): Promise<WaveResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.release",
  );
  if (!(await wavesEnabled(actor))) {
    return { ok: false, reason: "not_allowed", formError: WAVES_OFF };
  }
  const ids = [
    ...new Set(
      (Array.isArray(input.orderIds) ? input.orderIds : [])
        .map((id) => String(id ?? "").slice(0, 36))
        .filter((id) => id !== ""),
    ),
  ];
  if (ids.length === 0) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { orderIds: "Elige los pedidos de la ola." },
    };
  }
  if (ids.length > WAVE_MAX_ORDERS) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        orderIds: `Una ola admite hasta ${WAVE_MAX_ORDERS} pedidos.`,
      },
    };
  }
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  // The lines of a draft can change until it is locked: read them to lock
  // their products first; the release checks them again under the lock.
  const lines = await client.outboundOrderLine.findMany({
    where: { orderId: { in: ids } },
    select: { productId: true },
  });
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const areaIds = options.makeToOrder
    ? await options.makeToOrder.areasFor(client, facility.id, productIds)
    : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(
        (tx) =>
          createLocked(tx, actor, ids, productIds, facility.id, {
            makeToOrder: options.makeToOrder,
            areaIds,
          }),
        LOCKING_TRANSACTION,
      );
    } catch (error) {
      if (error instanceof WaveRejected) return error.result;
      // Two waves (or tasks) created at once take the same number: again.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

async function createLocked(
  tx: Tx,
  actor: InventoryActor,
  ids: string[],
  productIds: string[],
  facilityId: string,
  production: { makeToOrder?: MakeToOrder; areaIds: string[] },
): Promise<WaveResult> {
  const { organizationId, userId } = actor;
  await lockRows(tx, "product", productIds);
  if (!(await isFacilityInScope(tx, userId, facilityId))) {
    return stop("not_found", "Este almacén no está a tu alcance.");
  }
  // Where picked goods of the warehouse wait (WMS-14); created the first time.
  const staging = await ensureStagingLocation(tx, organizationId, facilityId);
  // WMS-79: the production areas, shared, before the orders (ADR 0094).
  const lockedAreaIds = new Set(
    production.areaIds.length > 0
      ? await lockRows(tx, "location", production.areaIds, { mode: "share" })
      : [],
  );
  await lockRows(tx, "outboundOrder", ids);
  const orders: LockedOutboundOrder[] = [];
  for (const id of ids) {
    const order = await lockedOutboundOrder(tx, id, userId);
    if (!order || order.facilityId !== facilityId) {
      return stop(
        "not_found",
        "Uno de los pedidos ya no está en este almacén. Vuelve a elegir.",
        "orderIds",
      );
    }
    const number = formatOutboundNumber(order.number);
    if (order.status !== "DRAFT" && order.status !== "RELEASED") {
      return stop(
        "not_allowed",
        `${number} ya no está por surtir (${OUTBOUND_ORDER_STATUS_LABELS[order.status].toLowerCase()}).`,
        "orderIds",
      );
    }
    const inWave = await tx.pickWaveOrder.findFirst({
      where: { openOrderId: order.id },
      select: { wave: { select: { number: true } } },
    });
    if (inWave) {
      return stop(
        "not_allowed",
        `${number} ya está en la ola ${formatWaveNumber(inWave.wave.number)}.`,
        "orderIds",
      );
    }
    orders.push(order);
  }
  const extra = await tx.outboundOrder.findMany({
    where: { id: { in: ids } },
    select: { id: true, dueOn: true },
  });
  const dueOf = new Map(extra.map((row) => [row.id, row.dueOn]));
  const ranked = [...orders].sort((a, b) =>
    byUrgency(
      { ...a, dueOn: dueOf.get(a.id) ?? null },
      { ...b, dueOn: dueOf.get(b.id) ?? null },
    ),
  );
  const locked = new Set(productIds);
  let released = 0;
  for (const order of ranked) {
    if (order.status !== "DRAFT") continue;
    const done = await releaseUnderLock(tx, actor, order, staging.id, locked, {
      makeToOrder: production.makeToOrder,
      lockedAreaIds,
    });
    if (!done.ok) {
      const number = formatOutboundNumber(order.number);
      const short = (done.shortages ?? [])
        .map((row) => `${row.productName} pide ${row.asked} y hay ${row.free}`)
        .join("; ");
      return stop(
        "not_allowed",
        short
          ? `${number}: ${short}. Libéralo con lo que hay desde su pantalla o déjalo fuera de la ola.`
          : `${number}: ${done.formError ?? Object.values(done.fieldErrors ?? {})[0] ?? "no se pudo liberar."}`,
        "orderIds",
      );
    }
    released++;
  }
  const openByOrder = await tx.warehouseTask.groupBy({
    by: ["outboundLineId"],
    where: {
      kind: "PICK",
      status: { in: [...OPEN_TASK_STATUSES] },
      outboundLine: { orderId: { in: ids } },
    },
    _count: { _all: true },
  });
  const lineOrders = await tx.outboundOrderLine.findMany({
    where: { orderId: { in: ids } },
    select: { id: true, orderId: true },
  });
  const orderOfLine = new Map(lineOrders.map((row) => [row.id, row.orderId]));
  const tasksOf = new Map<string, number>();
  for (const row of openByOrder) {
    const orderId = row.outboundLineId
      ? orderOfLine.get(row.outboundLineId)
      : undefined;
    if (orderId) {
      tasksOf.set(orderId, (tasksOf.get(orderId) ?? 0) + row._count._all);
    }
  }
  const idle = ranked.find((order) => !tasksOf.get(order.id));
  if (idle) {
    return stop(
      "not_allowed",
      (await tx.outboundLineWait.count({
        where: { orderId: idle.id, status: "OPEN" },
      })) > 0
        ? `${formatOutboundNumber(idle.number)} no tiene nada por surtir todavía (espera producción): libéralo desde su pantalla y déjalo fuera de la ola.`
        : `${formatOutboundNumber(idle.number)} no tiene nada por surtir: déjalo fuera de la ola.`,
      "orderIds",
    );
  }
  const last = await tx.pickWave.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const number = (last?.number ?? 0) + 1;
  const waveId = newId();
  await tx.pickWave.create({
    data: {
      id: waveId,
      organizationId,
      number,
      facilityId,
      createdByUserId: userId,
    },
  });
  await tx.pickWaveOrder.createMany({
    data: ranked.map((order) => ({
      id: newId(),
      organizationId,
      waveId,
      orderId: order.id,
      openOrderId: order.id,
    })),
  });
  const tasks = [...tasksOf.values()].reduce((sum, count) => sum + count, 0);
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "inventory.wave_created",
    target: { type: "pick_wave", id: waveId },
    metadata: {
      ola: formatWaveNumber(number),
      pedidos: ranked.map((order) => formatOutboundNumber(order.number)),
      liberados: released,
    },
  });
  return {
    ok: true,
    waveId,
    summary: `Se creó la ola ${formatWaveNumber(number)} con ${ranked.length === 1 ? "1 pedido" : `${ranked.length} pedidos`} y ${tasks === 1 ? "1 tarea" : `${tasks} tareas`} de surtido.`,
  };
}

const reasonSchema = z
  .string()
  .trim()
  .min(3, "Escribe por qué se cancela.")
  .max(300, "Usa como máximo 300 caracteres.");

/**
 * Cancels a wave: it only ungroups. Its orders and tasks go on, order by
 * order, and may go in another wave; cancelling an order is decided on
 * the order.
 */
export async function cancelWave(
  actor: InventoryActor,
  waveId: string,
  reason: string,
): Promise<WaveResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.release",
  );
  const why = reasonSchema.safeParse(reason ?? "");
  if (!why.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: why.error.issues[0]!.message },
    };
  }
  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      const [id] = await lockRows(tx, "pickWave", [String(waveId ?? "")]);
      const wave = id
        ? await tx.pickWave.findFirst({
            where: { id },
            select: { id: true, number: true, status: true, facilityId: true },
          })
        : null;
      if (!wave || !(await isFacilityInScope(tx, userId, wave.facilityId))) {
        return stop("not_found", "Esta ola no existe.");
      }
      if (wave.status === "CANCELLED") {
        return {
          ok: true,
          waveId: wave.id,
          repeated: true,
          summary: "La ola ya estaba cancelada.",
        };
      }
      const problem = waveTransitionProblem(wave.status, "CANCELLED");
      if (problem) return stop("not_allowed", problem);
      await tx.pickWaveOrder.updateMany({
        where: { waveId: wave.id, openOrderId: { not: null } },
        data: { openOrderId: null },
      });
      await tx.pickWave.update({
        where: { id: wave.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledByUserId: userId,
          cancelReason: why.data,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.wave_cancelled",
        target: { type: "pick_wave", id: wave.id },
        reason: why.data,
        metadata: { ola: formatWaveNumber(wave.number) },
      });
      return {
        ok: true,
        waveId: wave.id,
        summary: `Se canceló la ola ${formatWaveNumber(wave.number)}. Sus pedidos siguen; se surten por separado.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof WaveRejected) return error.result;
    throw error;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

export type WaveSummary = {
  id: string;
  numberText: string;
  status: PickWaveStatus;
  statusLabel: string;
  orders: number;
  createdAt: Date;
};

export type WavePage = {
  items: WaveSummary[];
  total: number;
  page: number;
  pageCount: number;
  status: PickWaveStatus | null;
};

/** Waves of the warehouse the person works in, newest first. */
export async function listWaves(
  actor: InventoryActor,
  options: { status?: unknown; page?: number } = {},
): Promise<WavePage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const status = isPickWaveStatus(options.status) ? options.status : null;
  const where = { facilityId: facility.id, ...(status ? { status } : {}) };
  const total = await client.pickWave.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / WAVE_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.pickWave.findMany({
    where,
    orderBy: { number: "desc" },
    skip: (page - 1) * WAVE_PAGE_SIZE,
    take: WAVE_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      _count: { select: { orders: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatWaveNumber(row.number),
      status: row.status,
      statusLabel: PICK_WAVE_STATUS_LABELS[row.status],
      orders: row._count.orders,
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    status,
  };
}

/**
 * Open waves of the warehouse the person works in that have work for
 * them (an open picking task inside their scope), oldest first, for the
 * shortcut in Tareas. At most ten.
 */
export async function listOpenWaves(
  actor: InventoryActor,
): Promise<{ id: string; numberText: string }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scope = await taskScope(client, actor.userId);
  const rows = await client.pickWave.findMany({
    where: {
      facilityId: facility.id,
      status: "OPEN",
      orders: {
        some: {
          openOrderId: { not: null },
          order: {
            lines: {
              some: {
                tasks: {
                  some: {
                    kind: "PICK",
                    status: { in: [...OPEN_TASK_STATUSES] },
                    ...scope,
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { number: "asc" },
    take: 10,
    select: { id: true, number: true },
  });
  return rows.map((row) => ({
    id: row.id,
    numberText: formatWaveNumber(row.number),
  }));
}

/** One task of a group: what it takes for which order. */
export type WavePickPart = {
  taskId: string;
  numberText: string;
  orderNumberText: string;
  recipient: string;
  quantityText: string;
  status: WarehouseTaskStatus;
  statusLabel: string;
  assignedToName: string | null;
  mine: boolean;
};

/**
 * What the floor takes of one product, in one place and one lot, for the
 * orders of the wave: «Toma 30: 10 para PS-0001, 12 para PS-0002…».
 */
export type WavePick = {
  key: string;
  productName: string;
  sku: string;
  lotCode: string | null;
  lotText: string | null;
  fromPath: string;
  /** The code of the place (what its label says), or null. */
  fromCode: string | null;
  zoneName: string;
  /** «30 piezas»: what every part of it adds up to. */
  quantityText: string;
  parts: WavePickPart[];
  /**
   * The tasks this person may confirm together now (available, or given to
   * them): sent back as they are, so nothing new joins without them seeing
   * it. Empty when it cannot be confirmed together (by serial).
   */
  takeIds: string[];
  /** «30 piezas»: what `takeIds` add up to. */
  takeText: string | null;
  bySerial: boolean;
};

export type WaveView = {
  id: string;
  numberText: string;
  status: PickWaveStatus;
  statusLabel: string;
  createdAt: Date;
  createdByName: string | null;
  doneAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  orders: {
    id: string;
    numberText: string;
    recipient: string;
    status: OutboundOrderStatus;
    statusLabel: string;
    urgent: boolean;
    /** Picking tasks still open, and all of them. */
    openTasks: number;
    tasks: number;
  }[];
  /** Zones its open tasks leave from (for the filter), by name. */
  zones: { id: string; name: string }[];
  /** The zone the view is narrowed to, if any (one of `zones`). */
  zone: string | null;
  /** What is left to pick, grouped, in walking order: one page. */
  picks: WavePick[];
  pickTotal: number;
  page: number;
  pageCount: number;
  /**
   * What comes next: the group chosen with `pick` when this person can take
   * it, or else the first one they can take in walking order.
   */
  next: WavePick | null;
  /** Available tasks in the zone shown: to take them or give them. */
  availableIds: string[];
  /** What this person picked and still carries, to leave in staging. */
  toLeave: {
    taskIds: string[];
    /** WMS-37B: each one, to deliver it from its own screen with a photo. */
    tasks: { id: string; numberText: string }[];
    text: string;
    place: string;
  } | null;
};

type PlaceRow = {
  id: string;
  code: string | null;
  name: string;
  parent?: LocationWithParents | null;
};

/** The wave if it exists for this person (its warehouse in scope). */
async function waveFor(
  client: ReturnType<typeof forOrganization>,
  userId: string,
  waveId: string,
) {
  const wave = await client.pickWave.findFirst({
    where: { id: String(waveId ?? "").slice(0, 36) },
    select: {
      id: true,
      number: true,
      status: true,
      facilityId: true,
      createdAt: true,
      createdByUserId: true,
      doneAt: true,
      cancelledAt: true,
      cancelReason: true,
    },
  });
  if (!wave || !(await isFacilityInScope(client, userId, wave.facilityId))) {
    return null;
  }
  return wave;
}

const WAVE_TASK_SELECT = {
  id: true,
  number: true,
  status: true,
  assignedToUserId: true,
  productId: true,
  fromLocationId: true,
  lotId: true,
  quantity: true,
  unitCode: true,
  product: { select: { name: true, sku: true, tracking: true } },
  lot: { select: { code: true, expiresOn: true } },
  fromLocation: {
    select: { id: true, code: true, name: true, parent: LOCATION_PARENTS },
  },
  toLocation: { select: { name: true } },
  outboundLine: {
    select: { order: { select: { id: true, number: true, recipient: true } } },
  },
} as const;

/**
 * The open picking tasks of a wave this person reaches (WMS-20: with
 * zones, only those inside them). Orders of a wave are at most
 * `WAVE_MAX_ORDERS`, so its tasks are read whole and ordered here.
 */
async function waveTasks(
  client: ReturnType<typeof forOrganization>,
  userId: string,
  waveId: string,
  statuses: readonly WarehouseTaskStatus[],
) {
  const scope = await taskScope(client, userId);
  return client.warehouseTask.findMany({
    where: {
      kind: "PICK",
      status: { in: [...statuses] },
      outboundLine: {
        order: { waves: { some: { waveId, openOrderId: { not: null } } } },
      },
      ...(Object.keys(scope).length > 0 ? { AND: [scope] } : {}),
    },
    orderBy: { number: "asc" },
    take: 5_000,
    select: WAVE_TASK_SELECT,
  });
}

type WaveTask = Awaited<ReturnType<typeof waveTasks>>[number];

const placeOf = (task: WaveTask) => ({
  code: task.fromLocation.code,
  path: locationPath(task.fromLocation as PlaceRow),
});

const keyOf = (task: WaveTask) =>
  `${task.productId}.${task.fromLocationId}.${task.lotId ?? ""}`;

/** The tasks still to pick: grouped by product, place and lot. */
const TO_PICK: readonly WarehouseTaskStatus[] = [
  "PENDING",
  "ASSIGNED",
  "ACCEPTED",
  "BLOCKED",
];

async function namesOf(organizationId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map<string, string>();
  const members = await forOrganization(organizationId).membership.findMany({
    where: { userId: { in: wanted } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

/**
 * One wave as the floor works it: its orders and how they go, and what is
 * left to pick grouped by product, place and lot in walking order — with
 * the zone filter (`zone`, only one of its zones) and a page of groups.
 */
export async function getWave(
  actor: InventoryActor,
  waveId: string,
  options: { zone?: unknown; page?: number; pick?: unknown } = {},
): Promise<WaveView | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "inventory.task.read");
  const client = forOrganization(organizationId);
  const wave = await waveFor(client, userId, waveId);
  if (!wave) return null;
  const members = await client.pickWaveOrder.findMany({
    where: { waveId: wave.id },
    select: {
      order: {
        select: {
          id: true,
          number: true,
          recipient: true,
          status: true,
          priority: true,
          dueOn: true,
        },
      },
    },
  });
  const orderIds = members.map((row) => row.order.id);
  const counts = await client.warehouseTask.groupBy({
    by: ["outboundLineId", "status"],
    where: { kind: "PICK", outboundLine: { orderId: { in: orderIds } } },
    _count: { _all: true },
  });
  const lines = await client.outboundOrderLine.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true },
  });
  const orderOfLine = new Map(lines.map((row) => [row.id, row.orderId]));
  const tally = new Map<string, { open: number; all: number }>();
  for (const row of counts) {
    const orderId = row.outboundLineId
      ? orderOfLine.get(row.outboundLineId)
      : undefined;
    if (!orderId) continue;
    const entry = tally.get(orderId) ?? { open: 0, all: 0 };
    entry.all += row._count._all;
    if (OPEN_TASK_STATUSES.includes(row.status)) entry.open += row._count._all;
    tally.set(orderId, entry);
  }
  const open = wave.status === "OPEN";
  const tasks = open
    ? await waveTasks(client, userId, wave.id, [...TO_PICK, "PICKED_UP"])
    : [];
  const zoneOf = await zonesOf(
    client,
    tasks.map((task) => task.fromLocationId),
  );
  const zones = [
    ...new Map(
      tasks.map((task) => {
        const zone = zoneOf.get(task.fromLocationId)!;
        return [zone.id, zone] as const;
      }),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const zone =
    typeof options.zone === "string" &&
    zones.some((row) => row.id === options.zone)
      ? options.zone
      : null;
  const inZone = (task: WaveTask) =>
    !zone || zoneOf.get(task.fromLocationId)?.id === zone;
  const names = await namesOf(organizationId, [
    wave.createdByUserId,
    ...tasks.map((task) => task.assignedToUserId),
  ]);
  const toPick = inRouteOrder(
    tasks.filter((task) => TO_PICK.includes(task.status) && inZone(task)),
    placeOf,
  );
  const groups = new Map<string, WaveTask[]>();
  for (const task of toPick) {
    const key = keyOf(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const sum = (rows: WaveTask[]) =>
    rows.reduce((total, task) => total.plus(task.quantity!.toString()), dec(0));
  const picks: WavePick[] = [...groups.entries()].map(([key, rows]) => {
    const head = rows[0]!;
    const unit = head.unitCode!;
    const bySerial = head.product!.tracking === "SERIAL";
    const takeable = rows.filter(
      (task) =>
        task.status === "PENDING" ||
        (task.assignedToUserId === userId &&
          (task.status === "ASSIGNED" || task.status === "ACCEPTED")),
    );
    const takeIds = bySerial ? [] : takeable.map((task) => task.id);
    return {
      key,
      productName: head.product!.name,
      sku: head.product!.sku,
      lotCode: head.lot?.code ?? null,
      lotText: head.lot
        ? lotLabel({
            code: head.lot.code,
            expiresOn: lotDayOf(head.lot.expiresOn),
          })
        : null,
      fromPath: placeOf(head).path,
      fromCode: head.fromLocation.code,
      zoneName: zoneOf.get(head.fromLocationId)?.name ?? "",
      quantityText: formatStock(sum(rows).toString(), unit),
      parts: rows.map((task) => ({
        taskId: task.id,
        numberText: formatTaskNumber(task.number),
        orderNumberText: formatOutboundNumber(task.outboundLine!.order.number),
        recipient: task.outboundLine!.order.recipient,
        quantityText: formatStock(task.quantity!.toString(), unit),
        status: task.status,
        statusLabel: WAREHOUSE_TASK_STATUS_LABELS[task.status],
        assignedToName: task.assignedToUserId
          ? (names.get(task.assignedToUserId) ?? null)
          : null,
        mine: task.assignedToUserId === userId,
      })),
      takeIds,
      takeText:
        takeIds.length > 0 ? formatStock(sum(takeable).toString(), unit) : null,
      bySerial,
    };
  });
  const pageCount = Math.max(1, Math.ceil(picks.length / WAVE_PICKS_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const carried = tasks.filter(
    (task) => task.status === "PICKED_UP" && task.assignedToUserId === userId,
  );
  return {
    id: wave.id,
    numberText: formatWaveNumber(wave.number),
    status: wave.status,
    statusLabel: PICK_WAVE_STATUS_LABELS[wave.status],
    createdAt: wave.createdAt,
    createdByName: names.get(wave.createdByUserId) ?? null,
    doneAt: wave.doneAt,
    cancelledAt: wave.cancelledAt,
    cancelReason: wave.cancelReason,
    orders: members
      .map((row) => row.order)
      .sort(byUrgency)
      .map((order) => ({
        id: order.id,
        numberText: formatOutboundNumber(order.number),
        recipient: order.recipient,
        status: order.status,
        statusLabel: OUTBOUND_ORDER_STATUS_LABELS[order.status],
        urgent: order.priority === "URGENT",
        openTasks: tally.get(order.id)?.open ?? 0,
        tasks: tally.get(order.id)?.all ?? 0,
      })),
    zones,
    zone,
    picks: picks.slice(
      (page - 1) * WAVE_PICKS_PAGE_SIZE,
      page * WAVE_PICKS_PAGE_SIZE,
    ),
    pickTotal: picks.length,
    page,
    pageCount,
    // The group the person chose (`pick`), or the first one they can take.
    next:
      picks.find(
        (pick) => pick.key === options.pick && pick.takeIds.length > 0,
      ) ??
      picks.find((pick) => pick.takeIds.length > 0) ??
      null,
    availableIds: toPick
      .filter((task) => task.status === "PENDING")
      .map((task) => task.id),
    toLeave:
      carried.length > 0
        ? {
            taskIds: carried.map((task) => task.id),
            tasks: carried.map((task) => ({
              id: task.id,
              numberText: formatTaskNumber(task.number),
            })),
            text:
              carried.length === 1
                ? "1 tarea surtida"
                : `${carried.length} tareas surtidas`,
            place: carried[0]!.toLocation.name,
          }
        : null,
  };
}

// ── Working a wave ───────────────────────────────────────────────────────

/**
 * Of the given tasks, those of this wave that this person reaches and are
 * in one of the given states. The service of the tasks checks everything
 * again under their locks; this only keeps a form from reaching tasks of
 * another wave.
 */
async function ofWave(
  actor: InventoryActor,
  waveId: string,
  taskIds: readonly unknown[],
  statuses: readonly WarehouseTaskStatus[],
): Promise<{ ids: string[]; wanted: number } | null> {
  const client = forOrganization(actor.organizationId);
  const wave = await waveFor(client, actor.userId, waveId);
  if (!wave || wave.status !== "OPEN") return null;
  const wanted = new Set(
    (Array.isArray(taskIds) ? taskIds : []).map((id) =>
      String(id ?? "").slice(0, 36),
    ),
  );
  const tasks = await waveTasks(client, actor.userId, wave.id, statuses);
  return {
    ids: tasks.filter((task) => wanted.has(task.id)).map((task) => task.id),
    wanted: wanted.size,
  };
}

const NO_WAVE: TaskGroupResult = {
  ok: false,
  reason: "not_found",
  formError: "Esta ola ya no está abierta.",
};

const NONE_LEFT: TaskGroupResult = {
  ok: true,
  count: 0,
  repeated: true,
  summary: "No queda ninguna tarea disponible aquí.",
};

const CHANGED: TaskGroupResult = {
  ok: false,
  reason: "not_allowed",
  formError:
    "Lo que viste cambió mientras tanto. Vuelve a abrir la ola y revisa lo que sigue.",
};

/**
 * «Ya tomé 30 piezas»: confirms together the tasks of one group of the
 * wave (as the screen showed them), with one scan of product, place and
 * lot. All or nothing (`confirmPickGroup`).
 */
export async function confirmWavePick(
  actor: InventoryActor,
  waveId: string,
  input: {
    taskIds: readonly unknown[];
    productCode: string;
    locationCode: string;
    lotCode?: string;
  },
): Promise<TaskGroupResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.execute",
  );
  const found = await ofWave(actor, waveId, input.taskIds, [
    "PENDING",
    "ASSIGNED",
    "ACCEPTED",
    "PICKED_UP",
  ]);
  if (!found) return NO_WAVE;
  if (found.ids.length === 0 || found.ids.length !== found.wanted) {
    return CHANGED;
  }
  return confirmPickGroup(actor, found.ids, {
    productCode: input.productCode,
    locationCode: input.locationCode,
    lotCode: input.lotCode,
  });
}

/** «Dejar en Preparación»: delivers what this person picked of the wave. */
export async function deliverWavePicks(
  actor: InventoryActor,
  waveId: string,
  taskIds: readonly unknown[],
): Promise<TaskGroupResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.execute",
  );
  const found = await ofWave(actor, waveId, taskIds, [
    "PICKED_UP",
    "DELIVERED",
  ]);
  if (!found) return NO_WAVE;
  if (found.ids.length === 0) return CHANGED;
  return deliverPickGroup(actor, found.ids);
}

/**
 * The available tasks of the wave in a zone (or all of it) this person
 * reaches: the ones «Tomar» and «Asignar» work on.
 */
async function availableIn(
  actor: InventoryActor,
  waveId: string,
  zone: unknown,
): Promise<string[] | null> {
  const view = await getWave(actor, waveId, { zone });
  if (!view || view.status !== "OPEN") return null;
  if (typeof zone === "string" && zone !== "" && view.zone !== zone) {
    return [];
  }
  return view.availableIds;
}

/** «Tomar las de esta zona»: the available tasks of the zone are this person's. */
export async function takeWaveTasks(
  actor: InventoryActor,
  waveId: string,
  zone?: unknown,
): Promise<TaskGroupResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.execute",
  );
  const ids = await availableIn(actor, waveId, zone);
  if (!ids) return NO_WAVE;
  if (ids.length === 0) return NONE_LEFT;
  return takeTasks(actor, ids);
}

/** «Asignar las de esta zona a…»: gives the available tasks of the zone. */
export async function assignWaveTasks(
  actor: InventoryActor,
  waveId: string,
  zone: unknown,
  assignToUserId: string,
): Promise<TaskGroupResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.create",
  );
  const ids = await availableIn(actor, waveId, zone);
  if (!ids) return NO_WAVE;
  if (ids.length === 0) return NONE_LEFT;
  return assignTasks(actor, ids, assignToUserId);
}

/** The wave an order is in now, if any («OL-0003»), for its screen. */
export async function waveOfOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<{ id: string; numberText: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const row = await forOrganization(
    actor.organizationId,
  ).pickWaveOrder.findFirst({
    where: { openOrderId: String(orderId ?? "").slice(0, 36) },
    select: { wave: { select: { id: true, number: true } } },
  });
  return row
    ? { id: row.wave.id, numberText: formatWaveNumber(row.wave.number) }
    : null;
}
