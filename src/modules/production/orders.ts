import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import {
  PRODUCTION_ORDER_LINE_SOURCE,
  formatStock,
  issuePlacementProblem,
  nextTaskNumber,
  pickSources,
  setAsideForProduction,
  type PickSource,
} from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  ARCHIVED_FACILITY_MESSAGE,
  LOCATION_PARENTS,
  activeFacilityOf,
  holdOpenFacility,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import {
  ProcessStagesPending,
  assertStagesDone,
  completeOperationStage,
  operationWaits,
  reachMilestone,
  setProcessPlace,
  startProcess,
} from "@/platform/processes";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { noticeOrderStillWaits } from "./make-to-order";
import {
  PRODUCTION_ORDER_PROCESS,
  PRODUCTION_ORDER_RELEASED_OPERATION,
} from "./order-process";
import { fitsLine, scaleInput, scaleOutput } from "./order-rules";
import {
  OPEN_PRODUCTION_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  formatProductionNumber,
  isProductionOrderStatus,
  productionTransitionProblem,
  type ProductionOrderStatus,
} from "./order-states";
import { formatRecipeVersion } from "./recipe-states";
import { formatProductionRequestNumber } from "./request-states";
import type { ProductionActor } from "./recipes";
import { MATERIALS_MODE, RELEASE_SHORT } from "./settings";

/**
 * Production orders (WMS-28, ADR 0073): a product with its recipe in force,
 * a quantity and a production area of the warehouse the person works in.
 * The order copies the version of the recipe scaled to its quantity; a
 * draft changes (and copies the recipe in force again); releasing it sets
 * each material aside where it will be taken from, what expires first
 * first, and — when the company brings materials to the line — creates its
 * «Surtir a producción» tasks. Cancelling lets go of everything.
 *
 * Locks: products (the materials, sorted) → locations (the area) → order →
 * tasks → progress of the process. An order exists only for who reaches
 * its area (WMS-20).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const PRODUCTION_PAGE_SIZE = 25;
/** People an order may have assigned. */
export const PRODUCTION_MAX_ASSIGNEES = 20;

export type ProductionOrderField =
  | "productId"
  | "quantity"
  | "areaLocationId"
  | "dueOn"
  | "priority"
  | "note"
  | "assigneeIds"
  | "reason";

export type ProductionShortage = {
  lineId: string;
  productName: string;
  /** «30 hojas». */
  needed: string;
  /** «25 hojas». */
  free: string;
};

export type ProductionOrderResult =
  | { ok: true; orderId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed" | "short";
      fieldErrors?: Partial<Record<ProductionOrderField, string>>;
      formError?: string;
      /** When releasing: what does not reach (nothing was set aside). */
      shortages?: ProductionShortage[];
      /** False when the company does not release an incomplete order. */
      mayTakeWhatThereIs?: boolean;
    };

type Failure = Extract<ProductionOrderResult, { ok: false }>;

/**
 * A failure inside the transaction of an order: everything rolls back.
 * Exported inside the module for WMS-28B (accepting a request runs the
 * same cores in its transaction); never from index.ts.
 */
export class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("production order rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: ProductionOrderField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Esta orden de producción no existe.";
const CHANGED = "La orden cambió mientras la liberabas. Inténtalo de nuevo.";
export const idOf = (value: unknown) => String(value ?? "").slice(0, 36);

/** Retry-safe clash of a consecutive number (orders or tasks). */
export const isNumberClash = (error: unknown) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes("number");

/**
 * Runs a step of an order: one transaction with its locks, tried again
 * when two documents took the same number at once.
 */
async function inOrder(
  organizationId: string,
  work: (tx: Tx) => Promise<ProductionOrderResult>,
): Promise<ProductionOrderResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await forOrganization(organizationId).$transaction(
        work,
        LOCKING_TRANSACTION,
      );
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      // A stage of the process was missing after all (the release asks
      // first, so it should not happen): everything rolled back.
      if (error instanceof ProcessStagesPending) {
        return { ok: false, reason: "not_allowed", formError: error.message };
      }
      if (isNumberClash(error) && attempt < 4) continue;
      throw error;
    }
  }
}

// ── The order under its lock ─────────────────────────────────────────────

const LOCKED_SELECT = {
  id: true,
  number: true,
  status: true,
  facilityId: true,
  areaLocationId: true,
  productId: true,
  recipeVersionId: true,
  quantity: true,
  unitCode: true,
  priority: true,
  product: { select: { name: true, status: true, unitCode: true } },
  lines: {
    orderBy: { lineNumber: "asc" as const },
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitCode: true,
      product: { select: { name: true, status: true, unitCode: true } },
    },
  },
} as const;

/**
 * The order under its lock. An order whose area is outside the scope of
 * who asks does not exist for them (WMS-20).
 */
async function lockOrder(tx: Tx, orderId: string, userId: string) {
  const [id] = await lockRows(tx, "productionOrder", [idOf(orderId)]);
  const order = id
    ? await tx.productionOrder.findFirst({
        where: { id },
        select: LOCKED_SELECT,
      })
    : null;
  if (!order) return stop("not_found", NOT_FOUND);
  if (
    (await locationsOutOfScope(tx, userId, [order.areaLocationId])).length > 0
  ) {
    return stop("not_found", NOT_FOUND);
  }
  return order;
}

/**
 * The warehouse of an order, read before its transaction (it never
 * changes). Creating, saving and changing the people of an order take a
 * shared lock of its row FIRST (by the primary key, like every lock, ADR
 * 0074): those steps lock no product, and changing locations (changeTree:
 * editing, moving, archiving) locks every warehouse in exclusive mode
 * before a location and counts the open orders of an area under that
 * lock. So an order is never created or saved with an area that is being
 * archived or changing its use (one waits for the other), and the area
 * need not be locked itself.
 *
 * The rule (review of WMS-28, ADR 0074): an operation that locks products
 * NEVER takes the warehouse before them (products → warehouse → location).
 * Releasing and cancelling lock products → order and take no warehouse:
 * the foreign key of the order checks it when its state is written, a
 * shared lock on the unique index that no exclusive lock competes for.
 * WMS-29 and WMS-31 follow the same rule.
 */
async function facilityOfOrder(
  organizationId: string,
  orderId: string,
): Promise<string | null> {
  const row = await forOrganization(organizationId).productionOrder.findFirst({
    where: { id: idOf(orderId) },
    select: { facilityId: true },
  });
  return row?.facilityId ?? null;
}

/**
 * The warehouse of the order, shared, first (ADR 0073/0074); an archived
 * one stops everything (WMS-82, ADR 0077).
 */
export const shareFacility = async (tx: Tx, facilityId: string | null) => {
  if (!facilityId) return;
  if (!(await holdOpenFacility(tx, facilityId))) {
    stop("not_allowed", ARCHIVED_FACILITY_MESSAGE);
  }
};

