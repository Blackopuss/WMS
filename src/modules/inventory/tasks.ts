import "server-only";

import { z } from "zod";

import { dec, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed, type Permission } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  type LocationWithParents,
  type LocationScopeReader,
  activeFacilityOf,
  assertLocationsInScope,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { dayWindow, type DayWindow } from "./calendar-day";
import { foldName, foldPath } from "./import-validation";
import {
  formatStock,
  postTaskTransfer,
  type InventoryActor,
} from "./movements";
import {
  deliverPick,
  lockPickOrder,
  releasePickReservation,
  settlePickedOrder,
  startPicking,
} from "./picking";
import {
  OPEN_TASK_STATUSES,
  WAREHOUSE_TASK_STATUS_LABELS,
  formatTaskNumber,
  taskTransitionProblem,
  type WarehouseTaskStatus,
} from "./task-states";
import { formatOutboundNumber } from "./outbound-states";
import { AVAILABLE_STOCK } from "./stock-status";
import { freeToMoveFrom, reservedMessage } from "./reservations";

/**
 * Warehouse tasks (WMS-06, especificación WMS v5 5.3): a supervisor asks
 * for a move («12 cajas de A-01 a B-03, urgente»), a person takes it,
 * picks the load up and delivers it. Nothing moves until the delivery,
 * which writes the TRANSFER movement in the same transaction (key
 * `task:<id>`). Every step locks the task, so two people never take the
 * same one and a task is never delivered twice; a step that was already
 * done by the same person answers `repeated` (a retry). Lock order of the
 * delivery: product → locations → task, as every movement.
 */

export const TASK_PAGE_SIZE = 25;
const NOTE_MAX = 300;

export type TaskPriority = "NORMAL" | "URGENT";

export type TaskResult =
  | { ok: true; taskId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors?: Partial<Record<TaskField, string>>;
      formError?: string;
    };

export type TaskField =
  | "productId"
  | "fromLocationId"
  | "toLocationId"
  | "quantity"
  | "priority"
  | "assignToUserId"
  | "note"
  | "reason"
  | "productCode"
  | "locationCode"
  | "shortReason";

type Failure = Extract<TaskResult, { ok: false }>;

class TaskRejected extends Error {
  constructor(readonly result: Failure) {
    super("task rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: TaskField,
): never => {
  throw new TaskRejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

type Tx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];

async function inTask(
  organizationId: string,
  work: (tx: Tx) => Promise<TaskResult>,
): Promise<TaskResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      work,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof TaskRejected) return error.result;
    throw error;
  }
}

/**
 * WMS-20: a task is of the person's concern only when where it leaves from
 * and where it goes are both inside their warehouses or zones. For a
 * `where` on `warehouseTask`; `{}` without a limit.
 */
async function taskScope(client: LocationScopeReader, userId: string) {
  const scoped = await locationScopeWhere(client, userId);
  return isLimited(scoped) ? { fromLocation: scoped, toLocation: scoped } : {};
}

/**
 * The task under its lock, or a refusal. A task outside the scope of who
 * asks does not exist for them (WMS-20).
 */
async function lockTask(tx: Tx, taskId: string, userId: string) {
  const [id] = await lockRows(tx, "warehouseTask", [String(taskId ?? "")]);
  const task = id
    ? await tx.warehouseTask.findFirst({
        where: { id },
        select: {
          id: true,
          number: true,
          status: true,
          assignedToUserId: true,
          productId: true,
          fromLocationId: true,
          toLocationId: true,
          quantity: true,
          unitCode: true,
          movementId: true,
          kind: true,
          outboundLineId: true,
          pickedQuantity: true,
          outboundLine: { select: { orderId: true } },
          product: {
            select: {
              name: true,
              sku: true,
              barcode: true,
              unitCode: true,
              quantityStep: true,
            },
          },
          fromLocation: {
            select: {
              name: true,
              code: true,
              parent: LOCATION_PARENTS,
            },
          },
          toLocation: { select: { name: true } },
        },
      })
    : null;
  if (!task) return stop("not_found", "Esta tarea no existe.");
  const outside = await locationsOutOfScope(tx, userId, [
    task.fromLocationId,
    task.toLocationId,
  ]);
  if (outside.length > 0) return stop("not_found", "Esta tarea no existe.");
  return task;
}

/**
 * The order of a picking task, read before its transaction (it never
 * changes), so the order is locked before the task: products → locations
 * → order → task, like every document.
 */
