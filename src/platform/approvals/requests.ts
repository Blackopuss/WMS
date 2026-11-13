import "server-only";

import { z } from "zod";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  buildScope,
  knownRoles,
  loadScope,
  loadSubject,
  permissionsOf,
  type Subject,
} from "@/platform/authorization";
import { entitles } from "@/platform/billing";
import { getEntitlements, type Entitlements } from "@/platform/entitlements";
import {
  isFacilityInScope,
  isLimited,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { memberName, notify } from "@/platform/notifications";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import {
  ApprovalExpired,
  type ApprovalContext,
  type ApprovalTx,
  type ApprovalType,
} from "./definitions";
import { APPROVAL_DECIDED_NOTICE, APPROVAL_PENDING_NOTICE } from "./notices";
import { readApprovalRule, type ApprovalRuleValue } from "./rules";
import { APPROVAL_STATUS_LABELS, type ApprovalStatus } from "./states";

/**
 * Approval requests (WMS-56, ADR 0053). A module asks inside its own
 * transaction (`openApprovalRequest`), after its locks, so checking and
 * asking happen together. Deciding is one transaction that locks the
 * request first, reads the person and the rule in force under that lock,
 * and runs the module's effect in the same transaction: a request is never
 * approved twice, and never approved halfway.
 *
 * Lock order: request → whatever the effect locks (products → locations →
 * documents). Nothing locks a request after one of those: asking inserts
 * a new row, and withdrawing or expiring lock only the request.
 */

type Actor = { organizationId: string; userId: string };
type Client = ApprovalTx;

const MAX_SUMMARY = 1000;
const MAX_PAYLOAD = 20_000;
export const APPROVALS_PAGE_SIZE = 25;

const NOT_FOUND = "Esta solicitud ya no existe.";

// ---------------------------------------------------------------------------
// Asking (inside the module's transaction)

export type OpenApprovalInput = {
  sourceType?: string | null;
  sourceId?: string | null;
  /** One open request per thing: «count:<id>». */
  openKey?: string | null;
  /** The confirmation of the form; a retry finds the same request. */
  idempotencyKey?: string | null;
  facilityId?: string | null;
  locationId?: string | null;
  /** What who decides reads; never with costs. */
  summary: string;
  /** What the module needs to apply it later; never secrets. */
  payload: Record<string, unknown>;
};

export type OpenApprovalResult =
  | { ok: true; requestId: string }
  | { ok: false; reason: "already_open"; requestId: string };

/**
 * Creates a pending request with the client of the module's transaction.
 * Writes the audit event of the request in the same transaction.
 */
export async function openApprovalRequest(
  tx: Client,
  type: Pick<ApprovalType, "key" | "label" | "decidePermissions">,
  actor: Actor,
  input: OpenApprovalInput,
): Promise<OpenApprovalResult> {
  const summary = input.summary.replace(/\s+/g, " ").trim();
  if (!summary) throw new Error("An approval request needs its summary");
  const payloadText = JSON.stringify(input.payload);
  if (payloadText.length > MAX_PAYLOAD) {
    throw new Error(`Payload of ${type.key} is too large`);
  }
  if (input.openKey) {
    const open = await findOpenApproval(tx, input.openKey);
    if (open) return { ok: false, reason: "already_open", requestId: open.id };
  }
  const id = newId();
  await tx.approvalRequest.create({
    data: {
      id,
      organizationId: actor.organizationId,
      typeKey: type.key,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      openKey: input.openKey?.slice(0, 120) ?? null,
      idempotencyKey: input.idempotencyKey?.slice(0, 64) ?? null,
      facilityId: input.facilityId ?? null,
      locationId: input.locationId ?? null,
      summary: summary.slice(0, MAX_SUMMARY),
      payload: JSON.parse(payloadText),
      requestedByUserId: actor.userId,
    },
  });
  await recordAuditEvent(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "approval.requested",
    target: { type: "approval_request", id },
    metadata: { tipo: type.label, resumen: summary },
  });
  // WMS-39: who may decide it hears it now (the rule in force, its roles
  // or the titular, what deciding takes, inside their scope).
  const rule = await readApprovalRule(tx, type.key);
  await notify(tx, APPROVAL_PENDING_NOTICE, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    to: {
      permissions: type.decidePermissions,
      roles: rule.roles,
      facilityId: input.facilityId ?? null,
      locationId: input.locationId ?? null,
    },
    text: `${await memberName(tx, actor.userId)} pide autorizar: ${summary}`,
    href: `/aprobaciones/${id}`,
    key: `approval:${id}:pending`,
  });
  return { ok: true, requestId: id };
}

