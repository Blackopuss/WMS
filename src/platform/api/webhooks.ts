import "server-only";

import { z } from "zod";

import { log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  assertAllowed,
  can,
  lockOrganization,
  seesWholeCompany,
} from "@/platform/authorization";
import { getEntitlements } from "@/platform/entitlements";
import type { JobHandler } from "@/platform/jobs";
import { queueAutomationEvent } from "@/platform/automations";
import { enqueueJob } from "@/platform/jobs";
import { notify, type NotificationType } from "@/platform/notifications";
import {
  LOCKING_TRANSACTION,
  db,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";
import { DEMO_REFUSED_MESSAGE, isDemoCompany } from "@/platform/tenancy";

import {
  decryptSecret,
  encryptSecret,
  newSigningSecret,
  signatureHeader,
} from "./webhook-crypto";
import { WEBHOOK_API_VERSION, type WebhookEventType } from "./webhook-events";
import { checkWebhookUrl } from "./webhook-target";
import { createTransport, type WebhookTransport } from "./webhook-transport";

/**
 * Webhooks of a company (WMS-60, ADR 0058): destinations, events emitted
 * inside the transaction of the fact, deliveries by the worker with a
 * signature, retries, and a pause after repeated failures.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Actor = { organizationId: string; userId: string };

export const WEBHOOK_ENDPOINTS_MAX = 10;
/** Final failures in a row that pause a destination by itself. */
export const WEBHOOK_PAUSE_AFTER = 5;
export const WEBHOOK_DELIVERY_JOB = "platform.webhook_delivery";
export const WEBHOOK_MAX_ATTEMPTS = 6;
/** Wait before attempt n+1: 30 s, 2 min, 10 min, 30 min, 2 h. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
/** A previous secret still signs this long after a change. */
export const SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;
/** Events and deliveries older than this are deleted. */
export const WEBHOOK_HISTORY_DAYS = 30;

const MANAGE = "platform.api.manage" as const;
const NOT_FOUND = "Este destino no existe.";
export const WEBHOOK_FANOUT_JOB = "platform.webhook_fanout";
/** Why someone limited to warehouses or zones (WMS-20) cannot see webhooks. */
export const WEBHOOKS_LIMITED_MESSAGE =
  "Los webhooks mandan datos de toda la empresa: solo los configura quien no está limitado a almacenes o zonas.";

/**
 * Webhooks carry facts of every warehouse, so they are only for who sees
 * the whole company (WMS-20): checks the permission and that.
 */
async function assertWholeCompany(actor: Actor): Promise<boolean> {
  await assertAllowed(actor.organizationId, actor.userId, MANAGE);
  return seesWholeCompany(forOrganization(actor.organizationId), actor.userId);
}

const LIMITED: WebhookResult = {
  ok: false,
  reason: "not_allowed",
  error: WEBHOOKS_LIMITED_MESSAGE,
};

/** Notice for who manages the API when a destination paused by itself. */
export const WEBHOOK_PAUSED_NOTICE: NotificationType = {
  key: "platform.webhook_paused",
  module: null,
  label: "Un webhook se pausó por fallas",
  description:
    "A quien administra la API, cuando un destino falla varias veces seguidas y deja de recibir eventos.",
  defaultEnabled: true,
};

export const API_NOTIFICATION_TYPES: readonly NotificationType[] = [
  WEBHOOK_PAUSED_NOTICE,
];

// ── Destinations ─────────────────────────────────────────────────────────

export type WebhookField = "url" | "description" | "events";

export type WebhookResult =
  | { ok: true; endpointId: string; secret?: string; repeated?: boolean }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      error?: string;
      fieldErrors?: Partial<Record<WebhookField, string>>;
    };

const endpointSchema = z.object({
  url: z.string(),
  description: z
    .string()
    .trim()
    .max(120, "Usa como máximo 120 caracteres.")
    .optional()
    .transform((value) => value || null),
  events: z.array(z.string()),
});

