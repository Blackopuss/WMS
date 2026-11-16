import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import {
  AVAILABLE_ANY_LOT,
  formatStock,
  pickSources,
  productsNearMinimum,
} from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { notify } from "@/platform/notifications";
import { ProcessStagesPending } from "@/platform/processes";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  ORDER_FROM_REQUEST_NOTICE,
  REQUEST_ANSWERED_NOTICE,
  REQUEST_TO_DECIDE_NOTICE,
} from "./notices";
import { scaleInput } from "./order-rules";
import {
  OPEN_PRODUCTION_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  formatProductionNumber,
  type ProductionOrderStatus,
} from "./order-states";
import {
  Rejected as OrderRejected,
  assignable,
  createOrderUnderLock,
  idOf,
  isNumberClash,
  lockProductionOrder,
  readHeader,
  releaseUnderLock,
  shareFacility,
  type ProductionShortage,
} from "./orders";
import type { ProductionActor } from "./recipes";
import { reachableQuantity } from "./request-rules";
import {
  PRODUCTION_REQUEST_STATUS_LABELS,
  formatProductionRequestNumber,
  isProductionRequestStatus,
  productionRequestProblem,
  type ProductionRequestStatus,
} from "./request-states";
import { LOW_MARGIN, RELEASE_SHORT } from "./settings";

/**
 * Production requests (WMS-28B, ADR 0075). Someone with nothing to their
 * name asks to produce a product of their area that is close to its
 * minimum; who decides (`production.request.decide` and reaching the area)
 * accepts it — and in the same transaction the production order is born in
 * their name, released — or rejects it with a reason. Who asked may cancel
 * it while nobody answered. A request sets nothing aside.
 *
 * Who asks never sees a quantity of stock: the list of what may be asked
 * carries ids and names only. Who decides sees stock of the product and of
 * its materials within their own scope.
 *
 * Accepting does not grant permissions over orders: it runs the cores of
 * creating and releasing (`createOrderUnderLock`, `releaseUnderLock`) for
 * THIS order only; cancelling, releasing a draft or closing it stays with
 * who holds the permissions of orders.
 *
 * Locks: asking → membership of who asks; accepting → products of the
 * materials → the request (conditional update) → warehouse (shared, by its
 * unique index) → the new order → progress; rejecting and cancelling → the
 * request only.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const PRODUCTION_REQUEST_PAGE_SIZE = 25;
/** At most this many products are offered in «Queda poco». */
export const REQUESTABLE_MAX = 50;
/** Products read at a time while looking for what may be asked. */
const REQUESTABLE_PAGE = 1_000;
/** Open requests of the same product shown to who decides. */
const OTHER_REQUESTS_MAX = 10;
/** Big enough to read everything free of a material. */
const EVERYTHING = dec("999999999.999");

export type ProductionRequestField =
  | "productId"
  | "quantity"
  | "note"
  | "areaLocationId"
  | "dueOn"
  | "priority"
  | "assigneeIds"
  | "reason";

export type ProductionRequestResult =
  | {
      ok: true;
      requestId: string;
      summary: string;
      repeated?: true;
      /** When accepting: the order that was born, and whether it is a draft. */
      orderId?: string;
      draft?: boolean;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed" | "busy" | "short";
      fieldErrors?: Partial<Record<ProductionRequestField, string>>;
      formError?: string;
      /** When accepting: what does not reach (nothing was written). */
      shortages?: ProductionShortage[];
      mayTakeWhatThereIs?: boolean;
    };

type Failure = Extract<ProductionRequestResult, { ok: false }>;

class Stop extends Error {
  constructor(readonly result: Failure) {
    super("production request rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: ProductionRequestField,
): never => {
  throw new Stop(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Esta solicitud de producción no existe.";

/** One transaction with its locks, tried again on a clash of numbers. */
async function inRequest(
  organizationId: string,
  work: (tx: Tx) => Promise<ProductionRequestResult>,
): Promise<ProductionRequestResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await forOrganization(organizationId).$transaction(
        work,
        LOCKING_TRANSACTION,
      );
    } catch (error) {
      if (error instanceof Stop) return error.result;
      // The cores of orders fail the same way (everything rolled back).
      if (error instanceof OrderRejected) {
        const { result } = error;
        return {
          ok: false,
          reason: result.reason === "not_found" ? "not_found" : result.reason,
          ...(result.fieldErrors
            ? {
                fieldErrors: result.fieldErrors as Failure["fieldErrors"],
              }
            : {}),
          ...(result.formError ? { formError: result.formError } : {}),
          ...(result.shortages ? { shortages: result.shortages } : {}),
          ...(result.mayTakeWhatThereIs !== undefined
            ? { mayTakeWhatThereIs: result.mayTakeWhatThereIs }
            : {}),
        };
      }
      if (error instanceof ProcessStagesPending) {
        return { ok: false, reason: "not_allowed", formError: error.message };
      }
      if (isNumberClash(error) && attempt < 4) continue;
      throw error;
    }
  }
}

// ── Nothing to their name (P8c, P8d) ────────────────────────────────────

/** What still waits for a person, as a sentence; null when nothing does. */
async function assignedWork(
  client: Pick<
    Tx,
    "productionOrderAssignee" | "processStageState" | "warehouseTask"
  >,
  userId: string,
): Promise<string | null> {
  const [orders, stages, tasks] = await Promise.all([
    client.productionOrderAssignee.count({
      where: {
        userId,
        order: { status: { in: ["RELEASED", "IN_PROGRESS"] } },
      },
    }),
    client.processStageState.count({
      where: {
        takenByUserId: userId,
        status: "READY",
        kind: "MANUAL",
        progress: { status: "ACTIVE" },
      },
    }),
    client.warehouseTask.count({
      where: {
        assignedToUserId: userId,
        status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "BLOCKED"] },
      },
    }),
  ]);
  if (orders > 0) {
    return "Tienes órdenes de producción asignadas: termina esas antes de pedir otra.";
  }
  if (tasks > 0) {
    return "Tienes tareas asignadas: termínalas antes de pedir producción.";
  }
  if (stages > 0) {
    return "Tienes etapas de proceso a tu nombre: termínalas antes de pedir producción.";
  }
  return null;
}