async function pickOrderOf(
  organizationId: string,
  taskId: string,
): Promise<string | null> {
  const row = await forOrganization(organizationId).warehouseTask.findFirst({
    where: { id: String(taskId ?? "") },
    select: { outboundLine: { select: { orderId: true } } },
  });
  return row?.outboundLine?.orderId ?? null;
}

type LockedTask = Awaited<ReturnType<typeof lockTask>>;

const describe = (task: LockedTask) =>
  `${formatTaskNumber(task.number)}: ${formatStock(task.quantity.toString(), task.unitCode)} de ${task.product.name} de ${task.fromLocation.name} a ${task.toLocation.name}`;

function ensure(task: LockedTask, to: WarehouseTaskStatus): void {
  const problem = taskTransitionProblem(task.status, to);
  if (problem) stop("not_allowed", problem);
}

/**
 * Can this person of the company be given a task? Read before the
 * transaction (it opens its own connection): the stock does not depend on
 * it, and the person checks it again on every step.
 */
const mayExecute = (organizationId: string, userId: string) =>
  isAllowed(organizationId, userId, "inventory.task.execute");

const ASSIGNEE_OUT_OF_SCOPE =
  "Esa persona no trabaja en el almacén o la zona de esta tarea. Elige a otra o déjala disponible.";

const reasonSchema = z
  .string()
  .trim()
  .min(3, "Escribe qué pasó.")
  .max(NOTE_MAX, `Usa como máximo ${NOTE_MAX} caracteres.`);

// ── Creating ─────────────────────────────────────────────────────────────

const createSchema = z.object({
  productId: z.string().trim().min(1, "Elige un producto.").max(36),
  fromLocationId: z.string().trim().min(1, "Elige de dónde sale.").max(36),
  toLocationId: z.string().trim().min(1, "Elige a dónde va.").max(36),
  quantity: z.string().trim().min(1, "Escribe la cantidad que se mueve."),
  priority: z
    .string()
    .optional()
    .transform((value): TaskPriority =>
      value === "URGENT" ? "URGENT" : "NORMAL",
    ),
  assignToUserId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  note: z
    .string()
    .trim()
    .max(NOTE_MAX, `Usa como máximo ${NOTE_MAX} caracteres.`)
    .optional()
    .transform((value) => value || null),
});

export type CreateTaskInput = z.input<typeof createSchema>;

/**
 * A new transfer task (WMS-06). The stock is checked now so nobody is sent
 * for what is not there, and again at the delivery (it may have moved).
 */