function readEndpoint(
  input: {
    url: string;
    description?: string | null;
    events: readonly string[];
  },
  types: readonly Pick<WebhookEventType, "key">[],
) {
  const parsed = endpointSchema.safeParse({
    url: String(input.url ?? ""),
    description: input.description ?? undefined,
    events: Array.isArray(input.events) ? input.events.map(String) : [],
  });
  const fieldErrors: Partial<Record<WebhookField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0] as WebhookField] ??= issue.message;
    }
    return { ok: false as const, fieldErrors };
  }
  const url = checkWebhookUrl(parsed.data.url);
  if (!url.ok) fieldErrors.url = url.reason;
  const events = types
    .map((type) => type.key)
    .filter((key) => parsed.data.events.includes(key));
  if (events.length === 0) fieldErrors.events = "Elige al menos un evento.";
  if (!url.ok || events.length === 0)
    return { ok: false as const, fieldErrors };
  return {
    ok: true as const,
    data: {
      url: url.url.toString(),
      description: parsed.data.description,
      events,
    },
  };
}

/**
 * Adds a destination. `types` are the events that exist (the registry);
 * the signing secret is returned once.
 */
export async function createWebhookEndpoint(
  actor: Actor,
  input: {
    url: string;
    description?: string | null;
    events: readonly string[];
  },
  types: readonly Pick<WebhookEventType, "key">[],
): Promise<WebhookResult> {
  const { organizationId, userId } = actor;
  if (!(await assertWholeCompany(actor))) return LIMITED;
  // WMS-44 (ADR 0089): nothing leaves a demonstration (the mark never changes).
  if (await isDemoCompany(organizationId)) {
    return { ok: false, reason: "not_allowed", error: DEMO_REFUSED_MESSAGE };
  }
  const read = readEndpoint(input, types);
  if (!read.ok)
    return { ok: false, reason: "invalid", fieldErrors: read.fieldErrors };
  const secret = newSigningSecret();
  const endpointId = newId();
  // The cap is counted under the lock of the company (like the team).
  const full = await db.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const active = await tx.webhookEndpoint.count({
      where: { organizationId, removedAt: null },
    });
    if (active >= WEBHOOK_ENDPOINTS_MAX) return true;
    await tx.webhookEndpoint.create({
      data: {
        id: endpointId,
        organizationId,
        url: read.data.url,
        description: read.data.description,
        events: read.data.events,
        secretCiphertext: encryptSecret(secret),
        createdByUserId: userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "webhook.created",
      target: { type: "webhook_endpoint", id: endpointId },
      metadata: { url: read.data.url, eventos: read.data.events },
    });
    return false;
  });
  if (full) {
    return {
      ok: false,
      reason: "not_allowed",
      error: `Tu empresa ya tiene ${WEBHOOK_ENDPOINTS_MAX} destinos. Quita uno que ya no uses.`,
    };
  }
  return { ok: true, endpointId, secret };
}

async function inEndpoint(
  actor: Actor,
  endpointId: string,
  work: (
    tx: Tx,
    endpoint: { id: string; status: "ACTIVE" | "PAUSED"; url: string },
  ) => Promise<WebhookResult>,
): Promise<WebhookResult> {
  const { organizationId } = actor;
  if (!(await assertWholeCompany(actor))) return LIMITED;
  return forOrganization(organizationId).$transaction(async (tx) => {
    const [id] = await lockRows(tx, "webhookEndpoint", [String(endpointId)]);
    const endpoint = id
      ? await tx.webhookEndpoint.findFirst({
          where: { id, removedAt: null },
          select: { id: true, status: true, url: true },
        })
      : null;
    if (!endpoint) return { ok: false, reason: "not_found", error: NOT_FOUND };
    return work(tx, endpoint);
  }, LOCKING_TRANSACTION);
}

export async function updateWebhookEndpoint(
  actor: Actor,
  endpointId: string,
  input: {
    url: string;
    description?: string | null;
    events: readonly string[];
  },
  types: readonly Pick<WebhookEventType, "key">[],
): Promise<WebhookResult> {
  const read = readEndpoint(input, types);
  if (!read.ok) {
    if (!(await assertWholeCompany(actor))) return LIMITED;
    return { ok: false, reason: "invalid", fieldErrors: read.fieldErrors };
  }
  return inEndpoint(actor, endpointId, async (tx, endpoint) => {
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: read.data,
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "webhook.changed",
      target: { type: "webhook_endpoint", id: endpoint.id },
      metadata: { url: read.data.url, eventos: read.data.events },
    });
    return { ok: true, endpointId: endpoint.id };
  });
}