// ── What may be asked (the three conditions) ────────────────────────────

type Area = { id: string; name: string };

/** Production areas of the warehouse the person works in, in their scope. */
async function areasInReach(
  client: Pick<Tx, "location" | "membership">,
  userId: string,
  facilityId: string,
): Promise<Area[]> {
  const scoped = await locationScopeWhere(client, userId);
  return client.location.findMany({
    where: {
      facilityId,
      type: "PRODUCTION",
      archivedAt: null,
      isTransit: null,
      ...(isLimited(scoped) ? scoped : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
    select: { id: true, name: true },
  });
}

type Candidate = {
  id: string;
  name: string;
  unitCode: string;
  quantityStep: string;
  /** The areas it may be asked for: the recipe's, or every one in reach. */
  areas: Area[];
};

/**
 * Products of the person's area close to their minimum: active, with a
 * recipe in force whose area (or, without one, any production area of
 * the warehouse) is in reach, and available at or below minimum × (1 +
 * margin). `onlyProductId` narrows it to one product (when asking).
 */
async function requestable(
  client: Tx | Client,
  userId: string,
  facilityId: string,
  margin: string,
  onlyProductId?: string,
  /** Stops after finding one more than this (to say there are more). */
  limit = REQUESTABLE_MAX,
): Promise<Candidate[]> {
  const areas = await areasInReach(client, userId, facilityId);
  if (areas.length === 0) return [];
  const byId = new Map(areas.map((area) => [area.id, area]));
  const ids = [...byId.keys()];
  const found: Candidate[] = [];
  // Read in name order, a page at a time, only products with a minimum and
  // a recipe of an area in reach (or without area), until `limit` are
  // close to their minimum: nothing is left out by a cut.
  for (let skip = 0; ; skip += REQUESTABLE_PAGE) {
    const products = await client.product.findMany({
      where: {
        ...(onlyProductId ? { id: onlyProductId } : {}),
        status: "ACTIVE",
        minimum: { isNot: null },
        recipe: {
          versions: { some: { status: "ACTIVE" } },
          OR: [{ areaLocationId: null }, { areaLocationId: { in: ids } }],
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip,
      take: REQUESTABLE_PAGE,
      select: {
        id: true,
        name: true,
        unitCode: true,
        quantityStep: true,
        recipe: { select: { areaLocationId: true } },
      },
    });
    const near = await productsNearMinimum(
      client,
      products.map((product) => product.id),
      margin,
    );
    for (const product of products) {
      if (!near.has(product.id)) continue;
      const own = product.recipe?.areaLocationId ?? null;
      found.push({
        id: product.id,
        name: product.name,
        unitCode: product.unitCode,
        quantityStep: product.quantityStep.toString(),
        areas: own ? [byId.get(own)!] : areas,
      });
      if (found.length > limit) return found;
    }
    if (products.length < REQUESTABLE_PAGE) return found;
  }
}

export type RequestableProduct = {
  id: string;
  name: string;
  /** The unit it is asked in (a catalog fact, not stock). */
  unitCode: string;
  /**
   * The production areas to choose from, only when the recipe names none
   * and the person reaches more than one (names of their own areas: never
   * stock, locations of stock nor warehouses).
   */
  areas: Area[] | null;
};

export type RequestableProducts =
  | {
      ok: true;
      items: RequestableProduct[];
      /** There are more than REQUESTABLE_MAX: the screen says so. */
      more: boolean;
    }
  | { ok: false; reason: "busy"; message: string };

/**
 * «Queda poco»: what the person may ask to produce right now, with names
 * only — never a quantity, a location of stock or a warehouse — or why
 * they may not ask (something to their name).
 */
export async function listRequestableProducts(
  actor: ProductionActor,
  filter: { productId?: string } = {},
): Promise<RequestableProducts> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.create",
  );
  const client = forOrganization(organizationId);
  const busy = await assignedWork(client, userId);
  if (busy) return { ok: false, reason: "busy", message: busy };
  const facility = await activeFacilityOf(client, userId);
  const margin = await readSetting(client, LOW_MARGIN);
  const items = await requestable(
    client,
    userId,
    facility.id,
    margin,
    filter.productId ? idOf(filter.productId) : undefined,
  );
  return {
    ok: true,
    more: items.length > REQUESTABLE_MAX,
    items: items.slice(0, REQUESTABLE_MAX).map((item) => ({
      id: item.id,
      name: item.name,
      unitCode: item.unitCode,
      areas: item.areas.length > 1 ? item.areas : null,
    })),
  };
}

// ── Asking ───────────────────────────────────────────────────────────────

const askSchema = z.object({
  productId: z.string().trim().min(1, "Elige qué producir.").max(36),
  quantity: z.string().trim().min(1, "Escribe cuánto quieres producir."),
  note: z
    .string()
    .trim()
    .max(300, "Usa como máximo 300 caracteres.")
    .optional()
    .transform((value) => value || null),
  areaLocationId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
});

/**
 * «Pedir producción»: checks the three conditions again under the lock of
 * the person's membership and saves the request, which waits for who
 * decides. Sets nothing aside.
 */
export async function submitProductionRequest(
  actor: ProductionActor,
  input: z.input<typeof askSchema>,
): Promise<ProductionRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.create",
  );
  const parsed = askSchema.safeParse({
    productId: String(input.productId ?? ""),
    quantity: String(input.quantity ?? ""),
    note: input.note == null ? undefined : String(input.note),
    areaLocationId:
      input.areaLocationId == null ? undefined : String(input.areaLocationId),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<ProductionRequestField, string>> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0] as ProductionRequestField] ??= issue.message;
    }
    return { ok: false, reason: "invalid", fieldErrors };
  }
  const data = parsed.data;
  const facility = await activeFacilityOf(
    forOrganization(organizationId),
    userId,
  );
  return inRequest(organizationId, async (tx) => {
    // Checked here once without locks and again after the lock below.
    const busy = await assignedWork(tx, userId);
    if (busy) return stop("busy", busy);
    const margin = await readSetting(tx, LOW_MARGIN);
    const [product] = await requestable(
      tx,
      userId,
      facility.id,
      margin,
      idOf(data.productId),
    );
    if (!product) {
      return stop(
        "not_allowed",
        "Ese producto ya no se puede pedir: no está por acabarse o no es de tu área.",
        "productId",
      );
    }
    const area =
      product.areas.length === 1
        ? product.areas[0]!
        : product.areas.find((row) => row.id === data.areaLocationId);
    if (!area) {
      return stop(
        "invalid",
        "Elige el área donde se produce.",
        "areaLocationId",
      );
    }
    const quantity = parseQuantity(
      { unitCode: product.unitCode, quantityStep: product.quantityStep },
      data.quantity,
    );
    if (!quantity.ok) return stop("invalid", quantity.error, "quantity");
    const last = await tx.productionRequest.findFirst({
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const id = newId();
    const number = (last?.number ?? 0) + 1;
    const numberText = formatProductionRequestNumber(number);
    await tx.productionRequest.create({
      data: {
        id,
        organizationId,
        number,
        facilityId: facility.id,
        areaLocationId: area.id,
        productId: product.id,
        quantity: quantity.quantity.toString(),
        unitCode: product.unitCode,
        note: data.note,
        requestedByUserId: userId,
      },
    });
    // Locks: the row is written first — its key to the company takes a
    // shared lock on the company, as every insert does — and then the
    // person's membership is locked, so two requests of the same person go
    // one after the other. Company → membership is the order of a change of
    // the team (`withTeamChange`) and of pending photos (files.ts): taking
    // the membership first deadlocked with disabling the person (review of
    // WMS-28B). Whatever fails from here rolls the row back.
    const membership = await tx.membership.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (membership) await lockRows(tx, "membership", [membership.id]);
    const member = membership
      ? await tx.membership.findFirst({
          where: { id: membership.id },
          select: { status: true },
        })
      : null;
    if (member?.status !== "ACTIVE") {
      return stop("not_allowed", "Ya no eres parte del equipo.");
    }
    const stillBusy = await assignedWork(tx, userId);
    if (stillBusy) return stop("busy", stillBusy);
    const open = await tx.productionRequest.findFirst({
      where: {
        requestedByUserId: userId,
        productId: product.id,
        status: "SUBMITTED",
        id: { not: id },
      },
      select: { number: true },
    });
    if (open) {
      return stop(
        "not_allowed",
        `Ya pediste ${product.name} (${formatProductionRequestNumber(open.number)}): espera la respuesta.`,
        "productId",
      );
    }
    const quantityText = formatStock(
      quantity.quantity.toString(),
      product.unitCode,
    );
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.request_created",
      target: { type: "production_request", id },
      metadata: {
        solicitud: numberText,
        producto: product.name,
        cantidad: quantityText,
      },
    });
    // Who decides and reaches the area: the Encargado de producción,
    // Almacén and the Supervisor de almacén; when none of them got it,
    // Administración and the titular. No stock in the text: one text goes
    // to everybody and the motor cannot work it out within the scope of
    // each one (the decision screen does).
    const who = (
      await tx.membership.findFirst({
        where: { userId },
        select: { user: { select: { name: true } } },
      })
    )?.user;
    const notice = {
      organizationId,
      actorUserId: userId,
      text: `${who?.name ?? "Alguien"} pidió producir ${quantityText} de ${product.name} (${numberText}).`,
      href: `/produccion/solicitudes/${id}`,
      key: `production_request:${id}:to_decide`,
    };
    const sent = await notify(tx, REQUEST_TO_DECIDE_NOTICE, {
      ...notice,
      to: {
        permissions: ["production.request.decide"],
        roles: ["production_supervisor", "warehouse", "supervisor"],
        ownerByRole: false,
        locationId: area.id,
      },
    });
    if (sent.sent === 0) {
      await notify(tx, REQUEST_TO_DECIDE_NOTICE, {
        ...notice,
        to: {
          permissions: ["production.request.decide"],
          roles: ["administrator"],
          locationId: area.id,
        },
      });
    }
    return {
      ok: true,
      requestId: id,
      summary: `Se envió la solicitud ${numberText}: ${quantityText} de ${product.name}. Te avisamos cuando la respondan.`,
    };
  });
}

