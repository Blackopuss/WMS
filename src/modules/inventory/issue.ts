import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import { lockRows, type TenantDb } from "@/server";

import {
  formatStock,
  postTaskTransfer,
  type InventoryActor,
} from "./movements";
import type { PickSource } from "./picking";
import { checkPlacement } from "./placement";
import { PRODUCTION_ORDER_LINE_SOURCE } from "./reservation-sources";
import { consumeReservation, reserveStock } from "./reservations";
import { formatTaskNumber } from "./task-states";

/**
 * «Surtir a producción» (WMS-28, ADR 0073). Releasing a production order
 * sets each material aside where it will be taken from (reservations with
 * source `production_order_line` + the line). With the company's
 * `production.materials.mode = issue`, each origin outside the order's area
 * also gets an ISSUE task to the area; delivering it moves what it carries
 * and keeps it reserved for the same line in the area, like a picking task
 * keeps what it picked for its order in the staging location.
 *
 * Producción creates these tasks when it releases an order; Inventario
 * runs them (take, pick up, deliver, cancel) with the services of tasks.ts.
 * Everything here runs inside the caller's transaction, with the lock order
 * of documents: products → locations → production order → task.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const minOf = (a: Decimal, b: Decimal) => (a.lessThan(b) ? a : b);

/**
 * Sets a material line aside in each of its sources and, for the sources
 * outside the area, creates its ISSUE task to the area (`withTasks`).
 * Inside the release of the order (already RELEASED in this transaction,
 * the products locked). Returns the next task number.
 */
export async function setAsideForProduction(
  tx: Tx,
  actor: InventoryActor,
  input: {
    order: { priority: "NORMAL" | "URGENT" };
    line: { id: string; productId: string; unitCode: string };
    sources: readonly PickSource[];
    areaId: string;
    /** The area and every location inside it: there no task is needed. */
    inArea: ReadonlySet<string>;
    withTasks: boolean;
    nextNumber: number;
  },
): Promise<{ nextNumber: number; tasks: number }> {
  let number = input.nextNumber;
  let tasks = 0;
  for (const source of input.sources) {
    const reserved = await reserveStock(tx, actor, {
      productId: input.line.productId,
      locationId: source.locationId,
      lotId: source.lotId,
      quantity: source.quantity,
      source: { type: PRODUCTION_ORDER_LINE_SOURCE, id: input.line.id },
    });
    if (!reserved.ok) {
      throw new Error(`Free stock of ${input.line.productId} moved under lock`);
    }
    if (!input.withTasks || input.inArea.has(source.locationId)) continue;
    await tx.warehouseTask.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        number: number++,
        kind: "ISSUE",
        priority: input.order.priority,
        productionOrderLineId: input.line.id,
        productId: input.line.productId,
        fromLocationId: source.locationId,
        toLocationId: input.areaId,
        lotId: source.lotId,
        quantity: source.quantity.toString(),
        unitCode: input.line.unitCode,
        createdByUserId: actor.userId,
      },
    });
    tasks += 1;
  }
  return { nextNumber: number, tasks };
}

/**
 * Before releasing with tasks: whether the area admits what they will bring
 * (its restrictions of products or categories, WMS-22B), asked once with
 * every arrival, in `report` mode (a capacity is said at delivery, never
 * stops it). The message of the first refusal, or null.
 */
export async function issuePlacementProblem(
  tx: Tx,
  input: {
    areaId: string;
    inArea: ReadonlySet<string>;
    lines: readonly { productId: string; sources: readonly PickSource[] }[];
  },
): Promise<string | null> {
  const arrivals = input.lines.flatMap((line) =>
    line.sources
      .filter((source) => !input.inArea.has(source.locationId))
      .map((source) => ({
        productId: line.productId,
        quantity: source.quantity,
        toLocationId: input.areaId,
        fromLocationId: source.locationId,
        status: "AVAILABLE" as const,
      })),
  );
  const result = await checkPlacement(tx, arrivals, { mode: "report" });
  return result.ok ? null : result.message;
}

