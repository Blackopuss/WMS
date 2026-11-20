import "server-only";

import { newId } from "@/lib";
import { currentDelegation, db, type TenantDb } from "@/server";

import {
  sanitizeMetadata,
  type AuditMetadata,
  type SafeJsonObject,
} from "./sanitize";

/**
 * Audit log (PLT-14). Append-only (database triggers reject UPDATE and
 * DELETE). Two kinds:
 * - company events (`recordAuditEvent`): who changed what in a company and
 *   why; written with the same client as the change, inside its
 *   transaction, so the change and its record exist together;
 * - account security events (`recordSecurityEvent`): password, MFA and
 *   sessions of one person.
 * Metadata is sanitized: no passwords, tokens, codes or secrets.
 */

const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

function checkAction(action: string) {
  if (!ACTION.test(action) || action.length > 80) {
    throw new Error(`Invalid audit action "${action}"`);
  }
}

export type AuditEventInput = {
  organizationId: string;
  /** Null for changes made by the system. */
  actorUserId: string | null;
  /** Dotted name, e.g. "organization.created", "inventory.adjustment". */
  action: string;
  target?: { type: string; id: string };
  /** Reason given by the person, when the action asks for one. */
  reason?: string;
  metadata?: AuditMetadata;
  ipAddress?: string | null;
};

type AuditEventData = {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata?: SafeJsonObject;
  ipAddress: string | null;
};

/** Anything that can create audit rows: a transaction or a scoped client. */
type AuditWriter = {
  auditEvent: { create(args: { data: AuditEventData }): PromiseLike<unknown> };
};

/** Records a company event with the client (or transaction) of the change. */
export async function recordAuditEvent(
  client: AuditWriter,
  event: AuditEventInput,
): Promise<void> {
  checkAction(event.action);
  // WMS-60: what an API key does is written for its creator; the record
  // says which key (its id, never the secret).
  const delegation = currentDelegation();
  const viaKey =
    delegation &&
    delegation.organizationId === event.organizationId &&
    delegation.userId === event.actorUserId
      ? delegation.automation
        ? { automatizacion: delegation.automation.ruleId }
        : { llaveApi: delegation.apiKeyId ?? "" }
      : null;
  const metadata = sanitizeMetadata(
    viaKey ? { ...(event.metadata ?? {}), ...viaKey } : event.metadata,
  );
  await client.auditEvent.create({
    data: {
      id: newId(),
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.target?.type.slice(0, 40) ?? null,
      targetId: event.target?.id.slice(0, 64) ?? null,
      reason: event.reason?.trim().slice(0, 500) || null,
      ...(metadata ? { metadata } : {}),
      ipAddress: event.ipAddress?.slice(0, 64) ?? null,
    },
  });
}

export type SecurityEventInput = {
  userId: string;
  action: string;
  metadata?: AuditMetadata;
  ipAddress?: string | null;
  /** Company the event happened in (WMS-68); none for account events. */
  organizationId?: string | null;
  /** «phone|Chrome|Android» (`deviceKeyOf`); never the raw user agent. */
  deviceKey?: string | null;
  /** Makes the event happen once per person (`claimSecurityEvent`). */
  dedupeKey?: string | null;
};

type SecurityEventWriter = {
  securityEvent: {
    create(args: {
      data: {
        id: string;
        userId: string;
        action: string;
        metadata?: SafeJsonObject;
        ipAddress: string | null;
        eventOrganizationId: string | null;
        deviceKey: string | null;
        dedupeKey: string | null;
      };
    }): PromiseLike<unknown>;
  };
};

function securityEventData(event: SecurityEventInput) {
  checkAction(event.action);
  const metadata = sanitizeMetadata(event.metadata);
  return {
    id: newId(),
    userId: event.userId,
    action: event.action,
    ...(metadata ? { metadata } : {}),
    ipAddress: event.ipAddress?.slice(0, 64) ?? null,
    eventOrganizationId: event.organizationId?.slice(0, 36) ?? null,
    deviceKey: event.deviceKey?.slice(0, 80) ?? null,
    dedupeKey: event.dedupeKey?.slice(0, 120) ?? null,
  };
}

/**
 * Records an account security event. Never breaks the operation that
 * triggered it: a failure is logged and the operation goes on. With
 * `client` (a transaction) it is written with the change it belongs to,
 * and a failure goes up with it.
 */
export async function recordSecurityEvent(
  event: SecurityEventInput,
  client?: SecurityEventWriter,
): Promise<void> {
  const data = securityEventData(event);
  if (client) {
    await client.securityEvent.create({ data });
    return;
  }
  try {
    await db.securityEvent.create({ data });
  } catch (error) {
    console.error("recordSecurityEvent failed", event.action, error);
  }
}

/**
 * Records an event that must happen once per person (`dedupeKey`, unique
 * with the person): true when this call wrote it, false when it was
 * already there (two requests at once: only one gets true) or could not be
 * written (logged).
 */
export async function claimSecurityEvent(
  event: SecurityEventInput & { dedupeKey: string },
): Promise<boolean> {
  try {
    await db.securityEvent.create({ data: securityEventData(event) });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") {
      console.error("claimSecurityEvent failed", event.action, error);
    }
    return false;
  }
}

export type AuditEventRow = {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
};

/** Newest company events first (for USR-11 and support). */
export async function listAuditEvents(
  client: TenantDb,
  options: { limit?: number; before?: Date } = {},
): Promise<AuditEventRow[]> {
  return client.auditEvent.findMany({
    where: options.before ? { createdAt: { lt: options.before } } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    select: {
      id: true,
      actorUserId: true,
      action: true,
      targetType: true,
      targetId: true,
      reason: true,
      metadata: true,
      createdAt: true,
    },
  });
}

/** Newest security events of one person first. */
export async function listSecurityEvents(userId: string, limit = 50) {
  return db.securityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, action: true, metadata: true, createdAt: true },
  });
}
