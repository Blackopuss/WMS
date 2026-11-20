import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  ARCHIVED_FACILITY_MESSAGE,
  activeFacilityOf,
  holdOpenFacility,
  ensureStagingLocation,
  isFacilityInScope,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { dayWindow, type DayWindow } from "./calendar-day";
import { lotDayOf, lotLabel } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import {
  OUTBOUND_ORDER_STATUS_LABELS,
  formatOutboundNumber,
  isOutboundOrderStatus,
  outboundTransitionProblem,
  type OutboundOrderStatus,
} from "./outbound-states";
import {
  OUTBOUND_LINE_SOURCE,
  createPickTasks,
  nextTaskNumber,
  pickSources,
  type PickSource,
} from "./picking";
import { releaseReservations, type ReservationSource } from "./reservations";
import {
  closeOrderWaits,
  creditLineWaits,
  openProductionWaits,
  waitsOfOrder,
  type MakeToOrder,
  type OutboundWaitView,
} from "./outbound-waits";
import { CROSS_DOCK_MODE, MAKE_TO_ORDER_MODE } from "./settings";
import { settleWaveOf } from "./wave-settle";
import { TO_SHIP, readyStatuses, shippedOnWhere } from "./shipment-ready";
import {
  SHIPMENT_STATUS_LABELS,
  formatShipmentNumber,
  type ShipmentStatus,
} from "./shipment-states";
import {
  WAREHOUSE_TASK_STATUS_LABELS,
  formatTaskNumber,
  type WarehouseTaskStatus,
} from "./task-states";

/**
 * Outbound orders (WMS-13, spec 5.2): what has to leave the warehouse, for
 * whom and when. A warehouse document, without prices (ADR 0032). A draft
 * changes freely; releasing it reserves its stock (WMS-12) without moving
 * it; cancelling it releases what it reserved. Picking, packing and
 * shipping come in WMS-14..16.
 *
 * Locks: products (sorted) → order, like every document that reserves or
 * moves stock. Every change of an order locks it and checks its state
 * under the lock.
 */

export const OUTBOUND_PAGE_SIZE = 25;
export const OUTBOUND_MAX_LINES = 200;
const SOURCE_TYPE = OUTBOUND_LINE_SOURCE;

const sourceOf = (lineId: string): ReservationSource => ({
  type: SOURCE_TYPE,
  id: lineId,
});

type Tx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];

export type OutboundField =
  | "recipient"
  | "address"
  | "reference"
  | "dueOn"
  | "priority"
  | "note"
  | "productId"
  | "quantity"
  | "reason";

export type OutboundShortage = {
  lineId: string;
  productName: string;
  /** «12 piezas». */
  asked: string;
  /** «5 piezas». */
  free: string;
};

export type OutboundResult =
  | { ok: true; orderId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed" | "short";
      fieldErrors?: Partial<Record<OutboundField, string>>;
      formError?: string;
      /** When releasing: what does not reach (nothing was reserved). */
      shortages?: OutboundShortage[];
    };