/** The pending request that holds that key, if any. */
export async function findOpenApproval(
  client: Pick<Client, "approvalRequest">,
  openKey: string,
): Promise<{ id: string; requestedByUserId: string } | null> {
  return client.approvalRequest.findFirst({
    where: { openKey: String(openKey).slice(0, 120), status: "PENDING" },
    select: { id: true, requestedByUserId: true },
  });
}

/** The request a confirmation created, whatever its state (a retry). */
export async function findApprovalByKey(
  client: Pick<Client, "approvalRequest">,
  idempotencyKey: string,
): Promise<{
  id: string;
  typeKey: string;
  status: ApprovalStatus;
  summary: string;
  requestedByUserId: string;
  payload: unknown;
} | null> {
  return client.approvalRequest.findFirst({
    where: { idempotencyKey: String(idempotencyKey).slice(0, 64) },
    select: {
      id: true,
      typeKey: true,
      status: true,
      summary: true,
      requestedByUserId: true,
      payload: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Who may decide

/** The person as the database says now, read with the given client. */
async function subjectIn(
  client: Pick<Client, "membership">,
  userId: string,
): Promise<(Subject & { name: string | null }) | null> {
  const membership = await client.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    select: {
      roles: { select: { role: true } },
      scopes: { select: { facilityId: true, locationId: true } },
      organization: { select: { ownerUserId: true } },
      user: { select: { name: true } },
    },
  });
  if (!membership) return null;
  const isOwner = membership.organization.ownerUserId === userId;
  const scope = isOwner ? null : buildScope(membership.scopes);
  return {
    isOwner,
    roles: membership.roles.map((each) => each.role),
    ...(scope ? { scope } : {}),
    name: membership.user.name,
  };
}

/**
 * True when the subject may decide requests of the type under that rule:
 * titular or one of its roles, holding what deciding takes, with the
 * module in full use. Self-approval and scope are asked apart.
 */
function mayDecide(
  subject: Subject,
  type: ApprovalType,
  rule: ApprovalRuleValue,
  entitlements: Entitlements,
): boolean {
  if (subject.support === true) return false;
  const byRole =
    subject.isOwner === true ||
    knownRoles(subject.roles).some((role) => rule.roles.includes(role));
  if (!byRole) return false;
  if (type.module && entitlements.moduleState(type.module) !== "active") {
    return false;
  }
  const granted = permissionsOf(subject);
  return type.decidePermissions.every(
    (permission) =>
      granted.has(permission) && entitles(entitlements, permission),
  );
}

/** True when the request's warehouse or location is open to the person. */
async function requestInScope(
  client: Pick<Client, "membership" | "location">,
  userId: string,
  request: { facilityId: string | null; locationId: string | null },
): Promise<boolean> {
  if (request.locationId) {
    return (
      (await locationsOutOfScope(client, userId, [request.locationId]))
        .length === 0
    );
  }
  if (request.facilityId) {
    return isFacilityInScope(client, userId, request.facilityId);
  }
  return true;
}

/** `where` that keeps only requests inside the person's scope. */
async function scopeWhere(
  client: Pick<Client, "membership" | "location">,
  userId: string,
) {
  const scoped = await locationScopeWhere(client, userId);
  if (!isLimited(scoped)) return {};
  const scope = await loadScope(client, userId);
  const facilities = scope ? [...scope.facilities.keys()] : [];
  return {
    OR: [
      { facilityId: null },
      { locationId: null, facilityId: { in: facilities } },
      { location: scoped },
    ],
  };
}

/** For each type the person may decide: whether they may approve their own. */
async function decidableTypes(
  actor: Actor,
  types: readonly ApprovalType[],
): Promise<Map<string, boolean>> {
  const client = forOrganization(actor.organizationId);
  const [subject, entitlements] = await Promise.all([
    loadSubject(actor.organizationId, actor.userId),
    getEntitlements(actor.organizationId),
  ]);
  const result = new Map<string, boolean>();
  for (const type of types) {
    const rule = await readApprovalRule(client, type.key);
    if (mayDecide(subject, type, rule, entitlements)) {
      result.set(type.key, rule.allowSelfApproval);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deciding

const reasonText = z
  .string()
  .trim()
  .regex(
    /^[^\u0000-\u001f\u007f]*$/,
    "Quita los saltos de línea o tabuladores.",
  )
  .max(500, "El motivo es demasiado largo (máximo 500 caracteres).");

const decideSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    reason: reasonText.optional().transform((value) => value || null),
  }),
  z.object({
    decision: z.literal("reject"),
    reason: reasonText.min(5, "Escribe por qué la rechazas."),
  }),
]);

export type DecideInput = z.input<typeof decideSchema>;

export type DecideResult =
  | {
      ok: true;
      status: "APPROVED" | "REJECTED";
      /** «Autorizada: Ajuste de Tornillo en A-01…». */
      summary: string;
      repeated?: true;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed" | "expired";
      field?: "reason";
      error: string;
    };

/** Carries an expected refusal out of the transaction so it rolls back. */
class Refused extends Error {
  constructor(readonly result: Extract<DecideResult, { ok: false }>) {
    super("approval refused");
  }
}

const refuse = (reason: "not_found" | "not_allowed", error: string): never => {
  throw new Refused({ ok: false, reason, error });
};

const FINAL_TEXT: Record<Exclude<ApprovalStatus, "PENDING">, string> = {
  APPROVED: "Esta solicitud ya se autorizó.",
  REJECTED: "Esta solicitud ya se rechazó.",
  CANCELLED: "Quien la pidió ya la retiró.",
  EXPIRED: "Esta solicitud venció: ya no aplica.",
};

const REQUEST_SELECT = {
  id: true,
  typeKey: true,
  sourceType: true,
  sourceId: true,
  payload: true,
  summary: true,
  status: true,
  requestedByUserId: true,
  createdAt: true,
  facilityId: true,
  locationId: true,
  outcome: true,
  decidedByUserId: true,
} as const;

/**
 * Approves or rejects a pending request. Everything is checked under the
 * request's lock, with the person and the rule as they are now; approving
 * runs the module's effect in the same transaction.
 */
export async function decideApproval(
  actor: Actor,
  types: readonly ApprovalType[],
  requestId: string,
  input: DecideInput,
): Promise<DecideResult> {
  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      field: "reason",
      error: parsed.error.issues[0]?.message ?? "Revisa lo que escribiste.",
    };
  }
  const data = parsed.data;
  const id = String(requestId).slice(0, 36);
  const { organizationId, userId } = actor;
  const entitlements = await getEntitlements(organizationId);
  const client = forOrganization(organizationId);

  try {
    return await client.$transaction(
      async (tx) => {
        const [locked] = await lockRows(tx, "approvalRequest", [id]);
        const request = locked
          ? await tx.approvalRequest.findFirst({
              where: { id: locked },
              select: REQUEST_SELECT,
            })
          : null;
        if (!request) return refuse("not_found", NOT_FOUND);
        const subject = await subjectIn(tx, userId);
        const mine = request.requestedByUserId === userId;
        if (!subject || !(await requestInScope(tx, userId, request))) {
          return refuse("not_found", NOT_FOUND);
        }
        const type = types.find((each) => each.key === request.typeKey);
        const rule = type ? await readApprovalRule(tx, type.key) : null;
        const eligible =
          type !== undefined &&
          rule !== null &&
          mayDecide(subject, type, rule, entitlements);
        // For anybody but who asked, who may decide or who decided it, the
        // request does not exist.
        if (!mine && !eligible && request.decidedByUserId !== userId) {
          return refuse("not_found", NOT_FOUND);
        }
        if (request.status !== "PENDING") {
          const final = request.status;
          if (
            (final === "APPROVED" && data.decision === "approve") ||
            (final === "REJECTED" && data.decision === "reject")
          ) {
            return {
              ok: true as const,
              status: final,
              repeated: true as const,
              summary: FINAL_TEXT[final],
            };
          }
          return refuse("not_allowed", FINAL_TEXT[final]);
        }
        if (!type || !rule) {
          return refuse(
            "not_allowed",
            "Esta solicitud es de algo que tu empresa ya no tiene activo.",
          );
        }
        if (!eligible) {
          return refuse(
            mine ? "not_allowed" : "not_found",
            mine
              ? "No puedes autorizar tu propia solicitud. Espera a que la decida alguien más o retírala."
              : NOT_FOUND,
          );
        }
        if (mine && !rule.allowSelfApproval) {
          return refuse(
            "not_allowed",
            "No puedes decidir tu propia solicitud: la regla de tu empresa pide que la autorice alguien más. Si ya no la necesitas, retírala.",
          );
        }

        const context: ApprovalContext = {
          organizationId,
          request: {
            id: request.id,
            typeKey: request.typeKey,
            sourceType: request.sourceType,
            sourceId: request.sourceId,
            payload: request.payload,
            summary: request.summary,
            requestedByUserId: request.requestedByUserId,
            createdAt: request.createdAt,
            facilityId: request.facilityId,
            locationId: request.locationId,
          },
          decidedByUserId: userId,
          decidedByName: subject.name,
          reason: data.reason,
        };
        let outcome: string | null = null;
        if (data.decision === "approve") {
          outcome = (await type.approve(tx, context)).outcome;
        } else {
          await type.reject?.(tx, context);
        }
        const status = data.decision === "approve" ? "APPROVED" : "REJECTED";
        await tx.approvalRequest.updateMany({
          where: { id: request.id, status: "PENDING" },
          data: {
            status,
            openKey: null,
            decidedByUserId: userId,
            decidedAt: new Date(),
            decisionReason: data.reason,
            outcome: outcome?.slice(0, 1000) ?? null,
          },
        });
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action:
            status === "APPROVED" ? "approval.approved" : "approval.rejected",
          target: { type: "approval_request", id: request.id },
          ...(data.reason ? { reason: data.reason } : {}),
          metadata: {
            tipo: type.label,
            resumen: request.summary,
            ...(outcome ? { resultado: outcome } : {}),
          },
        });
        // WMS-39: who asked hears the answer.
        await notify(tx, APPROVAL_DECIDED_NOTICE, {
          organizationId,
          actorUserId: userId,
          to: { userIds: [request.requestedByUserId] },
          text:
            status === "APPROVED"
              ? `Se autorizó: ${request.summary}`
              : `Se rechazó: ${request.summary}. Motivo: ${data.reason ?? ""}`,
          href: `/aprobaciones/${request.id}`,
          key: `approval:${request.id}:decided`,
        });
        return {
          ok: true as const,
          status,
          summary:
            status === "APPROVED"
              ? `Autorizada. ${outcome ?? ""}`.trim()
              : "Rechazada: no se aplicó nada.",
        };
      },
      { ...LOCKING_TRANSACTION, timeout: 60_000, maxWait: 15_000 },
    );
  } catch (error) {
    if (error instanceof Refused) return error.result;
    if (error instanceof ApprovalExpired) {
      await expire(actor, types, id, error.message);
      return { ok: false, reason: "expired", error: error.message };
    }
    throw error;
  }
}

