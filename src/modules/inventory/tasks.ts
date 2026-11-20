import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
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
import {
  attachEvidencePhotos,
  deleteFile,
  evidencePhotoLinks,
  storeFile,
  type StoreFileResult,
} from "@/platform/files";
import { memberName, notify } from "@/platform/notifications";
import { readSetting } from "@/platform/settings";
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
  formatIssueOrderNumber,
  formatTaskNumber,
  taskTransitionProblem,
  type WarehouseTaskStatus,
} from "./task-states";
import { formatOutboundNumber } from "./outbound-states";
import { deliverIssue, lockIssueOrder, releaseIssueReservation } from "./issue";
import { CapacityNotice, checkPlacement, type OverCapacity } from "./placement";
import { availableOfLot } from "./stock-status";
import { LOT_RULE_SELECT, lotForTake, ofLot } from "./lot-resolve";
import { lotDayOf, lotLabel, normalizeLotCode } from "./lot-rules";
import {
  TASK_HOLD,
  consumeReservation,
  blockedMessage,
  freeToMoveFrom,
  releaseReservations,
} from "./reservations";
import { isWaitingPlace } from "./unplaced";
import { PLACE_NOT_FOUND, scannedPlace } from "./scanned-place";
import { ofSerials, serialsForTake } from "./serials";
import {
  ContainerChanged,
  ContainerRejected,
  lockContainer,
  moveContainerWithin,
  planContainer,
  type LockedContainer,
} from "./containers";
import { containerName, theContainer } from "./container-rules";
import { compareRoute, inRouteOrder, routeKey } from "./pick-route";
import { formatWaveNumber } from "./wave-states";
import { TASK_ASSIGNED_NOTICE, TASK_BLOCKED_NOTICE } from "./notices";
import { settleWaveOf } from "./wave-settle";
import {
  EQUIPMENT_CODE_NOT_FOUND,
  equipmentChoices,
  equipmentLabel,
  type EquipmentChoice,
} from "./equipment";
import {
  EQUIPMENT_HOLDING_STATUSES,
  equipmentHolder,
  normalizeEquipmentCode,
} from "./equipment-rules";
import { TASK_PHOTO } from "./settings";

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
  | "shortReason"
  | "serials"
  | "lotId"
  | "lotCode"
  | "equipmentTypeId"
  | "equipmentCode"
  | "photos";

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
export async function taskScope(client: LocationScopeReader, userId: string) {
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
          lotId: true,
          lot: { select: { code: true } },
          outboundLine: { select: { orderId: true } },
          // WMS-28 (ADR 0073): the production order an ISSUE task serves.
          productionOrderLineId: true,
          productionOrderLine: {
            select: { orderId: true, order: { select: { number: true } } },
          },
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
          fromLocation: {
            select: {
              name: true,
              code: true,
              facilityId: true,
              parent: LOCATION_PARENTS,
            },
          },
          toLocation: { select: { name: true } },
          placedLocationId: true,
          containerId: true,
          container: { select: { code: true, kind: true } },
          // WMS-42: the type of equipment it asks for and the one in use.
          equipmentTypeId: true,
          equipmentType: { select: { name: true } },
          equipmentId: true,
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
): Promise<{ outbound: string | null; production: string | null }> {
  const row = await forOrganization(organizationId).warehouseTask.findFirst({
    where: { id: String(taskId ?? "") },
    select: {
      outboundLine: { select: { orderId: true } },
      // WMS-28: an ISSUE task locks its production order the same way.
      productionOrderLine: { select: { orderId: true } },
    },
  });
  return {
    outbound: row?.outboundLine?.orderId ?? null,
    production: row?.productionOrderLine?.orderId ?? null,
  };
}

/**
 * WMS-21B: the units by serial a task took, with their serials; empty for
 * any other product or before they are scanned.
 */
async function taskSerials(tx: Tx, taskId: string): Promise<string[]> {
  const rows = await tx.warehouseTaskSerial.findMany({
    where: { taskId },
    orderBy: { id: "asc" },
    select: { serialUnit: { select: { serial: true } } },
  });
  return rows.map((row) => row.serialUnit.serial);
}

/**
 * WMS-21B: the person scans the units of a product by serial they take
 * (as many as `quantity`, right at the origin, free of other tasks): they
 * stay with this task until it is delivered, released or cancelled.
 */
async function holdSerials(
  tx: Tx,
  actor: InventoryActor,
  task: ProductTask,
  input: unknown,
  quantity: Decimal,
): Promise<{ serial: string }[]> {
  // The step locked the product: movements of it wait.
  const answer = await serialsForTake(
    tx,
    {
      id: task.productId,
      name: task.product.name,
      tracking: task.product.tracking,
    },
    input,
    quantity,
    {
      locationId: task.fromLocationId,
      locationName: task.fromLocation.name,
      status: "AVAILABLE",
    },
    { verb: "tomaste", taskId: task.id },
  );
  if (!answer.ok) return stop("invalid", answer.error, "serials");
  const units = answer.units ?? [];
  await tx.warehouseTaskSerial.deleteMany({ where: { taskId: task.id } });
  if (units.length > 0) {
    await tx.warehouseTaskSerial.createMany({
      data: units.map((unit) => ({
        id: newId(),
        organizationId: actor.organizationId,
        taskId: task.id,
        serialUnitId: unit.id!,
      })),
    });
  }
  return units;
}

type LockedTask = Awaited<ReturnType<typeof lockTask>>;

/** A task that moves a product (not a whole container, WMS-53). */
type ProductTask = LockedTask & {
  productId: string;
  product: NonNullable<LockedTask["product"]>;
  quantity: NonNullable<LockedTask["quantity"]>;
  unitCode: string;
};

function ofProduct(task: LockedTask): ProductTask {
  if (
    !task.productId ||
    !task.product ||
    task.quantity === null ||
    task.unitCode === null
  ) {
    throw new Error(`Task ${task.id} moves a container, not a product`);
  }
  return task as ProductTask;
}

/** «12 cajas de Guante» or «Tarima C-0001»: what a task moves. */
const whatOf = (task: {
  quantity: { toString(): string } | null;
  unitCode: string | null;
  product: { name: string } | null;
  container: { kind: string; code: string } | null;
  lot: { code: string } | null;
}) =>
  task.container
    ? containerName(task.container)
    : `${formatStock(task.quantity!.toString(), task.unitCode!)} de ${task.product!.name}${ofLot(task.lot)}`;

/**
 * WMS-52: where a task sends the goods, in words. A put-away without a
 * recommendation has the origin itself as its destination (ADR 0042).
 */
const destinationOf = (task: {
  kind: string;
  fromLocationId: string;
  toLocationId: string;
  toLocation: { name: string };
}) =>
  task.kind === "PUTAWAY" && task.toLocationId === task.fromLocationId
    ? "el lugar que elijas"
    : task.toLocation.name;

const describe = (task: LockedTask) =>
  `${formatTaskNumber(task.number)}: ${whatOf(task)} de ${task.fromLocation.name} a ${destinationOf(task)}`;

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
  /** The lot to move, for a product by lot (WMS-21). */
  lotId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
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
  /** WMS-42: the type of equipment the task asks for (optional). */
  equipmentTypeId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
});

export type CreateTaskInput = z.input<typeof createSchema>;

/**
 * A new transfer task (WMS-06). The stock is checked now so nobody is sent
 * for what is not there, and again at the delivery (it may have moved).
 */
export function createTask(
  actor: InventoryActor,
  /**
   * `acceptCapacity`: the destination would go over its capacity and the
   * person wants the task anyway (WMS-22B).
   */
  input: CreateTaskInput & { acceptCapacity?: boolean },
): Promise<TaskResult | OverCapacity> {
  return createTaskGuarded(actor, input, null);
}

/**
 * A check another service runs inside `createTask`, under its locks
 * (product → locations) and before anything is written: a result stops the
 * creation and is answered as it is. WMS-65 (ADR 0086) uses it so a
 * suggestion accepted twice at once creates one task. Not in `index.ts`.
 */
export type CreateTaskGuard = (
  tx: Tx,
  task: {
    productId: string;
    fromLocationId: string;
    toLocationId: string;
  },
) => Promise<TaskResult | null>;