/** Pauses or resumes a destination; resuming forgets the failures. */
export async function setWebhookEndpointPaused(
  actor: Actor,
  endpointId: string,
  paused: boolean,
): Promise<WebhookResult> {
  return inEndpoint(actor, endpointId, async (tx, endpoint) => {
    const status = paused ? "PAUSED" : "ACTIVE";
    if (endpoint.status === status) {
      return { ok: true, endpointId: endpoint.id, repeated: true };
    }
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status, pausedByFailures: false, consecutiveFailures: 0 },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: paused ? "webhook.paused" : "webhook.resumed",
      target: { type: "webhook_endpoint", id: endpoint.id },
    });
    return { ok: true, endpointId: endpoint.id };
  });
}

/**
 * A new signing secret, returned once. The previous one keeps signing
 * for SECRET_OVERLAP_MS so the receiver can change without losing events.
 */
export async function rotateWebhookSecret(
  actor: Actor,
  endpointId: string,
): Promise<WebhookResult> {
  return inEndpoint(actor, endpointId, async (tx, endpoint) => {
    const current = await tx.webhookEndpoint.findFirstOrThrow({
      where: { id: endpoint.id },
      select: { secretCiphertext: true },
    });
    const secret = newSigningSecret();
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        secretCiphertext: encryptSecret(secret),
        previousSecretCiphertext: current.secretCiphertext,
        previousSecretExpiresAt: new Date(Date.now() + SECRET_OVERLAP_MS),
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "webhook.secret_rotated",
      target: { type: "webhook_endpoint", id: endpoint.id },
    });
    return { ok: true, endpointId: endpoint.id, secret };
  });
}

/** Removes a destination: it receives nothing more; its deliveries stay. */
export async function removeWebhookEndpoint(
  actor: Actor,
  endpointId: string,
): Promise<WebhookResult> {
  return inEndpoint(actor, endpointId, async (tx, endpoint) => {
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { removedAt: new Date(), status: "PAUSED" },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "webhook.removed",
      target: { type: "webhook_endpoint", id: endpoint.id },
      metadata: { url: endpoint.url },
    });
    return { ok: true, endpointId: endpoint.id };
  });
}

export type WebhookDeliveryView = {
  id: string;
  eventId: string;
  eventType: string;
  status: "PENDING" | "DELIVERED" | "FAILED" | "SKIPPED";
  attempts: number;
  lastStatusCode: number | null;
  reason: string | null;
  createdAt: Date;
  lastAttemptAt: Date | null;
};

export type WebhookEndpointView = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: "ACTIVE" | "PAUSED";
  pausedByFailures: boolean;
  consecutiveFailures: number;
  createdAt: Date;
  /** The last deliveries, newest first. Never the body. */
  deliveries: WebhookDeliveryView[];
};

/** Destinations of the company with their last deliveries. Never a secret. */
export async function listWebhookEndpoints(
  actor: Actor,
  options: { deliveries?: number } = {},
): Promise<
  | { limited: true; endpoints: [] }
  | { limited: false; endpoints: WebhookEndpointView[] }
> {
  if (!(await assertWholeCompany(actor))) {
    return { limited: true, endpoints: [] };
  }
  const take = Math.min(Math.max(options.deliveries ?? 10, 0), 50);
  const rows = await forOrganization(
    actor.organizationId,
  ).webhookEndpoint.findMany({
    where: { removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: WEBHOOK_ENDPOINTS_MAX,
    select: {
      id: true,
      url: true,
      description: true,
      events: true,
      status: true,
      pausedByFailures: true,
      consecutiveFailures: true,
      createdAt: true,
      deliveries: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          eventId: true,
          status: true,
          attempts: true,
          lastStatusCode: true,
          reason: true,
          createdAt: true,
          lastAttemptAt: true,
          event: { select: { type: true } },
        },
      },
    },
  });
  const endpoints = rows.map((row) => ({
    id: row.id,
    url: row.url,
    description: row.description,
    events: Array.isArray(row.events) ? row.events.map(String) : [],
    status: row.status,
    pausedByFailures: row.pausedByFailures,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    deliveries: row.deliveries.map((delivery) => ({
      id: delivery.id,
      eventId: delivery.eventId,
      eventType: delivery.event.type,
      status: delivery.status,
      attempts: delivery.attempts,
      lastStatusCode: delivery.lastStatusCode,
      reason: delivery.reason,
      createdAt: delivery.createdAt,
      lastAttemptAt: delivery.lastAttemptAt,
    })),
  }));
  return { limited: false, endpoints };
}