/** Marks a pending request expired, under its lock, with the reason. */
async function expire(
  actor: Actor,
  types: readonly ApprovalType[],
  id: string,
  why: string,
): Promise<void> {
  await forOrganization(actor.organizationId).$transaction(async (tx) => {
    const [locked] = await lockRows(tx, "approvalRequest", [id]);
    if (!locked) return;
    const request = await tx.approvalRequest.findFirst({
      where: { id: locked },
      select: {
        id: true,
        status: true,
        typeKey: true,
        summary: true,
        requestedByUserId: true,
      },
    });
    if (!request || request.status !== "PENDING") return;
    await tx.approvalRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: "EXPIRED",
        openKey: null,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
        outcome: why.slice(0, 1000),
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "approval.expired",
      target: { type: "approval_request", id: request.id },
      reason: why,
      metadata: {
        tipo:
          types.find((type) => type.key === request.typeKey)?.label ??
          request.typeKey,
        resumen: request.summary,
      },
    });
    await notify(tx, APPROVAL_DECIDED_NOTICE, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      to: { userIds: [request.requestedByUserId] },
      text: `Venció lo que pediste autorizar: ${request.summary}. ${why}`,
      href: `/aprobaciones/${request.id}`,
      key: `approval:${request.id}:decided`,
    });
  }, LOCKING_TRANSACTION);
}