// ── Header ───────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Usa como máximo ${max} caracteres.`)
    .optional()
    .transform((value) => value || null);

const headerSchema = z.object({
  quantity: z.string().trim().min(1, "Escribe cuánto se va a producir."),
  areaLocationId: z.string().trim().min(1, "Elige el área de producción."),
  dueOn: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine(
      (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
      "Escribe la fecha como año-mes-día.",
    )
    .refine(
      (value) =>
        value === null ||
        !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()),
      "Esa fecha no existe.",
    ),
  priority: z
    .string()
    .optional()
    .transform((value): "NORMAL" | "URGENT" =>
      value === "URGENT" ? "URGENT" : "NORMAL",
    ),
  note: optionalText(500),
  assigneeIds: z
    .array(z.string().max(36))
    .max(
      PRODUCTION_MAX_ASSIGNEES,
      `Asigna como máximo ${PRODUCTION_MAX_ASSIGNEES} personas.`,
    )
    .optional()
    .transform((ids) => [...new Set((ids ?? []).filter(Boolean))]),
});

export type ProductionOrderInput = z.input<typeof headerSchema>;
export type ProductionOrderHeader = z.output<typeof headerSchema>;

export function readHeader(input: ProductionOrderInput) {
  const parsed = headerSchema.safeParse({
    ...input,
    quantity: String(input.quantity ?? ""),
    areaLocationId: String(input.areaLocationId ?? ""),
  });
  if (parsed.success) return { ok: true as const, data: parsed.data };
  const fieldErrors: Partial<Record<ProductionOrderField, string>> = {};
  for (const issue of parsed.error.issues) {
    fieldErrors[issue.path[0] as ProductionOrderField] ??= issue.message;
  }
  return { ok: false as const, fieldErrors };
}

const dayOf = (value: string | null) =>
  value ? new Date(`${value}T00:00:00.000Z`) : null;

/** The area of an order: a production location of the warehouse, in scope. */
async function areaOf(
  tx: Tx,
  userId: string,
  facilityId: string,
  areaLocationId: string,
) {
  const area = await tx.location.findFirst({
    where: { id: idOf(areaLocationId), facilityId, isTransit: null },
    select: { id: true, name: true, type: true, archivedAt: true },
  });
  if (!area || (await locationsOutOfScope(tx, userId, [area.id])).length > 0) {
    return stop(
      "invalid",
      "Elige un área de producción de este almacén.",
      "areaLocationId",
    );
  }
  if (area.archivedAt) {
    return stop(
      "invalid",
      `${area.name} está archivada: elige otra área.`,
      "areaLocationId",
    );
  }
  if (area.type !== "PRODUCTION") {
    return stop(
      "invalid",
      `${area.name} no es un área de producción: cambia su uso a «Producción» en Ubicaciones o elige otra.`,
      "areaLocationId",
    );
  }
  return area;
}

/**
 * The people assigned, checked: active members who may report production
 * (`production.report.create`) and reach the area. Asked before the
 * transaction (permissions read the database on their own) and the scope
 * inside it.
 */
export async function assignable(
  organizationId: string,
  ids: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (ids.length === 0) return { ok: true };
  const members = await forOrganization(organizationId).membership.findMany({
    where: { userId: { in: ids }, status: "ACTIVE" },
    select: { userId: true },
  });
  if (members.length !== ids.length) {
    return { ok: false, message: "Elige personas del equipo." };
  }
  const allowed = await Promise.all(
    ids.map((id) => isAllowed(organizationId, id, "production.report.create")),
  );
  if (allowed.some((ok) => !ok)) {
    return {
      ok: false,
      message:
        "Asigna solo a personas que pueden reportar producción (Operario o Encargado de producción).",
    };
  }
  return { ok: true };
}

async function assigneesReachArea(
  tx: Tx,
  ids: string[],
  areaLocationId: string,
): Promise<void> {
  for (const id of ids) {
    if ((await locationsOutOfScope(tx, id, [areaLocationId])).length > 0) {
      stop(
        "invalid",
        "Una de esas personas no trabaja en el almacén o la zona de esta área.",
        "assigneeIds",
      );
    }
  }
}

async function writeAssignees(
  tx: Tx,
  actor: ProductionActor,
  orderId: string,
  ids: string[],
): Promise<void> {
  const current = await tx.productionOrderAssignee.findMany({
    where: { orderId },
    select: { id: true, userId: true },
  });
  const gone = current.filter((row) => !ids.includes(row.userId));
  if (gone.length > 0) {
    await tx.productionOrderAssignee.deleteMany({
      where: { id: { in: gone.map((row) => row.id) } },
    });
  }
  const have = new Set(current.map((row) => row.userId));
  const added = ids.filter((id) => !have.has(id));
  if (added.length > 0) {
    await tx.productionOrderAssignee.createMany({
      data: added.map((userId) => ({
        id: newId(),
        organizationId: actor.organizationId,
        orderId,
        userId,
        createdByUserId: actor.userId,
      })),
    });
  }
}

// ── Copying the recipe ───────────────────────────────────────────────────

type CopiedRecipe = {
  versionId: string;
  versionNumber: number;
  quantity: Decimal;
  unitCode: string;
  productName: string;
  lines: {
    productId: string;
    quantity: Decimal;
    unitCode: string;
    recipeQuantity: string;
    scrapPercent: string | null;
  }[];
  outputs: {
    productId: string;
    quantity: Decimal;
    unitCode: string;
    costShare: string;
  }[];
};

/**
 * The recipe in force of a product, scaled to a quantity, with every check
 * of the recipe against the catalog of today (ADR 0066: activating it did
 * not lock products): the product and every line active, units unchanged.
 */