export async function createTask(
  actor: InventoryActor,
  input: CreateTaskInput,
): Promise<TaskResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "inventory.task.create");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<TaskField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as TaskField;
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, reason: "invalid", fieldErrors };
  }
  const data = parsed.data;
  if (data.fromLocationId === data.toLocationId) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        toLocationId: "Elige una ubicación distinta a la de origen.",
      },
    };
  }

  const assigneeOk =
    !data.assignToUserId ||
    (await mayExecute(organizationId, data.assignToUserId));
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTask(organizationId, async (tx) => {
        const [productId] = await lockRows(tx, "product", [data.productId]);
        await lockRows(tx, "location", [
          data.fromLocationId,
          data.toLocationId,
        ]);
        // WMS-20: both ends inside the scope of who asks for the task.
        await assertLocationsInScope(tx, userId, [
          data.fromLocationId,
          data.toLocationId,
        ]);
        const product = productId
          ? await tx.product.findFirst({
              where: { id: productId },
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
          return stop("not_found", "Este producto ya no existe.", "productId");
        }
        if (product.status !== "ACTIVE") {
          return stop(
            "not_allowed",
            "Este producto está archivado. Reactívalo para moverlo.",
            "productId",
          );
        }
        const quantity = parseQuantity(
          {
            unitCode: product.unitCode,
            quantityStep: product.quantityStep.toString(),
          },
          data.quantity,
        );
        if (!quantity.ok) return stop("invalid", quantity.error, "quantity");

        const places = await tx.location.findMany({
          where: { id: { in: [data.fromLocationId, data.toLocationId] } },
          select: { id: true, name: true, archivedAt: true, facilityId: true },
        });
        const from = places.find((p) => p.id === data.fromLocationId);
        const to = places.find((p) => p.id === data.toLocationId);
        if (!from) {
          return stop(
            "not_found",
            "Esa ubicación ya no existe.",
            "fromLocationId",
          );
        }
        if (!to) {
          return stop(
            "not_found",
            "Esa ubicación ya no existe.",
            "toLocationId",
          );
        }
        if (to.archivedAt) {
          return stop(
            "not_allowed",
            `«${to.name}» está archivada. Elige otra ubicación.`,
            "toLocationId",
          );
        }
        // WMS-18: a task moves inside one warehouse.
        if (from.facilityId !== to.facilityId) {
          return stop(
            "not_allowed",
            "Esa ubicación es de otro almacén: entre almacenes se hace un traslado.",
            "toLocationId",
          );
        }
        const balance = await tx.stockBalance.findFirst({
          where: {
            productId: product.id,
            locationId: from.id,
            ...AVAILABLE_STOCK,
          },
          select: { quantity: true },
        });
        const there = dec(balance?.quantity.toString() ?? 0);
        if (there.lessThan(quantity.quantity)) {
          return stop(
            "invalid",
            there.isZero()
              ? `No hay existencias de ${product.name} en ${from.name}.`
              : `Solo hay ${formatStock(there.toString(), product.unitCode)} en ${from.name}.`,
            "quantity",
          );
        }
        // WMS-12: what is reserved in that location stays there.
        const freeHere = await freeToMoveFrom(tx, product.id, from.id);
        if (freeHere.lessThan(quantity.quantity)) {
          return stop(
            "invalid",
            reservedMessage(freeHere, product.unitCode, "mover"),
            "quantity",
          );
        }
        if (!assigneeOk) {
          return stop(
            "invalid",
            "Esa persona no puede hacer tareas de traslado. Elige a otra o déjala disponible.",
            "assignToUserId",
          );
        }
        if (
          data.assignToUserId &&
          (await locationsOutOfScope(tx, data.assignToUserId, [from.id, to.id]))
            .length > 0
        ) {
          return stop("invalid", ASSIGNEE_OUT_OF_SCOPE, "assignToUserId");
        }
        const last = await tx.warehouseTask.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = newId();
        const number = (last?.number ?? 0) + 1;
        await tx.warehouseTask.create({
          data: {
            id,
            organizationId,
            number,
            status: data.assignToUserId ? "ASSIGNED" : "PENDING",
            priority: data.priority,
            productId: product.id,
            fromLocationId: from.id,
            toLocationId: to.id,
            quantity: quantity.quantity.toString(),
            unitCode: product.unitCode,
            note: data.note,
            createdByUserId: userId,
            assignedToUserId: data.assignToUserId,
          },
        });
        return {
          ok: true,
          taskId: id,
          summary: `Se creó la tarea ${formatTaskNumber(number)}: ${formatStock(quantity.quantity.toString(), product.unitCode)} de ${product.name} de ${from.name} a ${to.name}.`,
        };
      });
    } catch (error) {
      // Two tasks created at once take the same number: try again.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

// ── Steps of the person who does it ──────────────────────────────────────

async function step(
  actor: InventoryActor,
  taskId: string,
  permission: Permission,
  work: (tx: Tx, task: LockedTask) => Promise<TaskResult>,
): Promise<TaskResult> {
  await assertModulePermission(actor.organizationId, actor.userId, permission);
  const orderId = await pickOrderOf(actor.organizationId, taskId);
  return inTask(actor.organizationId, async (tx) => {
    await lockPickOrder(tx, orderId);
    return work(tx, await lockTask(tx, taskId, actor.userId));
  });
}

/** Takes an available task, or the one given to this person. */
export function acceptTask(
  actor: InventoryActor,
  taskId: string,
): Promise<TaskResult> {
  return step(actor, taskId, "inventory.task.execute", async (tx, task) => {
    const mine = task.assignedToUserId === actor.userId;
    if (task.status === "ACCEPTED" && mine) {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: `Ya tenías la tarea ${formatTaskNumber(task.number)}.`,
      };
    }
    if (task.status === "ASSIGNED" && !mine) {
      return stop("not_allowed", "Esta tarea está asignada a otra persona.");
    }
    ensure(task, "ACCEPTED");
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: "ACCEPTED",
        assignedToUserId: actor.userId,
        acceptedAt: new Date(),
      },
    });
    if (task.outboundLine) await startPicking(tx, task.outboundLine.orderId);
    return {
      ok: true,
      taskId: task.id,
      summary: `Tomaste la tarea ${describe(task)}. Ve a ${task.fromLocation.name}.`,
    };
  });
}

