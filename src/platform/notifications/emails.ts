import "server-only";

import { isInternalHref, log } from "@/lib";
import type { Permission } from "@/platform/authorization";
import { InvalidEmailError, noticeEmail, sendEmail } from "@/platform/email";
import { getFreshEntitlements } from "@/platform/entitlements";
import { enqueueJob, type JobHandlers } from "@/platform/jobs";
import { placeOfLocation } from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { forOrganization } from "@/server";

import { isEmailOnly, type NotificationType } from "./definitions";
import {
  MEMBER_SELECT,
  NOTICE_EMAIL_GAP_MS,
  NOTICE_EMAIL_JOB_TYPE,
  NOTICE_EMAIL_MAX_ATTEMPTS,
  memberReaches,
  nextMailAt,
  type NoticeRequirement,
} from "./notify";
import { READ_NOTICE_DAYS } from "./notifications";
import { NOTICE_EMAIL_CHANNEL } from "./settings";

/**
 * Notices by mail (WMS-39B, ADR 0060). `notify` writes a row per person
 * that asked for the type by mail and a job; the worker runs
 * `sendNoticeEmails`, which takes every row of that person still waiting
 * and sends them in one mail. Before sending it checks again, with the
 * database as it is now, that the person may still get each one.
 *
 * - **One notice, one mail.** Rows are taken with an atomic update
 *   (`claimedBy`): two jobs never take the same row, and a job run again
 *   finds its rows already sent. If the worker dies between sending and
 *   closing, the next try sends again (as CMP-06B: a repeated mail is
 *   preferred over one believed sent that never left).
 * - **Bounded.** A mail gathers what arrived in the last minutes, and two
 *   mails to the same person are at least NOTICE_EMAIL_GAP_MS apart.
 * - **The notice never depends on it.** The notice in the app is already
 *   written; a mail that fails only marks its own row.
 */

type Client = ReturnType<typeof forOrganization>;

/** Notices listed in one mail; the rest are counted and lead to /avisos. */
export const NOTICE_EMAIL_LINES = 10;
/** Rows of a person one mail takes at most (the rest wait for the next). */
const CLAIM_MAX = 200;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
const FAILED_AFTER_RETRIES =
  "No se pudo entregar el correo después de varios intentos.";

/** Whether the company sends notices by mail (its setting). */
export async function isEmailChannelOn(
  client: Pick<Client, "organizationSetting">,
): Promise<boolean> {
  return (await readSetting(client, NOTICE_EMAIL_CHANNEL)) === "on";
}

/** Whether the company of the session sends notices by mail (a screen). */
export async function companySendsNoticeEmails(
  organizationId: string,
): Promise<boolean> {
  return isEmailChannelOn(forOrganization(organizationId));
}

/** The company sends mail only while it has a plan in force. */
async function planAllows(
  organizationId: string,
  moduleId: string | null,
): Promise<boolean> {
  const entitlements = await getFreshEntitlements(organizationId);
  if (entitlements.modules.size === 0) return false;
  return moduleId === null || entitlements.hasModule(moduleId);
}

/** The full address of a path of the app, for a link in a mail. */
export function appLink(href: string): string {
  const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  return `${base}${isInternalHref(href) ? href : "/avisos"}`;
}

/**
 * Whether a person still wants a type by mail now: the row of their
 * preference says so, and (for a notice in the app) the type is still on.
 */
export async function wantsEmail(
  client: Pick<Client, "notificationPreference">,
  userId: string,
  type: Pick<NotificationType, "key" | "defaultEnabled" | "channels">,
): Promise<boolean> {
  const row = await client.notificationPreference.findFirst({
    where: { userId, typeKey: type.key },
    select: { enabled: true, email: true },
  });
  if (!row?.email) return false;
  return isEmailOnly(type) || row.enabled;
}

/**
 * Who asked for a type by mail and is still an active member (a mail-only
 * type such as a daily summary), in a fixed order.
 */