async function copyRecipe(
  tx: Tx,
  productId: string,
  typedQuantity: string,
): Promise<CopiedRecipe> {
  const product = await tx.product.findFirst({
    where: { id: idOf(productId) },
    select: {
      id: true,
      name: true,
      status: true,
      unitCode: true,
      quantityStep: true,
    },
  });
  if (!product)
    return stop("not_found", "Ese producto no existe.", "productId");
  if (product.status !== "ACTIVE") {
    return stop(
      "not_allowed",
      `${product.name} está archivado: no se produce.`,
      "productId",
    );
  }
  const parsed = parseQuantity(
    {
      unitCode: product.unitCode,
      quantityStep: product.quantityStep.toString(),
    },
    typedQuantity,
  );
  if (!parsed.ok) return stop("invalid", parsed.error, "quantity");
  const version = await tx.recipeVersion.findFirst({
    where: { status: "ACTIVE", recipe: { productId: product.id } },
    select: {
      id: true,
      number: true,
      baseQuantity: true,
      unitCode: true,
      inputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          productId: true,
          baseQuantity: true,
          unitCode: true,
          scrapPercent: true,
        },
      },
      outputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          productId: true,
          quantity: true,
          unitCode: true,
          costShare: true,
        },
      },
    },
  });
  if (!version) {
    return stop(
      "not_allowed",
      `${product.name} no tiene una receta vigente: actívala en su ficha antes de crear la orden.`,
      "productId",
    );
  }
  if (version.unitCode !== product.unitCode) {
    return stop(
      "not_allowed",
      `La unidad de ${product.name} cambió desde que se activó su receta: haz una versión nueva de la receta.`,
      "productId",
    );
  }
  const ids = [
    ...new Set([
      ...version.inputs.map((line) => line.productId),
      ...version.outputs.map((line) => line.productId),
    ]),
  ];
  const products = new Map(
    (
      await tx.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          status: true,
          unitCode: true,
          quantityStep: true,
        },
      })
    ).map((row) => [row.id, row]),
  );
  const base = version.baseQuantity.toString();
  const lineProblem = (
    line: { productId: string; unitCode: string },
    what: string,
  ) => {
    const item = products.get(line.productId);
    if (!item) return `Un ${what} de la receta ya no existe.`;
    if (item.status !== "ACTIVE") {
      return `${item.name} está archivado: haz una versión nueva de la receta sin él o reactívalo.`;
    }
    if (item.unitCode !== line.unitCode) {
      return `La unidad de ${item.name} cambió desde que se activó la receta: haz una versión nueva de la receta.`;
    }
    return null;
  };
  const lines = version.inputs.map((line) => {
    const problem = lineProblem(line, "material");
    if (problem) return stop("not_allowed", problem, "productId");
    const item = products.get(line.productId)!;
    const quantity = scaleInput(
      line.baseQuantity.toString(),
      parsed.quantity,
      base,
      item.quantityStep.toString(),
    );
    if (!fitsLine(quantity)) {
      return stop(
        "invalid",
        `Con esa cantidad, ${item.name} pasa del máximo: produce menos en cada orden.`,
        "quantity",
      );
    }
    return {
      productId: line.productId,
      quantity,
      unitCode: line.unitCode,
      recipeQuantity: line.baseQuantity.toString(),
      scrapPercent: line.scrapPercent?.toString() ?? null,
    };
  });
  const outputs = version.outputs.map((line) => {
    const problem = lineProblem(line, "producto que sale");
    if (problem) return stop("not_allowed", problem, "productId");
    const item = products.get(line.productId)!;
    const quantity = scaleOutput(
      line.quantity.toString(),
      parsed.quantity,
      base,
      item.quantityStep.toString(),
    );
    if (!fitsLine(quantity)) {
      return stop(
        "invalid",
        `Con esa cantidad, ${item.name} pasa del máximo: produce menos en cada orden.`,
        "quantity",
      );
    }
    return {
      productId: line.productId,
      quantity,
      unitCode: line.unitCode,
      costShare: line.costShare.toString(),
    };
  });
  // What the order makes must come out: the product itself when it is an
  // output, or at least something when the recipe takes it apart.
  const main = outputs.find((line) => line.productId === product.id);
  if (
    main
      ? main.quantity.isZero()
      : outputs.every((line) => line.quantity.isZero())
  ) {
    return stop(
      "invalid",
      `Con esa cantidad no sale nada de la receta (es para ${formatStock(base, version.unitCode)}): produce más.`,
      "quantity",
    );
  }
  return {
    versionId: version.id,
    versionNumber: version.number,
    quantity: parsed.quantity,
    unitCode: product.unitCode,
    productName: product.name,
    lines,
    outputs,
  };
}

async function writeCopy(
  tx: Tx,
  organizationId: string,
  orderId: string,
  copy: CopiedRecipe,
): Promise<void> {
  await tx.productionOrderLine.deleteMany({ where: { orderId } });
  await tx.productionOrderOutput.deleteMany({ where: { orderId } });
  await tx.productionOrderLine.createMany({
    data: copy.lines.map((line, index) => ({
      id: newId(),
      organizationId,
      orderId,
      lineNumber: index + 1,
      productId: line.productId,
      quantity: line.quantity.toString(),
      unitCode: line.unitCode,
      recipeQuantity: line.recipeQuantity,
      scrapPercent: line.scrapPercent,
    })),
  });
  await tx.productionOrderOutput.createMany({
    data: copy.outputs.map((line, index) => ({
      id: newId(),
      organizationId,
      orderId,
      lineNumber: index + 1,
      productId: line.productId,
      quantity: line.quantity.toString(),
      unitCode: line.unitCode,
      costShare: line.costShare,
    })),
  });
}

// ── Creating and changing a draft ────────────────────────────────────────

/**
 * «Nueva orden»: a draft in the warehouse the person works in, with the
 * recipe in force of the product copied for the quantity.
 */
export async function createProductionOrder(
  actor: ProductionActor,
  input: ProductionOrderInput & { productId: unknown },
): Promise<ProductionOrderResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.create",
  );
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  const { data } = header;
  const people = await assignable(organizationId, data.assigneeIds);
  if (!people.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { assigneeIds: people.message },
    };
  }
  const facility = await activeFacilityOf(
    forOrganization(organizationId),
    userId,
  );
  return inOrder(organizationId, async (tx) => {
    await shareFacility(tx, facility.id);
    const made = await createOrderUnderLock(tx, actor, {
      facilityId: facility.id,
      productId: idOf(input.productId),
      header: data,
    });
    return {
      ok: true,
      orderId: made.id,
      summary: `Se creó la orden ${made.numberText}: ${made.quantityText} de ${made.productName}.`,
    };
  });
}

/**
 * The core of «Nueva orden», under the locks of its caller (the warehouse
 * shared through its unique index, and — when accepting a request — the
 * products of the materials and the request before it): a draft in the
 * warehouse with the recipe in force copied for the quantity, its people,
 * its process and its audit line. It checks no permission: only
 * `createProductionOrder` and accepting a production request (WMS-28B,
 * `production.request.decide`) call it; never exported from index.ts.
 */