// ── Emitting ─────────────────────────────────────────────────────────────

export type WebhookEmitTx = Pick<
  Tx,
  "webhookEndpoint" | "webhookEvent" | "job" | "automationRule"
>;

/**
 * Emits an event of a fact. Call it with the transaction that writes the
 * fact, after its writes: if it is rolled back, there is no event. Inside
 * that transaction it only reads (without locks) whether some destination
 * listens, writes the event and queues ONE job that hands it out to the
 * destinations later, outside the locks of the fact; with no destination
 * listening, nothing is written. `data` carries ids, numbers of documents
 * and quantities as text; never costs.
 *
 * WMS-64 (ADR 0092): the same fact is what automations listen to. When a
 * rule turned on listens, one more job is queued here (and nothing else
 * changes for the service that emits).
 */
export async function emitWebhookEvent(
  tx: WebhookEmitTx,
  type: Pick<WebhookEventType, "key" | "module">,
  input: { organizationId: string; data: Record<string, unknown> },
): Promise<{ eventId: string } | null> {
  await queueAutomationEvent(tx, type, input);
  const endpoints = await tx.webhookEndpoint.findMany({
    where: { status: "ACTIVE", removedAt: null },
    select: { events: true },
    take: WEBHOOK_ENDPOINTS_MAX,
  });
  const listening = endpoints.some(
    (endpoint) =>
      Array.isArray(endpoint.events) && endpoint.events.includes(type.key),
  );
  if (!listening) return null;
  const eventId = newId();
  const createdAt = new Date();
  const payload = JSON.parse(
    JSON.stringify({
      id: eventId,
      type: type.key,
      apiVersion: WEBHOOK_API_VERSION,
      createdAt: createdAt.toISOString(),
      data: input.data,
    }),
  );
  await tx.webhookEvent.create({
    data: {
      id: eventId,
      organizationId: input.organizationId,
      type: type.key,
      payload,
      createdAt,
    },
  });
  await enqueueJob(tx, input.organizationId, {
    type: WEBHOOK_FANOUT_JOB,
    payload: { eventId, module: type.module },
  });
  return { eventId };
}

/**
 * The handler of `platform.webhook_fanout`: one delivery (and its job) per
 * destination that listens now, if the module of the event is contracted.
 * Idempotent: the unique destination + event keeps a delivery from being
 * created twice when it runs again.
 */
export function webhookFanoutHandler(): JobHandler {
  return {
    async handle({ organizationId, payload }) {
      const { eventId, module } = (payload ?? {}) as {
        eventId?: unknown;
        module?: unknown;
      };
      const client = forOrganization(organizationId);
      const event = await client.webhookEvent.findFirst({
        where: { id: String(eventId ?? "") },
        select: { id: true, type: true, createdAt: true },
      });
      if (!event) return { deliveries: 0 };
      const entitlements = await getEntitlements(organizationId);
      if (
        typeof module !== "string" ||
        entitlements.moduleState(module) === "none"
      ) {
        return { deliveries: 0, skipped: "module" };
      }
      // A destination added after the fact does not receive it (ADR 0058).
      const endpoints = await client.webhookEndpoint.findMany({
        where: {
          status: "ACTIVE",
          removedAt: null,
          createdAt: { lte: event.createdAt },
        },
        select: { id: true, events: true },
        take: WEBHOOK_ENDPOINTS_MAX,
      });
      let created = 0;
      for (const endpoint of endpoints) {
        if (
          !Array.isArray(endpoint.events) ||
          !endpoint.events.includes(event.type)
        ) {
          continue;
        }
        const exists = await client.webhookDelivery.findFirst({
          where: { endpointId: endpoint.id, eventId: event.id },
          select: { id: true },
        });
        if (exists) continue;
        try {
          await client.$transaction(async (tx) => {
            const deliveryId = newId();
            await tx.webhookDelivery.create({
              data: {
                id: deliveryId,
                organizationId,
                endpointId: endpoint.id,
                eventId: event.id,
              },
            });
            await enqueueJob(tx, organizationId, {
              type: WEBHOOK_DELIVERY_JOB,
              payload: { deliveryId },
              maxAttempts: WEBHOOK_MAX_ATTEMPTS,
            });
          });
          created++;
        } catch (error) {
          // Created at the same time by another run: already handed out.
          if ((error as { code?: string }).code !== "P2002") throw error;
        }
      }
      return { deliveries: created };
    },
    // It holds nothing: if it fails for good the event stays without
    // deliveries until the cleanup (ADR 0058); it is left in the log.
    async onFailed({ organizationId, payload }) {
      log.warn("webhook.fanout_failed", {
        organizationId,
        eventId: String((payload as { eventId?: unknown })?.eventId ?? ""),
      });
    },
  };
}

