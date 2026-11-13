import "server-only";

import { z } from "zod";

import { dec, formatDate, formatDecimal, isAppError, newId } from "@/lib";
import { formatStock } from "@/modules/inventory";
import {
  ApprovalExpired,
  approvalRequired,
  cancelApproval,
  findOpenApproval,
  openApprovalRequest,
  type ApprovalContext,
  type ApprovalTx,
} from "@/platform/approvals";
import { recordAuditEvent } from "@/platform/audit";
import { loadScope } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { pluralizeName, resolveConversion } from "@/platform/catalog";
import { activeFacilityOf, isFacilityInScope } from "@/platform/locations";
import { notify, type NotifyTx } from "@/platform/notifications";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { PURCHASE_REQUEST_APPROVAL } from "./approval-keys";
import { REQUEST_ANSWERED_NOTICE, REQUEST_TO_ATTEND_NOTICE } from "./notices";
import { PURCHASE_ORDER_STATUS_LABELS } from "./order-states";
import {
  OrderNumberTaken,
  captureOf,
  formatOrderNumber,
  insertDraftOrder,
} from "./orders";
import type { PurchasingActor } from "./product-suppliers";
import {
  PURCHASE_REQUEST_STATUS_LABELS,
  formatRequestNumber,
  requestTransitionProblem,
  type PurchaseRequestStatus,
} from "./request-states";

/**
 * Purchase requests (WMS-57, ADR 0055): someone who needs goods asks
 * Compras for them. A request carries no costs — who asks never sees nor
 * writes them. It is a draft of the warehouse of who asks; sent, it waits
 * for an authorization (the approval rule of the company, WMS-56) or
 * reaches Compras directly; Compras turns it into one draft order per
 * supplier, once, or rejects it.
 *
 * Locks: an approval request → the purchase request (deciding); the
 * purchase request alone (sending, cancelling, rejecting); the products of
 * the request → the request (converting). Sending inserts the approval
 * request and cancelling withdraws it in its own transaction before
 * locking the request, so there is no cycle.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = ReturnType<typeof forOrganization> | Tx;

export const PURCHASE_REQUEST_MAX_LINES = 100;
export const PURCHASE_REQUEST_PAGE_SIZE = 25;

/** One open approval per request. */
const openKeyOf = (requestId: string) => `purchase_request:${requestId}`;

export type RequestField =
  "productId" | "capture" | "quantity" | "neededOn" | "notes" | "reason";

export type RequestFailure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed" | "invalid_transition";
  fieldErrors: Partial<Record<RequestField, string>>;
  formError?: string;
  /** By id of the line of the request (converting). */
  lineErrors?: Record<string, string>;
};

const refuse = (
  reason: RequestFailure["reason"],
  field: RequestField | null,
  message: string,
): RequestFailure => ({
  ok: false,
  reason,
  fieldErrors: field ? { [field]: message } : {},
  ...(field ? {} : { formError: message }),
});

/** Carries an expected refusal out of a transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: RequestFailure) {
    super("purchase request rejected");
  }
}

const NOT_FOUND = "Esta solicitud ya no existe.";
const NOT_DRAFT =
  "Esta solicitud ya se envió: sus productos y sus datos ya no se cambian.";
const NOT_YOURS =
  "Solo quien hizo la solicitud la cambia, la envía o la retira.";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(text: string): Date | null {
  if (!DAY.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === text &&
    date.getUTCFullYear() >= 2000
    ? date
    : null;
}

const oneLine = (max: number, message: string) =>
  z
    .string()
    .trim()
    .regex(
      /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/,
      "Quita los tabuladores o caracteres raros.",
    )
    .max(max, message);

const headerSchema = z.object({
  neededOn: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) return null;
      const day = parseDay(value);
      if (!day) {
        context.addIssue({
          code: "custom",
          message: "Elige un día del calendario, o déjalo vacío.",
        });
        return z.NEVER;
      }
      return day;
    }),
  notes: oneLine(500, "La nota admite hasta 500 caracteres.")
    .optional()
    .transform((value) => (value ? value : null)),
});

export type RequestHeaderInput = z.input<typeof headerSchema>;

export type RequestLineInput = {
  /** `base` or `p:<id of a presentation of the product>`. */
  capture: string;
  /** As typed: "3", "2.75". */
  quantity: string;
};

function headerErrors(error: z.ZodError): RequestFailure {
  const fieldErrors: Partial<Record<RequestField, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0] as RequestField;
    fieldErrors[field] ??= issue.message;
  }
  return { ok: false, reason: "invalid", fieldErrors };
}