export async function createOrderUnderLock(
  tx: Tx,
  actor: ProductionActor,
  input: {
    facilityId: string;
    productId: string;
    header: ProductionOrderHeader;
    /** WMS-28B: the accepted request it is born from. */
    request?: { id: string; numberText: string };
  },
): Promise<{
  id: string;
  number: number;
  numberText: string;
  areaLocationId: string;
  productName: string;
  quantityText: string;
}> {
  const { organizationId, userId } = actor;
  const data = input.header;
  const area = await areaOf(tx, userId, input.facilityId, data.areaLocationId);
  await assigneesReachArea(tx, data.assigneeIds, area.id);
  const copy = await copyRecipe(tx, input.productId, data.quantity);
  const last = await tx.productionOrder.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const id = newId();
  const number = (last?.number ?? 0) + 1;
  await tx.productionOrder.create({
    data: {
      id,
      organizationId,
      number,
      facilityId: input.facilityId,
      areaLocationId: area.id,
      productId: input.productId,
      recipeVersionId: copy.versionId,
      quantity: copy.quantity.toString(),
      unitCode: copy.unitCode,
      dueOn: dayOf(data.dueOn),
      priority: data.priority,
      note: data.note,
      createdByUserId: userId,
      requestId: input.request?.id ?? null,
    },
  });
  await writeCopy(tx, organizationId, id, copy);
  await writeAssignees(tx, actor, id, data.assigneeIds);
  // The process of the company, if it has one (lock: progress after the
  // order).
  await startProcess(tx, PRODUCTION_ORDER_PROCESS, actor, {
    documentId: id,
    facilityId: input.facilityId,
    locationId: area.id,
    label: formatProductionNumber(number),
    milestone: "DRAFT",
  });
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "production.order_created",
    target: { type: "production_order", id },
    metadata: {
      orden: formatProductionNumber(number),
      producto: copy.productName,
      cantidad: formatStock(copy.quantity.toString(), copy.unitCode),
      receta: formatRecipeVersion(copy.versionNumber),
      // P7d: the request it was born from; who approved it is the actor.
      ...(input.request ? { solicitud: input.request.numberText } : {}),
    },
  });
  return {
    id,
    number,
    numberText: formatProductionNumber(number),
    areaLocationId: area.id,
    productName: copy.productName,
    quantityText: formatStock(copy.quantity.toString(), copy.unitCode),
  };
}

/**
 * Changes a draft: quantity, area, day, priority, notes and people. Saving
 * copies the recipe in force again with the quantity («Usar la receta
 * vigente» is saving it as it is).
 */
export async function updateProductionOrder(
  actor: ProductionActor,
  orderId: string,
  input: ProductionOrderInput,
): Promise<ProductionOrderResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.create",
  );
  const header = readHeader(input);
  if (!header.ok) {
    return { ok: false, reason: "invalid", fieldErrors: header.fieldErrors };
  }
  const { data } = header;
  const people = await assignable(organizationId, data.assigneeIds);
  if (!people.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { assigneeIds: people.message },
    };
  }
  const facilityId = await facilityOfOrder(organizationId, orderId);
  return inOrder(organizationId, async (tx) => {
    await shareFacility(tx, facilityId);
    const order = await lockOrder(tx, orderId, userId);
    const problem = productionTransitionProblem(order.status, "DRAFT");
    if (order.status !== "DRAFT") {
      return stop("not_allowed", problem ?? "Solo un borrador cambia.");
    }
    const area = await areaOf(
      tx,
      userId,
      order.facilityId,
      data.areaLocationId,
    );
    await assigneesReachArea(tx, data.assigneeIds, area.id);
    const copy = await copyRecipe(tx, order.productId, data.quantity);
    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        areaLocationId: area.id,
        recipeVersionId: copy.versionId,
        quantity: copy.quantity.toString(),
        unitCode: copy.unitCode,
        dueOn: dayOf(data.dueOn),
        priority: data.priority,
        note: data.note,
      },
    });
    await writeCopy(tx, organizationId, order.id, copy);
    await writeAssignees(tx, actor, order.id, data.assigneeIds);
    if (area.id !== order.areaLocationId) {
      await setProcessPlace(tx, PRODUCTION_ORDER_PROCESS, order.id, {
        facilityId: order.facilityId,
        locationId: area.id,
      });
    }
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.order_changed",
      target: { type: "production_order", id: order.id },
      metadata: {
        orden: formatProductionNumber(order.number),
        cantidad: formatStock(copy.quantity.toString(), copy.unitCode),
        receta: formatRecipeVersion(copy.versionNumber),
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `Se guardó la orden ${formatProductionNumber(order.number)} con la receta ${formatRecipeVersion(copy.versionNumber)}.`,
    };
  });
}

/**
 * Who will make an open order (draft, released or in progress): active
 * members who may report production and reach its area.
 */
export async function setProductionOrderAssignees(
  actor: ProductionActor,
  orderId: string,
  assigneeIds: unknown,
): Promise<ProductionOrderResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.create",
  );
  const parsed = headerSchema.shape.assigneeIds.safeParse(
    Array.isArray(assigneeIds) ? assigneeIds.map(String) : [],
  );
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { assigneeIds: parsed.error.issues[0]!.message },
    };
  }
  const ids = parsed.data;
  const people = await assignable(organizationId, ids);
  if (!people.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { assigneeIds: people.message },
    };
  }
  const facilityId = await facilityOfOrder(organizationId, orderId);
  return inOrder(organizationId, async (tx) => {
    await shareFacility(tx, facilityId);
    const order = await lockOrder(tx, orderId, userId);
    if (!OPEN_PRODUCTION_STATUSES.includes(order.status)) {
      return stop(
        "not_allowed",
        `Esta orden está ${PRODUCTION_ORDER_STATUS_LABELS[order.status].toLowerCase()}: ya no cambia.`,
      );
    }
    await assigneesReachArea(tx, ids, order.areaLocationId);
    await writeAssignees(tx, actor, order.id, ids);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.order_changed",
      target: { type: "production_order", id: order.id },
      metadata: {
        orden: formatProductionNumber(order.number),
        personas: ids.length,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary:
        ids.length === 0
          ? "La orden quedó sin personas asignadas."
          : `Se guardaron las personas de ${formatProductionNumber(order.number)}.`,
    };
  });
}

// ── Releasing ────────────────────────────────────────────────────────────