// ── Deciding ─────────────────────────────────────────────────────────────

type RequestRow = {
  id: string;
  number: number;
  status: ProductionRequestStatus;
  facilityId: string;
  areaLocationId: string;
  productId: string;
  quantity: Decimal;
  unitCode: string;
  note: string | null;
  requestedByUserId: string;
  decidedByUserId: string | null;
  product: { name: string };
};

const REQUEST_SELECT = {
  id: true,
  number: true,
  status: true,
  facilityId: true,
  areaLocationId: true,
  productId: true,
  quantity: true,
  unitCode: true,
  note: true,
  requestedByUserId: true,
  decidedByUserId: true,
  product: { select: { name: true } },
} as const;

/** A request the person reaches (its area in scope), or not found. */
async function reachable(
  client: Tx | Client,
  userId: string,
  requestId: string,
): Promise<RequestRow> {
  const row = await client.productionRequest.findFirst({
    where: { id: idOf(requestId) },
    select: REQUEST_SELECT,
  });
  if (!row) return stop("not_found", NOT_FOUND);
  if (
    (await locationsOutOfScope(client, userId, [row.areaLocationId])).length > 0
  ) {
    return stop("not_found", NOT_FOUND);
  }
  return row as RequestRow;
}

/**
 * Takes the request from «Por atender» to `to` with a conditional update:
 * the row lock decides between two people at once (the second one waits
 * and then reads it already decided). Answers the row as it was, or why it
 * cannot.
 */