/** The load is in hand. */
export function pickUpTask(
  actor: InventoryActor,
  taskId: string,
): Promise<TaskResult> {
  return step(actor, taskId, "inventory.task.execute", async (tx, task) => {
    if (task.assignedToUserId !== actor.userId) {
      return stop("not_allowed", "Esta tarea la tiene otra persona.");
    }
    if (task.status === "PICKED_UP") {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: "Ya habías confirmado que recogiste la carga.",
      };
    }
    if (task.kind === "PICK") {
      return stop(
        "not_allowed",
        "Confirma el producto, la ubicación y cuánto surtiste.",
      );
    }
    ensure(task, "PICKED_UP");
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: { status: "PICKED_UP", pickedUpAt: new Date() },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Recogiste la carga. Llévala a ${task.toLocation.name}.`,
    };
  });
}

export type ConfirmPickInput = {
  /** Scanned or typed: the product's key or barcode. */
  productCode: string;
  /** Scanned or typed: the code, name or path of the origin location. */
  locationCode: string;
  /** What was taken, in the product's unit. */
  quantity: string;
  /** Why less than asked; required then. */
  shortReason?: string;
};

/**
 * Picking (WMS-14): the person confirms, at the origin, which product and
 * location they are at and how much they took. A wrong product or
 * location is refused; less than asked needs a reason, and what was not
 * taken is released at the delivery.
 */
export function confirmPick(
  actor: InventoryActor,
  taskId: string,
  input: ConfirmPickInput,
): Promise<TaskResult> {
  return step(actor, taskId, "inventory.task.execute", async (tx, task) => {
    if (task.kind !== "PICK") {
      return stop("not_allowed", "Esta tarea no es de surtido.");
    }
    if (task.assignedToUserId !== actor.userId) {
      return stop("not_allowed", "Esta tarea la tiene otra persona.");
    }
    const parsed = parseQuantity(
      {
        unitCode: task.product.unitCode,
        quantityStep: task.product.quantityStep.toString(),
      },
      String(input.quantity ?? ""),
    );
    if (task.status === "PICKED_UP") {
      const same =
        parsed.ok &&
        task.pickedQuantity !== null &&
        parsed.quantity.equals(task.pickedQuantity.toString());
      if (same) {
        return {
          ok: true,
          taskId: task.id,
          repeated: true,
          summary: "Ya habías confirmado lo que surtiste.",
        };
      }
    }
    ensure(task, "PICKED_UP");
    const code = foldName(String(input.productCode ?? "").slice(0, 80));
    if (code === "") {
      return stop(
        "invalid",
        `Escanea el producto o escribe su clave (${task.product.sku}).`,
        "productCode",
      );
    }
    if (
      code !== foldName(task.product.sku) &&
      code !== foldName(task.product.barcode ?? "")
    ) {
      return stop(
        "invalid",
        `Ese no es el producto de la tarea: busca ${task.product.name} (${task.product.sku}).`,
        "productCode",
      );
    }
    // Its code (WMS-22A) is what is scanned; without one, its name or path.
    const typed = String(input.locationCode ?? "").slice(0, 200);
    const place = foldPath(typed);
    const from = task.fromLocation;
    const path = locationPath(from);
    const byCode =
      from.code !== null && typed.trim().toUpperCase() === from.code;
    if (!byCode && place === "") {
      return stop(
        "invalid",
        from.code
          ? `Escanea la etiqueta del lugar o escribe su código (${from.code}).`
          : `Escribe dónde estás (${from.name}).`,
        "locationCode",
      );
    }
    if (!byCode && place !== foldPath(from.name) && place !== foldPath(path)) {
      return stop(
        "invalid",
        from.code
          ? `No es la ubicación de la tarea: ve a ${path} (código ${from.code}).`
          : `No es la ubicación de la tarea: ve a ${path}.`,
        "locationCode",
      );
    }
    if (!parsed.ok) return stop("invalid", parsed.error, "quantity");
    const asked = dec(task.quantity.toString());
    if (parsed.quantity.greaterThan(asked)) {
      return stop(
        "invalid",
        `La tarea pide ${formatStock(asked.toString(), task.unitCode)}: no surtas de más.`,
        "quantity",
      );
    }
    const short = parsed.quantity.lessThan(asked);
    let reason: string | null = null;
    if (short) {
      const why = reasonSchema.safeParse(input.shortReason ?? "");
      if (!why.success) {
        return stop(
          "invalid",
          "Surtiste menos de lo que pide la tarea: escribe por qué.",
          "shortReason",
        );
      }
      reason = why.data;
    }
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: "PICKED_UP",
        pickedUpAt: new Date(),
        pickedQuantity: parsed.quantity.toString(),
        shortReason: reason,
      },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Surtiste ${formatStock(parsed.quantity.toString(), task.unitCode)} de ${task.product.name}. Llévalo a ${task.toLocation.name}.`,
    };
  });
}