// ── Delivering (worker) ──────────────────────────────────────────────────

class DeliveryFailed extends Error {}

const deliveryIdOf = (payload: unknown) =>
  typeof payload === "object" && payload !== null
    ? String((payload as { deliveryId?: unknown }).deliveryId ?? "")
    : "";

/**
 * The handler of `platform.webhook_delivery`. Idempotent: a delivery that
 * is no longer pending is not sent again. A failed attempt throws so the
 * queue retries with a growing wait; `onFailed` closes the delivery,
 * counts a failure in a row and pauses the destination after
 * WEBHOOK_PAUSE_AFTER, with a notice inside the app.
 */
export function webhookDeliveryHandler(
  options: { transport?: WebhookTransport; now?: () => Date } = {},
): JobHandler {
  const transport = options.transport ?? createTransport();
  const clock = options.now ?? (() => new Date());
  return {
    retryDelayMs: (attempt) =>
      RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 30_000,
    async handle({ organizationId, payload, attempt }) {
      const client = forOrganization(organizationId);
      const delivery = await client.webhookDelivery.findFirst({
        where: { id: deliveryIdOf(payload) },
        select: {
          id: true,
          status: true,
          event: { select: { id: true, type: true, payload: true } },
          endpoint: {
            select: {
              id: true,
              url: true,
              status: true,
              removedAt: true,
              secretCiphertext: true,
              previousSecretCiphertext: true,
              previousSecretExpiresAt: true,
            },
          },
        },
      });
      if (!delivery || delivery.status !== "PENDING") return { skipped: true };
      const { endpoint, event } = delivery;
      if (endpoint.removedAt || endpoint.status !== "ACTIVE") {
        await client.webhookDelivery.updateMany({
          where: { id: delivery.id, status: "PENDING" },
          data: {
            status: "SKIPPED",
            reason: "El destino estaba pausado o se quitó.",
          },
        });
        return { skipped: true };
      }
      const now = clock();
      const secrets = [decryptSecret(endpoint.secretCiphertext)];
      if (
        endpoint.previousSecretCiphertext &&
        endpoint.previousSecretExpiresAt &&
        endpoint.previousSecretExpiresAt.getTime() > now.getTime()
      ) {
        secrets.push(decryptSecret(endpoint.previousSecretCiphertext));
      }
      const body = JSON.stringify(event.payload);
      const outcome = await transport({
        url: endpoint.url,
        body,
        headers: {
          "wms-event-id": event.id,
          "wms-event-type": event.type,
          "wms-signature": signatureHeader(
            secrets,
            Math.floor(now.getTime() / 1000),
            body,
          ),
        },
      });
      await client.webhookDelivery.updateMany({
        where: { id: delivery.id, status: "PENDING" },
        data: {
          attempts: attempt,
          lastAttemptAt: now,
          lastStatusCode: outcome.status ?? null,
          ...(outcome.kind === "delivered"
            ? { status: "DELIVERED", deliveredAt: now, reason: null }
            : { reason: outcome.reason.slice(0, 200) }),
        },
      });
      if (outcome.kind === "delivered") {
        await client.webhookEndpoint.updateMany({
          where: { id: endpoint.id, consecutiveFailures: { gt: 0 } },
          data: { consecutiveFailures: 0 },
        });
        return { delivered: true, status: outcome.status };
      }
      // Our own reason, never the body or the receiver's answer.
      throw new DeliveryFailed(outcome.reason);
    },
    async onFailed({ organizationId, payload }) {
      await forOrganization(organizationId).$transaction(async (tx) => {
        const delivery = await tx.webhookDelivery.findFirst({
          where: { id: deliveryIdOf(payload) },
          select: { id: true, endpointId: true, status: true },
        });
        if (!delivery) return;
        await lockRows(tx, "webhookEndpoint", [delivery.endpointId]);
        const closed = await tx.webhookDelivery.updateMany({
          where: { id: delivery.id, status: "PENDING" },
          data: { status: "FAILED" },
        });
        if (closed.count === 0) return;
        await tx.webhookDelivery.updateMany({
          where: { id: delivery.id, reason: null },
          data: { reason: "No se pudo entregar." },
        });
        const endpoint = await tx.webhookEndpoint.findFirstOrThrow({
          where: { id: delivery.endpointId },
          select: {
            id: true,
            status: true,
            consecutiveFailures: true,
            description: true,
          },
        });
        const failures = endpoint.consecutiveFailures + 1;
        const pause =
          endpoint.status === "ACTIVE" && failures >= WEBHOOK_PAUSE_AFTER;
        await tx.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: {
            consecutiveFailures: failures,
            ...(pause ? { status: "PAUSED", pausedByFailures: true } : {}),
          },
        });
        if (!pause) return;
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: null,
          action: "webhook.paused",
          target: { type: "webhook_endpoint", id: endpoint.id },
          metadata: { motivo: "fallas seguidas", fallas: failures },
        });
        // Only who sees the whole company manages webhooks (WMS-20): someone
        // limited never hears of a destination, not even by email.
        const managers = await wholeCompanyManagers(tx);
        if (managers.length === 0) return;
        const name = endpoint.description
          ? `«${endpoint.description}»`
          : "Un destino de webhooks";
        await notify(tx, WEBHOOK_PAUSED_NOTICE, {
          organizationId,
          actorUserId: null,
          // WMS-88: checked again when the mail leaves.
          to: { userIds: managers, permissions: [MANAGE], wholeCompany: true },
          // Never the address of the destination: the notice may also leave
          // by email (WMS-39B). Its name is what the company called it.
          text: `${name} se pausó después de ${failures} entregas fallidas seguidas. Revísalo en API y webhooks.`,
          href: "/configuracion/api",
          key: `webhook:${endpoint.id}:paused:${delivery.id}`,
        });
      }, LOCKING_TRANSACTION);
    },
  };
}