async function claim(
  tx: Tx,
  actor: ProductionActor,
  row: RequestRow,
  to: "ACCEPTED" | "REJECTED" | "CANCELLED",
  extra: { rejectReason?: string } = {},
): Promise<{ done: true } | { done: false; result: ProductionRequestResult }> {
  const now = new Date();
  const changed = await tx.productionRequest.updateMany({
    where: { id: row.id, status: "SUBMITTED" },
    data:
      to === "CANCELLED"
        ? { status: to, cancelledAt: now, cancelledByUserId: actor.userId }
        : {
            status: to,
            decidedAt: now,
            decidedByUserId: actor.userId,
            ...(to === "REJECTED" ? { rejectReason: extra.rejectReason } : {}),
          },
  });
  if (changed.count === 1) return { done: true };
  // Someone else (or this same person) got there first: read it again.
  const now_ = await tx.productionRequest.findFirst({
    where: { id: row.id },
    select: {
      status: true,
      decidedByUserId: true,
      cancelledByUserId: true,
      orders: { select: { id: true }, take: 1 },
    },
  });
  if (!now_)
    return {
      done: false,
      result: { ok: false, reason: "not_found", formError: NOT_FOUND },
    };
  const numberText = formatProductionRequestNumber(row.number);
  const mine =
    now_.status === to &&
    (to === "CANCELLED"
      ? now_.cancelledByUserId === actor.userId
      : now_.decidedByUserId === actor.userId);
  if (mine) {
    return {
      done: false,
      result: {
        ok: true,
        requestId: row.id,
        repeated: true,
        ...(now_.orders[0] ? { orderId: now_.orders[0].id } : {}),
        summary: `La solicitud ${numberText} ya estaba ${PRODUCTION_REQUEST_STATUS_LABELS[to].toLowerCase()}.`,
      },
    };
  }
  const by =
    now_.status === "CANCELLED"
      ? null
      : now_.decidedByUserId
        ? (
            await tx.membership.findFirst({
              where: { userId: now_.decidedByUserId },
              select: { user: { select: { name: true } } },
            })
          )?.user.name
        : null;
  return {
    done: false,
    result: {
      ok: false,
      reason: "not_allowed",
      formError: by
        ? `${by} ya ${now_.status === "ACCEPTED" ? "aceptó" : "rechazó"} la solicitud ${numberText}.`
        : (productionRequestProblem(now_.status, to) ?? NOT_FOUND),
    },
  };
}

const acceptSchema = z.object({
  mode: z
    .enum(["release", "take", "draft"])
    .optional()
    .transform((value) => value ?? "release"),
});

export type AcceptProductionRequestInput = {
  /** In the unit of the product; by default what was asked. */
  quantity?: string;
  dueOn?: string;
  priority?: string;
  /** By default who asked. */
  assigneeIds?: string[];
  /**
   * `release` (by default): the order is born released; `take`: released
   * with what there is when a material does not reach; `draft`: born as a
   * draft to release later.
   */
  mode?: "release" | "take" | "draft";
};

/**
 * «Aceptar»: in one transaction the production order is born in the name
 * of who accepts, with the request it comes from and — unless `draft` —
 * released (its materials set aside, only from what the person reaches).
 * When a material does not reach the company decides
 * (`production.release.short`): `ask` answers what is missing and lets
 * the person take what there is or accept it as a draft; `block` leaves
 * the order as a draft. Accepting twice answers `repeated`.
 *
 * Who decides needs `production.request.decide` and to reach the area;
 * NOT the permissions of orders: accepting creates and releases this
 * order only, and what comes after stays with who holds them.
 */