/** The area and every location inside it (no task brings what is there). */
export async function insideArea(tx: Tx, facilityId: string, areaId: string) {
  const rows = await tx.location.findMany({
    where: { facilityId, parentId: { not: null } },
    select: { id: true, parentId: true },
  });
  const children = new Map<string, string[]>();
  for (const row of rows) {
    const list = children.get(row.parentId!) ?? [];
    list.push(row.id);
    children.set(row.parentId!, list);
  }
  const inside = new Set<string>();
  const pending = [areaId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (inside.has(id)) continue;
    inside.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return inside;
}

/**
 * «Liberar orden»: sets each material aside where it will be taken from
 * (what expires first first), only from locations the person reaches in
 * the order's warehouse. When something does not reach, nothing is set
 * aside and the answer says what is missing — unless `takeWhatThereIs`
 * (and the company allows it), which sets aside what is free. With the
 * company's `production.materials.mode = issue`, also creates the
 * «Surtir a producción» tasks to the area.
 */
export async function releaseProductionOrder(
  actor: ProductionActor,
  orderId: string,
  options: { takeWhatThereIs?: boolean } = {},
): Promise<ProductionOrderResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.release",
  );
  // A draft's lines and area change until it is locked: read them to lock
  // their products first, then check under the lock.
  const draft = await forOrganization(organizationId).productionOrder.findFirst(
    {
      where: { id: idOf(orderId) },
      select: {
        areaLocationId: true,
        lines: { select: { productId: true } },
      },
    },
  );
  if (!draft) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  const productIds = draft.lines.map((line) => line.productId);
  return inOrder(organizationId, async (tx) => {
    // Products → order: no warehouse first, nor the area (it does not
    // change while the order is open, and `areaOf` reads it again below).
    await lockRows(tx, "product", productIds);
    const order = await lockOrder(tx, orderId, userId);
    if (order.status === "RELEASED" || order.status === "IN_PROGRESS") {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: `La orden ${formatProductionNumber(order.number)} ya estaba liberada.`,
      };
    }
    const done = await releaseUnderLock(tx, actor, order, {
      areaLocationId: draft.areaLocationId,
      productIds,
      takeWhatThereIs: options.takeWhatThereIs,
    });
    if (!done.released) {
      throw new Rejected({
        ok: false,
        reason: "short",
        formError:
          done.shortages.length === 1
            ? "Un material no alcanza: no se apartó nada."
            : `${done.shortages.length} materiales no alcanzan: no se apartó nada.`,
        shortages: done.shortages,
        mayTakeWhatThereIs: done.mayTakeWhatThereIs,
      });
    }
    return { ok: true, orderId: order.id, summary: done.summary };
  });
}

export type LockedOrder = Awaited<ReturnType<typeof lockOrder>>;

/** The order under its lock (WMS-28B: accepting a request releases it). */
export const lockProductionOrder = (tx: Tx, orderId: string, userId: string) =>
  lockOrder(tx, orderId, userId);

/**
 * The core of «Liberar orden», under the locks of its caller (the products
 * of the materials, then the order, `lockOrder`). Answers what was set
 * aside, or — writing nothing — what does not reach when the company or
 * the caller does not take what there is. Any other problem rolls back
 * (`Rejected`). It checks no permission: only `releaseProductionOrder` and
 * accepting a production request (WMS-28B) call it; never exported from
 * index.ts.
 */
export async function releaseUnderLock(
  tx: Tx,
  actor: ProductionActor,
  order: LockedOrder,
  expected: {
    /** What the caller locked: the area and the products it read. */
    areaLocationId: string;
    productIds: readonly string[];
    takeWhatThereIs?: boolean;
  },
): Promise<
  | { released: true; summary: string; shortages: ProductionShortage[] }
  | {
      released: false;
      shortages: ProductionShortage[];
      mayTakeWhatThereIs: boolean;
    }
> {
  const { organizationId, userId } = actor;
  const problem = productionTransitionProblem(order.status, "RELEASED");
  if (problem) return stop("not_allowed", problem);
  if (
    order.areaLocationId !== expected.areaLocationId ||
    order.lines.length !== expected.productIds.length ||
    order.lines.some((line) => !expected.productIds.includes(line.productId))
  ) {
    return stop("not_allowed", CHANGED);
  }
  await checkStillValid(tx, order);
  // The area is still a production area of its warehouse, active and in
  // reach (review of WMS-28: its use or its state may have changed).
  try {
    await areaOf(tx, userId, order.facilityId, order.areaLocationId);
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    return stop(
      "not_allowed",
      `${error.result.fieldErrors?.areaLocationId ?? "El área ya no sirve."} Cambia el área de la orden antes de liberarla.`,
    );
  }

  const [mode, short] = await Promise.all([
    readSetting(tx, MATERIALS_MODE),
    readSetting(tx, RELEASE_SHORT),
  ]);
  const within = await locationScopeWhere(tx, userId);
  const staging = await tx.location.findFirst({
    where: { facilityId: order.facilityId, isStaging: true },
    select: { id: true },
  });
  const plan: {
    line: (typeof order.lines)[number];
    sources: PickSource[];
  }[] = [];
  const shortages: ProductionShortage[] = [];
  for (const line of order.lines) {
    const needed = dec(line.quantity.toString());
    const sources = await pickSources(tx, line.productId, needed, {
      stagingId: staging?.id ?? "",
      facilityId: order.facilityId,
      ...(isLimited(within) ? { within } : {}),
    });
    const take = sources.reduce(
      (sum, source) => sum.plus(source.quantity),
      dec(0),
    );
    if (take.lessThan(needed)) {
      shortages.push({
        lineId: line.id,
        productName: line.product.name,
        needed: formatStock(needed.toString(), line.unitCode),
        free: formatStock(take.toString(), line.unitCode),
      });
    }
    plan.push({ line, sources });
  }
  const mayTake = short !== "block";
  if (shortages.length > 0 && !(expected.takeWhatThereIs && mayTake)) {
    return { released: false, shortages, mayTakeWhatThereIs: mayTake };
  }
  if (plan.every((step) => step.sources.length === 0)) {
    return stop(
      "not_allowed",
      "No hay nada libre de los materiales de esta orden: no se apartó nada.",
    );
  }
  const withTasks = mode === "issue";
  const inArea = withTasks
    ? await insideArea(tx, order.facilityId, order.areaLocationId)
    : new Set<string>();
  // With tasks to the area, the area must admit each material (its
  // restrictions, WMS-22B): asked once, before writing (lock: capacity
  // after the order).
  if (withTasks) {
    const refused = await issuePlacementProblem(tx, {
      areaId: order.areaLocationId,
      inArea,
      lines: plan.map((step) => ({
        productId: step.line.productId,
        sources: step.sources,
      })),
    });
    if (refused) {
      return stop(
        "not_allowed",
        `${refused} Cambia el área de la orden o sus restricciones antes de liberarla.`,
      );
    }
  }
  // WMS-74: the stages the company put before releasing (lock: progress
  // last).
  const stages = await assertStagesDone(
    tx,
    PRODUCTION_ORDER_PROCESS,
    order.id,
    PRODUCTION_ORDER_RELEASED_OPERATION,
  );
  if (!stages.ok) return stop("not_allowed", stages.message);
  // Released first: an ISSUE task only comes from a released order
  // (trigger).
  await tx.productionOrder.update({
    where: { id: order.id },
    data: {
      status: "RELEASED",
      releasedAt: new Date(),
      releasedByUserId: userId,
    },
  });
  let nextNumber = withTasks ? await nextTaskNumber(tx) : 0;
  let tasks = 0;
  for (const step of plan) {
    const done = await setAsideForProduction(tx, actor, {
      order: { priority: order.priority },
      line: {
        id: step.line.id,
        productId: step.line.productId,
        unitCode: step.line.unitCode,
      },
      sources: step.sources,
      areaId: order.areaLocationId,
      inArea,
      withTasks,
      nextNumber,
    });
    nextNumber = done.nextNumber;
    tasks += done.tasks;
  }
  // WMS-74: the order reached «Liberada» and its operation is done.
  await reachMilestone(
    tx,
    PRODUCTION_ORDER_PROCESS,
    actor,
    order.id,
    "RELEASED",
  );
  await completeOperationStage(
    tx,
    PRODUCTION_ORDER_PROCESS,
    actor,
    order.id,
    PRODUCTION_ORDER_RELEASED_OPERATION,
  );
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "production.order_released",
    target: { type: "production_order", id: order.id },
    metadata: {
      orden: formatProductionNumber(order.number),
      incompletos: shortages.length,
      tareas: tasks,
    },
  });
  const number = formatProductionNumber(order.number);
  return {
    released: true,
    shortages,
    summary:
      (shortages.length === 0
        ? `Se liberó la orden ${number}: todos los materiales quedaron apartados`
        : `Se liberó la orden ${number} con lo que hay (${shortages.length === 1 ? "1 material quedó incompleto" : `${shortages.length} materiales quedaron incompletos`})`) +
      (tasks === 0
        ? "."
        : tasks === 1
          ? " y hay 1 tarea para surtirlos al área."
          : ` y hay ${tasks} tareas para surtirlos al área.`),
  };
}