export async function emailSubscribers(
  client: Pick<Client, "notificationPreference" | "membership">,
  typeKey: string,
  limit = 1000,
): Promise<string[]> {
  // Active members first: a preference of someone who left never takes a
  // place under the limit.
  const active = await client.membership.findMany({
    where: { status: "ACTIVE" },
    orderBy: { userId: "asc" },
    take: 5000,
    select: { userId: true },
  });
  if (active.length === 0) return [];
  const rows = await client.notificationPreference.findMany({
    where: {
      typeKey,
      email: true,
      userId: { in: active.map((row) => row.userId) },
    },
    orderBy: { userId: "asc" },
    take: limit,
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/**
 * The address a member of the company is written to: the confirmed email
 * of their account, while their membership is active. Null otherwise.
 */
export async function memberAddress(
  client: Pick<Client, "membership">,
  userId: string,
): Promise<{ email: string; organizationName: string } | null> {
  const member = await client.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    select: {
      user: { select: { email: true, emailVerified: true } },
      organization: { select: { name: true } },
    },
  });
  if (!member || !member.user.emailVerified) return null;
  return {
    email: member.user.email,
    organizationName: member.organization.name,
  };
}

function requirementOf(value: unknown): NoticeRequirement {
  const raw = (value ?? {}) as Record<string, unknown>;
  const strings = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((each): each is string => typeof each === "string")
      : undefined;
  return {
    permissions: strings(raw.permissions) as Permission[] | undefined,
    match: raw.match === "any" ? "any" : "all",
    roles: strings(raw.roles),
    facilityId: typeof raw.facilityId === "string" ? raw.facilityId : null,
    locationId: typeof raw.locationId === "string" ? raw.locationId : null,
  };
}

export type NoticeEmailOutcome =
  | { sent: number; skipped: number; to: string }
  | { sent: 0; skipped: number; reason: string };

async function closeRows(
  client: Client,
  ids: readonly string[],
  status: "SKIPPED" | "FAILED",
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  await client.notificationEmail.updateMany({
    where: { id: { in: [...ids] }, status: "QUEUED" },
    data: { status, reason: reason.slice(0, 300) },
  });
}

/**
 * Sends the mail of a notice (the worker), gathering every notice of the
 * same person still waiting. `jobId` marks the rows it takes; the same job
 * run again finds them sent. Throws only when the mail could not leave:
 * the queue tries again.
 */
export async function sendNoticeEmails(
  organizationId: string,
  emailId: string,
  options: {
    types: readonly NotificationType[];
    jobId: string;
    /** The attempt of the job that runs it (the worker passes it). */
    attempt?: number;
    now?: Date;
  },
): Promise<NoticeEmailOutcome> {
  const client = forOrganization(organizationId);
  const now = options.now ?? new Date();
  const jobId = String(options.jobId).slice(0, 36);
  const own = await client.notificationEmail.findFirst({
    where: { id: String(emailId).slice(0, 36) },
    select: { id: true, recipientUserId: true, status: true, claimedBy: true },
  });
  if (!own) return { sent: 0, skipped: 0, reason: "El correo ya no existe." };
  const userId = own.recipientUserId;
  // A try of this same job already took it (it failed before closing).
  const retry = own.status === "QUEUED" && own.claimedBy === jobId;
  if (!retry && (own.status !== "QUEUED" || own.claimedBy !== null)) {
    // Another job took it (or it ended): that one deals with what waits.
    return { sent: 0, skipped: 0, reason: "Otro envío ya lo tomó." };
  }

  const lastSentAt = await lastMailAt(client, userId);
  if (!retry) {
    // Not before the gap since the last mail to this person: this row
    // waits for its next turn, and so does whatever arrived with it.
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < NOTICE_EMAIL_GAP_MS
    ) {
      await enqueueJob(client, organizationId, {
        type: NOTICE_EMAIL_JOB_TYPE,
        payload: { emailId: own.id },
        runAt: nextMailAt(now, lastSentAt),
        maxAttempts: NOTICE_EMAIL_MAX_ATTEMPTS,
      });
      return { sent: 0, skipped: 0, reason: "Espera al siguiente correo." };
    }
    // Take what waits for this person, at most CLAIM_MAX rows, by id: the
    // update touches only rows still free (two jobs never take the same
    // row) and never a range of the index that a notice is writing.
    const free = await client.notificationEmail.findMany({
      where: { recipientUserId: userId, status: "QUEUED", claimedBy: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CLAIM_MAX,
      select: { id: true },
    });
    if (free.length > 0) {
      await client.notificationEmail.updateMany({
        where: { id: { in: free.map((row) => row.id) }, claimedBy: null },
        data: { claimedBy: jobId },
      });
    }
  }
  const rows = await client.notificationEmail.findMany({
    where: { recipientUserId: userId, status: "QUEUED", claimedBy: jobId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CLAIM_MAX,
    select: {
      id: true,
      typeKey: true,
      text: true,
      href: true,
      requirement: true,
    },
  });
  if (rows.length === 0) {
    return { sent: 0, skipped: 0, reason: "No había nada por mandar." };
  }
  const ids = rows.map((row) => row.id);
  const stop = async (reason: string): Promise<NoticeEmailOutcome> => {
    await closeRows(client, ids, "SKIPPED", reason);
    await followUp(client, organizationId, userId, now, lastSentAt);
    return { sent: 0, skipped: ids.length, reason };
  };

  if (!(await isEmailChannelOn(client))) {
    return stop("La empresa apagó los avisos por correo.");
  }
  const address = await memberAddress(client, userId);
  if (!address) {
    return stop(
      "La persona ya no está en la empresa o no tiene correo confirmado.",
    );
  }
  const member = await client.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    select: MEMBER_SELECT,
  });
  if (!member) return stop("La persona ya no está en la empresa.");

  const byKey = new Map(options.types.map((type) => [type.key, type]));
  const keep: typeof rows = [];
  const dropped: { id: string; reason: string }[] = [];
  const allowedByModule = new Map<string | null, boolean>();
  const wanted = new Map<string, boolean>();
  for (const row of rows) {
    const type = byKey.get(row.typeKey);
    if (!type || isEmailOnly(type)) {
      dropped.push({ id: row.id, reason: "Ese tipo de aviso ya no existe." });
      continue;
    }
    if (!allowedByModule.has(type.module)) {
      allowedByModule.set(
        type.module,
        await planAllows(organizationId, type.module),
      );
    }
    if (!allowedByModule.get(type.module)) {
      dropped.push({
        id: row.id,
        reason: "La empresa no tiene un plan vigente para esto.",
      });
      continue;
    }
    if (!wanted.has(type.key)) {
      wanted.set(type.key, await wantsEmail(client, userId, type));
    }
    if (!wanted.get(type.key)) {
      dropped.push({
        id: row.id,
        reason: "La persona dejó de recibir este aviso por correo.",
      });
      continue;
    }
    const requirement = requirementOf(row.requirement);
    let place = null;
    if (requirement.locationId) {
      place = await placeOfLocation(client, requirement.locationId);
      if (!place) {
        dropped.push({ id: row.id, reason: "La ubicación ya no existe." });
        continue;
      }
    } else if (requirement.facilityId) {
      place = { facilityId: requirement.facilityId };
    }
    if (!memberReaches(member, requirement, place)) {
      dropped.push({
        id: row.id,
        reason: "La persona ya no tiene permiso o alcance para este aviso.",
      });
      continue;
    }
    keep.push(row);
  }
  for (const each of dropped) {
    await closeRows(client, [each.id], "SKIPPED", each.reason);
  }
  if (keep.length === 0) {
    await followUp(client, organizationId, userId, now, lastSentAt);
    return { sent: 0, skipped: dropped.length, reason: "Nada que mandar." };
  }

  // A worker that only went slow may have lost the job to another one
  // (the queue takes it again after STALE_AFTER_MS, with one more
  // attempt): then that one sends, never both.
  if (options.attempt !== undefined) {
    const job = await client.job.findFirst({
      where: { id: jobId },
      select: { status: true, attempts: true },
    });
    if (job && (job.status !== "RUNNING" || job.attempts !== options.attempt)) {
      return {
        sent: 0,
        skipped: dropped.length,
        reason: "Otro intento lo tomó.",
      };
    }
  }

  try {
    await sendEmail(
      noticeEmail({
        to: address.email,
        organizationName: address.organizationName,
        items: keep.slice(0, NOTICE_EMAIL_LINES).map((row) => ({
          text: row.text,
          url: appLink(row.href),
        })),
        more: Math.max(0, keep.length - NOTICE_EMAIL_LINES),
        allUrl: appLink("/avisos"),
        settingsUrl: appLink("/configuracion/avisos"),
      }),
    );
  } catch (error) {
    // A message that must not leave as it is: trying again changes nothing.
    if (error instanceof InvalidEmailError) {
      log.warn("notice_email_rejected", { organizationId, emailId: own.id });
      await closeRows(
        client,
        keep.map((row) => row.id),
        "FAILED",
        "El correo no se pudo armar con los datos de la cuenta.",
      );
      return { sent: 0, skipped: dropped.length, reason: "Correo inválido." };
    }
    throw error;
  }
  const sentAt = new Date();
  await client.notificationEmail.updateMany({
    where: { id: { in: keep.map((row) => row.id) }, status: "QUEUED" },
    data: { status: "SENT", sentAt },
  });
  await followUp(client, organizationId, userId, now, sentAt);
  return { sent: keep.length, skipped: dropped.length, to: address.email };
}