/** The reservation an ISSUE task carries: its line in its origin and lot. */
async function reservationOf(
  tx: Tx,
  task: {
    productionOrderLineId: string;
    fromLocationId: string;
    lotId: string | null;
  },
) {
  return tx.stockReservation.findFirst({
    where: {
      sourceType: PRODUCTION_ORDER_LINE_SOURCE,
      sourceId: task.productionOrderLineId,
      state: "ACTIVE",
      locationId: task.fromLocationId,
      lotId: task.lotId,
    },
    orderBy: { id: "asc" },
    select: { id: true, remaining: true },
  });
}

/**
 * Lets go of what an ISSUE task held in its origin (the task was cancelled,
 * or its order): at most the task's quantity, from its line's reservation
 * there. The caller locked the production order first.
 */
export async function releaseIssueReservation(
  tx: Tx,
  task: {
    productionOrderLineId: string;
    fromLocationId: string;
    lotId: string | null;
    quantity: Decimal;
  },
): Promise<void> {
  const reservation = await reservationOf(tx, task);
  if (!reservation) return;
  const give = minOf(dec(reservation.remaining.toString()), task.quantity);
  if (give.greaterThan(0)) await consumeReservation(tx, reservation.id, give);
}

/** Locks the production order of an ISSUE task (read before; it never changes). */
export async function lockIssueOrder(tx: Tx, orderId: string | null) {
  if (orderId) await lockRows(tx, "productionOrder", [orderId]);
}

/**
 * Delivers an ISSUE task: what it carries leaves the line's reservation in
 * the origin, moves to the area (TRANSFER, key `task:<id>`) and is
 * reserved there for the same line. The caller locked product → locations
 * → production order → task; the order must still be released or in
 * progress (a cancelled order cancelled its tasks first).
 */
export async function deliverIssue(
  tx: Tx,
  actor: InventoryActor,
  task: {
    id: string;
    number: number;
    productionOrderLineId: string;
    productId: string;
    fromLocationId: string;
    toLocationId: string;
    lotId: string | null;
    quantity: Decimal;
    unitCode: string;
    serials?: string[];
  },
): Promise<
  | { ok: true; movementId: string; notes: string[] }
  | { ok: false; error: string }
> {
  const line = await tx.productionOrderLine.findFirst({
    where: { id: task.productionOrderLineId },
    select: { order: { select: { status: true } } },
  });
  if (!line || !["RELEASED", "IN_PROGRESS"].includes(line.order.status)) {
    return { ok: false, error: "La orden de producción ya no está abierta." };
  }
  const reservation = await reservationOf(tx, task);
  if (
    !reservation ||
    dec(reservation.remaining.toString()).lessThan(task.quantity)
  ) {
    return {
      ok: false,
      error:
        "Lo apartado para la orden de producción ya no está completo en esa ubicación.",
    };
  }
  // First let go of the reservation in the origin, so the move may take it.
  await consumeReservation(tx, reservation.id, task.quantity);
  const moved = await postTaskTransfer(tx, actor, {
    productId: task.productId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    quantity: task.quantity.toString(),
    lotId: task.lotId,
    serials: task.serials,
    taskId: task.id,
    idempotencyKey: `task:${task.id}`,
    reference: formatTaskNumber(task.number),
  });
  if (!moved.ok) {
    return {
      ok: false,
      error:
        moved.formError ??
        Object.values(moved.fieldErrors ?? {})[0] ??
        "No se pudo mover el material.",
    };
  }
  const kept = await reserveStock(tx, actor, {
    productId: task.productId,
    locationId: task.toLocationId,
    lotId: task.lotId,
    quantity: task.quantity,
    source: {
      type: PRODUCTION_ORDER_LINE_SOURCE,
      id: task.productionOrderLineId,
    },
  });
  if (!kept.ok) throw new Error(`Issued stock of task ${task.id} not free`);
  return { ok: true, movementId: moved.movementId, notes: moved.notes ?? [] };
}

/** «12 piezas», for messages about an issued quantity. */
export const issuedText = (quantity: Decimal, unitCode: string) =>
  formatStock(quantity.toString(), unitCode);