async function inRequest<T>(
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T | RequestFailure> {
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

/** Whether the person holds a permission now: never an error. */
async function may(
  actor: PurchasingActor,
  permission: Parameters<typeof assertModulePermission>[2],
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

// ---------------------------------------------------------------------------
// Lines

/** A line converted inside the transaction, with the catalog as it is now. */
async function resolveLine(tx: Tx, productId: string, input: RequestLineInput) {
  const product = await tx.product.findFirst({
    where: { id: String(productId).slice(0, 36) },
    select: { id: true, sku: true, status: true },
  });
  if (!product) {
    throw new Rejected(
      refuse("not_found", "productId", "Ese producto ya no existe."),
    );
  }
  if (product.status !== "ACTIVE") {
    throw new Rejected(
      refuse(
        "invalid",
        "productId",
        `${product.sku} está archivado: no se pide.`,
      ),
    );
  }
  const capture = captureOf(
    String(input.capture ?? "").trim(),
    String(input.quantity ?? ""),
  );
  if (!capture) {
    throw new Rejected(
      refuse("invalid", "capture", "Elige cómo lo pides, de la lista."),
    );
  }
  const resolved = await resolveConversion(tx, product.id, capture);
  if (!resolved.ok) {
    throw new Rejected(
      refuse(
        "invalid",
        capture.kind === "presentation" &&
          /no existe para este producto/.test(resolved.error)
          ? "capture"
          : "quantity",
        resolved.error,
      ),
    );
  }
  const { conversion } = resolved;
  return {
    productId: product.id,
    capturedQuantity: conversion.capturedQuantity.toString(),
    presentationId: conversion.presentation?.id ?? null,
    presentationVersionId: conversion.presentation?.versionId ?? null,
    factor: conversion.factor.toString(),
    baseQuantity: conversion.baseQuantity.toString(),
    unitCode: resolved.product.unitCode,
  };
}

async function writeLine(
  tx: Tx,
  organizationId: string,
  requestId: string,
  line: Awaited<ReturnType<typeof resolveLine>>,
) {
  const already = await tx.purchaseRequestLine.findFirst({
    where: { requestId, productId: line.productId },
    select: { id: true },
  });
  if (already) {
    throw new Rejected(
      refuse(
        "invalid",
        "productId",
        "Ese producto ya está en la solicitud: cambia su cantidad.",
      ),
    );
  }
  const count = await tx.purchaseRequestLine.count({ where: { requestId } });
  if (count >= PURCHASE_REQUEST_MAX_LINES) {
    throw new Rejected(
      refuse(
        "invalid",
        null,
        `Una solicitud admite hasta ${PURCHASE_REQUEST_MAX_LINES} productos. Haz otra para lo que falta.`,
      ),
    );
  }
  const last = await tx.purchaseRequestLine.findFirst({
    where: { requestId },
    orderBy: { lineNumber: "desc" },
    select: { lineNumber: true },
  });
  const id = newId();
  await tx.purchaseRequestLine.create({
    data: {
      id,
      organizationId,
      requestId,
      lineNumber: (last?.lineNumber ?? 0) + 1,
      ...line,
    },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Locks

/**
 * The request, locked for the rest of the transaction. One of a warehouse
 * outside the person's scope, or a draft of somebody else, does not exist.
 */
async function lockRequest(tx: Tx, userId: string, requestId: string) {
  const [id] = await lockRows(tx, "purchaseRequest", [
    String(requestId).slice(0, 36),
  ]);
  const request = id
    ? await tx.purchaseRequest.findFirst({
        where: { id },
        select: {
          id: true,
          number: true,
          status: true,
          facilityId: true,
          neededOn: true,
          notes: true,
          requestedByUserId: true,
          submittedAt: true,
        },
      })
    : null;
  if (
    !request ||
    !(await isFacilityInScope(tx, userId, request.facilityId)) ||
    (request.status === "DRAFT" && request.requestedByUserId !== userId)
  ) {
    throw new Rejected(refuse("not_found", null, NOT_FOUND));
  }
  return request;
}

/** The request, locked, a draft of the person. */
async function lockOwnDraft(tx: Tx, userId: string, requestId: string) {
  const request = await lockRequest(tx, userId, requestId);
  if (request.requestedByUserId !== userId) {
    throw new Rejected(refuse("not_allowed", null, NOT_YOURS));
  }
  if (request.status !== "DRAFT") {
    throw new Rejected(refuse("invalid_transition", null, NOT_DRAFT));
  }
  return request;
}

// ---------------------------------------------------------------------------
// Writing a request

export type CreateRequestResult =
  { ok: true; requestId: string; number: number } | RequestFailure;

/**
 * Starts a request of the person's active warehouse, as a draft; with a
 * product, also its first line. Its number is the next one of the company.
 */
export async function createPurchaseRequest(
  actor: PurchasingActor,
  input: RequestHeaderInput &
    Partial<RequestLineInput> & { productId?: string },
): Promise<CreateRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  const parsed = headerSchema.safeParse(input ?? {});
  if (!parsed.success) return headerErrors(parsed.error);
  const productId =
    typeof input?.productId === "string" ? input.productId.slice(0, 36) : "";
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  const requestId = newId();
  for (let attempt = 0; attempt < 6; attempt++) {
    const last = await client.purchaseRequest.findFirst({
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    try {
      return await inRequest(organizationId, async (tx) => {
        await tx.purchaseRequest.create({
          data: {
            id: requestId,
            organizationId,
            number,
            facilityId: facility.id,
            neededOn: parsed.data.neededOn,
            notes: parsed.data.notes,
            requestedByUserId: userId,
          },
        });
        if (productId) {
          const line = await resolveLine(tx, productId, {
            capture: String(input.capture ?? "base"),
            quantity: String(input.quantity ?? ""),
          });
          await writeLine(tx, organizationId, requestId, line);
        }
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "purchase_request.created",
          target: { type: "purchase_request", id: requestId },
          metadata: {
            solicitud: formatRequestNumber(number),
            almacen: facility.name,
          },
        });
        return { ok: true as const, requestId, number };
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  throw new Error("Could not number the purchase request");
}

/** Changes «for when» and the note of the person's draft. */
export async function updatePurchaseRequest(
  actor: PurchasingActor,
  requestId: string,
  input: RequestHeaderInput,
): Promise<{ ok: true } | RequestFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  const parsed = headerSchema.safeParse(input ?? {});
  if (!parsed.success) return headerErrors(parsed.error);
  return inRequest(organizationId, async (tx) => {
    const request = await lockOwnDraft(tx, userId, requestId);
    await tx.purchaseRequest.updateMany({
      where: { id: request.id },
      data: { neededOn: parsed.data.neededOn, notes: parsed.data.notes },
    });
    return { ok: true as const };
  });
}

/** Adds a product to the person's draft. */
export async function addRequestLine(
  actor: PurchasingActor,
  requestId: string,
  input: RequestLineInput & { productId: string },
): Promise<{ ok: true; lineId: string } | RequestFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  const productId = String(input?.productId ?? "").slice(0, 36);
  if (!productId) return refuse("invalid", "productId", "Elige el producto.");
  return inRequest(organizationId, async (tx) => {
    const request = await lockOwnDraft(tx, userId, requestId);
    const line = await resolveLine(tx, productId, input);
    const lineId = await writeLine(tx, organizationId, request.id, line);
    return { ok: true as const, lineId };
  });
}

/** The draft a line belongs to, locked; the line as it is. */
async function lockLine(tx: Tx, userId: string, lineId: string) {
  const found = await tx.purchaseRequestLine.findFirst({
    where: { id: String(lineId).slice(0, 36) },
    select: { requestId: true },
  });
  if (!found) {
    throw new Rejected(
      refuse("not_found", null, "Ese producto ya no está en la solicitud."),
    );
  }
  await lockOwnDraft(tx, userId, found.requestId);
  const line = await tx.purchaseRequestLine.findFirst({
    where: { id: String(lineId).slice(0, 36) },
    select: { id: true, productId: true },
  });
  if (!line) {
    throw new Rejected(
      refuse("not_found", null, "Ese producto ya no está en la solicitud."),
    );
  }
  return line;
}

/** Changes how much of a product the person's draft asks for. */
export async function updateRequestLine(
  actor: PurchasingActor,
  lineId: string,
  input: RequestLineInput,
): Promise<{ ok: true } | RequestFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  return inRequest(organizationId, async (tx) => {
    const line = await lockLine(tx, userId, lineId);
    const resolved = await resolveLine(tx, line.productId, input);
    await tx.purchaseRequestLine.updateMany({
      where: { id: line.id },
      data: resolved,
    });
    return { ok: true as const };
  });
}

/** Takes a product out of the person's draft. */
export async function removeRequestLine(
  actor: PurchasingActor,
  lineId: string,
): Promise<{ ok: true } | RequestFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  return inRequest(organizationId, async (tx) => {
    const line = await lockLine(tx, userId, lineId);
    await tx.purchaseRequestLine.deleteMany({ where: { id: line.id } });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Sending, cancelling, rejecting

export type SubmitRequestResult =
  | {
      ok: true;
      /** It reached Compras (the approval rule of the company is off). */
      status: "APPROVED";
      repeated?: true;
    }
  | {
      ok: false;
      /** It waits for an authorization: nothing reached Compras yet. */
      reason: "pending_approval";
      approvalRequestId: string;
      message: string;
      repeated?: true;
    }
  | RequestFailure;

const WAITING =
  "Quedó esperando autorización. Cuando alguien la autorice, pasa a Compras.";

/** «SC-0003: 3 productos, para el 20 nov 2026». Never with costs. */
function summaryOf(
  number: number,
  lines: number,
  neededOn: Date | null,
  notes: string | null,
) {
  const what = lines === 1 ? "1 producto" : `${lines} productos`;
  const when = neededOn ? `, para el ${formatDate(neededOn, "UTC")}` : "";
  const note = notes ? ` · ${notes}` : "";
  return `${formatRequestNumber(number)}: ${what}${when}${note}`.slice(0, 900);
}

/**
 * WMS-39: a request reached «Por atender»: who buys for its warehouse
 * hears it, never who caused it. Never with costs.
 */
async function noticeToAttend(
  tx: NotifyTx,
  organizationId: string,
  actorUserId: string,
  request: { id: string; facilityId: string },
  text: string,
) {
  await notify(tx, REQUEST_TO_ATTEND_NOTICE, {
    organizationId,
    actorUserId,
    to: {
      permissions: ["purchasing.order.create"],
      facilityId: request.facilityId,
    },
    text: `Por atender: ${text}`,
    href: `/compras/solicitudes/${request.id}`,
    key: `purchase_request:${request.id}:to_attend`,
  });
}

/** WMS-39: who asked hears what Compras did with the request. */
async function noticeAnswered(
  tx: NotifyTx,
  organizationId: string,
  actorUserId: string,
  request: { id: string; requestedByUserId: string },
  text: string,
) {
  await notify(tx, REQUEST_ANSWERED_NOTICE, {
    organizationId,
    actorUserId,
    to: { userIds: [request.requestedByUserId] },
    text,
    href: `/compras/solicitudes/${request.id}`,
    key: `purchase_request:${request.id}:answered`,
  });
}

/**
 * Sends the person's draft (or sends again one whose authorization was
 * withdrawn or expired). With the approval rule of the company off it
 * reaches Compras («por atender»); on, it waits for an authorization,
 * asked here, inside this transaction and after the lock of the request.
 * Sending twice sends once.
 */
export async function submitPurchaseRequest(
  actor: PurchasingActor,
  requestId: string,
): Promise<SubmitRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  return inRequest(organizationId, async (tx) => {
    const request = await lockRequest(tx, userId, requestId);
    if (request.requestedByUserId !== userId) {
      throw new Rejected(refuse("not_allowed", null, NOT_YOURS));
    }
    if (request.status === "APPROVED") {
      return {
        ok: true as const,
        status: "APPROVED" as const,
        repeated: true as const,
      };
    }
    const open = await findOpenApproval(tx, openKeyOf(request.id));
    if (request.status === "SUBMITTED" && open) {
      return {
        ok: false as const,
        reason: "pending_approval" as const,
        approvalRequestId: open.id,
        message: WAITING,
        repeated: true as const,
      };
    }
    if (request.status !== "DRAFT" && request.status !== "SUBMITTED") {
      throw new Rejected(
        refuse(
          "invalid_transition",
          null,
          requestTransitionProblem(request.status, "APPROVED") ?? NOT_DRAFT,
        ),
      );
    }
    const lines = await tx.purchaseRequestLine.findMany({
      where: { requestId: request.id },
      take: PURCHASE_REQUEST_MAX_LINES,
      select: { product: { select: { sku: true, status: true } } },
    });
    if (lines.length === 0) {
      throw new Rejected(
        refuse(
          "invalid",
          null,
          "Esta solicitud todavía no pide nada. Agrega al menos un producto.",
        ),
      );
    }
    const archived = lines
      .filter((line) => line.product.status !== "ACTIVE")
      .map((line) => line.product.sku);
    if (archived.length > 0) {
      throw new Rejected(
        refuse(
          "invalid",
          null,
          `${archived.join(", ")} ${archived.length === 1 ? "está archivado" : "están archivados"}. Quítalo de la solicitud antes de enviarla.`,
        ),
      );
    }
    const now = new Date();
    const numberText = formatRequestNumber(request.number);
    if (await approvalRequired(tx, PURCHASE_REQUEST_APPROVAL.key)) {
      if (request.status === "DRAFT") {
        await tx.purchaseRequest.updateMany({
          where: { id: request.id },
          data: { status: "SUBMITTED", submittedAt: now },
        });
      }
      const asked = await openApprovalRequest(
        tx,
        PURCHASE_REQUEST_APPROVAL,
        actor,
        {
          sourceType: "purchase_request",
          sourceId: request.id,
          openKey: openKeyOf(request.id),
          facilityId: request.facilityId,
          summary: summaryOf(
            request.number,
            lines.length,
            request.neededOn,
            request.notes,
          ),
          payload: { requestId: request.id },
        },
      );
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "purchase_request.submitted",
        target: { type: "purchase_request", id: request.id },
        metadata: { solicitud: numberText, espera: "autorización" },
      });
      return {
        ok: false as const,
        reason: "pending_approval" as const,
        approvalRequestId: asked.requestId,
        message: WAITING,
      };
    }
    await tx.purchaseRequest.updateMany({
      where: { id: request.id },
      data: {
        status: "APPROVED",
        submittedAt: request.submittedAt ?? now,
        approvedAt: now,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "purchase_request.submitted",
      target: { type: "purchase_request", id: request.id },
      metadata: { solicitud: numberText },
    });
    await noticeToAttend(
      tx,
      organizationId,
      userId,
      request,
      summaryOf(request.number, lines.length, request.neededOn, request.notes),
    );
    return { ok: true as const, status: "APPROVED" as const };
  });
}

export type RequestTransitionResult =
  { ok: true; status: PurchaseRequestStatus; repeated?: true } | RequestFailure;

/**
 * Who asked withdraws the request while it is not authorized (a draft, or
 * waiting). Its pending authorization is withdrawn first, in its own
 * transaction (the motor's lock order: approval → request); if somebody
 * decided it in the meantime, nothing is cancelled and the person is told.
 */
export async function cancelPurchaseRequest(
  actor: PurchasingActor,
  requestId: string,
): Promise<RequestTransitionResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.request.create",
  );
  const id = String(requestId).slice(0, 36);
  const client = forOrganization(organizationId);
  const seen = await client.purchaseRequest.findFirst({
    where: { id, requestedByUserId: userId },
    select: { id: true, status: true },
  });
  if (seen?.status === "SUBMITTED") {
    const open = await findOpenApproval(client, openKeyOf(seen.id));
    if (open && open.requestedByUserId === userId) {
      // Loaded here: the types import the effects of this file.
      const { PURCHASING_APPROVAL_TYPES } = await import("./approvals");
      const withdrawn = await cancelApproval(
        actor,
        PURCHASING_APPROVAL_TYPES,
        open.id,
      );
      if (!withdrawn.ok && withdrawn.reason === "not_allowed") {
        return refuse("invalid_transition", null, withdrawn.error);
      }
    }
  }
  return inRequest(organizationId, async (tx) => {
    const request = await lockRequest(tx, userId, id);
    if (request.requestedByUserId !== userId) {
      throw new Rejected(refuse("not_allowed", null, NOT_YOURS));
    }
    if (request.status === "CANCELLED") {
      return {
        ok: true as const,
        status: "CANCELLED" as const,
        repeated: true as const,
      };
    }
    const problem = requestTransitionProblem(request.status, "CANCELLED");
    if (problem)
      throw new Rejected(refuse("invalid_transition", null, problem));
    if (await findOpenApproval(tx, openKeyOf(request.id))) {
      throw new Rejected(
        refuse(
          "invalid_transition",
          null,
          "Esta solicitud espera autorización. Vuelve a intentarlo en un momento.",
        ),
      );
    }
    await tx.purchaseRequest.updateMany({
      where: { id: request.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "purchase_request.cancelled",
      target: { type: "purchase_request", id: request.id },
      metadata: { solicitud: formatRequestNumber(request.number) },
    });
    return { ok: true as const, status: "CANCELLED" as const };
  });
}

const reasonSchema = z.object({
  reason: oneLine(300, "El motivo admite hasta 300 caracteres.").min(
    5,
    "Escribe por qué no se compra (al menos 5 letras).",
  ),
});

/**
 * Compras says no to a request it was to attend, with its reason («ya
 * hay», «no se compra»). Rejecting twice rejects once.
 */
export async function rejectPurchaseRequest(
  actor: PurchasingActor,
  requestId: string,
  input: { reason?: unknown },
): Promise<RequestTransitionResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.order.create",
  );
  const parsed = reasonSchema.safeParse({ reason: input?.reason ?? "" });
  if (!parsed.success) {
    return refuse("invalid", "reason", parsed.error.issues[0]!.message);
  }
  return inRequest(organizationId, async (tx) => {
    const request = await lockRequest(tx, userId, requestId);
    if (request.status === "REJECTED") {
      return {
        ok: true as const,
        status: "REJECTED" as const,
        repeated: true as const,
      };
    }
    if (request.status !== "APPROVED") {
      throw new Rejected(
        refuse(
          "invalid_transition",
          null,
          request.status === "SUBMITTED"
            ? "Esta solicitud espera autorización: se rechaza desde Aprobaciones."
            : (requestTransitionProblem(request.status, "REJECTED") ??
                "Esta solicitud ya no está por atender."),
        ),
      );
    }
    await tx.purchaseRequest.updateMany({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectedByUserId: userId,
        rejectReason: parsed.data.reason,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "purchase_request.rejected",
      target: { type: "purchase_request", id: request.id },
      reason: parsed.data.reason,
      metadata: { solicitud: formatRequestNumber(request.number) },
    });
    await noticeAnswered(
      tx,
      organizationId,
      userId,
      request,
      `Compras no va a comprar ${formatRequestNumber(request.number)}. Motivo: ${parsed.data.reason}`,
    );
    return { ok: true as const, status: "REJECTED" as const };
  });
}

// ---------------------------------------------------------------------------
// The effects of the approval type (inside `decideApproval`)

const payloadSchema = z.object({ requestId: z.string().min(1).max(36) });

/** What an authorization approves: the request it was asked for. */
async function lockForDecision(tx: ApprovalTx, context: ApprovalContext) {
  const payload = payloadSchema.safeParse(context.request.payload);
  const id = payload.success ? payload.data.requestId : null;
  if (!id || id !== context.request.sourceId) return null;
  const [locked] = await lockRows(tx, "purchaseRequest", [id]);
  return locked
    ? tx.purchaseRequest.findFirst({
        where: { id: locked },
        select: {
          id: true,
          number: true,
          status: true,
          facilityId: true,
          requestedByUserId: true,
        },
      })
    : null;
}

/**
 * Authorized: the request reaches Compras. Checked again under its lock:
 * if it no longer waits (cancelled meanwhile), the authorization expires.
 * Written in the name of who asked, with who authorized it.
 */
export async function approveRequestEffect(
  tx: ApprovalTx,
  context: ApprovalContext,
): Promise<{ outcome: string }> {
  const request = await lockForDecision(tx, context);
  if (!request || request.status !== "SUBMITTED") {
    throw new ApprovalExpired(
      "Esta solicitud de compra ya no espera autorización.",
    );
  }
  await tx.purchaseRequest.updateMany({
    where: { id: request.id, status: "SUBMITTED" },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByUserId: context.decidedByUserId,
    },
  });
  const numberText = formatRequestNumber(request.number);
  await recordAuditEvent(tx, {
    organizationId: context.organizationId,
    actorUserId: request.requestedByUserId,
    action: "purchase_request.approved",
    target: { type: "purchase_request", id: request.id },
    metadata: {
      solicitud: numberText,
      autorizadoPor: context.decidedByName ?? context.decidedByUserId,
      autorizacion: context.request.id,
    },
  });
  await noticeToAttend(
    tx,
    context.organizationId,
    context.decidedByUserId,
    { id: request.id, facilityId: request.facilityId },
    context.request.summary,
  );
  return { outcome: `${numberText} pasó a Compras para atenderse.` };
}

/** Rejected when authorizing: the request ends rejected, with that reason. */
export async function rejectRequestEffect(
  tx: ApprovalTx,
  context: ApprovalContext,
): Promise<void> {
  const request = await lockForDecision(tx, context);
  if (!request || request.status !== "SUBMITTED") return;
  await tx.purchaseRequest.updateMany({
    where: { id: request.id, status: "SUBMITTED" },
    data: {
      status: "REJECTED",
      rejectedAt: new Date(),
      rejectedByUserId: context.decidedByUserId,
      rejectReason: (context.reason ?? "Rechazada al autorizar.").slice(0, 500),
    },
  });
  await recordAuditEvent(tx, {
    organizationId: context.organizationId,
    actorUserId: context.decidedByUserId,
    action: "purchase_request.rejected",
    target: { type: "purchase_request", id: request.id },
    ...(context.reason ? { reason: context.reason } : {}),
    metadata: {
      solicitud: formatRequestNumber(request.number),
      autorizacion: context.request.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Converting into orders

export type ConvertRequestResult =
  | {
      ok: true;
      orders: {
        orderId: string;
        numberText: string;
        supplierName: string;
        lines: number;
      }[];
      summary: string;
      repeated?: true;
    }
  | RequestFailure;

/**
 * Turns a request to attend into one draft order per supplier (WMS-57):
 * `suppliers` says, by id of each line, which supplier to buy it from.
 * Once: under the lock of the request, a converted one answers with its
 * orders (`repeated`). Each line keeps what was asked for — the same
 * presentation and quantity, converted with the content in force — and
 * the last cost of that supplier only for who may record costs and only
 * when it was for that same way of buying it (as the suggestions, CMP-14).
 */
export async function convertPurchaseRequest(
  actor: PurchasingActor,
  requestId: string,
  input: { suppliers?: Record<string, unknown> },
): Promise<ConvertRequestResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "purchasing.order.create",
  );
  const withCosts = await may(actor, "purchasing.cost.record");
  const id = String(requestId).slice(0, 36);
  const chosen = new Map<string, string>();
  if (input?.suppliers && typeof input.suppliers === "object") {
    for (const [lineId, supplierId] of Object.entries(input.suppliers).slice(
      0,
      PURCHASE_REQUEST_MAX_LINES,
    )) {
      if (typeof supplierId === "string" && supplierId.trim()) {
        chosen.set(lineId.slice(0, 36), supplierId.trim().slice(0, 36));
      }
    }
  }
  const client = forOrganization(organizationId);
  // Lines change only in a draft (trigger), and a draft is not converted:
  // reading them before the locks tells which products to lock.
  const known = await client.purchaseRequestLine.findMany({
    where: { requestId: id },
    take: PURCHASE_REQUEST_MAX_LINES,
    select: { productId: true },
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await inRequest(organizationId, async (tx) => {
        await lockRows(
          tx,
          "product",
          known.map((line) => line.productId),
        );
        const request = await lockRequest(tx, userId, id);
        const numberText = formatRequestNumber(request.number);
        if (request.status === "CONVERTED") {
          const orders = await ordersOf(tx, request.id);
          return {
            ok: true as const,
            repeated: true as const,
            orders,
            summary: `${numberText} ya se había convertido en ${orders.map((order) => order.numberText).join(", ")}. No se crearon órdenes nuevas.`,
          };
        }
        if (request.status !== "APPROVED") {
          throw new Rejected(
            refuse(
              "invalid_transition",
              null,
              requestTransitionProblem(request.status, "CONVERTED") ??
                "Esta solicitud no está por atender.",
            ),
          );
        }
        const lines = await tx.purchaseRequestLine.findMany({
          where: { requestId: request.id },
          orderBy: { lineNumber: "asc" },
          take: PURCHASE_REQUEST_MAX_LINES,
          select: {
            id: true,
            productId: true,
            capturedQuantity: true,
            presentationId: true,
            product: { select: { sku: true, status: true } },
          },
        });
        if (lines.length === 0) {
          throw new Rejected(
            refuse("invalid", null, "Esta solicitud no pide nada."),
          );
        }
        const supplierIds = [...new Set(chosen.values())];
        const suppliers = await tx.contact.findMany({
          where: {
            id: { in: supplierIds },
            isSupplier: true,
            archivedAt: null,
          },
          select: { id: true, name: true },
        });
        const supplierOf = new Map(suppliers.map((row) => [row.id, row]));
        const lineErrors: Record<string, string> = {};
        for (const line of lines) {
          const supplierId = chosen.get(line.id);
          if (line.product.status !== "ACTIVE") {
            lineErrors[line.id] =
              `${line.product.sku} está archivado: no se compra. Rechaza la solicitud o pide que hagan otra.`;
          } else if (!supplierId) {
            lineErrors[line.id] = "Elige a quién se le compra.";
          } else if (!supplierOf.has(supplierId)) {
            lineErrors[line.id] =
              "Ese proveedor ya no está disponible. Elige otro de la lista.";
          }
        }
        if (Object.keys(lineErrors).length > 0) {
          throw new Rejected({
            ok: false,
            reason: "invalid",
            fieldErrors: {},
            formError:
              Object.keys(lineErrors).length === 1
                ? "Revisa el producto marcado."
                : "Revisa los productos marcados.",
            lineErrors,
          });
        }
        // The last cost of each product at each supplier, for who may
        // record costs only (never read otherwise).
        const costs = new Map<string, string>();
        if (withCosts) {
          const links = await tx.productSupplier.findMany({
            where: {
              productId: { in: lines.map((line) => line.productId) },
              contactId: { in: supplierIds },
              lastCost: { not: null },
            },
            select: {
              productId: true,
              contactId: true,
              lastCost: true,
              lastCostPresentationId: true,
            },
          });
          for (const link of links) {
            costs.set(
              `${link.productId}|${link.contactId}|${link.lastCostPresentationId ?? ""}`,
              link.lastCost!.toString(),
            );
          }
        }
        const groups = new Map<string, typeof lines>();
        for (const line of lines) {
          const supplierId = chosen.get(line.id)!;
          groups.set(supplierId, [...(groups.get(supplierId) ?? []), line]);
        }
        const last = await tx.purchaseOrder.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        let number = last?.number ?? 0;
        const orders: Extract<ConvertRequestResult, { ok: true }>["orders"] =
          [];
        for (const [supplierId, group] of [...groups.entries()].sort((a, b) =>
          supplierOf
            .get(a[0])!
            .name.localeCompare(supplierOf.get(b[0])!.name, "es"),
        )) {
          number += 1;
          const supplierName = supplierOf.get(supplierId)!.name;
          const written = await insertDraftOrder(tx, actor, {
            number,
            supplierId,
            supplierName,
            notes: `Desde la solicitud ${numberText}.`,
            expectedOn: request.neededOn,
            facilityId: request.facilityId,
            purchaseRequestId: request.id,
            origin: `solicitud ${numberText}`,
            lines: group.map((line) => {
              const quantity = line.capturedQuantity.toString();
              return {
                productId: line.productId,
                capture: line.presentationId
                  ? {
                      kind: "presentation" as const,
                      quantity,
                      presentationId: line.presentationId,
                    }
                  : { kind: "base" as const, quantity },
                unitCost:
                  costs.get(
                    `${line.productId}|${supplierId}|${line.presentationId ?? ""}`,
                  ) ?? null,
              };
            }),
          });
          if (!written.ok) {
            const line = group[written.line]!;
            throw new Rejected({
              ok: false,
              reason: "invalid",
              fieldErrors: {},
              formError: written.error,
              lineErrors: { [line.id]: written.error },
            });
          }
          orders.push({
            orderId: written.orderId,
            numberText: formatOrderNumber(number),
            supplierName,
            lines: group.length,
          });
        }
        await tx.purchaseRequest.updateMany({
          where: { id: request.id, status: "APPROVED" },
          data: {
            status: "CONVERTED",
            convertedAt: new Date(),
            convertedByUserId: userId,
          },
        });
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "purchase_request.converted",
          target: { type: "purchase_request", id: request.id },
          metadata: {
            solicitud: numberText,
            ordenes: orders.map((order) => order.numberText).join(", "),
          },
        });
        // Who asked may not see orders or suppliers: only that it is done.
        await noticeAnswered(
          tx,
          organizationId,
          userId,
          request,
          `Compras ya pidió lo de ${numberText}: se convirtió en orden de compra.`,
        );
        return {
          ok: true as const,
          orders,
          summary:
            orders.length === 1
              ? `Se creó el borrador ${orders[0]!.numberText} para ${orders[0]!.supplierName}. Revísalo antes de confirmarlo.`
              : `Se crearon ${orders.length} borradores: ${orders.map((order) => `${order.numberText} (${order.supplierName})`).join(", ")}. Revísalos antes de confirmarlos.`,
        };
      });
    } catch (error) {
      if (error instanceof OrderNumberTaken) continue;
      throw error;
    }
  }
  throw new Error("Could not number the orders of a purchase request");
}

async function ordersOf(client: Reader, requestId: string) {
  const rows = await client.purchaseOrder.findMany({
    where: { purchaseRequestId: requestId },
    orderBy: { number: "asc" },
    take: 50,
    select: {
      id: true,
      number: true,
      contact: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });
  return rows.map((row) => ({
    orderId: row.id,
    numberText: formatOrderNumber(row.number),
    supplierName: row.contact.name,
    lines: row._count.lines,
  }));
}

// ---------------------------------------------------------------------------
// Reading

async function namesOf(
  client: Reader,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const members = await client.membership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

/** Requests sent whose authorization is still pending, of those given. */
async function waitingOf(client: Reader, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await client.approvalRequest.findMany({
    where: { status: "PENDING", openKey: { in: ids.map(openKeyOf) } },
    select: { sourceId: true },
  });
  return new Set(rows.map((row) => row.sourceId ?? ""));
}

/** What a person reads as the state: «Se retiró la autorización» included. */
function statusText(status: PurchaseRequestStatus, waiting: boolean) {
  if (status === "SUBMITTED" && !waiting) return "Se retiró la autorización";
  return PURCHASE_REQUEST_STATUS_LABELS[status];
}

export type PurchaseRequestSummary = {
  id: string;
  numberText: string;
  status: PurchaseRequestStatus;
  statusLabel: string;
  requestedByName: string | null;
  lines: number;
  /** 2026-11-20, or null. */
  neededOn: string | null;
  createdAt: Date;
};

export type PurchaseRequestView = "attend" | "mine" | "all";

export type PurchaseRequestPage = {
  items: PurchaseRequestSummary[];
  total: number;
  page: number;
  pageCount: number;
  view: PurchaseRequestView;
};

/** `where` of the requests of a view, inside the person's warehouse. */
async function viewWhere(
  client: Reader,
  actor: PurchasingActor,
  view: PurchaseRequestView,
) {
  if (view === "mine") {
    // Across warehouses, but only those of the person's scope.
    const scope = await loadScope(client, actor.userId);
    return {
      requestedByUserId: actor.userId,
      ...(scope ? { facilityId: { in: [...scope.facilities.keys()] } } : {}),
    };
  }
  const active = await activeFacilityOf(client, actor.userId);
  if (view === "attend") {
    return { facilityId: active.id, status: "APPROVED" as const };
  }
  // A draft is private to who writes it.
  return {
    facilityId: active.id,
    OR: [
      { status: { not: "DRAFT" as const } },
      { requestedByUserId: actor.userId },
    ],
  };
}

/**
 * Requests a page at a time. «Por atender» (Compras: `attend`) are the
 * ones of the active warehouse that reached Compras, oldest first; «Mis
 * solicitudes» (`mine`) are the person's; «Todas» (`all`) are the sent ones
 * of the active warehouse. No costs anywhere.
 */
export async function listPurchaseRequests(
  actor: PurchasingActor,
  options: { view?: unknown; page?: number } = {},
): Promise<PurchaseRequestPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "purchasing.request.read",
  );
  const view: PurchaseRequestView =
    options.view === "attend" || options.view === "mine" ? options.view : "all";
  if (view === "attend") {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      "purchasing.order.create",
    );
  }
  const client = forOrganization(actor.organizationId);
  const where = await viewWhere(client, actor, view);
  const total = await client.purchaseRequest.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PURCHASE_REQUEST_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.purchaseRequest.findMany({
    where,
    // The number is unique in the company: a stable order on its index.
    orderBy: { number: view === "attend" ? "asc" : "desc" },
    skip: (page - 1) * PURCHASE_REQUEST_PAGE_SIZE,
    take: PURCHASE_REQUEST_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      neededOn: true,
      createdAt: true,
      requestedByUserId: true,
      _count: { select: { lines: true } },
    },
  });
  const [names, waiting] = await Promise.all([
    namesOf(
      client,
      rows.map((row) => row.requestedByUserId),
    ),
    waitingOf(
      client,
      rows.filter((row) => row.status === "SUBMITTED").map((row) => row.id),
    ),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatRequestNumber(row.number),
      status: row.status,
      statusLabel: statusText(row.status, waiting.has(row.id)),
      requestedByName: names.get(row.requestedByUserId) ?? null,
      lines: row._count.lines,
      neededOn: row.neededOn ? row.neededOn.toISOString().slice(0, 10) : null,
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    view,
  };
}

/** How many requests wait for Compras in the active warehouse (Inicio). */
export async function countRequestsToAttend(
  actor: PurchasingActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "purchasing.request.read",
  );
  if (!(await may(actor, "purchasing.order.create"))) return 0;
  const client = forOrganization(actor.organizationId);
  const active = await activeFacilityOf(client, actor.userId);
  return client.purchaseRequest.count({
    where: { facilityId: active.id, status: "APPROVED" },
  });
}