export async function acceptProductionRequest(
  actor: ProductionActor,
  requestId: string,
  input: AcceptProductionRequestInput = {},
): Promise<ProductionRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.decide",
  );
  const { mode } = acceptSchema.parse({
    mode: ["release", "take", "draft"].includes(String(input.mode))
      ? input.mode
      : undefined,
  });
  const client = forOrganization(organizationId);
  // Read without locks: what product, and the materials of its recipe in
  // force, to lock those products first.
  const first = await client.productionRequest.findFirst({
    where: { id: idOf(requestId) },
    select: {
      productId: true,
      quantity: true,
      requestedByUserId: true,
      areaLocationId: true,
    },
  });
  // Out of reach it does not exist: before saying anything about the input.
  if (
    !first ||
    (await locationsOutOfScope(client, userId, [first.areaLocationId])).length >
      0
  ) {
    return { ok: false, reason: "not_found", formError: NOT_FOUND };
  }
  const version = await client.recipeVersion.findFirst({
    where: { status: "ACTIVE", recipe: { productId: first.productId } },
    select: { inputs: { select: { productId: true } } },
  });
  const productIds = [
    ...new Set((version?.inputs ?? []).map((line) => line.productId)),
  ];
  const header = readHeader({
    quantity: input.quantity ?? first.quantity.toString(),
    areaLocationId: "-",
    dueOn: input.dueOn,
    priority: input.priority,
    assigneeIds: input.assigneeIds ?? [first.requestedByUserId],
  });
  if (!header.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: header.fieldErrors as Failure["fieldErrors"],
    };
  }
  const people = await assignable(organizationId, header.data.assigneeIds);
  if (!people.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { assigneeIds: people.message },
    };
  }
  // Who may not cancel orders accepted it: the Encargado and Administración
  // hear about the order (P7d).
  const [managesOrders, mayCreate, mayRelease] = await Promise.all([
    isAllowed(organizationId, userId, "production.order.cancel"),
    isAllowed(organizationId, userId, "production.order.create"),
    isAllowed(organizationId, userId, "production.order.release"),
  ]);
  // Deciding does not give power over orders (review of WMS-28B): who
  // could not create and release this order by hand accepts at most what
  // was asked.
  const capped = !(mayCreate && mayRelease);
  return inRequest(organizationId, async (tx) => {
    // Products → request → warehouse (shared) → order → progress.
    await lockRows(tx, "product", productIds);
    const row = await reachable(tx, userId, requestId);
    const claimed = await claim(tx, actor, row, "ACCEPTED");
    if (!claimed.done) return claimed.result;
    const numberText = formatProductionRequestNumber(row.number);
    if (capped) {
      // With the rule of the product today, the same one the order uses:
      // what does not parse is refused here, never skipped.
      const item = await tx.product.findFirst({
        where: { id: row.productId },
        select: { unitCode: true, quantityStep: true },
      });
      const typed = item
        ? parseQuantity(
            {
              unitCode: item.unitCode,
              quantityStep: item.quantityStep.toString(),
            },
            header.data.quantity,
          )
        : null;
      if (!typed || !typed.ok) {
        return stop(
          "invalid",
          typed && !typed.ok ? typed.error : NOT_FOUND,
          "quantity",
        );
      }
      if (
        item!.unitCode !== row.unitCode ||
        typed.quantity.greaterThan(row.quantity.toString())
      ) {
        return stop(
          "invalid",
          `Puedes aceptar hasta lo que se pidió (${formatStock(row.quantity.toString(), row.unitCode)}) o menos.`,
          "quantity",
        );
      }
    }
    await shareFacility(tx, row.facilityId);
    const made = await createOrderUnderLock(tx, actor, {
      facilityId: row.facilityId,
      productId: row.productId,
      header: {
        ...header.data,
        areaLocationId: row.areaLocationId,
        note: row.note,
      },
      request: { id: row.id, numberText },
    });
    let draft = mode === "draft";
    let releasedText = "";
    if (!draft) {
      const order = await lockProductionOrder(tx, made.id, userId);
      const lines = order.lines.map((line) => line.productId);
      // The recipe changed between reading it and taking the locks.
      if (lines.some((id) => !productIds.includes(id))) {
        return stop(
          "not_allowed",
          "La receta cambió mientras aceptabas: inténtalo de nuevo.",
        );
      }
      const done = await releaseUnderLock(tx, actor, order, {
        areaLocationId: order.areaLocationId,
        productIds: lines,
        takeWhatThereIs: mode === "take",
      });
      if (!done.released) {
        if (done.mayTakeWhatThereIs) {
          // `ask`: say what is missing; nothing is written.
          throw new Stop({
            ok: false,
            reason: "short",
            formError:
              done.shortages.length === 1
                ? "Un material no alcanza: no se aceptó todavía."
                : `${done.shortages.length} materiales no alcanzan: no se aceptó todavía.`,
            shortages: done.shortages,
            mayTakeWhatThereIs: true,
          });
        }
        // `block`: the order is born as a draft.
        draft = true;
        releasedText = " Quedó en borrador porque faltan materiales.";
      } else {
        releasedText = ` ${done.summary}`;
      }
    }
    const quantityText = made.quantityText;
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.request_accepted",
      target: { type: "production_request", id: row.id },
      metadata: {
        solicitud: numberText,
        orden: made.numberText,
        producto: row.product.name,
        cantidad: quantityText,
        borrador: draft,
      },
    });
    await notify(tx, REQUEST_ANSWERED_NOTICE, {
      organizationId,
      actorUserId: userId,
      to: { userIds: [row.requestedByUserId] },
      text: `Se aceptó tu solicitud ${numberText}: nació la orden ${made.numberText} (${quantityText} de ${row.product.name}).`,
      href: `/produccion/${made.id}`,
      key: `production_request:${row.id}:answered`,
    });
    const born = {
      organizationId,
      actorUserId: userId,
      text: `Nació la orden ${made.numberText} de la solicitud ${numberText}: ${quantityText} de ${row.product.name}${draft ? " (en borrador)" : ""}.`,
      href: `/produccion/${made.id}`,
      key: `production_order:${made.id}:from_request`,
    };
    // Almacén and the Supervisor de almacén who reach the area, to get the
    // materials ready…
    await notify(tx, ORDER_FROM_REQUEST_NOTICE, {
      ...born,
      to: {
        permissions: ["production.request.decide"],
        roles: ["warehouse", "supervisor"],
        ownerByRole: false,
        locationId: row.areaLocationId,
      },
    });
    // …and, when who accepted does not manage orders, who does.
    if (!managesOrders) {
      await notify(tx, ORDER_FROM_REQUEST_NOTICE, {
        ...born,
        to: {
          permissions: ["production.order.cancel"],
          locationId: row.areaLocationId,
        },
      });
    }
    return {
      ok: true,
      requestId: row.id,
      orderId: made.id,
      draft,
      summary: `Se aceptó la solicitud ${numberText} y nació la orden ${made.numberText}.${releasedText}`,
    };
  });
}