/**
 * Left at the destination: writes the TRANSFER movement (key
 * `task:<id>`) and closes the task, in one transaction. If the stock is no
 * longer at the origin nothing changes and the person is told why (they
 * can report the problem).
 */
export async function deliverTask(
  actor: InventoryActor,
  taskId: string,
): Promise<TaskResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.task.execute",
  );
  // What it moves never changes (trigger): read it to take the locks of a
  // movement first (product → locations), then the task's.
  const fixed = await forOrganization(organizationId).warehouseTask.findFirst({
    where: { id: String(taskId ?? "") },
    select: {
      productId: true,
      fromLocationId: true,
      toLocationId: true,
      outboundLine: { select: { orderId: true } },
    },
  });
  if (!fixed) {
    return {
      ok: false,
      reason: "not_found",
      formError: "Esta tarea no existe.",
    };
  }
  return inTask(organizationId, async (tx) => {
    await lockRows(tx, "product", [fixed.productId]);
    await lockRows(tx, "location", [fixed.fromLocationId, fixed.toLocationId]);
    await lockPickOrder(tx, fixed.outboundLine?.orderId ?? null);
    const task = await lockTask(tx, taskId, userId);
    if (task.assignedToUserId !== userId) {
      return stop("not_allowed", "Esta tarea la tiene otra persona.");
    }
    if (task.status === "DELIVERED") {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: `La tarea ${formatTaskNumber(task.number)} ya estaba entregada. No se movió nada de nuevo.`,
      };
    }
    ensure(task, "DELIVERED");
    if (task.kind === "PICK" && task.outboundLineId && task.outboundLine) {
      const picked = dec(task.pickedQuantity?.toString() ?? 0);
      const delivered = await deliverPick(tx, actor, {
        id: task.id,
        number: task.number,
        outboundLineId: task.outboundLineId,
        productId: task.productId,
        fromLocationId: task.fromLocationId,
        toLocationId: task.toLocationId,
        quantity: dec(task.quantity.toString()),
        picked,
        unitCode: task.unitCode,
      });
      if (!delivered.ok) {
        return stop(
          "not_allowed",
          `${delivered.error} Si no puedes entregarlo, reporta el problema.`,
        );
      }
      await tx.warehouseTask.update({
        where: { id: task.id },
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          movementId: delivered.movementId,
        },
      });
      await settlePickedOrder(tx, task.outboundLine.orderId);
      return {
        ok: true,
        taskId: task.id,
        summary: `Dejaste ${formatStock(picked.toString(), task.unitCode)} de ${task.product.name} en ${task.toLocation.name}.`,
      };
    }
    const moved = await postTaskTransfer(tx, actor, {
      productId: task.productId,
      fromLocationId: task.fromLocationId,
      toLocationId: task.toLocationId,
      quantity: task.quantity.toString(),
      idempotencyKey: `task:${task.id}`,
      reference: formatTaskNumber(task.number),
    });
    if (!moved.ok) {
      return stop(
        "not_allowed",
        `${moved.formError ?? Object.values(moved.fieldErrors)[0] ?? "No se pudo mover la carga."} Si no puedes entregarla, reporta el problema.`,
      );
    }
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        movementId: moved.movementId,
      },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Entregaste la tarea ${describe(task)}.`,
    };
  });
}

/** Something stops it: damage, wrong location, nothing there. */
export function blockTask(
  actor: InventoryActor,
  taskId: string,
  reason: string,
): Promise<TaskResult> {
  const why = reasonSchema.safeParse(reason);
  if (!why.success) {
    return Promise.resolve({
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: why.error.issues[0]!.message },
    });
  }
  return step(actor, taskId, "inventory.task.execute", async (tx, task) => {
    if (task.assignedToUserId !== actor.userId) {
      return stop("not_allowed", "Esta tarea la tiene otra persona.");
    }
    if (task.status === "BLOCKED") {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: "El problema ya estaba reportado.",
      };
    }
    ensure(task, "BLOCKED");
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: "BLOCKED",
        blockedAt: new Date(),
        blockedReason: why.data,
      },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Reportaste un problema en la tarea ${formatTaskNumber(task.number)}. Tu supervisor la revisará.`,
    };
  });
}