export type CancelApprovalResult =
  | { ok: true; repeated?: true }
  | { ok: false; reason: "not_found" | "not_allowed"; error: string };

/** Who asked withdraws a pending request; nothing is applied. */
export async function cancelApproval(
  actor: Actor,
  types: readonly ApprovalType[],
  requestId: string,
): Promise<CancelApprovalResult> {
  const id = String(requestId).slice(0, 36);
  try {
    return await forOrganization(actor.organizationId).$transaction(
      async (tx) => {
        const [locked] = await lockRows(tx, "approvalRequest", [id]);
        const request = locked
          ? await tx.approvalRequest.findFirst({
              where: { id: locked, requestedByUserId: actor.userId },
              select: { id: true, status: true, typeKey: true, summary: true },
            })
          : null;
        if (!request) return refuse("not_found", NOT_FOUND);
        if (request.status === "CANCELLED") {
          return { ok: true as const, repeated: true as const };
        }
        if (request.status !== "PENDING") {
          return refuse("not_allowed", FINAL_TEXT[request.status]);
        }
        await tx.approvalRequest.updateMany({
          where: { id: request.id, status: "PENDING" },
          data: {
            status: "CANCELLED",
            openKey: null,
            decidedByUserId: actor.userId,
            decidedAt: new Date(),
          },
        });
        await recordAuditEvent(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "approval.cancelled",
          target: { type: "approval_request", id: request.id },
          metadata: {
            tipo:
              types.find((type) => type.key === request.typeKey)?.label ??
              request.typeKey,
            resumen: request.summary,
          },
        });
        return { ok: true as const };
      },
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Refused) {
      const { reason, error: message } = error.result;
      return {
        ok: false,
        reason: reason === "not_allowed" ? "not_allowed" : "not_found",
        error: message,
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading

export type ApprovalRequestSummary = {
  id: string;
  typeKey: string;
  typeLabel: string;
  summary: string;
  status: ApprovalStatus;
  statusLabel: string;
  requestedByName: string | null;
  createdAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  outcome: string | null;
  /** Where to see what it is about, if there is a screen. */
  href: string | null;
};

export type ApprovalRequestView = ApprovalRequestSummary & {
  /** The person asked for it. */
  mine: boolean;
  /** The person may approve or reject it now. */
  canDecide: boolean;
  /** The person asked for it and it is still pending. */
  canCancel: boolean;
};

export type ApprovalPage = {
  rows: ApprovalRequestSummary[];
  total: number;
  page: number;
  pageCount: number;
};

const LIST_SELECT = {
  id: true,
  typeKey: true,
  sourceType: true,
  sourceId: true,
  summary: true,
  status: true,
  requestedByUserId: true,
  createdAt: true,
  decidedByUserId: true,
  decidedAt: true,
  decisionReason: true,
  outcome: true,
  facilityId: true,
  locationId: true,
} as const;

type ListRow = {
  id: string;
  typeKey: string;
  sourceType: string | null;
  sourceId: string | null;
  summary: string;
  status: ApprovalStatus;
  requestedByUserId: string;
  createdAt: Date;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  outcome: string | null;
};

async function namesOf(
  client: Pick<Client, "membership">,
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

function summarize(
  rows: ListRow[],
  names: Map<string, string>,
  types: readonly ApprovalType[],
): ApprovalRequestSummary[] {
  return rows.map((row) => {
    const type = types.find((each) => each.key === row.typeKey);
    return {
      id: row.id,
      typeKey: row.typeKey,
      typeLabel: type?.label ?? "Otra solicitud",
      summary: row.summary,
      status: row.status,
      statusLabel: APPROVAL_STATUS_LABELS[row.status],
      requestedByName: names.get(row.requestedByUserId) ?? null,
      createdAt: row.createdAt,
      decidedByName: row.decidedByUserId
        ? (names.get(row.decidedByUserId) ?? null)
        : null,
      decidedAt: row.decidedAt,
      decisionReason: row.decisionReason,
      outcome: row.outcome,
      href: type?.href?.(row) ?? null,
    };
  });
}

async function page(
  client: Client | ReturnType<typeof forOrganization>,
  where: object,
  types: readonly ApprovalType[],
  pageNumber: number,
  order: "asc" | "desc",
): Promise<ApprovalPage> {
  const total = await client.approvalRequest.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / APPROVALS_PAGE_SIZE));
  const current = Math.min(
    Math.max(1, Math.floor(Number(pageNumber) || 1)),
    pageCount,
  );
  const rows = await client.approvalRequest.findMany({
    where,
    orderBy: [{ createdAt: order }, { id: order }],
    skip: (current - 1) * APPROVALS_PAGE_SIZE,
    take: APPROVALS_PAGE_SIZE,
    select: LIST_SELECT,
  });
  const names = await namesOf(
    client,
    rows.flatMap((row) => [row.requestedByUserId, row.decidedByUserId]),
  );
  return {
    rows: summarize(rows, names, types),
    total,
    page: current,
    pageCount,
  };
}

/** `where` of the pending requests the person may decide, or null if none. */
async function pendingWhere(actor: Actor, types: readonly ApprovalType[]) {
  const decidable = await decidableTypes(actor, types);
  if (decidable.size === 0) return null;
  const client = forOrganization(actor.organizationId);
  return {
    AND: [
      { status: "PENDING" as const },
      {
        OR: [...decidable].map(([typeKey, self]) =>
          self
            ? { typeKey }
            : { typeKey, requestedByUserId: { not: actor.userId } },
        ),
      },
      await scopeWhere(client, actor.userId),
    ],
  };
}

/**
 * Pending requests the person may decide, oldest first. `decides` says
 * whether they may decide any type at all (the screen shows the tab).
 */
export async function listPendingApprovals(
  actor: Actor,
  types: readonly ApprovalType[],
  options: { page?: number } = {},
): Promise<ApprovalPage & { decides: boolean }> {
  const where = await pendingWhere(actor, types);
  if (!where)
    return { rows: [], total: 0, page: 1, pageCount: 1, decides: false };
  const result = await page(
    forOrganization(actor.organizationId),
    where,
    types,
    options.page ?? 1,
    "asc",
  );
  return { ...result, decides: true };
}

/** How many requests wait for the person (Inicio); 0 if they decide none. */
export async function countPendingApprovals(
  actor: Actor,
  types: readonly ApprovalType[],
): Promise<number> {
  const where = await pendingWhere(actor, types);
  if (!where) return 0;
  return forOrganization(actor.organizationId).approvalRequest.count({ where });
}

/** What the person asked for, newest first. */
export async function listMyApprovalRequests(
  actor: Actor,
  types: readonly ApprovalType[],
  options: { page?: number; pendingOnly?: boolean } = {},
): Promise<ApprovalPage> {
  return page(
    forOrganization(actor.organizationId),
    {
      requestedByUserId: actor.userId,
      ...(options.pendingOnly ? { status: "PENDING" as const } : {}),
    },
    types,
    options.page ?? 1,
    "desc",
  );
}

/**
 * One request, for who asked for it or who may decide it (inside their
 * scope); for anybody else it does not exist (null).
 */
export async function getApprovalRequest(
  actor: Actor,
  types: readonly ApprovalType[],
  requestId: string,
): Promise<ApprovalRequestView | null> {
  const client = forOrganization(actor.organizationId);
  const row = await client.approvalRequest.findFirst({
    where: { id: String(requestId).slice(0, 36) },
    select: LIST_SELECT,
  });
  if (!row) return null;
  if (!(await requestInScope(client, actor.userId, row))) return null;
  const mine = row.requestedByUserId === actor.userId;
  const decidable = await decidableTypes(
    actor,
    types.filter((type) => type.key === row.typeKey),
  );
  const decides = decidable.has(row.typeKey);
  const decidedIt = row.decidedByUserId === actor.userId;
  if (!mine && !decides && !decidedIt) return null;
  const names = await namesOf(client, [
    row.requestedByUserId,
    row.decidedByUserId,
  ]);
  const [summary] = summarize([row], names, types);
  const pending = row.status === "PENDING";
  return {
    ...summary!,
    mine,
    canDecide:
      pending && decides && (!mine || decidable.get(row.typeKey) === true),
    canCancel: pending && mine,
  };
}