type Failure = Extract<OutboundResult, { ok: false }>;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("outbound order rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: OutboundField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

async function inOrder(
  organizationId: string,
  work: (tx: Tx) => Promise<OutboundResult>,
): Promise<OutboundResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      work,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

/**
 * The order under its lock. An order of a warehouse outside the scope of
 * who asks does not exist for them (WMS-20).
 */
async function lockOrder(tx: Tx, orderId: string, userId: string) {
  const [id] = await lockRows(tx, "outboundOrder", [String(orderId ?? "")]);
  const order = id
    ? await tx.outboundOrder.findFirst({
        where: { id },
        select: {
          id: true,
          number: true,
          status: true,
          priority: true,
          recipient: true,
          facilityId: true,
          lines: {
            orderBy: { lineNumber: "asc" },
            select: {
              id: true,
              lineNumber: true,
              productId: true,
              quantity: true,
              unitCode: true,
              product: { select: { name: true, status: true } },
            },
          },
        },
      })
    : null;
  if (!order) return stop("not_found", "Este pedido no existe.");
  if (!(await isFacilityInScope(tx, userId, order.facilityId))) {
    return stop("not_found", "Este pedido no existe.");
  }
  return order;
}

function draftOnly(status: OutboundOrderStatus) {
  if (status !== "DRAFT") {
    stop(
      "not_allowed",
      status === "CANCELLED"
        ? "Este pedido está cancelado."
        : "Este pedido ya se liberó: ya no se cambia.",
    );
  }
}

// ── Header ───────────────────────────────────────────────────────────────

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Usa como máximo ${max} caracteres.`)
    .optional()
    .transform((value) => value || null);

const headerSchema = z.object({
  recipient: z
    .string()
    .trim()
    .min(1, "Escribe para quién es el pedido.")
    .max(160, "Usa como máximo 160 caracteres."),
  address: text(300),
  reference: text(120),
  note: text(500),
  dueOn: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine(
      (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
      "Escribe la fecha como año-mes-día.",
    ),
  priority: z
    .string()
    .optional()
    .transform((value): "NORMAL" | "URGENT" =>
      value === "URGENT" ? "URGENT" : "NORMAL",
    ),
});

export type OutboundHeaderInput = z.input<typeof headerSchema>;

function readHeader(input: OutboundHeaderInput) {
  const parsed = headerSchema.safeParse(input);
  if (parsed.success) return { ok: true as const, data: parsed.data };
  const fieldErrors: Partial<Record<OutboundField, string>> = {};
  for (const issue of parsed.error.issues) {
    fieldErrors[issue.path[0] as OutboundField] ??= issue.message;
  }
  return { ok: false as const, fieldErrors };
}

const dayOf = (value: string | null) =>
  value ? new Date(`${value}T00:00:00.000Z`) : null;

export async function createOutboundOrder(
  actor: InventoryActor,
  input: OutboundHeaderInput,
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  const { data } = header;
  const facility = await activeFacilityOf(
    forOrganization(organizationId),
    userId,
  );
  for (let attempt = 0; ; attempt++) {
    try {
      return await forOrganization(organizationId).$transaction(async (tx) => {
        // WMS-82 (ADR 0077): its warehouse, shared, before anything else;
        // archiving takes it in exclusive and sees this order.
        if (!(await holdOpenFacility(tx, facility.id))) {
          return {
            ok: false as const,
            reason: "not_allowed" as const,
            formError: ARCHIVED_FACILITY_MESSAGE,
          };
        }
        const last = await tx.outboundOrder.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = newId();
        const number = (last?.number ?? 0) + 1;
        await tx.outboundOrder.create({
          data: {
            id,
            organizationId,
            // It leaves from the warehouse its author works in (WMS-18).
            facilityId: facility.id,
            number,
            recipient: data.recipient,
            address: data.address,
            reference: data.reference,
            note: data.note,
            dueOn: dayOf(data.dueOn),
            priority: data.priority,
            createdByUserId: userId,
          },
        });
        return {
          ok: true as const,
          orderId: id,
          summary: `Se creó el pedido ${formatOutboundNumber(number)} para ${data.recipient}.`,
        };
      });
    } catch (error) {
      // Two orders created at once take the same number: try again.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

export async function updateOutboundOrder(
  actor: InventoryActor,
  orderId: string,
  input: OutboundHeaderInput,
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  const { data } = header;
  return inOrder(organizationId, async (tx) => {
    const order = await lockOrder(tx, orderId, userId);
    draftOnly(order.status);
    await tx.outboundOrder.update({
      where: { id: order.id },
      data: {
        recipient: data.recipient,
        address: data.address,
        reference: data.reference,
        note: data.note,
        dueOn: dayOf(data.dueOn),
        priority: data.priority,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `Se guardó el pedido ${formatOutboundNumber(order.number)}.`,
    };
  });
}

// ── Lines ────────────────────────────────────────────────────────────────

/**
 * Sets what a draft asks of a product (one line per product): adds it, or
 * replaces its quantity. The product is found by id; the quantity follows
 * its rule.
 */
export async function setOutboundLine(
  actor: InventoryActor,
  orderId: string,
  input: { productId: string; quantity: string },
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  const productId = String(input.productId ?? "").trim();
  if (!productId) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { productId: "Elige un producto." },
    };
  }
  return inOrder(organizationId, async (tx) => {
    const [locked] = await lockRows(tx, "product", [productId]);
    const order = await lockOrder(tx, orderId, userId);
    draftOnly(order.status);
    const product = locked
      ? await tx.product.findFirst({
          where: { id: locked },
          select: {
            id: true,
            name: true,
            status: true,
            unitCode: true,
            quantityStep: true,
          },
        })
      : null;
    if (!product) {
      return stop("not_found", "Este producto no existe.", "productId");
    }
    if (product.status !== "ACTIVE") {
      return stop("not_allowed", "Este producto está archivado.", "productId");
    }
    const quantity = parseQuantity(
      {
        unitCode: product.unitCode,
        quantityStep: product.quantityStep.toString(),
      },
      String(input.quantity ?? ""),
    );
    if (!quantity.ok) return stop("invalid", quantity.error, "quantity");
    const existing = order.lines.find((line) => line.productId === product.id);
    if (existing) {
      await tx.outboundOrderLine.update({
        where: { id: existing.id },
        data: { quantity: quantity.quantity.toString() },
      });
    } else {
      if (order.lines.length >= OUTBOUND_MAX_LINES) {
        return stop(
          "not_allowed",
          `Un pedido admite hasta ${OUTBOUND_MAX_LINES} productos.`,
        );
      }
      await tx.outboundOrderLine.create({
        data: {
          id: newId(),
          organizationId,
          orderId: order.id,
          lineNumber:
            order.lines.reduce(
              (max, line) => Math.max(max, line.lineNumber),
              0,
            ) + 1,
          productId: product.id,
          quantity: quantity.quantity.toString(),
          unitCode: product.unitCode,
        },
      });
    }
    return {
      ok: true,
      orderId: order.id,
      summary: `${formatStock(quantity.quantity.toString(), product.unitCode)} de ${product.name} en el pedido.`,
    };
  });
}

export async function removeOutboundLine(
  actor: InventoryActor,
  orderId: string,
  lineId: string,
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  return inOrder(organizationId, async (tx) => {
    const order = await lockOrder(tx, orderId, userId);
    draftOnly(order.status);
    const line = order.lines.find((row) => row.id === String(lineId ?? ""));
    if (!line) return stop("not_found", "Esa línea ya no está en el pedido.");
    await tx.outboundOrderLine.delete({ where: { id: line.id } });
    return {
      ok: true,
      orderId: order.id,
      summary: `Se quitó ${line.product.name} del pedido.`,
    };
  });
}

// ── Release and cancel ───────────────────────────────────────────────────

/**
 * Releases a draft to the warehouse: reserves the stock of each line. When
 * something does not reach, nothing is reserved and the answer says what
 * is short — unless `takeWhatThereIs`, which reserves what is free of each
 * line and releases the order with the rest pending.
 */
export async function releaseOutboundOrder(
  actor: InventoryActor,
  orderId: string,
  options: ReleaseOptions = {},
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.release",
  );
  // The lines of a draft can change until it is locked: read them to
  // lock their products first, then check under the lock.
  const draft = await forOrganization(
    organizationId,
  ).outboundOrderLine.findMany({
    where: { orderId: String(orderId ?? "") },
    select: { productId: true },
  });
  // The warehouse it leaves from only changes in draft: read it to prepare
  // its staging location, and check it again under the lock.
  const facilityId =
    (
      await forOrganization(organizationId).outboundOrder.findFirst({
        where: { id: String(orderId ?? "") },
        select: { facilityId: true },
      })
    )?.facilityId ?? null;
  // WMS-79 (ADR 0094): the production areas these products would use,
  // to lock them (shared) before the order.
  const areaIds =
    options.makeToOrder && facilityId
      ? await options.makeToOrder.areasFor(
          forOrganization(organizationId),
          facilityId,
          [...new Set(draft.map((line) => line.productId))],
        )
      : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await releaseLocked(
        actor,
        orderId,
        draft,
        options,
        facilityId,
        areaIds,
      );
    } catch (error) {
      // A task created by hand took the same number at once: again.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

function releaseLocked(
  actor: InventoryActor,
  orderId: string,
  draft: { productId: string }[],
  options: ReleaseOptions,
  facilityId: string | null,
  areaIds: string[],
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  return inOrder(organizationId, async (tx) => {
    await lockRows(
      tx,
      "product",
      draft.map((line) => line.productId),
    );
    // Where picked goods wait (WMS-14); created the first time.
    if (!facilityId) return stop("not_found", "Este pedido no existe.");
    // WMS-20: before touching anything of a warehouse closed to the person.
    if (!(await isFacilityInScope(tx, userId, facilityId))) {
      return stop("not_found", "Este pedido no existe.");
    }
    // Where picked goods of its warehouse wait (WMS-14/18).
    const staging = await ensureStagingLocation(tx, organizationId, facilityId);
    // WMS-79: the production areas, shared, before the order (a linked
    // request reads its area when it is inserted).
    const lockedAreaIds = new Set(
      areaIds.length > 0
        ? await lockRows(tx, "location", areaIds, { mode: "share" })
        : [],
    );
    const order = await lockOrder(tx, orderId, userId);
    if (order.facilityId !== facilityId) {
      return stop(
        "not_allowed",
        "El pedido cambió mientras se liberaba. Inténtalo de nuevo.",
      );
    }
    if (order.status === "RELEASED") {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: `El pedido ${formatOutboundNumber(order.number)} ya estaba liberado.`,
      };
    }
    const done = await releaseUnderLock(
      tx,
      actor,
      order,
      staging.id,
      new Set(draft.map((line) => line.productId)),
      { ...options, lockedAreaIds },
    );
    if (!done.ok) throw new Rejected(done);
    return done;
  });
}

export type ReleaseOptions = {
  /** Reserves what is free and releases with the rest pending. */
  takeWhatThereIs?: boolean;
  /**
   * WMS-79 (ADR 0094): with `inventory.outbound.make_to_order = on`, what
   * falls short of a line production can make is asked to production
   * instead of stopping the release. Without it, as before.
   */
  makeToOrder?: MakeToOrder;
};

/** An outbound order read under its lock (`lockOrder`). */
export type LockedOutboundOrder = Awaited<ReturnType<typeof lockOrder>>;

/**
 * The order under its lock, or null when it does not exist for this
 * person (another company, a warehouse outside their scope). For
 * documents that group orders (WMS-25): they lock all of them first.
 */
export async function lockedOutboundOrder(
  tx: Tx,
  orderId: string,
  userId: string,
): Promise<LockedOutboundOrder | null> {
  try {
    return await lockOrder(tx, orderId, userId);
  } catch (error) {
    if (error instanceof Rejected) return null;
    throw error;
  }
}

/**
 * Releases a draft whose products, staging location and order the caller
 * already locked (products → locations → order), in its transaction:
 * reserves each line where it is picked from and creates its PICK tasks.
 * Shared by `releaseOutboundOrder` and the waves (WMS-25), so there is one
 * release. A refusal is answered before anything is written; the caller
 * decides whether it stops everything.
 */
export async function releaseUnderLock(
  tx: Tx,
  actor: InventoryActor,
  order: LockedOutboundOrder,
  stagingId: string,
  /** The products the caller locked: a line of another one is refused. */
  lockedIds: ReadonlySet<string>,
  options: ReleaseOptions & { lockedAreaIds?: ReadonlySet<string> } = {},
): Promise<OutboundResult> {
  try {
    return await releaseCore(tx, actor, order, stagingId, lockedIds, options);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

async function releaseCore(
  tx: Tx,
  actor: InventoryActor,
  order: LockedOutboundOrder,
  stagingId: string,
  lockedIds: ReadonlySet<string>,
  options: ReleaseOptions & { lockedAreaIds?: ReadonlySet<string> },
): Promise<OutboundResult> {
  const { userId } = actor;
  const facilityId = order.facilityId;
  const staging = { id: stagingId };
  const problem = outboundTransitionProblem(order.status, "RELEASED");
  if (problem) return stop("not_allowed", problem);
  if (order.lines.length === 0) {
    return stop("invalid", "Agrega al menos un producto antes de liberar.");
  }
  // A product added after the first read is not locked: try again.
  if (order.lines.some((line) => !lockedIds.has(line.productId))) {
    return stop(
      "not_allowed",
      "El pedido cambió mientras se liberaba. Inténtalo de nuevo.",
    );
  }
  const archived = order.lines.find((line) => line.product.status !== "ACTIVE");
  if (archived) {
    return stop(
      "not_allowed",
      `${archived.product.name} está archivado: quítalo del pedido o reactívalo.`,
    );
  }

  const plan: {
    line: (typeof order.lines)[number];
    sources: PickSource[];
    take: Decimal;
  }[] = [];
  const shortages: OutboundShortage[] = [];
  // Several lines of the same product are not possible (unique index),
  // so each line asks its product once. Where it is picked from decides
  // what can be taken: stock already in the staging location or held
  // elsewhere does not count.
  for (const line of order.lines) {
    const asked = dec(line.quantity.toString());
    const sources = await pickSources(tx, line.productId, asked, {
      stagingId: staging.id,
      facilityId,
    });
    const take = sources.reduce(
      (sum, source) => sum.plus(source.quantity),
      dec(0),
    );
    if (take.lessThan(asked)) {
      shortages.push({
        lineId: line.id,
        productName: line.product.name,
        asked: formatStock(asked.toString(), line.unitCode),
        free: formatStock(take.toString(), line.unitCode),
      });
    }
    plan.push({ line, sources, take });
  }
  // WMS-79 (ADR 0094): what falls short of a line production can make is
  // asked to production; it does not stop the release.
  const toMake = new Map<string, string>();
  if (
    shortages.length > 0 &&
    options.makeToOrder &&
    (await readSetting(tx, MAKE_TO_ORDER_MODE)) === "on"
  ) {
    const shortIds = new Set(shortages.map((row) => row.lineId));
    const made = await options.makeToOrder.makeable(tx, {
      organizationId: actor.organizationId,
      facilityId,
      productIds: plan
        .filter((step) => shortIds.has(step.line.id))
        .map((step) => step.line.productId),
      lockedAreaIds: options.lockedAreaIds ?? new Set(),
    });
    if (made.changed) {
      return stop(
        "not_allowed",
        "La receta cambió mientras se liberaba. Inténtalo de nuevo.",
      );
    }
    for (const step of plan) {
      const area = made.areas.get(step.line.productId);
      if (shortIds.has(step.line.id) && area) toMake.set(step.line.id, area);
    }
  }
  const blocking = shortages.filter((row) => !toMake.has(row.lineId));
  if (blocking.length > 0 && !options.takeWhatThereIs) {
    throw new Rejected({
      ok: false,
      reason: "short",
      formError:
        blocking.length === 1
          ? "Un producto no alcanza."
          : `${blocking.length} productos no alcanzan.`,
      shortages: blocking,
    });
  }
  // WMS-54 (ADR 0052): with cross-docking, an order may wait for what
  // arrives with nothing set aside yet; without it, nothing to release
  // unless something of it waits for production (WMS-79).
  const waitsForAll = plan.every((step) => step.take.isZero());
  if (
    waitsForAll &&
    toMake.size === 0 &&
    (await readSetting(tx, CROSS_DOCK_MODE)) !== "on"
  ) {
    return stop(
      "not_allowed",
      "No hay nada disponible de este pedido: no se apartó nada.",
    );
  }
  // Released first: a picking task only comes from a released order
  // (trigger).
  await tx.outboundOrder.update({
    where: { id: order.id },
    data: {
      status: "RELEASED",
      releasedAt: new Date(),
      releasedByUserId: userId,
    },
  });
  const firstTask = await nextTaskNumber(tx);
  let nextNumber = firstTask;
  for (const step of plan) {
    nextNumber = await createPickTasks(tx, actor, {
      order: {
        number: formatOutboundNumber(order.number),
        recipient: order.recipient,
        priority: order.priority,
      },
      line: step.line,
      sources: step.sources,
      stagingId: staging.id,
      nextNumber,
    });
  }
  // WMS-79: a wait and a linked request for each line production makes.
  let askedText = "";
  if (toMake.size > 0 && options.makeToOrder) {
    const lines = plan
      .filter((step) => toMake.has(step.line.id))
      .map((step) => ({
        lineId: step.line.id,
        productId: step.line.productId,
        quantity: dec(step.line.quantity.toString()).minus(step.take),
        unitCode: step.line.unitCode,
      }));
    const waits = await openProductionWaits(tx, actor, {
      orderId: order.id,
      lines,
    });
    const asked = await options.makeToOrder.ask(tx, actor, {
      facilityId,
      lines: lines.map((line) => ({
        ...line,
        waitId: waits.get(line.lineId)!,
        areaLocationId: toMake.get(line.lineId)!,
      })),
    });
    askedText = ` Se pidió producir ${asked.length === 1 ? "1 producto" : `${asked.length} productos`} (${asked.map((row) => row.numberText).join(", ")}); el pedido no sale hasta que llegue.`;
  }
  if (waitsForAll) {
    return {
      ok: true,
      orderId: order.id,
      summary:
        toMake.size > 0
          ? `Se liberó el pedido ${formatOutboundNumber(order.number)} sin nada apartado.${askedText}`
          : `Se liberó el pedido ${formatOutboundNumber(order.number)} sin nada apartado: lo que llegue para él irá directo a preparación.`,
    };
  }
  const incomplete = shortages.length - toMake.size;
  return {
    ok: true,
    orderId: order.id,
    summary:
      (incomplete === 0
        ? `Se liberó el pedido ${formatOutboundNumber(order.number)}: ${toMake.size > 0 ? "se apartó lo que hay" : "todo quedó apartado"}`
        : `Se liberó el pedido ${formatOutboundNumber(order.number)} con lo que hay (${incomplete === 1 ? "1 producto quedó incompleto" : `${incomplete} productos quedaron incompletos`})`) +
      (nextNumber - firstTask === 1
        ? " y hay 1 tarea de surtido."
        : ` y hay ${nextNumber - firstTask} tareas de surtido.`) +
      askedText,
  };
}

/**
 * WMS-79 (ADR 0094): «Apartar lo que ya hay» — what a released order or one
 * being picked still lacks is set aside from what is free now, with its
 * picking tasks, through the same steps as releasing it (`pickSources`,
 * `createPickTasks`). It counts toward a line's wait for production.
 * Locks: products → warehouse (staging) → order, like releasing.
 */
export async function reserveWhatThereIs(
  actor: InventoryActor,
  orderId: string,
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.release",
  );
  const client = forOrganization(organizationId);
  const id = String(orderId ?? "").slice(0, 36);
  const first = await client.outboundOrder.findFirst({
    where: { id },
    select: { facilityId: true, lines: { select: { productId: true } } },
  });
  if (!first) {
    return {
      ok: false,
      reason: "not_found",
      formError: "Este pedido no existe.",
    };
  }
  const productIds = [...new Set(first.lines.map((line) => line.productId))];
  for (let attempt = 0; ; attempt++) {
    try {
      return await inOrder(organizationId, async (tx) => {
        await lockRows(tx, "product", productIds);
        if (!(await isFacilityInScope(tx, userId, first.facilityId))) {
          return stop("not_found", "Este pedido no existe.");
        }
        const staging = await ensureStagingLocation(
          tx,
          organizationId,
          first.facilityId,
        );
        const order = await lockOrder(tx, id, userId);
        const numberText = formatOutboundNumber(order.number);
        if (order.status !== "RELEASED" && order.status !== "PICKING") {
          return stop(
            "not_allowed",
            `Solo se aparta en un pedido liberado o en surtido; ${numberText} está ${OUTBOUND_ORDER_STATUS_LABELS[order.status].toLowerCase()}.`,
          );
        }
        if (order.lines.some((line) => !productIds.includes(line.productId))) {
          return stop(
            "not_allowed",
            "El pedido cambió mientras se apartaba. Inténtalo de nuevo.",
          );
        }
        const held = await tx.stockReservation.groupBy({
          by: ["sourceId"],
          where: {
            sourceType: OUTBOUND_LINE_SOURCE,
            sourceId: { in: order.lines.map((line) => line.id) },
            state: "ACTIVE",
          },
          _sum: { remaining: true },
        });
        const heldOf = new Map(
          held.map((row) => [
            row.sourceId,
            dec((row._sum.remaining ?? 0).toString()),
          ]),
        );
        const firstTask = await nextTaskNumber(tx);
        let nextNumber = firstTask;
        const taken = new Map<string, Decimal>();
        for (const line of order.lines) {
          const lacking = dec(line.quantity.toString()).minus(
            heldOf.get(line.id) ?? 0,
          );
          if (!lacking.greaterThan(0)) continue;
          const sources = await pickSources(tx, line.productId, lacking, {
            stagingId: staging.id,
            facilityId: order.facilityId,
          });
          const take = sources.reduce(
            (sum, source) => sum.plus(source.quantity),
            dec(0),
          );
          if (!take.greaterThan(0)) continue;
          nextNumber = await createPickTasks(tx, actor, {
            order: {
              number: numberText,
              recipient: order.recipient,
              priority: order.priority,
            },
            line,
            sources,
            stagingId: staging.id,
            nextNumber,
          });
          taken.set(line.id, take);
        }
        if (taken.size === 0) {
          return stop(
            "not_allowed",
            `No hay nada libre de lo que le falta al pedido ${numberText}.`,
          );
        }
        await creditLineWaits(tx, taken);
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.outbound_topped_up",
          target: { type: "outbound_order", id: order.id },
          metadata: {
            pedido: numberText,
            tareas: nextNumber - firstTask,
          },
        });
        return {
          ok: true,
          orderId: order.id,
          summary: `Se apartó lo que había para el pedido ${numberText}: ${nextNumber - firstTask === 1 ? "1 tarea de surtido" : `${nextNumber - firstTask} tareas de surtido`}.`,
        };
      });
    } catch (error) {
      // A task made at once took the same number: again.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

export async function cancelOutboundOrder(
  actor: InventoryActor,
  orderId: string,
  reason: string,
  /** WMS-79: cancels what was still asked to production for it. */
  options: { makeToOrder?: MakeToOrder } = {},
): Promise<OutboundResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.cancel",
  );
  const why = String(reason ?? "").trim();
  if (why.length < 3) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: "Escribe por qué se cancela." },
    };
  }
  if (why.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: "Usa como máximo 300 caracteres." },
    };
  }
  return inOrder(organizationId, async (tx) => {
    const order = await lockOrder(tx, orderId, userId);
    if (order.status === "CANCELLED") {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: "El pedido ya estaba cancelado.",
      };
    }
    const problem = outboundTransitionProblem(order.status, "CANCELLED");
    if (problem) return stop("not_allowed", problem);
    let released = 0;
    for (const line of order.lines) {
      released += await releaseReservations(tx, sourceOf(line.id));
    }
    // Picking had not started (it would be PICKING): its tasks go too.
    await tx.warehouseTask.updateMany({
      where: {
        kind: "PICK",
        outboundLine: { orderId: order.id },
        status: { in: ["PENDING", "ASSIGNED", "BLOCKED"] },
      },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: `Se canceló el pedido: ${why}`.slice(0, 300),
        closedByUserId: userId,
      },
    });
    await tx.outboundOrder.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: userId,
        cancelReason: why,
      },
    });
    // WMS-79 (ADR 0094): it no longer waits for production; what was still
    // asked is cancelled, the orders already made go on without the link.
    const waits = await closeOrderWaits(
      tx,
      actor,
      order.id,
      "CANCELLED",
      `Se canceló el pedido: ${why}`,
    );
    if (waits.length > 0 && options.makeToOrder) {
      await options.makeToOrder.closed(
        tx,
        actor,
        waits,
        `Se canceló el pedido ${formatOutboundNumber(order.number)}: ${why}`,
      );
    }
    // WMS-25: its wave ends when this was the last of its open work.
    await settleWaveOf(tx, order.id);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "inventory.outbound_cancelled",
      target: { type: "outbound_order", id: order.id },
      reason: why,
      metadata: {
        pedido: formatOutboundNumber(order.number),
        reservasLiberadas: released,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `Se canceló el pedido ${formatOutboundNumber(order.number)}${released > 0 ? " y se liberó lo que tenía apartado" : ""}.`,
    };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export type OutboundSummary = {
  id: string;
  numberText: string;
  status: OutboundOrderStatus;
  statusLabel: string;
  urgent: boolean;
  recipient: string;
  reference: string | null;
  /** «2026-11-12» or null. */
  dueOn: string | null;
  lines: number;
  createdAt: Date;
  /** WMS-79: something of it waits for production. */
  waitsForProduction: boolean;
};

export type OutboundPage = {
  items: OutboundSummary[];
  total: number;
  page: number;
  pageCount: number;
  status: OutboundOrderStatus | null;
  /** WMS-15: picked or being packed («por empacar»). */
  toPack: boolean;
  /** The day the list is narrowed to («2026-11-12»), if any. */
  pickedOn: string | null;
  /** WMS-16: ready to leave («por despachar»). */
  toShip: boolean;
  /** The day it is narrowed to orders shipped on, if any. */
  shippedOn: string | null;
};

/** The value of `status` that lists what waits to be packed (WMS-15). */
export const TO_PACK = "por-empacar";

const LEFT_PICKING = ["PICKED", "PACKING", "PACKED", "SHIPPED"] as const;

/**
 * Orders of a warehouse picked on a day: they have left picking and their
 * last picking task closed that day (the order keeps no date of its own).
 * The same for the list and for the summary of the day (WMS-73).
 */
export function pickedOnWhere(facilityId: string, window: DayWindow) {
  const pickClosed = (when: { gte: Date; lt?: Date }) => ({
    lines: {
      some: {
        tasks: {
          some: {
            kind: "PICK" as const,
            OR: [{ deliveredAt: when }, { cancelledAt: when }],
          },
        },
      },
    },
  });
  return {
    facilityId,
    status: { in: [...LEFT_PICKING] },
    ...pickClosed(window.range),
    // Its last picking task closed that day, not on a later one.
    NOT: pickClosed({ gte: window.range.lt }),
  };
}

const ymd = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * Orders a page at a time, newest first; optionally one state, the ones
 * ready to leave (`status: TO_SHIP`), or the ones picked or shipped on a
 * day (`pickedOn`, `shippedOn`: year-month-day of the company's calendar).
 */
export async function listOutboundOrders(
  actor: InventoryActor,
  options: {
    status?: unknown;
    page?: number;
    pickedOn?: unknown;
    shippedOn?: unknown;
  } = {},
): Promise<OutboundPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const status = isOutboundOrderStatus(options.status) ? options.status : null;
  const toPack = options.status === TO_PACK;
  const toShip = options.status === TO_SHIP;
  const client = forOrganization(actor.organizationId);
  // The warehouse the person works in (WMS-18).
  const facility = await activeFacilityOf(client, actor.userId);
  const window =
    typeof options.pickedOn === "string"
      ? await dayWindow(client, options.pickedOn)
      : null;
  const shippedWindow =
    !window && typeof options.shippedOn === "string"
      ? await dayWindow(client, options.shippedOn)
      : null;
  const where = window
    ? pickedOnWhere(facility.id, window)
    : shippedWindow
      ? shippedOnWhere(facility.id, shippedWindow)
      : toShip
        ? {
            facilityId: facility.id,
            status: { in: await readyStatuses(client) },
          }
        : toPack
          ? {
              facilityId: facility.id,
              status: { in: ["PICKED" as const, "PACKING" as const] },
            }
          : { facilityId: facility.id, ...(status ? { status } : {}) };
  const total = await client.outboundOrder.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / OUTBOUND_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.outboundOrder.findMany({
    where,
    orderBy: { number: "desc" },
    skip: (page - 1) * OUTBOUND_PAGE_SIZE,
    take: OUTBOUND_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      recipient: true,
      reference: true,
      dueOn: true,
      createdAt: true,
      _count: {
        select: {
          lines: true,
          productionWaits: { where: { status: "OPEN" } },
        },
      },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatOutboundNumber(row.number),
      status: row.status,
      statusLabel: OUTBOUND_ORDER_STATUS_LABELS[row.status],
      urgent: row.priority === "URGENT",
      recipient: row.recipient,
      reference: row.reference,
      dueOn: ymd(row.dueOn),
      lines: row._count.lines,
      createdAt: row.createdAt,
      waitsForProduction: row._count.productionWaits > 0,
    })),
    total,
    page,
    pageCount,
    // A day narrows by itself: the state asked along with it is not applied.
    status: window || shippedWindow ? null : status,
    toPack: !window && !shippedWindow && toPack,
    pickedOn: window?.day ?? null,
    toShip: !window && !shippedWindow && toShip,
    shippedOn: shippedWindow?.day ?? null,
  };
}

export type OutboundView = OutboundSummary & {
  address: string | null;
  note: string | null;
  priority: "NORMAL" | "URGENT";
  releasedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  lineItems: {
    id: string;
    productId: string;
    productName: string;
    sku: string;
    quantity: string;
    /** «12 piezas». */
    quantityText: string;
    /** What its reservation still holds, «12 piezas» (released orders). */
    reservedText: string | null;
    /** Asked but not reserved when released with what there was. */
    shortText: string | null;
    /** Already in the staging location (delivered picking), «8 piezas». */
    pickedText: string | null;
    /** What left with its shipment (WMS-16), «8 piezas». */
    shippedText: string | null;
    /**
     * WMS-54: what arrived for it and went straight to it (cross-docking),
     * «8 piezas llegaron con OC-0007»; null when nothing did.
     */
    crossDockText: string | null;
    /**
     * WMS-79 (ADR 0094): the latest wait of the line for production; null
     * when it never waited.
     */
    production: OutboundWaitView | null;
  }[];
  /** The shipment it is in or left with (WMS-16); null when none. */
  shipment: {
    id: string;
    numberText: string;
    status: ShipmentStatus;
    statusLabel: string;
  } | null;
  /** Ready to leave and in no shipment: it can go in a new one. */
  readyToShip: boolean;
  /** Its picking tasks (WMS-14), in order. */
  tasks: {
    id: string;
    numberText: string;
    status: WarehouseTaskStatus;
    statusLabel: string;
    productName: string;
    fromName: string;
    /** «Lote L-01 · caduca 05/03/2027», for a product by lot (WMS-21). */
    lotText: string | null;
    /** «12 piezas». */
    quantityText: string;
    /** What was confirmed as picked, when it was. */
    pickedText: string | null;
    shortReason: string | null;
    /** The line of the order it picks. */
    lineId: string | null;
    /** The serials of the units picked, for a product by serial (WMS-21B). */
    serials: string[];
    /** Their units, to open their traceability (WMS-21B). */
    serialUnits: { id: string; serial: string }[];
    /** Its lot, to open the lot's card. */
    lot: { id: string; code: string } | null;
    /** WMS-54: «Llegó con OC-0007» when an entry sent it straight here. */
    crossDockText: string | null;
  }[];
};

export async function getOutboundOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<OutboundView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const client = forOrganization(actor.organizationId);
  // WMS-20: an order of a warehouse closed to the person does not exist.
  const placed = await client.outboundOrder.findFirst({
    where: { id: String(orderId ?? "") },
    select: { facilityId: true },
  });
  if (
    !placed ||
    !(await isFacilityInScope(client, actor.userId, placed.facilityId))
  ) {
    return null;
  }
  const row = await client.outboundOrder.findFirst({
    where: { id: String(orderId ?? "") },
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      recipient: true,
      reference: true,
      address: true,
      note: true,
      dueOn: true,
      createdAt: true,
      releasedAt: true,
      cancelledAt: true,
      cancelReason: true,
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitCode: true,
          product: { select: { name: true, sku: true } },
        },
      },
    },
  });
  if (!row) return null;
  const reservations =
    row.status === "DRAFT" || row.lines.length === 0
      ? []
      : await client.stockReservation.findMany({
          where: {
            sourceType: SOURCE_TYPE,
            sourceId: { in: row.lines.map((line) => line.id) },
          },
          select: { sourceId: true, quantity: true, remaining: true },
        });
  const reservedOf = new Map<
    string,
    { quantity: Decimal; remaining: Decimal }
  >();
  for (const reservation of reservations) {
    const current = reservedOf.get(reservation.sourceId) ?? {
      quantity: dec(0),
      remaining: dec(0),
    };
    reservedOf.set(reservation.sourceId, {
      quantity: current.quantity.plus(reservation.quantity.toString()),
      remaining: current.remaining.plus(reservation.remaining.toString()),
    });
  }
  const released = row.status !== "DRAFT" && row.status !== "CANCELLED";
  const tasks =
    row.status === "DRAFT" || row.lines.length === 0
      ? []
      : await client.warehouseTask.findMany({
          where: {
            kind: "PICK",
            outboundLineId: { in: row.lines.map((line) => line.id) },
          },
          orderBy: { number: "asc" },
          select: {
            id: true,
            number: true,
            status: true,
            quantity: true,
            unitCode: true,
            pickedQuantity: true,
            shortReason: true,
            outboundLineId: true,
            product: { select: { name: true } },
            fromLocation: { select: { name: true } },
            lot: { select: { id: true, code: true, expiresOn: true } },
            crossDockMovement: { select: { reference: true } },
            serials: {
              orderBy: { id: "asc" },
              take: 1_000,
              select: { serialUnit: { select: { id: true, serial: true } } },
            },
          },
        });
  // WMS-16: its shipment (a draft, or the one it left in) and what left.
  const [inShipment, shippedLines, ready] = await Promise.all([
    client.shipmentOrder.findFirst({
      where: { orderId: row.id, openOrderId: { not: null } },
      select: {
        shipment: { select: { id: true, number: true, status: true } },
      },
    }),
    row.status === "SHIPPED"
      ? client.shipmentLine.groupBy({
          by: ["orderLineId"],
          where: { orderId: row.id },
          orderBy: { orderLineId: "asc" },
          _sum: { quantity: true },
        })
      : Promise.resolve([]),
    readyStatuses(client),
  ]);
  const shippedOf = new Map(
    shippedLines.map((line) => [
      line.orderLineId,
      dec((line._sum.quantity ?? 0).toString()),
    ]),
  );
  // WMS-54: what entries sent straight to each line, and with which ones.
  const arrivedOf = new Map<string, { quantity: Decimal; refs: Set<string> }>();
  for (const task of tasks) {
    if (!task.crossDockMovement || !task.outboundLineId) continue;
    if (task.status === "CANCELLED") continue;
    const entry = arrivedOf.get(task.outboundLineId) ?? {
      quantity: dec(0),
      refs: new Set<string>(),
    };
    entry.quantity = entry.quantity.plus(
      (task.pickedQuantity ?? task.quantity ?? 0).toString(),
    );
    entry.refs.add(arrivedWith(task.crossDockMovement.reference));
    arrivedOf.set(task.outboundLineId, entry);
  }
  // WMS-79: the latest wait of each line (most recent first).
  const waitOf = new Map<string, OutboundWaitView>();
  for (const wait of await waitsOfOrder(client, row.id)) {
    if (!waitOf.has(wait.lineId)) waitOf.set(wait.lineId, wait);
  }
  const pickedOf = new Map<string, Decimal>();
  for (const task of tasks) {
    if (task.status !== "DELIVERED" || !task.outboundLineId) continue;
    pickedOf.set(
      task.outboundLineId,
      (pickedOf.get(task.outboundLineId) ?? dec(0)).plus(
        task.pickedQuantity?.toString() ?? 0,
      ),
    );
  }
  return {
    id: row.id,
    numberText: formatOutboundNumber(row.number),
    status: row.status,
    statusLabel: OUTBOUND_ORDER_STATUS_LABELS[row.status],
    urgent: row.priority === "URGENT",
    priority: row.priority,
    recipient: row.recipient,
    reference: row.reference,
    address: row.address,
    waitsForProduction: [...waitOf.values()].some(
      (wait) => wait.status === "OPEN",
    ),
    note: row.note,
    dueOn: ymd(row.dueOn),
    lines: row.lines.length,
    createdAt: row.createdAt,
    releasedAt: row.releasedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    lineItems: row.lines.map((line) => {
      const asked = dec(line.quantity.toString());
      const held = reservedOf.get(line.id);
      // What it still lacks (WMS-54: what a waiting order waits for): asked
      // minus what its reservations hold today — in its origin while being
      // picked, in staging once picked — or minus what left with it.
      const short = !released
        ? dec(0)
        : asked.minus(
            row.status === "SHIPPED"
              ? (shippedOf.get(line.id) ?? 0)
              : (held?.remaining ?? 0),
          );
      return {
        id: line.id,
        productId: line.productId,
        productName: line.product.name,
        sku: line.product.sku,
        quantity: asked.toString(),
        quantityText: formatStock(asked.toString(), line.unitCode),
        reservedText: released
          ? formatStock((held?.remaining ?? dec(0)).toString(), line.unitCode)
          : null,
        shortText: short.greaterThan(0)
          ? formatStock(short.toString(), line.unitCode)
          : null,
        pickedText: pickedOf.has(line.id)
          ? formatStock(pickedOf.get(line.id)!.toString(), line.unitCode)
          : null,
        shippedText:
          row.status === "SHIPPED"
            ? formatStock(
                (shippedOf.get(line.id) ?? dec(0)).toString(),
                line.unitCode,
              )
            : null,
        crossDockText: arrivedOf.has(line.id)
          ? `${formatStock(arrivedOf.get(line.id)!.quantity.toString(), line.unitCode)} ${arrivedOf.get(line.id)!.quantity.equals(1) ? "llegó" : "llegaron"} ${[...arrivedOf.get(line.id)!.refs].join(" y ")}`
          : null,
        production: waitOf.get(line.id) ?? null,
      };
    }),
    shipment: inShipment
      ? {
          id: inShipment.shipment.id,
          numberText: formatShipmentNumber(inShipment.shipment.number),
          status: inShipment.shipment.status,
          statusLabel: SHIPMENT_STATUS_LABELS[inShipment.shipment.status],
        }
      : null,
    readyToShip: !inShipment && ready.includes(row.status),
    tasks: tasks.map((task) => ({
      id: task.id,
      numberText: formatTaskNumber(task.number),
      status: task.status,
      statusLabel: WAREHOUSE_TASK_STATUS_LABELS[task.status],
      // Picking tasks always move a product (WMS-14).
      productName: task.product!.name,
      fromName: task.fromLocation.name,
      lotText: task.lot
        ? lotLabel({
            code: task.lot.code,
            expiresOn: lotDayOf(task.lot.expiresOn),
          })
        : null,
      quantityText: formatStock(task.quantity!.toString(), task.unitCode!),
      pickedText:
        task.pickedQuantity === null
          ? null
          : formatStock(task.pickedQuantity.toString(), task.unitCode!),
      shortReason: task.shortReason,
      lineId: task.outboundLineId,
      serials: task.serials.map((row) => row.serialUnit.serial),
      serialUnits: task.serials.map((row) => row.serialUnit),
      lot: task.lot ? { id: task.lot.id, code: task.lot.code } : null,
      crossDockText: task.crossDockMovement
        ? `Llegó ${arrivedWith(task.crossDockMovement.reference)}`
        : null,
    })),
  };
}

/** «con OC-0007», or «con una entrada» when it has no reference. */
const arrivedWith = (reference: string | null) =>
  reference ? `con ${reference}` : "con una entrada";

// ── Draft with its lines in one step (WMS-60) ───────────────────────────

/**
 * The stored lines are exactly the ones sent, as a multiset: each stored
 * line matches one sent line and none is used twice ([A:2, B:3] is not
 * [A:2, A:2]).
 */
function sameLines(
  stored: readonly { productId: string; quantity: string }[],
  sent: readonly { productId: string | null; quantity: unknown }[],
): boolean {
  if (stored.length !== sent.length) return false;
  const left = [...stored];
  for (const line of sent) {
    const at = left.findIndex(
      (row) =>
        row.productId === line.productId &&
        sameQuantity(row.quantity, line.quantity),
    );
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return left.length === 0;
}

/** The stored quantity equals what was sent (an exact decimal text). */
function sameQuantity(stored: string, sent: unknown): boolean {
  const text = String(sent ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return false;
  return dec(stored).equals(text);
}

/** Idempotency key of an order created by the API (ADR 0058). */
const API_REQUEST_KEY = /^[0-9a-f]{64}$/;

export type OutboundDraftLineInput = {
  /** Id or code (SKU) of the product. */
  product: string;
  /** In the product's unit, as text: «12», «2.5». */
  quantity: string;
};

export type OutboundDraftResult =
  | { ok: true; orderId: string; repeated: boolean }
  | {
      ok: false;
      reason: "invalid" | "key_reused";
      fieldErrors?: Partial<Record<OutboundField, string>>;
      /** By position of the line sent. */
      lineErrors?: Record<number, string>;
      formError?: string;
    };

/**
 * Creates a draft order with all its lines in one transaction (WMS-60):
 * what the API sends at once. Same rules as the screen (header, active
 * product, quantity by the product's rule, one line per product, at most
 * OUTBOUND_MAX_LINES), in the warehouse the person (or key) works in.
 * `apiRequestKey` (its own unique column, apart from the `sourceKey` of
 * imports) makes it idempotent: the same key with the same content —
 * every field of the header and every line — gives back the same order
 * (`repeated`); with any other content, `key_reused`.
 */
export async function createOutboundDraft(
  actor: InventoryActor,
  input: OutboundHeaderInput & {
    lines: readonly OutboundDraftLineInput[];
    apiRequestKey: string;
  },
): Promise<OutboundDraftResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  if (!API_REQUEST_KEY.test(String(input.apiRequestKey))) {
    throw new Error("createOutboundDraft needs an API request key");
  }
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length === 0 || lines.length > OUTBOUND_MAX_LINES) {
    return {
      ok: false,
      reason: "invalid",
      formError: `Un pedido lleva de 1 a ${OUTBOUND_MAX_LINES} productos.`,
    };
  }
  const { data } = header;
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  const wanted = lines.map((line) =>
    String(line.product ?? "")
      .trim()
      .slice(0, 64),
  );
  // Products by id or by code, read before the locks to know what to lock.
  const found = await client.product.findMany({
    where: { OR: [{ id: { in: wanted } }, { sku: { in: wanted } }] },
    select: { id: true, sku: true },
  });
  const idOf = (value: string) =>
    found.find((each) => each.id === value)?.id ??
    found.find((each) => each.sku.toLowerCase() === value.toLowerCase())?.id ??
    null;

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const existing = await tx.outboundOrder.findFirst({
          where: { apiRequestKey: input.apiRequestKey },
          select: {
            id: true,
            recipient: true,
            address: true,
            reference: true,
            note: true,
            dueOn: true,
            priority: true,
            lines: { select: { productId: true, quantity: true } },
          },
        });
        const ids = wanted.map(idOf);
        if (existing) {
          const same =
            existing.recipient === data.recipient &&
            existing.address === data.address &&
            existing.reference === data.reference &&
            existing.note === data.note &&
            (existing.dueOn?.toISOString().slice(0, 10) ?? null) ===
              data.dueOn &&
            existing.priority === data.priority &&
            sameLines(
              existing.lines.map((row) => ({
                productId: row.productId,
                quantity: row.quantity.toString(),
              })),
              lines.map((line, index) => ({
                productId: ids[index] ?? null,
                quantity: line.quantity,
              })),
            );
          return same
            ? { ok: true as const, orderId: existing.id, repeated: true }
            : {
                ok: false as const,
                reason: "key_reused" as const,
                formError:
                  "Esta clave de idempotencia ya se usó para otro pedido.",
              };
        }
        await lockRows(
          tx,
          "product",
          ids.filter((id): id is string => id !== null),
        );
        // WMS-82 (ADR 0077): its warehouse, shared, after the products.
        if (!(await holdOpenFacility(tx, facility.id))) {
          return {
            ok: false as const,
            reason: "invalid" as const,
            formError: ARCHIVED_FACILITY_MESSAGE,
          };
        }
        const products = await tx.product.findMany({
          where: { id: { in: ids.filter((id): id is string => id !== null) } },
          select: {
            id: true,
            status: true,
            unitCode: true,
            quantityStep: true,
          },
        });
        const lineErrors: Record<number, string> = {};
        const rows: {
          productId: string;
          quantity: string;
          unitCode: string;
        }[] = [];
        const seen = new Set<string>();
        lines.forEach((line, index) => {
          const product = products.find((each) => each.id === ids[index]);
          if (!product) {
            lineErrors[index] = "Este producto no existe.";
            return;
          }
          if (product.status !== "ACTIVE") {
            lineErrors[index] = "Este producto está archivado.";
            return;
          }
          if (seen.has(product.id)) {
            lineErrors[index] = "Este producto ya está en otra línea.";
            return;
          }
          seen.add(product.id);
          const quantity = parseQuantity(
            {
              unitCode: product.unitCode,
              quantityStep: product.quantityStep.toString(),
            },
            String(line.quantity ?? ""),
          );
          if (!quantity.ok) {
            lineErrors[index] = quantity.error;
            return;
          }
          rows.push({
            productId: product.id,
            quantity: quantity.quantity.toString(),
            unitCode: product.unitCode,
          });
        });
        if (Object.keys(lineErrors).length > 0) {
          return { ok: false as const, reason: "invalid" as const, lineErrors };
        }
        const last = await tx.outboundOrder.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const orderId = newId();
        await tx.outboundOrder.create({
          data: {
            id: orderId,
            organizationId,
            facilityId: facility.id,
            number: (last?.number ?? 0) + 1,
            recipient: data.recipient,
            address: data.address,
            reference: data.reference,
            note: data.note,
            dueOn: dayOf(data.dueOn),
            priority: data.priority,
            createdByUserId: userId,
            apiRequestKey: input.apiRequestKey,
          },
        });
        await tx.outboundOrderLine.createMany({
          data: rows.map((row, index) => ({
            id: newId(),
            organizationId,
            orderId,
            lineNumber: index + 1,
            ...row,
          })),
        });
        return { ok: true as const, orderId, repeated: false };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      // Same number taken at once, or the same key sent twice at once:
      // again (the second time the key is found and compared).
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}