// ── What a supervisor does ───────────────────────────────────────────────

/** Gives a task to a person, changes who has it, or leaves it available. */
export async function assignTask(
  actor: InventoryActor,
  taskId: string,
  assignToUserId: string | null,
): Promise<TaskResult> {
  const target = assignToUserId?.trim() || null;
  const targetOk = !target || (await mayExecute(actor.organizationId, target));
  return step(actor, taskId, "inventory.task.create", async (tx, task) => {
    if (task.status !== "PENDING" && task.status !== "ASSIGNED") {
      return stop(
        "not_allowed",
        "Esta tarea ya la tomó alguien: no se puede reasignar.",
      );
    }
    if (target === task.assignedToUserId) {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: "La tarea ya estaba así.",
      };
    }
    if (!targetOk) {
      return stop(
        "invalid",
        "Esa persona no puede hacer tareas de traslado.",
        "assignToUserId",
      );
    }
    if (
      target &&
      (
        await locationsOutOfScope(tx, target, [
          task.fromLocationId,
          task.toLocationId,
        ])
      ).length > 0
    ) {
      return stop("invalid", ASSIGNEE_OUT_OF_SCOPE, "assignToUserId");
    }
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: target ? "ASSIGNED" : "PENDING",
        assignedToUserId: target,
      },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: target
        ? `Asignaste la tarea ${formatTaskNumber(task.number)}.`
        : `La tarea ${formatTaskNumber(task.number)} quedó disponible para cualquiera.`,
    };
  });
}

/** A task with a problem goes back to available, for anyone to take. */
export function releaseTask(
  actor: InventoryActor,
  taskId: string,
): Promise<TaskResult> {
  return step(actor, taskId, "inventory.task.cancel", async (tx, task) => {
    if (task.status === "PENDING") {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: "La tarea ya estaba disponible.",
      };
    }
    if (task.status !== "BLOCKED") {
      return stop("not_allowed", "Solo se libera una tarea con problema.");
    }
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: "PENDING",
        assignedToUserId: null,
        acceptedAt: null,
        pickedUpAt: null,
        // Whoever takes it again confirms again what they pick.
        pickedQuantity: null,
        shortReason: null,
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "inventory.task_released",
      target: { type: "warehouse_task", id: task.id },
      metadata: { tarea: formatTaskNumber(task.number) },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `La tarea ${formatTaskNumber(task.number)} quedó disponible otra vez.`,
    };
  });
}