/** «Rechazar», with a reason; who asked hears about it. */
export async function rejectProductionRequest(
  actor: ProductionActor,
  requestId: string,
  reason: string,
): Promise<ProductionRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.decide",
  );
  const why = String(reason ?? "").trim();
  if (why.length < 3) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: "Escribe por qué se rechaza." },
    };
  }
  if (why.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: "Usa como máximo 300 caracteres." },
    };
  }
  return inRequest(organizationId, async (tx) => {
    const row = await reachable(tx, userId, requestId);
    const claimed = await claim(tx, actor, row, "REJECTED", {
      rejectReason: why,
    });
    if (!claimed.done) return claimed.result;
    const numberText = formatProductionRequestNumber(row.number);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.request_rejected",
      target: { type: "production_request", id: row.id },
      reason: why,
      metadata: { solicitud: numberText, producto: row.product.name },
    });
    await notify(tx, REQUEST_ANSWERED_NOTICE, {
      organizationId,
      actorUserId: userId,
      to: { userIds: [row.requestedByUserId] },
      text: `Se rechazó tu solicitud ${numberText} de ${row.product.name}: ${why}`,
      href: `/produccion/solicitudes/${row.id}`,
      key: `production_request:${row.id}:answered`,
    });
    return {
      ok: true,
      requestId: row.id,
      summary: `Se rechazó la solicitud ${numberText}.`,
    };
  });
}

/** «Cancelar solicitud»: only who asked, while nobody answered. */
export async function cancelProductionRequest(
  actor: ProductionActor,
  requestId: string,
): Promise<ProductionRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.create",
  );
  return inRequest(organizationId, async (tx) => {
    const row = await reachable(tx, userId, requestId);
    if (row.requestedByUserId !== userId) {
      return stop("not_allowed", "Solo quien la pidió cancela una solicitud.");
    }
    const claimed = await claim(tx, actor, row, "CANCELLED");
    if (!claimed.done) return claimed.result;
    const numberText = formatProductionRequestNumber(row.number);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.request_cancelled",
      target: { type: "production_request", id: row.id },
      metadata: { solicitud: numberText, producto: row.product.name },
    });
    return {
      ok: true,
      requestId: row.id,
      summary: `Se canceló la solicitud ${numberText}.`,
    };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export type ProductionRequestSummary = {
  id: string;
  numberText: string;
  status: ProductionRequestStatus;
  statusLabel: string;
  productName: string;
  quantityText: string;
  areaName: string;
  requestedBy: string;
  createdAt: Date;
};

export type ProductionRequestPage = {
  items: ProductionRequestSummary[];
  total: number;
  page: number;
  pageCount: number;
  status: "open" | "all" | ProductionRequestStatus;
  mine: boolean;
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

/**
 * Requests of the warehouse the person works in, within their scope, the
 * newest first; those waiting by default. `mine`: only the person's.
 */
export async function listProductionRequests(
  actor: ProductionActor,
  filter: { status?: string; mine?: boolean; page?: number } = {},
): Promise<ProductionRequestPage> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.read",
  );
  const client = forOrganization(organizationId);
  const status: ProductionRequestPage["status"] =
    filter.status === "all"
      ? "all"
      : isProductionRequestStatus(filter.status)
        ? filter.status
        : "open";
  const facility = await activeFacilityOf(client, userId);
  const scoped = await locationScopeWhere(client, userId);
  const where = {
    facilityId: facility.id,
    ...(isLimited(scoped) ? { area: scoped } : {}),
    ...(status === "open"
      ? { status: "SUBMITTED" as const }
      : status === "all"
        ? {}
        : { status }),
    ...(filter.mine ? { requestedByUserId: userId } : {}),
  };
  const total = await client.productionRequest.count({ where });
  const pageCount = Math.max(
    1,
    Math.ceil(total / PRODUCTION_REQUEST_PAGE_SIZE),
  );
  const page = Math.min(
    Math.max(1, Math.trunc(Number(filter.page) || 1)),
    pageCount,
  );
  const rows = await client.productionRequest.findMany({
    where,
    orderBy: [{ number: "desc" }, { id: "desc" }],
    skip: (page - 1) * PRODUCTION_REQUEST_PAGE_SIZE,
    take: PRODUCTION_REQUEST_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      quantity: true,
      unitCode: true,
      createdAt: true,
      requestedByUserId: true,
      product: { select: { name: true } },
      area: { select: { name: true } },
    },
  });
  const names = await namesOf(
    client,
    rows.map((row) => row.requestedByUserId),
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatProductionRequestNumber(row.number),
      status: row.status,
      statusLabel: PRODUCTION_REQUEST_STATUS_LABELS[row.status],
      productName: row.product.name,
      quantityText: formatStock(row.quantity.toString(), row.unitCode),
      areaName: row.area.name,
      requestedBy:
        names.get(row.requestedByUserId) ?? "Persona fuera del equipo",
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    status,
    mine: Boolean(filter.mine),
  };
}

export type RequestDecisionView = {
  /** The person is limited to warehouses or zones: only theirs counts. */
  limited: boolean;
  product: {
    /** Available minus set aside, in reach. */
    availableText: string;
    reservedText: string;
    /** The minimum of the product (of the whole company), or null. */
    minimumText: string | null;
    /** In open production orders of this product, in reach. */
    inOrdersText: string;
    inInspectionText: string;
  };
  /** Null when the product no longer has a recipe in force. */
  materials:
    | {
        productId: string;
        productName: string;
        neededText: string;
        freeText: string;
        enough: boolean;
      }[]
    | null;
  /** «Con el material libre alcanza para 16 de 20 piezas.» */
  reachText: string | null;
  reachesAll: boolean;
  others: {
    id: string;
    numberText: string;
    quantityText: string;
    requestedBy: string;
  }[];
  /** `production.release.short` of the company. */
  releaseShort: "ask" | "block";
  /** Who the order may be assigned to (may report production, reach the area). */
  people: { id: string; name: string }[];
  /**
   * Who decides could not create and release orders by hand: they accept
   * at most what was asked.
   */
  capped: boolean;
  /**
   * The area stopped being a production area (or was archived): the
   * request can only be rejected.
   */
  areaProblem: string | null;
};