export type PurchaseRequestLineView = {
  id: string;
  lineNumber: number;
  productId: string;
  sku: string;
  productName: string;
  /** `base` or `p:<id>`: what the edit form shows as chosen. */
  capture: string;
  capturedQuantity: string;
  /** «3 cajas × 100 = 300 piezas», or «25 piezas». */
  quantityText: string;
};

export type PurchaseRequestDetail = {
  id: string;
  number: number;
  numberText: string;
  status: PurchaseRequestStatus;
  statusLabel: string;
  facilityName: string;
  requestedByName: string | null;
  neededOn: string | null;
  notes: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  rejectedAt: Date | null;
  rejectedByName: string | null;
  rejectReason: string | null;
  cancelledAt: Date | null;
  convertedAt: Date | null;
  lines: PurchaseRequestLineView[];
  /** The orders it became, with how they go; never amounts. */
  orders: {
    id: string;
    numberText: string;
    statusLabel: string;
    /** Only for who may see suppliers. */
    supplierName?: string;
  }[];
  /** The pending authorization, when it waits for one. */
  approvalRequestId: string | null;
  /** The person asked for it. */
  mine: boolean;
  /** Lines and data can be changed by the person. */
  editable: boolean;
  canSubmit: boolean;
  canCancel: boolean;
  /** Compras may convert it or reject it now. */
  canAttend: boolean;
};