/** Cancelled with a reason; nothing had moved. */
export function cancelTask(
  actor: InventoryActor,
  taskId: string,
  reason: string,
): Promise<TaskResult> {
  const why = reasonSchema.safeParse(reason);
  if (!why.success) {
    return Promise.resolve({
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          why.error.issues[0]!.code === "too_small"
            ? "Escribe por qué se cancela."
            : why.error.issues[0]!.message,
      },
    });
  }
  return step(actor, taskId, "inventory.task.cancel", async (tx, task) => {
    if (task.status === "CANCELLED") {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: "La tarea ya estaba cancelada.",
      };
    }
    ensure(task, "CANCELLED");
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: why.data,
        closedByUserId: actor.userId,
        pickedQuantity: null,
        shortReason: null,
      },
    });
    if (task.kind === "PICK" && task.outboundLineId && task.outboundLine) {
      // Nothing was picked: what it held for the order is free again.
      await releasePickReservation(
        tx,
        {
          outboundLineId: task.outboundLineId,
          fromLocationId: task.fromLocationId,
          quantity: dec(task.quantity.toString()),
        },
        dec(0),
      );
      await settlePickedOrder(tx, task.outboundLine.orderId);
    }
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "inventory.task_cancelled",
      target: { type: "warehouse_task", id: task.id },
      reason: why.data,
      metadata: { tarea: formatTaskNumber(task.number) },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Cancelaste la tarea ${formatTaskNumber(task.number)}.`,
    };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export type TaskSummary = {
  id: string;
  numberText: string;
  status: WarehouseTaskStatus;
  statusLabel: string;
  urgent: boolean;
  /** «TRANSFER» (a move asked by someone) or «PICK» (an order, WMS-14). */
  kind: "TRANSFER" | "PICK";
  /** PICK: the order it picks for. */
  order: { id: string; numberText: string; recipient: string } | null;
  productName: string;
  sku: string;
  quantityText: string;
  fromPath: string;
  toPath: string;
  assignedToUserId: string | null;
  assignedToName: string | null;
  createdAt: Date;
};

export type TaskView = TaskSummary & {
  /** «12», in the product's unit; and that unit. */
  quantity: string;
  unitCode: string;
  /** PICK: what was confirmed as taken, «10 piezas»; and why it was less. */
  pickedText: string | null;
  shortReason: string | null;
  note: string | null;
  createdByName: string | null;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  blockedAt: Date | null;
  blockedReason: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  movementId: string | null;
};

/** «mine»: what this person has; «available»: what anyone may take. */
export type TaskListView = "mine" | "available" | "open" | "closed";

const LOCATION_NAMES = {
  select: {
    name: true,
    parent: LOCATION_PARENTS,
  },
} as const;

type LocationNames = LocationWithParents;

const pathOf = (location: LocationNames) => locationPath(location);

const SUMMARY_SELECT = {
  id: true,
  number: true,
  status: true,
  priority: true,
  kind: true,
  outboundLine: {
    select: {
      order: { select: { id: true, number: true, recipient: true } },
    },
  },
  quantity: true,
  unitCode: true,
  assignedToUserId: true,
  createdAt: true,
  product: { select: { name: true, sku: true } },
  fromLocation: LOCATION_NAMES,
  toLocation: LOCATION_NAMES,
} as const;

type SummaryRow = {
  id: string;
  number: number;
  status: WarehouseTaskStatus;
  priority: TaskPriority;
  kind: "TRANSFER" | "PICK";
  outboundLine: {
    order: { id: string; number: number; recipient: string };
  } | null;
  quantity: { toString(): string };
  unitCode: string;
  assignedToUserId: string | null;
  createdAt: Date;
  product: { name: string; sku: string };
  fromLocation: LocationNames;
  toLocation: LocationNames;
};

/** Names of people of the company, read through their memberships. */
async function namesOf(
  organizationId: string,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const members = await forOrganization(organizationId).membership.findMany({
    where: { userId: { in: wanted } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

const summaryOf = (
  row: SummaryRow,
  names: Map<string, string>,
): TaskSummary => ({
  id: row.id,
  numberText: formatTaskNumber(row.number),
  status: row.status,
  statusLabel: WAREHOUSE_TASK_STATUS_LABELS[row.status],
  urgent: row.priority === "URGENT",
  kind: row.kind,
  order: row.outboundLine
    ? {
        id: row.outboundLine.order.id,
        numberText: formatOutboundNumber(row.outboundLine.order.number),
        recipient: row.outboundLine.order.recipient,
      }
    : null,
  productName: row.product.name,
  sku: row.product.sku,
  quantityText: formatStock(row.quantity.toString(), row.unitCode),
  fromPath: pathOf(row.fromLocation),
  toPath: pathOf(row.toLocation),
  assignedToUserId: row.assignedToUserId,
  assignedToName: row.assignedToUserId
    ? (names.get(row.assignedToUserId) ?? null)
    : null,
  createdAt: row.createdAt,
});

export type TaskPage = {
  view: TaskListView;
  items: TaskSummary[];
  total: number;
  page: number;
  pageCount: number;
  /** The day the list is narrowed to («2026-11-12»), if any. */
  day: string | null;
};

/**
 * Tasks delivered on a day that left from a place: the work done that day,
 * the same for the list and for the summary of the day (WMS-73). Cancelled
 * tasks are not work done.
 */
export const deliveredOnWhere = (window: DayWindow, from: object) => ({
  status: "DELIVERED" as const,
  deliveredAt: window.range,
  fromLocation: from,
});

/**
 * Tasks a page at a time. Urgent first, then oldest first, for what needs
 * doing; the closed ones newest first. `day` (year-month-day, a day of the
 * company's calendar) narrows the closed ones to those delivered that day.
 */
export async function listTasks(
  actor: InventoryActor,
  options: { view?: unknown; page?: number; day?: unknown } = {},
): Promise<TaskPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  const view: TaskListView =
    options.view === "available" ||
    options.view === "open" ||
    options.view === "closed"
      ? options.view
      : "mine";
  const byView =
    view === "mine"
      ? {
          assignedToUserId: actor.userId,
          status: {
            in: [
              "ASSIGNED",
              "ACCEPTED",
              "PICKED_UP",
              "BLOCKED",
            ] as WarehouseTaskStatus[],
          },
        }
      : view === "available"
        ? { status: "PENDING" as const }
        : view === "open"
          ? { status: { in: [...OPEN_TASK_STATUSES] } }
          : {
              status: {
                in: ["DELIVERED", "CANCELLED"] as WarehouseTaskStatus[],
              },
            };
  const client = forOrganization(actor.organizationId);
  // Tasks of the warehouse the person works in (WMS-18).
  const facility = await activeFacilityOf(client, actor.userId);
  // WMS-20: and, with zones, only the ones inside them.
  const scope = await taskScope(client, actor.userId);
  const window =
    view === "closed" && typeof options.day === "string"
      ? await dayWindow(client, options.day)
      : null;
  const where = {
    ...(window
      ? deliveredOnWhere(window, { facilityId: facility.id })
      : { ...byView, fromLocation: { facilityId: facility.id } }),
    ...(Object.keys(scope).length > 0 ? { AND: [scope] } : {}),
  };
  const total = await client.warehouseTask.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / TASK_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.warehouseTask.findMany({
    where,
    orderBy:
      view === "closed"
        ? [{ number: "desc" }]
        : [{ priority: "desc" }, { number: "asc" }],
    skip: (page - 1) * TASK_PAGE_SIZE,
    take: TASK_PAGE_SIZE,
    select: SUMMARY_SELECT,
  });
  const names = await namesOf(
    actor.organizationId,
    rows.map((row) => row.assignedToUserId),
  );
  return {
    view,
    items: rows.map((row) => summaryOf(row, names)),
    total,
    page,
    pageCount,
    day: window?.day ?? null,
  };
}

/** How many tasks wait for this person, and how many anyone may take. */
export async function countMyTasks(
  actor: InventoryActor,
): Promise<{ mine: number; available: number; blocked: number }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scope = await taskScope(client, actor.userId);
  const here = {
    fromLocation: { facilityId: facility.id },
    ...(Object.keys(scope).length > 0 ? { AND: [scope] } : {}),
  };
  const [mine, available, blocked] = await Promise.all([
    client.warehouseTask.count({
      where: {
        ...here,
        assignedToUserId: actor.userId,
        status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP"] },
      },
    }),
    client.warehouseTask.count({ where: { ...here, status: "PENDING" } }),
    client.warehouseTask.count({ where: { ...here, status: "BLOCKED" } }),
  ]);
  return { mine, available, blocked };
}

export async function getTask(
  actor: InventoryActor,
  taskId: string,
): Promise<TaskView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = await client.warehouseTask.findFirst({
    where: {
      id: String(taskId ?? ""),
      ...(await taskScope(client, actor.userId)),
    },
    select: {
      ...SUMMARY_SELECT,
      note: true,
      createdByUserId: true,
      acceptedAt: true,
      pickedUpAt: true,
      deliveredAt: true,
      blockedAt: true,
      blockedReason: true,
      cancelledAt: true,
      cancelReason: true,
      movementId: true,
      pickedQuantity: true,
      shortReason: true,
    },
  });
  if (!row) return null;
  const names = await namesOf(actor.organizationId, [
    row.assignedToUserId,
    row.createdByUserId,
  ]);
  return {
    ...summaryOf(row, names),
    quantity: row.quantity.toString(),
    unitCode: row.unitCode,
    pickedText:
      row.pickedQuantity === null
        ? null
        : formatStock(row.pickedQuantity.toString(), row.unitCode),
    shortReason: row.shortReason,
    note: row.note,
    createdByName: names.get(row.createdByUserId) ?? null,
    acceptedAt: row.acceptedAt,
    pickedUpAt: row.pickedUpAt,
    deliveredAt: row.deliveredAt,
    blockedAt: row.blockedAt,
    blockedReason: row.blockedReason,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    movementId: row.movementId,
  };
}

/** People of the company who may be given a task, for the selector. */
export async function listTaskPeople(
  actor: InventoryActor,
): Promise<{ id: string; name: string }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.create",
  );
  const members = await forOrganization(
    actor.organizationId,
  ).membership.findMany({
    where: { status: "ACTIVE" },
    select: { userId: true, user: { select: { name: true } } },
  });
  const allowed = await Promise.all(
    members.map((member) => mayExecute(actor.organizationId, member.userId)),
  );
  return members
    .filter((_, index) => allowed[index])
    .map((member) => ({ id: member.userId, name: member.user.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}