/**
 * Under the locks of its products and the order: the version it copied is
 * still the one in force, and its product and materials are active with
 * the same unit (ADR 0066: a recipe does not lock products).
 */
async function checkStillValid(
  tx: Tx,
  order: Awaited<ReturnType<typeof lockOrder>>,
): Promise<void> {
  if (order.product.status !== "ACTIVE") {
    stop("not_allowed", `${order.product.name} está archivado: no se produce.`);
  }
  if (order.product.unitCode !== order.unitCode) {
    stop(
      "not_allowed",
      `La unidad de ${order.product.name} cambió: usa la receta vigente antes de liberar.`,
    );
  }
  const version = await tx.recipeVersion.findFirst({
    where: { id: order.recipeVersionId },
    select: { status: true, number: true },
  });
  if (version?.status !== "ACTIVE") {
    const current = await tx.recipeVersion.findFirst({
      where: { status: "ACTIVE", recipe: { productId: order.productId } },
      select: { number: true },
    });
    stop(
      "not_allowed",
      current
        ? `La receta cambió desde que se guardó la orden (ahora ${formatRecipeVersion(current.number)}): usa la receta vigente antes de liberar.`
        : `${order.product.name} ya no tiene una receta vigente: no se puede liberar.`,
    );
  }
  for (const line of order.lines) {
    if (line.product.status !== "ACTIVE") {
      stop(
        "not_allowed",
        `${line.product.name} está archivado: haz una versión nueva de la receta sin él, o reactívalo, antes de liberar.`,
      );
    }
    if (line.product.unitCode !== line.unitCode) {
      stop(
        "not_allowed",
        `La unidad de ${line.product.name} cambió desde que se copió la receta: haz una versión nueva de la receta.`,
      );
    }
  }
}

// ── Cancelling ───────────────────────────────────────────────────────────

/**
 * Cancels a draft or a released order with a reason: lets go of every
 * material it set aside and cancels its «Surtir a producción» tasks not
 * yet picked up (one picked up is delivered or reported first). What was
 * already delivered to the area stays there, free.
 */
export async function cancelProductionOrder(
  actor: ProductionActor,
  orderId: string,
  reason: string,
): Promise<ProductionOrderResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.cancel",
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
  const draft = await forOrganization(organizationId).productionOrder.findFirst(
    {
      where: { id: idOf(orderId) },
      select: { lines: { select: { productId: true } } },
    },
  );
  const productIds = draft?.lines.map((line) => line.productId) ?? [];
  return inOrder(organizationId, async (tx) => {
    // Products → order: no warehouse first (it locks products).
    await lockRows(tx, "product", productIds);
    const order = await lockOrder(tx, orderId, userId);
    if (order.status === "CANCELLED") {
      return {
        ok: true,
        orderId: order.id,
        repeated: true,
        summary: "La orden ya estaba cancelada.",
      };
    }
    const problem = productionTransitionProblem(order.status, "CANCELLED");
    if (problem) return stop("not_allowed", problem);
    // Its tasks, after the order (order → tasks), read again under lock.
    const open = await tx.warehouseTask.findMany({
      where: {
        kind: "ISSUE",
        productionOrderLine: { orderId: order.id },
        status: { notIn: ["DELIVERED", "CANCELLED"] },
      },
      select: { id: true },
    });
    const locked = await lockRows(
      tx,
      "warehouseTask",
      open.map((task) => task.id),
    );
    const tasks = await tx.warehouseTask.findMany({
      where: { id: { in: locked } },
      select: { id: true, number: true, status: true, pickedUpAt: true },
    });
    // A load in someone's hands: picked up, or reported after picking it
    // up (blocked with its pick-up written). It is delivered or resolved
    // first; cancelling would free what it carries in the origin.
    const carried = tasks.find(
      (task) =>
        task.status === "PICKED_UP" ||
        (task.status === "BLOCKED" && task.pickedUpAt !== null),
    );
    if (carried) {
      return stop(
        "not_allowed",
        `Hay material en camino al área (tarea T-${String(carried.number).padStart(4, "0")}): que se entregue o se reporte antes de cancelar la orden.`,
      );
    }
    const cancelled = tasks.filter((task) => task.status !== "DELIVERED");
    if (cancelled.length > 0) {
      await tx.warehouseTask.updateMany({
        where: { id: { in: cancelled.map((task) => task.id) } },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelReason:
            `Se canceló la orden ${formatProductionNumber(order.number)}: ${why}`.slice(
              0,
              300,
            ),
          closedByUserId: userId,
        },
      });
    }
    let released = 0;
    for (const line of order.lines) {
      const result = await tx.stockReservation.updateMany({
        where: {
          sourceType: PRODUCTION_ORDER_LINE_SOURCE,
          sourceId: line.id,
          state: "ACTIVE",
        },
        data: { remaining: "0", state: "CLOSED", closedAt: new Date() },
      });
      released += result.count;
    }
    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: userId,
        cancelReason: why,
      },
    });
    await reachMilestone(
      tx,
      PRODUCTION_ORDER_PROCESS,
      actor,
      order.id,
      "CANCELLED",
    );
    // WMS-79 (ADR 0094): the outbound order it was made for still waits.
    await noticeOrderStillWaits(
      tx,
      actor,
      await lineWaitOfOrder(tx, order.id),
      `Se canceló la orden ${formatProductionNumber(order.number)}.`,
    );
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.order_cancelled",
      target: { type: "production_order", id: order.id },
      reason: why,
      metadata: {
        orden: formatProductionNumber(order.number),
        reservasLiberadas: released,
        tareasCanceladas: cancelled.length,
      },
    });
    return {
      ok: true,
      orderId: order.id,
      summary: `Se canceló la orden ${formatProductionNumber(order.number)}${released > 0 ? " y se liberó lo que tenía apartado" : ""}.`,
    };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export type ProductionOrderSummary = {
  id: string;
  numberText: string;
  status: ProductionOrderStatus;
  statusLabel: string;
  urgent: boolean;
  productName: string;
  sku: string;
  quantityText: string;
  areaName: string;
  dueOn: string | null;
  createdAt: Date;
};