/** When the last mail of notices went out to a person, if ever. */
async function lastMailAt(
  client: Client,
  userId: string,
): Promise<Date | null> {
  const last = await client.notificationEmail.aggregate({
    where: { recipientUserId: userId },
    _max: { sentAt: true },
  });
  return last._max.sentAt ?? null;
}

/**
 * What is still free for the person after a mail (more than CLAIM_MAX
 * rows, or what arrived meanwhile) gets a job for its next turn, so no
 * row is left waiting without one.
 */
async function followUp(
  client: Client,
  organizationId: string,
  userId: string,
  now: Date,
  lastSentAt: Date | null,
): Promise<void> {
  const next = await client.notificationEmail.findFirst({
    where: { recipientUserId: userId, status: "QUEUED", claimedBy: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!next) return;
  await enqueueJob(client, organizationId, {
    type: NOTICE_EMAIL_JOB_TYPE,
    payload: { emailId: next.id },
    runAt: nextMailAt(now, lastSentAt),
    maxAttempts: NOTICE_EMAIL_MAX_ATTEMPTS,
  });
}

/**
 * The job gave up: what it took (or its own row, if it never took it)
 * ends as failed. The notice in the app is not touched. Safe to repeat.
 */
export async function failNoticeEmails(
  organizationId: string,
  emailId: string,
  jobId: string,
): Promise<void> {
  const client = forOrganization(organizationId);
  await client.notificationEmail.updateMany({
    where: {
      status: "QUEUED",
      OR: [
        { claimedBy: String(jobId).slice(0, 36) },
        { id: String(emailId).slice(0, 36), claimedBy: null },
      ],
    },
    data: { status: "FAILED", reason: FAILED_AFTER_RETRIES },
  });
}

/**
 * Removes the company's mails that ended more than READ_NOTICE_DAYS ago
 * (the round that cleans up notices). Waiting ones stay.
 */
export async function purgeFinishedNoticeEmails(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ removed: number }> {
  const before = new Date(now.getTime() - READ_NOTICE_DAYS * 86_400_000);
  const result = await forOrganization(
    organizationId,
  ).notificationEmail.deleteMany({
    where: { status: { not: "QUEUED" }, createdAt: { lt: before } },
  });
  return { removed: result.count };
}

const emailIdOf = (payload: unknown) =>
  String((payload as { emailId?: unknown } | null)?.emailId ?? "");

/**
 * The job of the notices by mail. The platform never imports modules: the
 * registry passes the list of types (to know their module and channel).
 */
export function noticeEmailJobHandlers(
  types: readonly NotificationType[],
): JobHandlers {
  return {
    [NOTICE_EMAIL_JOB_TYPE]: {
      // The company is the one of the job, never one named in the payload.
      handle: (context) =>
        sendNoticeEmails(context.organizationId, emailIdOf(context.payload), {
          types,
          jobId: context.jobId,
          attempt: context.attempt,
        }),
      retryDelayMs: (attempt) =>
        RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!,
      onFailed: (context) =>
        failNoticeEmails(
          context.organizationId,
          emailIdOf(context.payload),
          context.jobId,
        ),
    },
  };
}