/**
 * Members who may manage the API and see the whole company: those without
 * any scope row (the titular is never limited). Read with the client of
 * the transaction.
 */
async function wholeCompanyManagers(
  tx: Pick<Tx, "membership">,
): Promise<string[]> {
  const members = await tx.membership.findMany({
    where: { status: "ACTIVE" },
    take: 2000,
    select: {
      userId: true,
      roles: { select: { role: true } },
      scopes: { select: { id: true }, take: 1 },
      organization: { select: { ownerUserId: true } },
    },
  });
  return members
    .filter((member) => {
      const isOwner = member.organization.ownerUserId === member.userId;
      if (!isOwner && member.scopes.length > 0) return false;
      return can(
        { isOwner, roles: member.roles.map((each) => each.role) },
        MANAGE,
      );
    })
    .map((member) => member.userId);
}

/** Events and deliveries older than WEBHOOK_HISTORY_DAYS (a round of the worker). */
export async function purgeWebhookHistory(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ events: number; deliveries: number }> {
  const before = new Date(
    now.getTime() - WEBHOOK_HISTORY_DAYS * 24 * 60 * 60 * 1000,
  );
  const client = forOrganization(organizationId);
  const deliveries = await client.webhookDelivery.deleteMany({
    where: { event: { createdAt: { lt: before } }, status: { not: "PENDING" } },
  });
  const events = await client.webhookEvent.deleteMany({
    where: { createdAt: { lt: before }, deliveries: { none: {} } },
  });
  return { events: events.count, deliveries: deliveries.count };
}

/** Companies with webhook history: who the cleanup round goes through. */
export async function organizationsWithWebhookHistory(): Promise<string[]> {
  const rows = await db.webhookEvent.groupBy({
    by: ["organizationId"],
    orderBy: { organizationId: "asc" },
  });
  return rows.map((row) => row.organizationId);
}