/** `createTask` with a guard under its locks (WMS-65). */
export async function createTaskGuarded(
  actor: InventoryActor,
  input: CreateTaskInput & { acceptCapacity?: boolean },
  guard: CreateTaskGuard | null,
): Promise<TaskResult | OverCapacity> {
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
        if (guard && productId) {
          const stopped = await guard(tx, {
            productId,
            fromLocationId: data.fromLocationId,
            toLocationId: data.toLocationId,
          });
          if (stopped) return stopped;
        }
        const product = productId
          ? await tx.product.findFirst({
              where: { id: productId },
              select: {
                id: true,
                name: true,
                status: true,
                unitCode: true,
                quantityStep: true,
                ...LOT_RULE_SELECT,
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
        // WMS-21: a task of a product by lot says which lot to move.
        const lotAnswer = await lotForTake(tx, product, data.lotId);
        if (!lotAnswer.ok) return stop("invalid", lotAnswer.error, "lotId");
        const lot = lotAnswer.lot;
        const balance = await tx.stockBalance.findFirst({
          where: {
            productId: product.id,
            locationId: from.id,
            ...availableOfLot(lot?.id),
          },
          select: { quantity: true },
        });
        const there = dec(balance?.quantity.toString() ?? 0);
        if (there.lessThan(quantity.quantity)) {
          return stop(
            "invalid",
            there.isZero()
              ? `No hay existencias de ${product.name}${ofLot(lot)} en ${from.name}.`
              : `Solo hay ${formatStock(there.toString(), product.unitCode)}${ofLot(lot)} en ${from.name}.`,
            "quantity",
          );
        }
        // WMS-12: what is reserved in that location stays there.
        const freeHere = await freeToMoveFrom(tx, product.id, from.id, lot?.id);
        if (freeHere.lessThan(quantity.quantity)) {
          return stop(
            "invalid",
            await blockedMessage(tx, freeHere, product.unitCode, "mover", {
              productId: product.id,
              locationId: from.id,
              locationName: from.name,
              lotId: lot?.id,
            }),
            "quantity",
          );
        }
        // WMS-22B: nobody is sent to a place that does not admit the
        // product, or (as the company decided) that has no room for it.
        // Asked now, where someone can choose; the delivery only reports.
        const placed = await checkPlacement(
          tx,
          [
            {
              productId: product.id,
              quantity: quantity.quantity,
              toLocationId: to.id,
              fromLocationId: from.id,
              status: "AVAILABLE",
            },
          ],
          { mode: "ask", accepted: input.acceptCapacity === true },
        );
        if (!placed.ok) {
          if (placed.reason === "over_capacity" && !placed.blocked) {
            throw new CapacityNotice(placed.message);
          }
          return stop("not_allowed", placed.message, "toLocationId");
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
        // WMS-42: a type in use with some equipment in this warehouse, or
        // nobody could ever take the task.
        let equipmentType: { id: string; name: string } | null = null;
        if (data.equipmentTypeId) {
          equipmentType = await tx.equipmentType.findFirst({
            where: {
              id: data.equipmentTypeId,
              archivedAt: null,
              equipment: {
                some: { facilityId: from.facilityId, retiredAt: null },
              },
            },
            select: { id: true, name: true },
          });
          if (!equipmentType) {
            return stop(
              "invalid",
              "Este almacén no tiene equipos de ese tipo. Elige otro o deja la tarea sin equipo.",
              "equipmentTypeId",
            );
          }
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
            lotId: lot?.id ?? null,
            quantity: quantity.quantity.toString(),
            unitCode: product.unitCode,
            note: data.note,
            createdByUserId: userId,
            assignedToUserId: data.assignToUserId,
            equipmentTypeId: equipmentType?.id ?? null,
          },
        });
        // WMS-39: given to someone when created, they hear it.
        if (data.assignToUserId) {
          await notify(tx, TASK_ASSIGNED_NOTICE, {
            organizationId,
            actorUserId: userId,
            // WMS-88: the same rule that lets them see the task.
            to: {
              userIds: [data.assignToUserId],
              permissions: ["inventory.task.read"],
              locationIds: [from.id, to.id],
            },
            text: `${await memberName(tx, userId)} te asignó la tarea ${formatTaskNumber(number)}: ${product.name} de ${from.name} a ${to.name}.`,
            href: `/tareas/${id}`,
            key: `task:${id}:assigned:${data.assignToUserId}`,
          });
        }
        return {
          ok: true,
          taskId: id,
          summary: `Se creó la tarea ${formatTaskNumber(number)}: ${formatStock(quantity.quantity.toString(), product.unitCode)} de ${product.name}${ofLot(lot)} de ${from.name} a ${to.name}${equipmentType ? `, con ${equipmentType.name}` : ""}.`,
        };
      });
    } catch (error) {
      if (error instanceof CapacityNotice) return error.result;
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
  /**
   * WMS-21B: the step reads units by serial of the product (picking up,
   * confirming a pick), so it locks the product first, like a movement:
   * product → order → task.
   */
  options: { lockProduct?: boolean } = {},
): Promise<TaskResult> {
  await assertModulePermission(actor.organizationId, actor.userId, permission);
  const orders = await pickOrderOf(actor.organizationId, taskId);
  const productId = options.lockProduct
    ? ((
        await forOrganization(actor.organizationId).warehouseTask.findFirst({
          where: { id: String(taskId ?? "") },
          select: { productId: true },
        })
      )?.productId ?? null)
    : null;
  return inTask(actor.organizationId, async (tx) => {
    if (productId) await lockRows(tx, "product", [productId]);
    await lockPickOrder(tx, orders.outbound);
    await lockIssueOrder(tx, orders.production);
    return work(tx, await lockTask(tx, taskId, actor.userId));
  });
}

/**
 * Takes an available task, or the one given to this person. A task that
 * asks for a type of equipment (WMS-42) is taken with one: its code,
 * scanned or chosen (`equipmentCode`).
 */
export function acceptTask(
  actor: InventoryActor,
  taskId: string,
  input: { equipmentCode?: unknown } = {},
): Promise<TaskResult> {
  return step(actor, taskId, "inventory.task.execute", (tx, task) =>
    acceptLocked(tx, actor, task, input.equipmentCode),
  );
}

/**
 * WMS-42 (ADR 0065): the equipment this person takes for a task that asks
 * for a type, under its lock (task → equipment): of that type, of the
 * task's warehouse, in service, not retired and not used by someone else
 * in an open task (the same person may use it in several).
 */
async function takeEquipment(
  tx: Tx,
  actor: InventoryActor,
  task: LockedTask,
  typed: unknown,
): Promise<{ id: string; code: string; name: string }> {
  const asked = task.equipmentType?.name ?? "equipo";
  const code = normalizeEquipmentCode(String(typed ?? "").slice(0, 60));
  if (!code.ok) {
    return stop(
      "invalid",
      String(typed ?? "").trim() === ""
        ? `Esta tarea pide ${asked}: escanea o elige el que vas a usar.`
        : EQUIPMENT_CODE_NOT_FOUND,
      "equipmentCode",
    );
  }
  const found = await tx.equipment.findFirst({
    where: { code: code.code },
    select: { id: true },
  });
  const [id] = found ? await lockRows(tx, "equipment", [found.id]) : [];
  const equipment = id
    ? await tx.equipment.findFirst({
        where: { id },
        select: {
          id: true,
          code: true,
          name: true,
          facilityId: true,
          typeId: true,
          status: true,
          outOfServiceReason: true,
          retiredAt: true,
          type: { select: { name: true } },
        },
      })
    : null;
  if (
    !equipment ||
    equipment.retiredAt ||
    equipment.facilityId !== task.fromLocation.facilityId
  ) {
    return stop("invalid", EQUIPMENT_CODE_NOT_FOUND, "equipmentCode");
  }
  if (equipment.typeId !== task.equipmentTypeId) {
    return stop(
      "invalid",
      `${equipment.code} es ${equipment.type.name}; esta tarea pide ${asked}.`,
      "equipmentCode",
    );
  }
  if (equipment.status !== "IN_SERVICE") {
    return stop(
      "invalid",
      `${equipment.code} está fuera de servicio${equipment.outOfServiceReason ? `: ${equipment.outOfServiceReason}` : ""}. Elige otro.`,
      "equipmentCode",
    );
  }
  const holders = await tx.warehouseTask.findMany({
    where: {
      equipmentId: equipment.id,
      status: { in: [...EQUIPMENT_HOLDING_STATUSES] },
      NOT: { id: task.id },
    },
    orderBy: { number: "asc" },
    take: 20,
    select: {
      assignedToUserId: true,
      number: true,
      fromLocationId: true,
      toLocationId: true,
    },
  });
  const other = equipmentHolder(
    holders.map((row) => ({
      userId: row.assignedToUserId,
      taskNumber: row.number,
    })),
    actor.userId,
  );
  if (other) {
    // WMS-20: a task outside the person's scope is not named, nor who has it.
    const theirs = holders.find((row) => row.number === other.taskNumber)!;
    const visible =
      (
        await locationsOutOfScope(tx, actor.userId, [
          theirs.fromLocationId,
          theirs.toLocationId,
        ])
      ).length === 0;
    return stop(
      "invalid",
      visible
        ? `${equipment.code} lo está usando ${await memberName(tx, other.userId)} en ${formatTaskNumber(other.taskNumber)}. Elige otro.`
        : `${equipment.code} lo está usando otra persona. Elige otro.`,
      "equipmentCode",
    );
  }
  return equipment;
}

/**
 * WMS-42: the load is not picked up with equipment out of service or
 * retired (the person changes it first); a load in hand is delivered.
 */
async function assertEquipmentUsable(tx: Tx, task: LockedTask) {
  if (!task.equipmentId) return;
  await lockRows(tx, "equipment", [task.equipmentId]);
  const equipment = await tx.equipment.findFirst({
    where: { id: task.equipmentId },
    select: { code: true, status: true, retiredAt: true },
  });
  if (!equipment || equipment.retiredAt || equipment.status !== "IN_SERVICE") {
    stop(
      "not_allowed",
      `${equipment?.code ?? "El equipo"} quedó fuera de servicio: cambia de equipo antes de recoger la carga.`,
      "equipmentCode",
    );
  }
}

/** `acceptTask` on a task already locked (with its order before it). */
async function acceptLocked(
  tx: Tx,
  actor: InventoryActor,
  task: LockedTask,
  equipmentCode?: unknown,
): Promise<TaskResult> {
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
  // WMS-42: locked after the task (order → task → equipment).
  const equipment = task.equipmentTypeId
    ? await takeEquipment(tx, actor, task, equipmentCode)
    : null;
  await tx.warehouseTask.update({
    where: { id: task.id },
    data: {
      status: "ACCEPTED",
      assignedToUserId: actor.userId,
      acceptedAt: new Date(),
      ...(equipment ? { equipmentId: equipment.id } : {}),
    },
  });
  if (task.outboundLine) await startPicking(tx, task.outboundLine.orderId);
  return {
    ok: true,
    taskId: task.id,
    summary: `Tomaste la tarea ${describe(task)}${equipment ? ` con ${equipment.code}` : ""}. Ve a ${task.fromLocation.name}.`,
  };
}

/**
 * WMS-42: another piece of equipment for a task taken and not yet picked
 * up (the one in use went out of service, or the person changed it).
 */