export type ProductionRequestView = ProductionRequestSummary & {
  productId: string;
  sku: string;
  quantity: string;
  unitCode: string;
  note: string | null;
  areaPath: string;
  requestedByUserId: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  cancelledAt: Date | null;
  order: { id: string; numberText: string; statusLabel: string } | null;
  /** Who asked, while nobody answered. */
  mayCancel: boolean;
  /** Stock to decide with: only for who decides, while it waits. */
  decision: RequestDecisionView | null;
};

/** One request, or null when it does not exist for the person. */
export async function getProductionRequest(
  actor: ProductionActor,
  requestId: string,
): Promise<ProductionRequestView | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.read",
  );
  const client = forOrganization(organizationId);
  const row = await client.productionRequest.findFirst({
    where: { id: idOf(requestId) },
    select: {
      id: true,
      number: true,
      status: true,
      productId: true,
      quantity: true,
      unitCode: true,
      note: true,
      createdAt: true,
      facilityId: true,
      areaLocationId: true,
      requestedByUserId: true,
      decidedAt: true,
      decidedByUserId: true,
      rejectReason: true,
      cancelledAt: true,
      product: { select: { name: true, sku: true } },
      area: { select: { name: true, parent: LOCATION_PARENTS } },
      orders: {
        take: 1,
        select: { id: true, number: true, status: true },
      },
    },
  });
  if (!row) return null;
  if (
    (await locationsOutOfScope(client, userId, [row.areaLocationId])).length > 0
  ) {
    return null;
  }
  const names = await namesOf(client, [
    row.requestedByUserId,
    row.decidedByUserId,
  ]);
  const nameOf = (id: string | null) =>
    id ? (names.get(id) ?? "Persona fuera del equipo") : null;
  const decides =
    row.status === "SUBMITTED" &&
    (await isAllowed(organizationId, userId, "production.request.decide"));
  const order = row.orders[0] ?? null;
  return {
    id: row.id,
    numberText: formatProductionRequestNumber(row.number),
    status: row.status,
    statusLabel: PRODUCTION_REQUEST_STATUS_LABELS[row.status],
    productId: row.productId,
    productName: row.product.name,
    sku: row.product.sku,
    quantity: row.quantity.toString(),
    unitCode: row.unitCode,
    quantityText: formatStock(row.quantity.toString(), row.unitCode),
    note: row.note,
    areaName: row.area.name,
    areaPath: locationPath(row.area),
    requestedByUserId: row.requestedByUserId,
    requestedBy: nameOf(row.requestedByUserId)!,
    createdAt: row.createdAt,
    decidedBy: nameOf(row.decidedByUserId),
    decidedAt: row.decidedAt,
    rejectReason: row.rejectReason,
    cancelledAt: row.cancelledAt,
    order: order
      ? {
          id: order.id,
          numberText: formatProductionNumber(order.number),
          statusLabel:
            PRODUCTION_ORDER_STATUS_LABELS[
              order.status as ProductionOrderStatus
            ],
        }
      : null,
    mayCancel: row.status === "SUBMITTED" && row.requestedByUserId === userId,
    decision: decides ? await decisionOf(organizationId, userId, row) : null,
  };
}

/**
 * What who decides sees, within their scope and in the warehouse of the
 * request: stock of the product, what its materials need for the quantity
 * asked and what is free of each, and other requests waiting for it.
 * Nothing outside their scope is counted or named; never costs.
 */