/**
 * One request with its lines and where it stands, without costs; null
 * when it is not one the person may see (another warehouse, or another
 * person's draft).
 */
export async function getPurchaseRequest(
  actor: PurchasingActor,
  requestId: string,
): Promise<PurchaseRequestDetail | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "purchasing.request.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = await client.purchaseRequest.findFirst({
    where: { id: String(requestId).slice(0, 36) },
    select: {
      id: true,
      number: true,
      status: true,
      facilityId: true,
      facility: { select: { name: true } },
      neededOn: true,
      notes: true,
      createdAt: true,
      requestedByUserId: true,
      submittedAt: true,
      approvedAt: true,
      approvedByUserId: true,
      rejectedAt: true,
      rejectedByUserId: true,
      rejectReason: true,
      cancelledAt: true,
      convertedAt: true,
      lines: {
        orderBy: { lineNumber: "asc" },
        take: PURCHASE_REQUEST_MAX_LINES,
        select: {
          id: true,
          lineNumber: true,
          productId: true,
          capturedQuantity: true,
          presentationId: true,
          factor: true,
          baseQuantity: true,
          unitCode: true,
          product: { select: { sku: true, name: true } },
          presentation: { select: { name: true } },
        },
      },
      orders: {
        orderBy: { number: "asc" },
        take: 50,
        select: {
          id: true,
          number: true,
          status: true,
          contact: { select: { name: true } },
        },
      },
    },
  });
  if (!row) return null;
  const mine = row.requestedByUserId === actor.userId;
  if (row.status === "DRAFT" && !mine) return null;
  if (!(await isFacilityInScope(client, actor.userId, row.facilityId))) {
    return null;
  }
  const [names, open, creates, attends, seesSuppliers] = await Promise.all([
    namesOf(client, [
      row.requestedByUserId,
      row.approvedByUserId,
      row.rejectedByUserId,
    ]),
    row.status === "SUBMITTED"
      ? findOpenApproval(client, openKeyOf(row.id))
      : Promise.resolve(null),
    may(actor, "purchasing.request.create"),
    may(actor, "purchasing.order.create"),
    may(actor, "purchasing.supplier.read"),
  ]);
  return {
    id: row.id,
    number: row.number,
    numberText: formatRequestNumber(row.number),
    status: row.status,
    statusLabel: statusText(row.status, open !== null),
    facilityName: row.facility.name,
    requestedByName: names.get(row.requestedByUserId) ?? null,
    neededOn: row.neededOn ? row.neededOn.toISOString().slice(0, 10) : null,
    notes: row.notes,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    approvedByName: row.approvedByUserId
      ? (names.get(row.approvedByUserId) ?? null)
      : null,
    rejectedAt: row.rejectedAt,
    rejectedByName: row.rejectedByUserId
      ? (names.get(row.rejectedByUserId) ?? null)
      : null,
    rejectReason: row.rejectReason,
    cancelledAt: row.cancelledAt,
    convertedAt: row.convertedAt,
    lines: row.lines.map((line) => {
      const captured = dec(line.capturedQuantity.toString());
      const base = formatStock(line.baseQuantity.toString(), line.unitCode);
      return {
        id: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        sku: line.product.sku,
        productName: line.product.name,
        capture: line.presentationId ? `p:${line.presentationId}` : "base",
        capturedQuantity: captured.toString(),
        quantityText: line.presentation
          ? `${formatDecimal(captured)} ${pluralizeName(line.presentation.name, captured).toLowerCase()} × ${formatDecimal(line.factor.toString())} = ${base}`
          : base,
      };
    }),
    orders: row.orders.map((order) => ({
      id: order.id,
      numberText: formatOrderNumber(order.number),
      statusLabel: PURCHASE_ORDER_STATUS_LABELS[order.status],
      ...(seesSuppliers ? { supplierName: order.contact.name } : {}),
    })),
    approvalRequestId: open?.id ?? null,
    mine,
    editable: mine && creates && row.status === "DRAFT",
    canSubmit:
      mine &&
      creates &&
      row.lines.length > 0 &&
      (row.status === "DRAFT" || (row.status === "SUBMITTED" && !open)),
    canCancel:
      mine && creates && (row.status === "DRAFT" || row.status === "SUBMITTED"),
    canAttend: attends && row.status === "APPROVED",
  };
}