export function changeTaskEquipment(
  actor: InventoryActor,
  taskId: string,
  input: { equipmentCode?: unknown },
): Promise<TaskResult> {
  return step(actor, taskId, "inventory.task.execute", async (tx, task) => {
    if (task.assignedToUserId !== actor.userId) {
      return stop("not_allowed", "Esta tarea la tiene otra persona.");
    }
    if (!task.equipmentTypeId) {
      return stop("not_allowed", "Esta tarea no pide equipo.");
    }
    if (task.status !== "ACCEPTED") {
      return stop(
        "not_allowed",
        task.status === "PICKED_UP"
          ? "La carga ya se recogió: entrégala o reporta el problema."
          : "Primero toma la tarea.",
      );
    }
    const equipment = await takeEquipment(tx, actor, task, input.equipmentCode);
    if (equipment.id === task.equipmentId) {
      return {
        ok: true,
        taskId: task.id,
        repeated: true,
        summary: `Ya usabas ${equipment.code} en esta tarea.`,
      };
    }
    await tx.warehouseTask.update({
      where: { id: task.id },
      data: { equipmentId: equipment.id },
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Ahora haces la tarea ${formatTaskNumber(task.number)} con ${equipmentLabel(equipment)}.`,
    };
  });
}

/**
 * The load is in hand. For a product by serial (WMS-21B) the person scans
 * the serials of the units they took (`serials`).
 */
export function pickUpTask(
  actor: InventoryActor,
  taskId: string,
  input: { serials?: unknown } = {},
): Promise<TaskResult> {
  return step(
    actor,
    taskId,
    "inventory.task.execute",
    async (tx, task) => {
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
      await assertEquipmentUsable(tx, task);
      // WMS-53: a container carries its units; nothing to scan.
      const units = task.containerId
        ? []
        : await holdSerials(
            tx,
            actor,
            ofProduct(task),
            input.serials,
            dec(task.quantity!.toString()),
          );
      await tx.warehouseTask.update({
        where: { id: task.id },
        data: { status: "PICKED_UP", pickedUpAt: new Date() },
      });
      return {
        ok: true,
        taskId: task.id,
        summary: `Recogiste la carga${ofSerials(units)}. Llévala a ${destinationOf(task)}.`,
      };
    },
    { lockProduct: true },
  );
}

export type ConfirmPickInput = {
  /** Scanned or typed: the product's key or barcode. */
  productCode: string;
  /** Scanned or typed: the code, name or path of the origin location. */
  locationCode: string;
  /** Scanned or typed: the lot taken, when the task names one (WMS-21). */
  lotCode?: string;
  /** What was taken, in the product's unit. */
  quantity: string;
  /** Why less than asked; required then. */
  shortReason?: string;
  /**
   * The serials of the units taken, one per line (WMS-21B), for a product
   * by serial: as many as `quantity`.
   */
  serials?: unknown;
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
  return step(
    actor,
    taskId,
    "inventory.task.execute",
    (tx, locked) => confirmPickLocked(tx, actor, locked, input),
    { lockProduct: true },
  );
}

/**
 * `confirmPick` on a task already locked (product → order → task): the
 * checks and the write of one confirmation, shared with confirming several
 * tasks of a wave at once (WMS-25).
 */
async function confirmPickLocked(
  tx: Tx,
  actor: InventoryActor,
  locked: LockedTask,
  input: ConfirmPickInput,
): Promise<TaskResult> {
  if (locked.kind !== "PICK") {
    return stop("not_allowed", "Esta tarea no es de surtido.");
  }
  const task = ofProduct(locked);
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
  await assertEquipmentUsable(tx, task);
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
  const byCode = from.code !== null && typed.trim().toUpperCase() === from.code;
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
  // WMS-21: the lot in hand is the one set aside for the order.
  if (task.lot) {
    const typedLot = normalizeLotCode(input.lotCode);
    if (!typedLot.ok) {
      return stop(
        "invalid",
        `Escanea o escribe el lote que tomaste (${task.lot.code}).`,
        "lotCode",
      );
    }
    if (typedLot.code !== task.lot.code) {
      return stop(
        "invalid",
        `Ese no es el lote de la tarea: busca el lote ${task.lot.code}. Si no está, reporta el problema.`,
        "lotCode",
      );
    }
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
  // WMS-21B: the units in hand, by their serials (set aside from here).
  const units = await holdSerials(
    tx,
    actor,
    task,
    input.serials,
    parsed.quantity,
  );
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
    summary: `Surtiste ${formatStock(parsed.quantity.toString(), task.unitCode)} de ${task.product.name}${ofSerials(units)}. Llévalo a ${task.toLocation.name}.`,
  };
}

export type DeliverInput = {
  /**
   * PUTAWAY (WMS-52): where the person left it — the code, path or name
   * of the location, scanned or typed. Required for a put-away.
   */
  locationCode?: string;
  /**
   * PUTAWAY: it goes over a capacity the company only warns about, and
   * the person leaves it there anyway (WMS-22B).
   */
  acceptCapacity?: boolean;
  /**
   * WMS-37B (ADR 0076): photos of where it was left, uploaded with
   * `uploadTaskPhoto`; linked with the delivery, in its transaction.
   */
  photoIds?: readonly string[];
};

const TASK_PHOTO_REQUIRED = "Toma una foto de dónde la dejaste.";
const GROUP_NEEDS_PHOTO =
  "Esta empresa pide una foto al entregar: deja cada tarea desde su ficha con su foto.";

/**
 * WMS-37B (ADR 0076): whether this company demands a photo to deliver,
 * read inside the delivery's transaction (after its locks, before
 * writing): with «required» and none, nothing is written.
 */
async function assertPhotoGiven(tx: Tx, photoIds: readonly string[]) {
  if (
    photoIds.length === 0 &&
    (await readSetting(tx, TASK_PHOTO)) === "required"
  ) {
    stop("invalid", TASK_PHOTO_REQUIRED, "photos");
  }
}

/**
 * WMS-37B: links the photos of a delivery to its task, at the end of the
 * delivery's transaction (after its moves and the task written as
 * delivered; the files are the last locks). A photo that does not serve
 * undoes the whole delivery. Says how many were kept, for the summary.
 */
async function attachTaskPhotos(
  tx: Tx,
  actor: InventoryActor,
  taskId: string,
  photoIds: readonly string[],
): Promise<string> {
  if (photoIds.length === 0) return "";
  const linked = await attachEvidencePhotos(tx, actor, {
    purpose: "task_photo",
    owner: { kind: "warehouse_task", id: taskId },
    fileIds: photoIds,
  });
  if (!linked.ok) return stop("invalid", linked.error, "photos");
  return linked.count === 1
    ? " Se guardó la foto."
    : ` Se guardaron ${linked.count} fotos.`;
}

/**
 * Left at the destination: writes the TRANSFER movement (key
 * `task:<id>`) and closes the task, in one transaction. If the stock is no
 * longer at the origin nothing changes and the person is told why (they
 * can report the problem).
 *
 * A put-away (WMS-52) is left where the person scanned: the recommended
 * place or another of its warehouse, which must admit the goods; the task
 * records where it really went (`placedLocationId`).
 */
export async function deliverTask(
  actor: InventoryActor,
  taskId: string,
  input: DeliverInput = {},
): Promise<TaskResult | OverCapacity> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.task.execute",
  );
  const client = forOrganization(organizationId);
  // What it moves never changes (trigger): read it to take the locks of a
  // movement first (product → locations), then the task's.
  const fixed = await client.warehouseTask.findFirst({
    where: { id: String(taskId ?? "") },
    select: {
      kind: true,
      status: true,
      productId: true,
      containerId: true,
      fromLocationId: true,
      toLocationId: true,
      fromLocation: { select: { facilityId: true } },
      outboundLine: { select: { orderId: true } },
      productionOrderLine: { select: { orderId: true } },
    },
  });
  if (!fixed) {
    return {
      ok: false,
      reason: "not_found",
      formError: "Esta tarea no existe.",
    };
  }
  // WMS-52: where a put-away was left, found before the locks.
  let placedId: string | null = null;
  if (fixed.kind === "PUTAWAY" && fixed.status !== "DELIVERED") {
    const found = await scannedPlace(
      client,
      fixed.fromLocation.facilityId,
      await locationScopeWhere(client, userId),
      String(input.locationCode ?? ""),
    );
    if ("error" in found) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { locationCode: found.error },
      };
    }
    placedId = found.id;
  }
  const destination = placedId ?? fixed.toLocationId;
  // WMS-53: a container task locks what the container holds (products),
  // the locations and the container before the task. Nothing is packed
  // or taken out of it while its task is open, so what it holds is fixed.
  const plan = fixed.containerId
    ? await planContainer(client, fixed.containerId)
    : null;
  try {
    return await inTask(organizationId, async (tx) => {
      let box: LockedContainer | null = null;
      if (plan) {
        box = await lockContainer(tx, userId, plan, [destination]);
      } else {
        await lockRows(tx, "product", [fixed.productId ?? ""]);
        await lockRows(tx, "location", [fixed.fromLocationId, destination]);
        await lockPickOrder(tx, fixed.outboundLine?.orderId ?? null);
        await lockIssueOrder(tx, fixed.productionOrderLine?.orderId ?? null);
      }
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
      // WMS-37B: a photo the company demands is asked before anything
      // moves; the photos are linked after everything else.
      const photoIds = input.photoIds ?? [];
      await assertPhotoGiven(tx, photoIds);
      const delivered = await deliverLocked(tx, actor, task, box, {
        destination,
        input,
      });
      if (!delivered.ok) return delivered;
      const photos = await attachTaskPhotos(tx, actor, task.id, photoIds);
      return { ...delivered, summary: delivered.summary + photos };
    });
  } catch (error) {
    if (error instanceof CapacityNotice) return error.result;
    if (error instanceof ContainerRejected) {
      const result = error.result;
      return {
        ok: false,
        reason: result.reason,
        fieldErrors: result.fieldErrors.locationCode
          ? { locationCode: result.fieldErrors.locationCode }
          : undefined,
        formError:
          result.formError ??
          (result.fieldErrors.locationCode
            ? undefined
            : Object.values(result.fieldErrors)[0]),
      };
    }
    if (error instanceof ContainerChanged) {
      return {
        ok: false,
        reason: "not_allowed",
        formError:
          "La tarima de esta tarea cambió de lugar o de contenido. Reporta el problema.",
      };
    }
    throw error;
  }
}

/**
 * The delivery of a task by its kind (the caller took every lock and
 * checked it may be delivered). Moves the goods and writes the task as
 * delivered; refuses by throwing, so everything is undone.
 */
async function deliverLocked(
  tx: Tx,
  actor: InventoryActor,
  task: LockedTask,
  box: LockedContainer | null,
  where: { destination: string; input: DeliverInput },
): Promise<TaskResult> {
  const { destination, input } = where;
  if (box) {
    return deliverContainer(tx, actor, task, box, destination, input);
  }
  if (task.kind === "PICK" && task.outboundLineId && task.outboundLine) {
    return deliverPickTask(tx, actor, ofProduct(task));
  }
  if (task.kind === "PUTAWAY") {
    return deliverPutaway(tx, actor, ofProduct(task), destination, input);
  }
  if (task.kind === "REPLENISH") {
    return deliverReplenish(tx, actor, ofProduct(task));
  }
  if (task.kind === "ISSUE") {
    return deliverIssueTask(tx, actor, ofProduct(task));
  }
  const product = ofProduct(task);
  const moved = await postTaskTransfer(tx, actor, {
    productId: product.productId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    quantity: product.quantity.toString(),
    lotId: task.lotId,
    serials: await taskSerials(tx, task.id),
    taskId: task.id,
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
    // WMS-22B: a destination left above its capacity is said, not stopped.
    summary:
      `Entregaste la tarea ${describe(task)}.` +
      (moved.notes ?? []).map((note) => ` ${note}`).join(""),
  };
}

async function deliverPickTask(
  tx: Tx,
  actor: InventoryActor,
  task: ProductTask,
  /** WMS-25: false when the caller settles the waves after several. */
  settleWave = true,
): Promise<Extract<TaskResult, { ok: true }> & { notes: string[] }> {
  const picked = dec(task.pickedQuantity?.toString() ?? 0);
  const delivered = await deliverPick(tx, actor, {
    id: task.id,
    number: task.number,
    outboundLineId: task.outboundLineId!,
    productId: task.productId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    lotId: task.lotId,
    quantity: dec(task.quantity.toString()),
    picked,
    unitCode: task.unitCode,
    serials: await taskSerials(tx, task.id),
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
  await settlePickedOrder(tx, task.outboundLine!.orderId, {
    wave: settleWave,
  });
  return {
    ok: true,
    taskId: task.id,
    summary:
      `Dejaste ${formatStock(picked.toString(), task.unitCode)} de ${task.product.name} en ${task.toLocation.name}.` +
      delivered.notes.map((note) => ` ${note}`).join(""),
    notes: delivered.notes,
  };
}

/**
 * WMS-52: the place where a put-away is left, checked again under the
 * locks: of the task's warehouse, active, inside the scope of who leaves
 * it, not the origin, not a place «de paso» nor the staging one.
 */
async function putawayPlace(
  tx: Tx,
  actor: InventoryActor,
  task: LockedTask,
  placedId: string,
): Promise<{ id: string; name: string }> {
  const outside = await locationsOutOfScope(tx, actor.userId, [placedId]);
  const place =
    outside.length > 0
      ? null
      : await tx.location.findFirst({
          where: { id: placedId },
          select: {
            id: true,
            name: true,
            facilityId: true,
            archivedAt: true,
            isDefault: true,
            isStaging: true,
            type: true,
          },
        });
  const origin = await tx.location.findFirst({
    where: { id: task.fromLocationId },
    select: { facilityId: true },
  });
  if (
    !place ||
    !origin ||
    place.archivedAt ||
    place.facilityId !== origin.facilityId
  ) {
    return stop("invalid", PLACE_NOT_FOUND, "locationCode");
  }
  if (place.id === task.fromLocationId) {
    return stop(
      "invalid",
      `Sigue en ${place.name}: llévalo a un lugar donde se guarde y escanea esa etiqueta.`,
      "locationCode",
    );
  }
  if (isWaitingPlace(place) || place.isStaging) {
    return stop(
      "invalid",
      `«${place.name}» es un lugar de paso: acomódalo en una ubicación donde se guarde.`,
      "locationCode",
    );
  }
  return place;
}

/**
 * WMS-52: a put-away left at `placedId` (the caller locked product →
 * origin and that place → task). The goods leave their hold and move with
 * the transfer of every task; the capacity of the recommended place only
 * reports (it was asked when recommending), the one of another place is
 * asked like any relocation.
 */
async function deliverPutaway(
  tx: Tx,
  actor: InventoryActor,
  task: ProductTask,
  placedId: string,
  input: DeliverInput,
): Promise<TaskResult> {
  const place = await putawayPlace(tx, actor, task, placedId);
  const hold = await tx.stockReservation.findFirst({
    where: { sourceType: TASK_HOLD, sourceId: task.id, state: "ACTIVE" },
    select: { id: true, remaining: true },
  });
  const quantity = dec(task.quantity.toString());
  if (!hold || dec(hold.remaining.toString()).lessThan(quantity)) {
    return stop(
      "not_allowed",
      `Lo apartado para esta tarea ya no está completo en ${task.fromLocation.name}. Si no puedes acomodarlo, reporta el problema.`,
    );
  }
  // First let go of the hold, so the move may take it.
  await consumeReservation(tx, hold.id, quantity);
  const recommended = place.id === task.toLocationId;
  const moved = await postTaskTransfer(
    tx,
    actor,
    {
      productId: task.productId,
      fromLocationId: task.fromLocationId,
      toLocationId: place.id,
      quantity: quantity.toString(),
      lotId: task.lotId,
      serials: await taskSerials(tx, task.id),
      taskId: task.id,
      idempotencyKey: `task:${task.id}`,
      reference: formatTaskNumber(task.number),
    },
    recommended
      ? { mode: "report" }
      : { mode: "ask", accepted: input.acceptCapacity === true },
  );
  if (!moved.ok) {
    const problem =
      moved.formError ??
      Object.values(moved.fieldErrors)[0] ??
      "No se pudo mover la carga.";
    // A restriction of the place: the person may choose another one.
    return moved.fieldErrors.toLocationId
      ? stop("not_allowed", problem, "locationCode")
      : stop(
          "not_allowed",
          `${problem} Si no puedes acomodarlo, reporta el problema.`,
        );
  }
  await tx.warehouseTask.update({
    where: { id: task.id },
    data: {
      status: "DELIVERED",
      deliveredAt: new Date(),
      movementId: moved.movementId,
      placedLocationId: place.id,
    },
  });
  return {
    ok: true,
    taskId: task.id,
    summary:
      `Acomodaste ${formatStock(quantity.toString(), task.unitCode)} de ${task.product.name}${ofLot(task.lot)} en ${place.name}.` +
      (moved.notes ?? []).map((note) => ` ${note}`).join(""),
  };
}

/**
 * WMS-24 (ADR 0051): a replenishment left at its picking location (the
 * caller locked product → locations → task). Like a put-away, the goods
 * leave their hold and move with the transfer of every task; the capacity
 * only reports (it was asked when the task was decided).
 */
/**
 * WMS-28 (ADR 0073): a «Surtir a producción» task leaves the material in
 * the area of its production order, still set aside for the same line.
 */
async function deliverIssueTask(
  tx: Tx,
  actor: InventoryActor,
  task: ProductTask,
): Promise<TaskResult> {
  const quantity = dec(task.quantity.toString());
  const delivered = await deliverIssue(tx, actor, {
    id: task.id,
    number: task.number,
    productionOrderLineId: task.productionOrderLineId!,
    productId: task.productId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    lotId: task.lotId,
    quantity,
    unitCode: task.unitCode,
    serials: await taskSerials(tx, task.id),
  });
  if (!delivered.ok) {
    return stop(
      "not_allowed",
      `${delivered.error} Si no puedes entregarla, reporta el problema.`,
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
  return {
    ok: true,
    taskId: task.id,
    summary:
      `Dejaste ${formatStock(quantity.toString(), task.unitCode)} de ${task.product.name}${ofLot(task.lot)} en ${task.toLocation.name}` +
      (task.productionOrderLine
        ? ` para ${formatIssueOrderNumber(task.productionOrderLine.order.number)}.`
        : ".") +
      delivered.notes.map((note) => ` ${note}`).join(""),
  };
}

async function deliverReplenish(
  tx: Tx,
  actor: InventoryActor,
  task: ProductTask,
): Promise<TaskResult> {
  const hold = await tx.stockReservation.findFirst({
    where: { sourceType: TASK_HOLD, sourceId: task.id, state: "ACTIVE" },
    select: { id: true, remaining: true },
  });
  const quantity = dec(task.quantity.toString());
  if (!hold || dec(hold.remaining.toString()).lessThan(quantity)) {
    return stop(
      "not_allowed",
      `Lo apartado para esta tarea ya no está completo en ${task.fromLocation.name}. Si no puedes entregarla, reporta el problema.`,
    );
  }
  // First let go of the hold, so the move may take it.
  await consumeReservation(tx, hold.id, quantity);
  const moved = await postTaskTransfer(tx, actor, {
    productId: task.productId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    quantity: quantity.toString(),
    lotId: task.lotId,
    serials: await taskSerials(tx, task.id),
    taskId: task.id,
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
    summary:
      `Repusiste ${formatStock(quantity.toString(), task.unitCode)} de ${task.product.name}${ofLot(task.lot)} en ${task.toLocation.name}.` +
      (moved.notes ?? []).map((note) => ` ${note}`).join(""),
  };
}

/**
 * WMS-53 (ADR 0043): a task that moves a whole container (a put-away of a
 * pallet, or a transfer). The caller locked products → locations →
 * container → task; the container moves with the same core as moving it
 * by hand (`moveContainerWithin`, key `task:<id>`). A put-away goes where
 * the person scanned, like any put-away; a transfer to its destination.
 */
async function deliverContainer(
  tx: Tx,
  actor: InventoryActor,
  task: LockedTask,
  box: LockedContainer,
  destination: string,
  input: DeliverInput,
): Promise<TaskResult> {
  if (box.locationId !== task.fromLocationId) {
    return stop(
      "not_allowed",
      `${containerName(box)} ya no está en ${task.fromLocation.name}. Si no puedes entregarla, reporta el problema.`,
    );
  }
  const putaway = task.kind === "PUTAWAY";
  const place = putaway
    ? await putawayPlace(tx, actor, task, destination)
    : { id: task.toLocationId, name: task.toLocation.name };
  const recommended = place.id === task.toLocationId;
  const moved = await moveContainerWithin(tx, actor, box, place.id, {
    idempotencyKey: `task:${task.id}`,
    taskId: task.id,
    capacity:
      !putaway || recommended
        ? { mode: "report" }
        : { mode: "ask", accepted: input.acceptCapacity === true },
  });
  if (!moved.movementId) {
    // An empty container moves without a movement; the task needs one.
    return stop(
      "not_allowed",
      `${containerName(box)} está vacía: no hay nada que acomodar. Cancela la tarea.`,
    );
  }
  await tx.warehouseTask.update({
    where: { id: task.id },
    data: {
      status: "DELIVERED",
      deliveredAt: new Date(),
      movementId: moved.movementId,
      ...(putaway ? { placedLocationId: place.id } : {}),
    },
  });
  return {
    ok: true,
    taskId: task.id,
    summary:
      `${putaway ? "Acomodaste" : "Entregaste"} ${theContainer(box)} en ${place.name}.` +
      moved.notes.map((note) => ` ${note}`).join(""),
  };
}

// ── Photos of a delivery (WMS-37B, ADR 0076) ────────────────────────────

export type TaskPhotoResult =
  { ok: true; fileId: string } | { ok: false; error: string };

export type TaskPhotoMode = "off" | "optional" | "required";

const PHOTO_NOT_NOW =
  "Esta tarea ya no la estás entregando: vuelve a abrir la pantalla.";

/**
 * Keeps a photo taken to deliver a task: checked by its content and stored
 * without metadata, unlinked (seen only by who took it) until the task is
 * delivered, and gone after a day if it never is. Only for a task of this
 * person, inside their scope, with its load picked up — nobody stores
 * photos of a task they are not delivering — and while the company does
 * not turn photos off.
 */
export async function uploadTaskPhoto(
  actor: InventoryActor,
  taskId: string,
  input: { name: string; bytes: Uint8Array },
): Promise<TaskPhotoResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.task.execute",
  );
  const client = forOrganization(organizationId);
  const task = await client.warehouseTask.findFirst({
    where: {
      id: String(taskId ?? "").slice(0, 36),
      ...(await taskScope(client, userId)),
    },
    select: { id: true, status: true, assignedToUserId: true },
  });
  if (
    !task ||
    task.assignedToUserId !== userId ||
    task.status !== "PICKED_UP"
  ) {
    return { ok: false, error: PHOTO_NOT_NOW };
  }
  if ((await readSetting(client, TASK_PHOTO)) === "off") {
    return {
      ok: false,
      error: "Esta empresa no pide fotos al entregar una tarea.",
    };
  }
  // WMS-37B: taken for this task, it serves only this task.
  const stored: StoreFileResult = await storeFile(actor, {
    purpose: "task_photo",
    name: input.name,
    bytes: input.bytes,
    pendingOwnerId: task.id,
  });
  return stored.ok
    ? { ok: true, fileId: stored.fileId }
    : { ok: false, error: stored.error };
}

/**
 * «Quitar» a photo taken to deliver a task and not used: only one of this
 * person, not linked (a linked photo is never touched).
 */
export async function discardTaskPhoto(
  actor: InventoryActor,
  fileId: string,
): Promise<{ ok: boolean }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.execute",
  );
  const file = await forOrganization(actor.organizationId).storedFile.findFirst(
    {
      where: { id: String(fileId ?? "").slice(0, 36), purpose: "task_photo" },
      select: { id: true },
    },
  );
  return file ? deleteFile(actor, file.id) : { ok: false };
}

/**
 * Whether the person reaches a task — the same condition as `getTask`
 * (its origin and destination inside their warehouses and zones): who
 * decides if its photos exist for them (`evidenceOwners`, ADR 0063). The
 * permission to read is checked by the platform with the purpose's.
 */
export async function reachesTask(
  actor: InventoryActor,
  taskId: string,
): Promise<boolean> {
  const client = forOrganization(actor.organizationId);
  const task = await client.warehouseTask.findFirst({
    where: {
      id: String(taskId ?? "").slice(0, 36),
      ...(await taskScope(client, actor.userId)),
    },
    select: { id: true },
  });
  return task !== null;
}

/** Whether this company asks for a photo to deliver (for the screen). */
export async function taskPhotoMode(
  actor: InventoryActor,
): Promise<TaskPhotoMode> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  return (await readSetting(
    forOrganization(actor.organizationId),
    TASK_PHOTO,
  )) as TaskPhotoMode;
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
    // WMS-39: supervision of where it leaves from hears it now. A task can
    // be blocked again after being released: each report is its own fact.
    await notify(tx, TASK_BLOCKED_NOTICE, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      to: {
        permissions: ["inventory.task.create"],
        locationId: task.fromLocationId,
      },
      text: `${await memberName(tx, actor.userId)} reportó un problema en la tarea ${formatTaskNumber(task.number)}: ${why.data}`,
      href: `/tareas/${task.id}`,
      key: `task:${task.id}:blocked:${newId()}`,
    });
    return {
      ok: true,
      taskId: task.id,
      summary: `Reportaste un problema en la tarea ${formatTaskNumber(task.number)}. Tu supervisor la revisará.`,
    };
  });
}

// ── Several tasks at once (WMS-25, ADR 0054) ─────────────────────────────

/** How many tasks one step on several of them takes, at most. */
export const TASK_GROUP_MAX = 100;

export type TaskGroupResult =
  | {
      ok: true;
      summary: string;
      /** How many tasks the step changed (0 when all were already so). */
      count: number;
      repeated?: true;
    }
  | Failure;

async function inGroup(
  organizationId: string,
  work: (tx: Tx) => Promise<TaskGroupResult>,
): Promise<TaskGroupResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      work,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof TaskRejected) return error.result;
    if (error instanceof CapacityNotice) {
      return {
        ok: false,
        reason: "not_allowed",
        formError: error.result.formError,
      };
    }
    throw error;
  }
}

const groupIds = (taskIds: readonly unknown[]) =>
  [
    ...new Set(
      taskIds
        .map((id) => String(id ?? "").slice(0, 36))
        .filter((id) => id !== ""),
    ),
  ].slice(0, TASK_GROUP_MAX);

const CHANGED =
  "Estas tareas cambiaron mientras tanto. Vuelve a abrir la ola y revisa lo que sigue.";

/** What several tasks move, read before their transaction (never changes). */
async function fixedOf(organizationId: string, ids: string[]) {
  return forOrganization(organizationId).warehouseTask.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      productId: true,
      fromLocationId: true,
      toLocationId: true,
      outboundLine: { select: { orderId: true } },
      productionOrderLine: { select: { orderId: true } },
    },
  });
}

/** WMS-28: the production orders of ISSUE tasks, locked before the tasks. */
const productionOrderIdsOf = (fixed: Awaited<ReturnType<typeof fixedOf>>) => [
  ...new Set(
    fixed
      .map((task) => task.productionOrderLine?.orderId)
      .filter((id): id is string => Boolean(id)),
  ),
];

const orderIdsOf = (fixed: Awaited<ReturnType<typeof fixedOf>>) => [
  ...new Set(
    fixed
      .map((task) => task.outboundLine?.orderId)
      .filter((id): id is string => Boolean(id)),
  ),
];

/** Says which task a refusal is about, when several go together. */
async function each(
  task: { number: number },
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof TaskRejected)) throw error;
    const message =
      error.result.formError ??
      Object.values(error.result.fieldErrors ?? {})[0];
    throw new TaskRejected({
      ...error.result,
      formError: `${formatTaskNumber(task.number)}: ${message ?? "no se pudo cambiar."}`,
      fieldErrors: error.result.fieldErrors,
    });
  }
}

/**
 * Picking of several tasks with one scan (WMS-25): PICK tasks of the same
 * product, origin and lot — «Toma 30: 10 para PS-0001, 12 para PS-0002…».
 * In one transaction each one is taken (when it was available or given to
 * this person) and confirmed with its whole quantity, with the rules of
 * `confirmPick`; if one fails, nothing changes. Less than asked, or a
 * product by serial, is confirmed task by task. Locks: product → orders →
 * tasks.
 */
export async function confirmPickGroup(
  actor: InventoryActor,
  taskIds: readonly unknown[],
  input: Omit<ConfirmPickInput, "quantity" | "shortReason" | "serials">,
): Promise<TaskGroupResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.task.execute",
  );
  const ids = groupIds(taskIds);
  if (ids.length === 0) {
    return { ok: false, reason: "invalid", formError: "Elige qué surtes." };
  }
  const fixed = await fixedOf(organizationId, ids);
  const products = [...new Set(fixed.map((task) => task.productId))];
  if (fixed.length !== ids.length || products.length !== 1 || !products[0]) {
    return { ok: false, reason: "not_found", formError: CHANGED };
  }
  return inGroup(organizationId, async (tx) => {
    await lockRows(tx, "product", [products[0]!]);
    await lockRows(tx, "outboundOrder", orderIdsOf(fixed));
    await lockRows(tx, "warehouseTask", ids);
    let first: LockedTask | null = null;
    let total = dec(0);
    let changed = 0;
    const orders = new Set<string>();
    for (const id of [...ids].sort()) {
      let task = await lockTask(tx, id, userId);
      if (task.kind !== "PICK" || !task.outboundLine) {
        return stop("not_allowed", "Esta tarea no es de surtido.");
      }
      if (task.product?.tracking === "SERIAL") {
        return stop(
          "not_allowed",
          "Un producto por serie se surte pedido por pedido: escanea las series en cada tarea.",
        );
      }
      if (
        first &&
        (task.productId !== first.productId ||
          task.fromLocationId !== first.fromLocationId ||
          task.lotId !== first.lotId)
      ) {
        return stop("not_allowed", CHANGED);
      }
      first ??= task;
      const mine = task.assignedToUserId === userId;
      const takeable =
        task.status === "PENDING" ||
        (mine && ["ASSIGNED", "ACCEPTED", "PICKED_UP"].includes(task.status));
      if (!takeable) {
        return stop(
          "not_allowed",
          task.assignedToUserId && !mine
            ? `${formatTaskNumber(task.number)} la tiene otra persona. Vuelve a abrir la ola.`
            : `${formatTaskNumber(task.number)} ya cambió. Vuelve a abrir la ola.`,
        );
      }
      const quantity = dec(task.quantity!.toString());
      const current = task;
      await each(current, async () => {
        if (current.status === "PENDING" || current.status === "ASSIGNED") {
          await acceptLocked(tx, actor, current);
          task = await lockTask(tx, id, userId);
        }
        const done = await confirmPickLocked(tx, actor, task, {
          ...input,
          quantity: quantity.toString(),
        });
        if (done.ok && !done.repeated) changed++;
      });
      total = total.plus(quantity);
      orders.add(task.outboundLine!.orderId);
    }
    const head = ofProduct(first!);
    if (changed === 0) {
      return {
        ok: true,
        count: 0,
        repeated: true,
        summary: "Ya habías confirmado lo que surtiste.",
      };
    }
    return {
      ok: true,
      count: changed,
      summary: `Surtiste ${formatStock(total.toString(), head.unitCode)} de ${head.product.name} para ${orders.size === 1 ? "1 pedido" : `${orders.size} pedidos`}. Llévalo a ${head.toLocation.name}.`,
    };
  });
}

/**
 * Leaves in staging every PICK task given that this person picked
 * (WMS-25): each one writes its own move (`task:<id>`) and keeps what was
 * picked reserved there for its line, as `deliverTask` does, in one
 * transaction. Locks: products → locations → orders → tasks.
 */
export async function deliverPickGroup(
  actor: InventoryActor,
  taskIds: readonly unknown[],
): Promise<TaskGroupResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.task.execute",
  );
  const ids = groupIds(taskIds);
  if (ids.length === 0) {
    return {
      ok: false,
      reason: "invalid",
      formError: "No hay nada que dejar.",
    };
  }
  const fixed = await fixedOf(organizationId, ids);
  if (
    fixed.length !== ids.length ||
    fixed.some((task) => task.kind !== "PICK" || !task.productId)
  ) {
    return { ok: false, reason: "not_found", formError: CHANGED };
  }
  return inGroup(organizationId, async (tx) => {
    await lockRows(
      tx,
      "product",
      fixed.map((task) => task.productId!),
    );
    await lockRows(
      tx,
      "location",
      fixed.flatMap((task) => [task.fromLocationId, task.toLocationId]),
    );
    await lockRows(tx, "outboundOrder", orderIdsOf(fixed));
    await lockRows(tx, "warehouseTask", ids);
    let changed = 0;
    const notes: string[] = [];
    const places = new Set<string>();
    // WMS-37B (ADR 0076): a photo is evidence of one task, so a company
    // that demands it delivers task by task (each with its photo).
    const photoRequired = (await readSetting(tx, TASK_PHOTO)) === "required";
    for (const id of [...ids].sort()) {
      const task = await lockTask(tx, id, userId);
      if (task.assignedToUserId !== userId) {
        return stop(
          "not_allowed",
          `${formatTaskNumber(task.number)} la tiene otra persona.`,
        );
      }
      if (task.status === "DELIVERED") continue;
      if (task.status !== "PICKED_UP") {
        return stop(
          "not_allowed",
          `${formatTaskNumber(task.number)} todavía no está surtida.`,
        );
      }
      if (photoRequired) return stop("invalid", GROUP_NEEDS_PHOTO);
      await each(task, async () => {
        ensure(task, "DELIVERED");
        const done = await deliverPickTask(tx, actor, ofProduct(task), false);
        notes.push(...done.notes);
      });
      places.add(task.toLocation.name);
      changed++;
    }
    // The waves last, after every move and its capacity (lock order).
    for (const orderId of orderIdsOf(fixed).sort()) {
      await settleWaveOf(tx, orderId);
    }
    if (changed === 0) {
      return {
        ok: true,
        count: 0,
        repeated: true,
        summary: "Ya lo habías dejado. No se movió nada de nuevo.",
      };
    }
    return {
      ok: true,
      count: changed,
      summary:
        `Dejaste ${changed === 1 ? "1 tarea" : `${changed} tareas`} en ${[...places].join(" y ")}.` +
        [...new Set(notes)].map((note) => ` ${note}`).join(""),
    };
  });
}

/**
 * Takes for this person every task given that is still available or
 * given to them (WMS-25, «Tomar las de esta zona»). A task someone else
 * took meanwhile is left alone. Locks: orders → tasks.
 */
export async function takeTasks(
  actor: InventoryActor,
  taskIds: readonly unknown[],
): Promise<TaskGroupResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.task.execute",
  );
  const ids = groupIds(taskIds);
  if (ids.length === 0) {
    return {
      ok: false,
      reason: "invalid",
      formError: "No hay tareas que tomar.",
    };
  }
  const fixed = await fixedOf(organizationId, ids);
  return inGroup(organizationId, async (tx) => {
    await lockRows(tx, "outboundOrder", orderIdsOf(fixed));
    await lockRows(tx, "productionOrder", productionOrderIdsOf(fixed));
    const locked = await lockRows(tx, "warehouseTask", ids);
    let changed = 0;
    let withEquipment = 0;
    for (const id of locked) {
      const task = await lockTask(tx, id, userId);
      const free =
        task.status === "PENDING" ||
        (task.status === "ASSIGNED" && task.assignedToUserId === userId);
      if (!free) continue;
      // WMS-42: one that asks for equipment is taken alone, saying which.
      if (task.equipmentTypeId) {
        withEquipment++;
        continue;
      }
      await acceptLocked(tx, actor, task);
      changed++;
    }
    const alone =
      withEquipment === 0
        ? ""
        : withEquipment === 1
          ? " 1 pide equipo: tómala sola."
          : ` ${withEquipment} piden equipo: tómalas una por una.`;
    return changed === 0
      ? {
          ok: true,
          count: 0,
          repeated: true,
          summary:
            withEquipment > 0
              ? `No tomaste ninguna.${alone}`
              : "No quedaba ninguna disponible: alguien ya las tomó.",
        }
      : {
          ok: true,
          count: changed,
          summary:
            (changed === 1
              ? "Tomaste 1 tarea."
              : `Tomaste ${changed} tareas.`) + alone,
        };
  });
}

/**
 * Gives to one person every task given that is still available (WMS-25,
 * «Asignar las de esta zona»), with the rules of `assignTask`: they can do
 * tasks and reach where each one leaves from and goes. Locks: orders →
 * tasks.
 */
export async function assignTasks(
  actor: InventoryActor,
  taskIds: readonly unknown[],
  assignToUserId: string,
): Promise<TaskGroupResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "inventory.task.create");
  const target = String(assignToUserId ?? "")
    .trim()
    .slice(0, 36);
  if (!target) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { assignToUserId: "Elige a quién se las das." },
    };
  }
  if (!(await mayExecute(organizationId, target))) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        assignToUserId: "Esa persona no puede hacer tareas de traslado.",
      },
    };
  }
  const ids = groupIds(taskIds);
  if (ids.length === 0) {
    return {
      ok: false,
      reason: "invalid",
      formError: "No hay tareas disponibles que asignar.",
    };
  }
  const fixed = await fixedOf(organizationId, ids);
  return inGroup(organizationId, async (tx) => {
    await lockRows(tx, "outboundOrder", orderIdsOf(fixed));
    await lockRows(tx, "productionOrder", productionOrderIdsOf(fixed));
    const locked = await lockRows(tx, "warehouseTask", ids);
    const tasks = [];
    for (const id of locked) {
      const task = await lockTask(tx, id, userId);
      if (task.status === "PENDING") tasks.push(task);
    }
    const outside = await locationsOutOfScope(
      tx,
      target,
      tasks.flatMap((task) => [task.fromLocationId, task.toLocationId]),
    );
    if (outside.length > 0) {
      return stop("invalid", ASSIGNEE_OUT_OF_SCOPE, "assignToUserId");
    }
    for (const task of tasks) {
      await tx.warehouseTask.update({
        where: { id: task.id },
        data: { status: "ASSIGNED", assignedToUserId: target },
      });
    }
    // WMS-39: whoever gets them hears it once for the whole group.
    if (tasks.length > 0) {
      const first = tasks[0]!;
      await notify(tx, TASK_ASSIGNED_NOTICE, {
        organizationId,
        actorUserId: userId,
        to: {
          userIds: [target],
          permissions: ["inventory.task.read"],
          locationIds: tasks.flatMap((task) => [
            task.fromLocationId,
            task.toLocationId,
          ]),
        },
        text:
          tasks.length === 1
            ? `${await memberName(tx, userId)} te asignó la tarea ${formatTaskNumber(first.number)}.`
            : `${await memberName(tx, userId)} te asignó ${tasks.length} tareas.`,
        href: tasks.length === 1 ? `/tareas/${first.id}` : "/tareas?vista=mine",
        key: `task:${first.id}:assigned:${target}:${tasks.length}`,
      });
    }
    return tasks.length === 0
      ? {
          ok: true,
          count: 0,
          repeated: true,
          summary: "No quedaba ninguna disponible: ya las tomaron.",
        }
      : {
          ok: true,
          count: tasks.length,
          summary:
            tasks.length === 1
              ? "Asignaste 1 tarea."
              : `Asignaste ${tasks.length} tareas.`,
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
    // WMS-39: who gets the task hears it (once per task and person).
    if (target) {
      await notify(tx, TASK_ASSIGNED_NOTICE, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        to: {
          userIds: [target],
          permissions: ["inventory.task.read"],
          locationIds: [task.fromLocationId, task.toLocationId],
        },
        text: `${await memberName(tx, actor.userId)} te asignó la tarea ${formatTaskNumber(task.number)}.`,
        href: `/tareas/${task.id}`,
        key: `task:${task.id}:assigned:${target}`,
      });
    }
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
        // WMS-42: and says which equipment they use.
        equipmentId: null,
      },
    });
    // WMS-21B: and scans again the units they take.
    await tx.warehouseTaskSerial.deleteMany({ where: { taskId: task.id } });
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
          lotId: task.lotId,
          quantity: dec(task.quantity!.toString()),
        },
        dec(0),
      );
      await settlePickedOrder(tx, task.outboundLine.orderId);
    }
    // WMS-28: what an ISSUE task held for its production order is free
    // again in its origin (like a picking task's).
    if (task.kind === "ISSUE" && task.productionOrderLineId) {
      await releaseIssueReservation(tx, {
        productionOrderLineId: task.productionOrderLineId,
        fromLocationId: task.fromLocationId,
        lotId: task.lotId,
        quantity: dec(task.quantity!.toString()),
      });
    }
    // WMS-52/24: what a put-away or a replenishment held in its place is
    // free again.
    if (task.kind === "PUTAWAY" || task.kind === "REPLENISH") {
      await releaseReservations(tx, { type: TASK_HOLD, id: task.id });
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
  /**
   * «TRANSFER» (a move asked by someone), «PICK» (an order, WMS-14) or
   * «PUTAWAY» (what waits in «General» or receiving, WMS-52) or
   * «REPLENISH» (fills a picking location from storage, WMS-24).
   */
  kind: "TRANSFER" | "PICK" | "PUTAWAY" | "REPLENISH" | "ISSUE";
  /** PICK: the order it picks for. */
  order: { id: string; numberText: string; recipient: string } | null;
  /** ISSUE (WMS-28): the production order it takes a material to. */
  productionOrder: { id: string; numberText: string } | null;
  /**
   * WMS-53: the container it moves whole, instead of a product; then
   * `productName` is its name («Tarima C-0001») and `sku` is empty.
   */
  container: { id: string; name: string; code: string } | null;
  productName: string;
  sku: string;
  /** «Lote L-01 · caduca 05/03/2027», for a product by lot (WMS-21). */
  lotText: string | null;
  /** Its code alone: what the person scans or types when picking. */
  lotCode: string | null;
  quantityText: string;
  fromPath: string;
  /**
   * Where it goes. PUTAWAY: where it was left once delivered; before, the
   * recommended place, or «Sin lugar recomendado».
   */
  toPath: string;
  assignedToUserId: string | null;
  assignedToName: string | null;
  createdAt: Date;
  /** WMS-42: the type of equipment it asks for («Montacargas»). */
  equipmentTypeName: string | null;
  /** WMS-42: the equipment it is done with, «MC-01 · Montacargas 1». */
  equipmentText: string | null;
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
  /** WMS-21B: the product is by serial: picking up asks the serials. */
  bySerial: boolean;
  /** The serials of the units it took, once scanned. */
  serials: string[];
  /**
   * PUTAWAY (WMS-52): the place the system recommended and its code (what
   * its label says), or null when there was none; and where it was really
   * left, once delivered.
   */
  recommendedPath: string | null;
  recommendedCode: string | null;
  placedPath: string | null;
  /** PICK (WMS-25): the open wave of its order, if any. */
  wave: { id: string; numberText: string } | null;
  /**
   * WMS-42: the equipment in use went out of service or was retired: the
   * load is not picked up with it (the person changes it).
   */
  equipmentStopped: boolean;
  /**
   * WMS-42: it asks for a type and is not taken yet, but its warehouse has
   * no piece of that type left (retired or changed): nobody can take it.
   */
  equipmentUnavailable: boolean;
  /**
   * WMS-37B (ADR 0076): photos of where it was left, with who took them
   * and when; only for who reaches the task.
   */
  photos: {
    fileId: string;
    url: string;
    width: number | null;
    height: number | null;
    byName: string | null;
    createdAt: Date;
  }[];
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
  productionOrderLine: {
    select: { order: { select: { id: true, number: true } } },
  },
  quantity: true,
  unitCode: true,
  assignedToUserId: true,
  createdAt: true,
  product: { select: { name: true, sku: true } },
  container: { select: { id: true, code: true, kind: true } },
  lot: { select: { code: true, expiresOn: true } },
  fromLocationId: true,
  toLocationId: true,
  fromLocation: LOCATION_NAMES,
  toLocation: LOCATION_NAMES,
  placedLocation: LOCATION_NAMES,
  equipmentType: { select: { name: true } },
  equipment: { select: { code: true, name: true } },
} as const;

type SummaryRow = {
  id: string;
  number: number;
  status: WarehouseTaskStatus;
  priority: TaskPriority;
  kind: "TRANSFER" | "PICK" | "PUTAWAY" | "REPLENISH" | "ISSUE";
  outboundLine: {
    order: { id: string; number: number; recipient: string };
  } | null;
  productionOrderLine: { order: { id: string; number: number } } | null;
  quantity: { toString(): string } | null;
  unitCode: string | null;
  assignedToUserId: string | null;
  createdAt: Date;
  product: { name: string; sku: string } | null;
  container: { id: string; code: string; kind: string } | null;
  lot: { code: string; expiresOn: Date | null } | null;
  fromLocationId: string;
  toLocationId: string;
  fromLocation: LocationNames;
  toLocation: LocationNames;
  placedLocation: LocationNames | null;
  equipmentType: { name: string } | null;
  equipment: { code: string; name: string } | null;
};

/** WMS-52: a put-away whose destination is its origin had no recommendation. */
const recommendationOf = (row: SummaryRow): LocationNames | null =>
  row.kind === "PUTAWAY" && row.toLocationId === row.fromLocationId
    ? null
    : row.toLocation;

export const NO_RECOMMENDATION = "Sin lugar recomendado";

const toPathOf = (row: SummaryRow) => {
  if (row.placedLocation) return pathOf(row.placedLocation);
  const recommended = recommendationOf(row);
  return recommended ? pathOf(recommended) : NO_RECOMMENDATION;
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
  productionOrder: row.productionOrderLine
    ? {
        id: row.productionOrderLine.order.id,
        numberText: formatIssueOrderNumber(
          row.productionOrderLine.order.number,
        ),
      }
    : null,
  container: row.container
    ? {
        id: row.container.id,
        name: containerName(row.container),
        code: row.container.code,
      }
    : null,
  productName: row.container
    ? containerName(row.container)
    : (row.product?.name ?? ""),
  sku: row.product?.sku ?? "",
  lotText: row.lot
    ? lotLabel({ code: row.lot.code, expiresOn: lotDayOf(row.lot.expiresOn) })
    : null,
  lotCode: row.lot?.code ?? null,
  quantityText:
    row.quantity !== null && row.unitCode !== null
      ? formatStock(row.quantity.toString(), row.unitCode)
      : "Todo lo que trae",
  fromPath: pathOf(row.fromLocation),
  toPath: toPathOf(row),
  assignedToUserId: row.assignedToUserId,
  assignedToName: row.assignedToUserId
    ? (names.get(row.assignedToUserId) ?? null)
    : null,
  createdAt: row.createdAt,
  equipmentTypeName: row.equipmentType?.name ?? null,
  equipmentText: row.equipment ? equipmentLabel(row.equipment) : null,
});

export type TaskPage = {
  view: TaskListView;
  /** The person the open list is narrowed to (WMS-34), if any. */
  person: { userId: string; name: string } | null;
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
  options: {
    view?: unknown;
    page?: number;
    day?: unknown;
    /** Open view only: the tasks a person has (WMS-34, ADR 0085). */
    person?: unknown;
  } = {},
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
  // A person asked for in the open view counts only if they are in the
  // team (active or not) and have open tasks in this warehouse inside the
  // scope of who looks; otherwise the filter is ignored and nobody is named
  // (WMS-34, ADR 0085; the rule of WMS-32 for people).
  const scopeAnd = Object.keys(scope).length > 0 ? { AND: [scope] } : {};
  let askedPerson =
    view === "open" && typeof options.person === "string" && options.person
      ? await client.membership.findFirst({
          where: { userId: options.person.slice(0, 36) },
          select: { userId: true, user: { select: { name: true } } },
        })
      : null;
  if (
    askedPerson &&
    (await client.warehouseTask.count({
      where: {
        ...assignedOpenWhere(facility.id, askedPerson.userId),
        ...scopeAnd,
      },
    })) === 0
  ) {
    askedPerson = null;
  }
  const where = {
    ...(window
      ? deliveredOnWhere(window, { facilityId: facility.id })
      : askedPerson
        ? assignedOpenWhere(facility.id, askedPerson.userId)
        : { ...byView, fromLocation: { facilityId: facility.id } }),
    ...scopeAnd,
  };
  const total = await client.warehouseTask.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / TASK_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  // WMS-25 (ADR 0054): what a person has is walked once — urgent first,
  // then in walking order by the code of where each task leaves from. A
  // person's open tasks are few: they are read whole (up to a cap) and
  // ordered here; the other lists stay paginated in the database.
  const rows =
    view === "mine"
      ? (await myTasksInRoute(client, where)).slice(
          (page - 1) * TASK_PAGE_SIZE,
          page * TASK_PAGE_SIZE,
        )
      : await client.warehouseTask.findMany({
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
    person: askedPerson
      ? { userId: askedPerson.userId, name: askedPerson.user.name }
      : null,
  };
}

/** Tasks someone has and has not finished: assigned and still open. */
export const ASSIGNED_OPEN_STATUSES: readonly WarehouseTaskStatus[] = [
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
  "BLOCKED",
];

/**
 * The open work of the people of a warehouse (WMS-34, ADR 0085): tasks
 * leaving from it with a person and not finished. The same condition for
 * the count of the dashboard and for the list it opens.
 */
export function assignedOpenWhere(facilityId: string, personId?: string) {
  return {
    status: { in: [...ASSIGNED_OPEN_STATUSES] },
    fromLocation: { facilityId },
    assignedToUserId: personId ?? { not: null },
  };
}

/** People shown at most in the open work of the dashboard. */
export const OPEN_WORK_PEOPLE_MAX = 50;

export type OpenWorkRow = {
  userId: string;
  /** Null when the person is no longer in the team. */
  name: string | null;
  open: number;
  blocked: number;
};

/**
 * Open work per person in the active warehouse, inside the scope of who
 * asks (WMS-34, ADR 0085). The most loaded first.
 */
export async function listOpenWorkByPerson(
  actor: InventoryActor,
): Promise<{ rows: OpenWorkRow[]; truncated: boolean }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  const client = forOrganization(actor.organizationId);
  const [facility, scope] = await Promise.all([
    activeFacilityOf(client, actor.userId),
    taskScope(client, actor.userId),
  ]);
  const groups = await client.warehouseTask.groupBy({
    by: ["assignedToUserId", "status"],
    where: {
      ...assignedOpenWhere(facility.id),
      ...(Object.keys(scope).length > 0 ? { AND: [scope] } : {}),
    },
    orderBy: [{ assignedToUserId: "asc" }, { status: "asc" }],
    _count: { _all: true },
  });
  const byPerson = new Map<string, OpenWorkRow>();
  for (const group of groups) {
    if (!group.assignedToUserId) continue;
    const row = byPerson.get(group.assignedToUserId) ?? {
      userId: group.assignedToUserId,
      name: null,
      open: 0,
      blocked: 0,
    };
    row.open += group._count._all;
    if (group.status === "BLOCKED") row.blocked += group._count._all;
    byPerson.set(group.assignedToUserId, row);
  }
  const names = await namesOf(actor.organizationId, [...byPerson.keys()]);
  const rows = [...byPerson.values()]
    .map((row) => ({ ...row, name: names.get(row.userId) ?? null }))
    .sort(
      (a, b) =>
        b.open - a.open ||
        (a.name ?? "").localeCompare(b.name ?? "", "es") ||
        a.userId.localeCompare(b.userId),
    );
  return {
    rows: rows.slice(0, OPEN_WORK_PEOPLE_MAX),
    truncated: rows.length > OPEN_WORK_PEOPLE_MAX,
  };
}

/** A person's open tasks read whole to put them in walking order, at most. */
const MY_TASKS_MAX = 500;

const ROUTE_SELECT = {
  ...SUMMARY_SELECT,
  fromLocation: { select: { ...LOCATION_NAMES.select, code: true } },
} as const;

/** Tasks matching `where`, urgent first and then in walking order. */
async function myTasksInRoute(
  client: ReturnType<typeof forOrganization>,
  where: object,
) {
  const rows = await client.warehouseTask.findMany({
    where,
    orderBy: [{ priority: "desc" }, { number: "asc" }],
    take: MY_TASKS_MAX,
    select: ROUTE_SELECT,
  });
  const urgent = rows.filter((row) => row.priority === "URGENT");
  const normal = rows.filter((row) => row.priority !== "URGENT");
  const walk = (list: typeof rows) =>
    inRouteOrder(list, (row) => ({
      code: row.fromLocation.code,
      path: pathOf(row.fromLocation),
    }));
  return [...walk(urgent), ...walk(normal)];
}

/**
 * WMS-25: «Siguiente tarea» — the open task of this person that comes
 * after this one in walking order (or the first one, when this one was
 * the last place); null when they have no other.
 */
export async function nextTaskFor(
  actor: InventoryActor,
  taskId: string,
): Promise<{ id: string; numberText: string; fromPath: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scope = await taskScope(client, actor.userId);
  const mine = await myTasksInRoute(client, {
    assignedToUserId: actor.userId,
    status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP"] },
    fromLocation: { facilityId: facility.id },
    ...(Object.keys(scope).length > 0 ? { AND: [scope] } : {}),
  });
  const others = mine.filter((row) => row.id !== String(taskId ?? ""));
  if (others.length === 0) return null;
  const current = await client.warehouseTask.findFirst({
    where: { id: String(taskId ?? ""), ...scope },
    select: { fromLocation: ROUTE_SELECT.fromLocation },
  });
  const here = current
    ? routeKey({
        code: current.fromLocation.code,
        path: pathOf(current.fromLocation),
      })
    : null;
  const after = here
    ? others.find(
        (row) =>
          row.priority !== "URGENT" &&
          compareRoute(
            routeKey({
              code: row.fromLocation.code,
              path: pathOf(row.fromLocation),
            }),
            here,
          ) >= 0,
      )
    : undefined;
  // Something urgent always goes first.
  const next =
    others.find((row) => row.priority === "URGENT") ?? after ?? others[0]!;
  return {
    id: next.id,
    numberText: formatTaskNumber(next.number),
    fromPath: pathOf(next.fromLocation),
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
      product: { select: { name: true, sku: true, tracking: true } },
      toLocation: { select: { ...LOCATION_NAMES.select, code: true } },
      equipment: {
        select: { code: true, name: true, status: true, retiredAt: true },
      },
      equipmentTypeId: true,
      fromLocation: { select: { ...LOCATION_NAMES.select, facilityId: true } },
      serials: {
        orderBy: { id: "asc" },
        take: 1_000,
        select: { serialUnit: { select: { serial: true } } },
      },
      _count: { select: { photos: true } },
    },
  });
  if (!row) return null;
  // WMS-37B: the photos of its delivery, asked of their owner (this task).
  const photos =
    row._count.photos > 0
      ? await evidencePhotoLinks(
          actor,
          { kind: "warehouse_task", id: row.id },
          { warehouse_task: reachesTask },
        )
      : [];
  const names = await namesOf(actor.organizationId, [
    row.assignedToUserId,
    row.createdByUserId,
    ...photos.map((photo) => photo.createdByUserId),
  ]);
  // WMS-25: the open wave its order is in, to go back to it.
  const inWave = row.outboundLine
    ? await client.pickWaveOrder.findFirst({
        where: { openOrderId: row.outboundLine.order.id },
        select: { wave: { select: { id: true, number: true } } },
      })
    : null;
  return {
    ...summaryOf(row, names),
    wave: inWave
      ? {
          id: inWave.wave.id,
          numberText: formatWaveNumber(inWave.wave.number),
        }
      : null,
    quantity: row.quantity?.toString() ?? "",
    unitCode: row.unitCode ?? "",
    pickedText:
      row.pickedQuantity === null || row.unitCode === null
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
    bySerial: row.product?.tracking === "SERIAL",
    serials: row.serials.map((item) => item.serialUnit.serial),
    recommendedPath: recommendationOf(row) ? pathOf(row.toLocation) : null,
    recommendedCode: recommendationOf(row) ? row.toLocation.code : null,
    placedPath: row.placedLocation ? pathOf(row.placedLocation) : null,
    equipmentStopped: row.equipment
      ? row.equipment.status !== "IN_SERVICE" ||
        row.equipment.retiredAt !== null
      : false,
    equipmentUnavailable:
      row.equipmentTypeId !== null &&
      (row.status === "PENDING" || row.status === "ASSIGNED") &&
      (await client.equipment.count({
        where: {
          typeId: row.equipmentTypeId,
          facilityId: row.fromLocation.facilityId,
          retiredAt: null,
        },
      })) === 0,
    photos: photos.map((photo) => ({
      fileId: photo.fileId,
      url: photo.url,
      width: photo.width,
      height: photo.height,
      byName: names.get(photo.createdByUserId) ?? null,
      createdAt: photo.createdAt,
    })),
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

/**
 * WMS-42: the equipment this person may choose to take a task that asks
 * for a type (or to change the one in use): empty for a task that asks
 * for none or that is outside their scope. Checked again when taking.
 */
export async function taskEquipmentChoices(
  actor: InventoryActor,
  taskId: string,
): Promise<EquipmentChoice[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.execute",
  );
  const client = forOrganization(actor.organizationId);
  const task = await client.warehouseTask.findFirst({
    where: {
      id: String(taskId ?? ""),
      ...(await taskScope(client, actor.userId)),
    },
    select: {
      equipmentTypeId: true,
      fromLocation: { select: { facilityId: true } },
    },
  });
  if (!task?.equipmentTypeId) return [];
  return equipmentChoices(client, {
    facilityId: task.fromLocation.facilityId,
    typeId: task.equipmentTypeId,
    userId: actor.userId,
  });
}