async function decisionOf(
  organizationId: string,
  userId: string,
  row: {
    id: string;
    productId: string;
    quantity: Decimal;
    unitCode: string;
    facilityId: string;
    areaLocationId: string;
  },
): Promise<RequestDecisionView> {
  const client = forOrganization(organizationId);
  const scoped = await locationScopeWhere(client, userId);
  const limited = isLimited(scoped);
  const here = {
    facilityId: row.facilityId,
    isTransit: null,
    ...(limited ? scoped : {}),
  };
  const sum = (value: { toString(): string } | null | undefined) =>
    dec((value ?? 0).toString());
  const [available, reserved, inspection, inOrders, minimum, releaseShort] =
    await Promise.all([
      client.stockBalance.aggregate({
        where: {
          productId: row.productId,
          location: here,
          ...AVAILABLE_ANY_LOT,
        },
        _sum: { quantity: true },
      }),
      client.stockReservation.aggregate({
        where: { productId: row.productId, state: "ACTIVE", location: here },
        _sum: { remaining: true },
      }),
      client.stockBalance.aggregate({
        where: {
          productId: row.productId,
          location: here,
          status: "INSPECTION",
        },
        _sum: { quantity: true },
      }),
      client.productionOrder.aggregate({
        where: {
          productId: row.productId,
          facilityId: row.facilityId,
          status: { in: [...OPEN_PRODUCTION_STATUSES] },
          ...(limited ? { area: scoped } : {}),
        },
        _sum: { quantity: true },
      }),
      client.stockMinimum.findFirst({
        where: { productId: row.productId },
        select: { quantity: true },
      }),
      readSetting(client, RELEASE_SHORT),
    ]);
  const reservedQty = sum(reserved._sum.remaining);
  const freeQty = sum(available._sum.quantity).minus(reservedQty);
  const unit = row.unitCode;
  const product = {
    availableText: formatStock(
      (freeQty.lessThan(0) ? dec(0) : freeQty).toString(),
      unit,
    ),
    reservedText: formatStock(reservedQty.toString(), unit),
    minimumText: minimum
      ? formatStock(minimum.quantity.toString(), unit)
      : null,
    inOrdersText: formatStock(sum(inOrders._sum.quantity).toString(), unit),
    inInspectionText: formatStock(
      sum(inspection._sum.quantity).toString(),
      unit,
    ),
  };

  // The recipe in force for the quantity asked: the same rule as the order.
  const version = await client.recipeVersion.findFirst({
    where: { status: "ACTIVE", recipe: { productId: row.productId } },
    select: {
      baseQuantity: true,
      inputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          productId: true,
          baseQuantity: true,
          unitCode: true,
          product: { select: { name: true, quantityStep: true } },
        },
      },
    },
  });
  let materials: RequestDecisionView["materials"] = null;
  let reachText: string | null = null;
  let reachesAll = false;
  if (version) {
    const staging = await client.location.findFirst({
      where: { facilityId: row.facilityId, isStaging: true },
      select: { id: true },
    });
    const lines = await client.$transaction(async (tx) =>
      Promise.all(
        version.inputs.map(async (line) => {
          const sources = await pickSources(tx, line.productId, EVERYTHING, {
            stagingId: staging?.id ?? "",
            facilityId: row.facilityId,
            ...(limited ? { within: scoped } : {}),
          });
          const free = sources.reduce(
            (total, source) => total.plus(source.quantity),
            dec(0),
          );
          const step = line.product.quantityStep.toString();
          const needed = scaleInput(
            line.baseQuantity.toString(),
            row.quantity.toString(),
            version.baseQuantity.toString(),
            step,
          );
          return { line, free, needed, step };
        }),
      ),
    );
    materials = lines.map(({ line, free, needed }) => ({
      productId: line.productId,
      productName: line.product.name,
      neededText: formatStock(needed.toString(), line.unitCode),
      freeText: formatStock(free.toString(), line.unitCode),
      enough: !free.lessThan(needed),
    }));
    reachesAll = materials.every((material) => material.enough);
    const productStep = await client.product.findFirst({
      where: { id: row.productId },
      select: { quantityStep: true },
    });
    const reach = reachableQuantity(
      row.quantity.toString(),
      productStep?.quantityStep.toString() ?? "1",
      version.baseQuantity.toString(),
      lines.map(({ line, free, step }) => ({
        recipeQuantity: line.baseQuantity.toString(),
        step,
        free,
      })),
    );
    reachText = reachesAll
      ? `Con el material libre alcanza para las ${formatStock(row.quantity.toString(), unit)}.`
      : `Con el material libre alcanza para ${formatStock(reach.toString(), unit)} de ${formatStock(row.quantity.toString(), unit)}.`;
  }

  const othersRows = await client.productionRequest.findMany({
    where: {
      productId: row.productId,
      status: "SUBMITTED",
      id: { not: row.id },
      facilityId: row.facilityId,
      ...(limited ? { area: scoped } : {}),
    },
    orderBy: [{ number: "asc" }, { id: "asc" }],
    take: OTHER_REQUESTS_MAX,
    select: {
      id: true,
      number: true,
      quantity: true,
      unitCode: true,
      requestedByUserId: true,
    },
  });
  const [people, area, mayCreate, mayRelease] = await Promise.all([
    peopleFor(organizationId, row.areaLocationId),
    client.location.findFirst({
      where: { id: row.areaLocationId },
      select: { name: true, type: true, archivedAt: true },
    }),
    isAllowed(organizationId, userId, "production.order.create"),
    isAllowed(organizationId, userId, "production.order.release"),
  ]);
  const areaProblem = !area
    ? "El área de esta solicitud ya no existe: solo se puede rechazar."
    : area.archivedAt
      ? `${area.name} está archivada: esta solicitud solo se puede rechazar.`
      : area.type !== "PRODUCTION"
        ? `${area.name} ya no es un área de producción: esta solicitud solo se puede rechazar.`
        : null;
  const names = await namesOf(
    client,
    othersRows.map((other) => other.requestedByUserId),
  );
  return {
    limited,
    product,
    materials,
    reachText,
    reachesAll,
    others: othersRows.map((other) => ({
      id: other.id,
      numberText: formatProductionRequestNumber(other.number),
      quantityText: formatStock(other.quantity.toString(), other.unitCode),
      requestedBy:
        names.get(other.requestedByUserId) ?? "Persona fuera del equipo",
    })),
    releaseShort: releaseShort === "block" ? "block" : "ask",
    people,
    capped: !(mayCreate && mayRelease),
    areaProblem,
  };
}

/** Active members who may report production and reach the area. */
async function peopleFor(
  organizationId: string,
  areaLocationId: string,
): Promise<{ id: string; name: string }[]> {
  const client = forOrganization(organizationId);
  const members = await client.membership.findMany({
    where: { status: "ACTIVE" },
    select: { userId: true, user: { select: { name: true } } },
  });
  const allowed = await Promise.all(
    members.map(
      async (member) =>
        (await isAllowed(
          organizationId,
          member.userId,
          "production.report.create",
        )) &&
        (await locationsOutOfScope(client, member.userId, [areaLocationId]))
          .length === 0,
    ),
  );
  return members
    .filter((_, index) => allowed[index])
    .map((member) => ({ id: member.userId, name: member.user.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/** How many requests wait for the person to decide (in reach). */
export async function countProductionRequestsToDecide(
  actor: ProductionActor,
): Promise<number> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.request.decide",
  );
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  const scoped = await locationScopeWhere(client, userId);
  return client.productionRequest.count({
    where: {
      facilityId: facility.id,
      status: "SUBMITTED",
      ...(isLimited(scoped) ? { area: scoped } : {}),
    },
  });
}