export type ProductionOrderPage = {
  items: ProductionOrderSummary[];
  total: number;
  page: number;
  pageCount: number;
  /** The filter applied, as it goes in the address. */
  status: "open" | "all" | ProductionOrderStatus;
  mine: boolean;
};

const ymd = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/** Where an order of the active warehouse within the person's scope is. */
async function visibleWhere(client: Client, userId: string) {
  const facility = await activeFacilityOf(client, userId);
  const scoped = await locationScopeWhere(client, userId);
  return {
    facilityId: facility.id,
    ...(isLimited(scoped) ? { area: scoped } : {}),
  };
}

/**
 * Orders of the warehouse the person works in, the newest first; open ones
 * by default. `mine`: only those assigned to the person.
 */
export async function listProductionOrders(
  actor: ProductionActor,
  filter: { status?: string; mine?: boolean; page?: number } = {},
): Promise<ProductionOrderPage> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "production.order.read");
  const client = forOrganization(organizationId);
  const status: ProductionOrderPage["status"] =
    filter.status === "all"
      ? "all"
      : isProductionOrderStatus(filter.status)
        ? filter.status
        : "open";
  const where = {
    ...(await visibleWhere(client, userId)),
    ...(status === "open"
      ? { status: { in: [...OPEN_PRODUCTION_STATUSES] } }
      : status === "all"
        ? {}
        : { status }),
    ...(filter.mine ? { assignees: { some: { userId } } } : {}),
  };
  const total = await client.productionOrder.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PRODUCTION_PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Math.trunc(Number(filter.page) || 1)),
    pageCount,
  );
  const rows = await client.productionOrder.findMany({
    where,
    orderBy: [{ number: "desc" }, { id: "desc" }],
    skip: (page - 1) * PRODUCTION_PAGE_SIZE,
    take: PRODUCTION_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      quantity: true,
      unitCode: true,
      dueOn: true,
      createdAt: true,
      product: { select: { name: true, sku: true } },
      area: { select: { name: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatProductionNumber(row.number),
      status: row.status,
      statusLabel: PRODUCTION_ORDER_STATUS_LABELS[row.status],
      urgent: row.priority === "URGENT",
      productName: row.product.name,
      sku: row.product.sku,
      quantityText: formatStock(row.quantity.toString(), row.unitCode),
      areaName: row.area.name,
      dueOn: ymd(row.dueOn),
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    status,
    mine: Boolean(filter.mine),
  };
}

export type ProductionOrderView = ProductionOrderSummary & {
  productId: string;
  quantity: string;
  unitCode: string;
  areaLocationId: string;
  areaPath: string;
  priority: "NORMAL" | "URGENT";
  note: string | null;
  recipe: {
    versionText: string;
    /** The version in force today, when it is not the one copied. */
    currentText: string | null;
  };
  lines: {
    id: string;
    productId: string;
    productName: string;
    sku: string;
    quantityText: string;
    /** What is set aside for it now (every location), in its unit. */
    reservedText: string;
    reservedComplete: boolean;
    scrapPercent: string | null;
    /** «Surtir a producción» tasks: open and delivered. */
    openTasks: number;
    deliveredTasks: number;
  }[];
  outputs: {
    productId: string;
    productName: string;
    quantityText: string;
    costShare: string;
  }[];
  assignees: { id: string; name: string }[];
  createdBy: string;
  releasedBy: string | null;
  releasedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /**
   * WMS-74: why «Liberar orden» waits for a stage of the process (only to
   * paint; the release decides again under its locks).
   */
  releaseWaits: string | null;
  /**
   * WMS-28B (P7d): the request it was born from and who approved it (who
   * executed it comes from the reports, WMS-29).
   */
  request: {
    id: string;
    numberText: string;
    requestedBy: string;
    approvedBy: string;
  } | null;
};

async function namesOf(client: Client, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await client.membership.findMany({
    where: { userId: { in: wanted } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(rows.map((row) => [row.userId, row.user.name]));
}

/** One order, or null when it does not exist for the person. */
export async function getProductionOrder(
  actor: ProductionActor,
  orderId: string,
): Promise<ProductionOrderView | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "production.order.read");
  const client = forOrganization(organizationId);
  const row = await client.productionOrder.findFirst({
    where: { id: idOf(orderId) },
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      productId: true,
      quantity: true,
      unitCode: true,
      dueOn: true,
      note: true,
      createdAt: true,
      createdByUserId: true,
      releasedAt: true,
      releasedByUserId: true,
      cancelledAt: true,
      cancelledByUserId: true,
      cancelReason: true,
      areaLocationId: true,
      product: { select: { name: true, sku: true } },
      area: { select: { name: true, parent: LOCATION_PARENTS } },
      recipeVersion: {
        select: { number: true, status: true, recipeId: true },
      },
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitCode: true,
          scrapPercent: true,
          product: { select: { name: true, sku: true } },
          tasks: { select: { status: true } },
        },
      },
      outputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          productId: true,
          quantity: true,
          unitCode: true,
          costShare: true,
          product: { select: { name: true } },
        },
      },
      assignees: { select: { userId: true } },
      request: {
        select: {
          id: true,
          number: true,
          requestedByUserId: true,
          decidedByUserId: true,
        },
      },
    },
  });
  if (!row) return null;
  if (
    (await locationsOutOfScope(client, userId, [row.areaLocationId])).length > 0
  ) {
    return null;
  }
  const [current, reserved, names, releaseWaits] = await Promise.all([
    row.recipeVersion.status === "ACTIVE"
      ? null
      : client.recipeVersion.findFirst({
          where: { status: "ACTIVE", recipeId: row.recipeVersion.recipeId },
          select: { number: true },
        }),
    client.stockReservation.groupBy({
      by: ["sourceId"],
      where: {
        sourceType: PRODUCTION_ORDER_LINE_SOURCE,
        sourceId: { in: row.lines.map((line) => line.id) },
        state: "ACTIVE",
      },
      _sum: { remaining: true },
    }),
    namesOf(client, [
      row.createdByUserId,
      row.releasedByUserId,
      row.cancelledByUserId,
      row.request?.requestedByUserId ?? null,
      row.request?.decidedByUserId ?? null,
      ...row.assignees.map((person) => person.userId),
    ]),
    row.status === "DRAFT"
      ? operationWaits(
          client,
          PRODUCTION_ORDER_PROCESS,
          row.id,
          PRODUCTION_ORDER_RELEASED_OPERATION,
        )
      : null,
  ]);
  const reservedOf = new Map(
    reserved.map((sum) => [
      sum.sourceId,
      dec((sum._sum.remaining ?? 0).toString()),
    ]),
  );
  const nameOf = (id: string | null) =>
    id ? (names.get(id) ?? "Persona fuera del equipo") : null;
  return {
    id: row.id,
    numberText: formatProductionNumber(row.number),
    status: row.status,
    statusLabel: PRODUCTION_ORDER_STATUS_LABELS[row.status],
    urgent: row.priority === "URGENT",
    priority: row.priority,
    productId: row.productId,
    productName: row.product.name,
    sku: row.product.sku,
    quantity: row.quantity.toString(),
    unitCode: row.unitCode,
    quantityText: formatStock(row.quantity.toString(), row.unitCode),
    areaLocationId: row.areaLocationId,
    areaName: row.area.name,
    areaPath: locationPath(row.area),
    dueOn: ymd(row.dueOn),
    note: row.note,
    createdAt: row.createdAt,
    recipe: {
      versionText: formatRecipeVersion(row.recipeVersion.number),
      currentText:
        row.recipeVersion.status === "ACTIVE"
          ? null
          : current
            ? formatRecipeVersion(current.number)
            : "ninguna",
    },
    lines: row.lines.map((line) => {
      const held = reservedOf.get(line.id) ?? dec(0);
      return {
        id: line.id,
        productId: line.productId,
        productName: line.product.name,
        sku: line.product.sku,
        quantityText: formatStock(line.quantity.toString(), line.unitCode),
        reservedText: formatStock(held.toString(), line.unitCode),
        reservedComplete: !held.lessThan(line.quantity.toString()),
        scrapPercent: line.scrapPercent?.toString() ?? null,
        openTasks: line.tasks.filter(
          (task) => task.status !== "DELIVERED" && task.status !== "CANCELLED",
        ).length,
        deliveredTasks: line.tasks.filter((task) => task.status === "DELIVERED")
          .length,
      };
    }),
    outputs: row.outputs.map((line) => ({
      productId: line.productId,
      productName: line.product.name,
      quantityText: formatStock(line.quantity.toString(), line.unitCode),
      costShare: line.costShare.toString(),
    })),
    assignees: row.assignees
      .map((person) => ({
        id: person.userId,
        name: nameOf(person.userId)!,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
    createdBy: nameOf(row.createdByUserId)!,
    releasedBy: nameOf(row.releasedByUserId),
    releasedAt: row.releasedAt,
    cancelledBy: nameOf(row.cancelledByUserId),
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    releaseWaits,
    request: row.request
      ? {
          id: row.request.id,
          numberText: formatProductionRequestNumber(row.request.number),
          requestedBy: nameOf(row.request.requestedByUserId)!,
          approvedBy: nameOf(row.request.decidedByUserId)!,
        }
      : null,
  };
}

/**
 * Production areas of the warehouse the person works in, inside their
 * scope (for the form of an order and of a recipe).
 */
export async function listProductionAreas(
  actor: ProductionActor,
): Promise<{ id: string; path: string }[]> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "production.order.read");
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  const scoped = await locationScopeWhere(client, userId);
  const rows = await client.location.findMany({
    where: {
      facilityId: facility.id,
      type: "PRODUCTION",
      archivedAt: null,
      isTransit: null,
      ...(isLimited(scoped) ? scoped : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
    select: { id: true, name: true, parent: LOCATION_PARENTS },
  });
  return rows.map((row) => ({ id: row.id, path: locationPath(row) }));
}

/** People an order may be assigned to: who may report production. */
export async function listProductionPeople(
  actor: ProductionActor,
): Promise<{ id: string; name: string }[]> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.create",
  );
  const members = await forOrganization(organizationId).membership.findMany({
    where: { status: "ACTIVE" },
    select: { userId: true, user: { select: { name: true } } },
  });
  const allowed = await Promise.all(
    members.map((member) =>
      isAllowed(organizationId, member.userId, "production.report.create"),
    ),
  );
  return members
    .filter((_, index) => allowed[index])
    .map((member) => ({ id: member.userId, name: member.user.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export type ProducibleProduct = {
  id: string;
  name: string;
  sku: string;
  unitCode: string;
  versionText: string;
  /** The area its recipe proposes, when it is of this warehouse. */
  areaLocationId: string | null;
};

/**
 * Products with a recipe in force, for «Nueva orden»: by name, code or
 * barcode, paged in the database.
 */
export async function listProducibleProducts(
  actor: ProductionActor,
  /** `productId`: only that product, when it can be produced. */
  filter: { q?: string; page?: number; productId?: string } = {},
): Promise<{
  items: ProducibleProduct[];
  total: number;
  page: number;
  pageCount: number;
}> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.create",
  );
  const client = forOrganization(organizationId);
  const words = String(filter.q ?? "")
    .trim()
    .slice(0, 100)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((word) => word.replace(/[\\%_]/g, (c) => `\\${c}`));
  const where = {
    ...(filter.productId ? { id: idOf(filter.productId) } : {}),
    status: "ACTIVE" as const,
    recipe: { versions: { some: { status: "ACTIVE" as const } } },
    AND: words.map((word) => ({
      OR: [
        { name: { contains: word } },
        { sku: { contains: word } },
        { barcode: { contains: word } },
      ],
    })),
  };
  const total = await client.product.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PRODUCTION_PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Math.trunc(Number(filter.page) || 1)),
    pageCount,
  );
  const facility = await activeFacilityOf(client, userId);
  const rows = await client.product.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * PRODUCTION_PAGE_SIZE,
    take: PRODUCTION_PAGE_SIZE,
    select: {
      id: true,
      name: true,
      sku: true,
      unitCode: true,
      recipe: {
        select: {
          area: { select: { id: true, facilityId: true } },
          versions: {
            where: { status: "ACTIVE" },
            select: { number: true },
          },
        },
      },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      unitCode: row.unitCode,
      versionText: formatRecipeVersion(row.recipe?.versions[0]?.number ?? 0),
      areaLocationId:
        row.recipe?.area?.facilityId === facility.id
          ? row.recipe.area.id
          : null,
    })),
    total,
    page,
    pageCount,
  };
}

/**
 * WMS-79 (ADR 0094): the wait of the outbound line an order was made for
 * (through the request it was born from); null when it has none.
 */
export async function lineWaitOfOrder(
  client: Tx | Client,
  orderId: string,
): Promise<string | null> {
  const row = await client.productionOrder.findFirst({
    where: { id: orderId },
    select: { request: { select: { lineWaitId: true } } },
  });
  return row?.request?.lineWaitId ?? null;
}
