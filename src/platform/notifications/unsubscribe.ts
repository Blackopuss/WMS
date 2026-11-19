import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { newId } from "@/lib";
import {
  clientIp,
  refundAttempt,
  reserveAttempt,
  settleFailure,
  throttleKeys,
  tooManyAttemptsMessage,
} from "@/platform/auth";
import { forOrganization } from "@/server";

/**
 * Stopping notices by mail without signing in (WMS-88, ADR 0084). Each
 * mail of notices and each daily summary carries its own link,
 * `/baja-de-avisos?t=<company>.<secret>`: 32 random bytes of which only the
 * sha256 is kept. The company in the link is not a secret: it only says
 * where to look. Using the link turns off every notice by mail of that
 * person in that company (the summary included); the app stays as it was.
 * It gives no session and says nothing of the person or the company.
 */

/** A link works this long after its mail. */
export const UNSUBSCRIBE_LINK_DAYS = 60;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const hashOf = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

export type UnsubscribeLink = {
  /** The page with the button, for the body of the mail. */
  pageUrl: string;
  /** The address of List-Unsubscribe, which takes the one-click POST. */
  oneClickUrl: string;
};

/**
 * A new link for a person of the company (the worker, when it builds a
 * mail): the page for the body and the one-click address for the header.
 */
export async function createUnsubscribeLink(
  organizationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<UnsubscribeLink> {
  const secret = randomBytes(32).toString("base64url");
  await forOrganization(organizationId).noticeUnsubscribe.create({
    data: {
      id: newId(),
      organizationId,
      userId,
      tokenHash: hashOf(secret),
      expiresAt: new Date(now.getTime() + UNSUBSCRIBE_LINK_DAYS * 86_400_000),
    },
  });
  const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  const token = `${organizationId}.${secret}`;
  return {
    pageUrl: `${base}/baja-de-avisos?t=${token}`,
    oneClickUrl: `${base}/api/baja-de-avisos?t=${token}`,
  };
}

export type UnsubscribeResult =
  { ok: true } | { ok: false; reason: "invalid" | "too_many"; message: string };

const INVALID_MESSAGE =
  "El enlace no es válido o ya venció. Puedes elegir qué avisos recibes desde Configuración, en «Avisos que recibo».";

/**
 * Uses a link to stop notices by mail. The attempt is set aside per IP
 * before anything is checked (PLT-06); a link that does not work counts as
 * a failure, one that works is given back. Repeating a link that works
 * answers the same. Nothing of the person or the company is returned.
 */
export async function unsubscribeFromNoticeEmails(
  token: string,
  headers: Headers,
): Promise<UnsubscribeResult> {
  const keys = [throttleKeys.noticeUnsubscribeIp(clientIp(headers))];
  const wait = await reserveAttempt(keys);
  if (wait > 0) {
    return {
      ok: false,
      reason: "too_many",
      message: tooManyAttemptsMessage(wait),
    };
  }
  try {
    return await useLink(token, keys);
  } catch (error) {
    // A failure of the database is not a guess: the attempt goes back
    // (review of WMS-88).
    await refundAttempt(keys).catch(() => {});
    throw error;
  }
}

async function useLink(
  token: string,
  keys: Parameters<typeof refundAttempt>[0],
): Promise<UnsubscribeResult> {
  const text = String(token ?? "").slice(0, 100);
  const dot = text.indexOf(".");
  const organizationId = dot > 0 ? text.slice(0, dot) : "";
  const secret = dot > 0 ? text.slice(dot + 1) : "";
  if (!ID.test(organizationId) || !SECRET.test(secret)) {
    await settleFailure(keys);
    return { ok: false, reason: "invalid", message: INVALID_MESSAGE };
  }
  const client = forOrganization(organizationId);
  const now = new Date();
  const link = await client.noticeUnsubscribe.findFirst({
    where: { tokenHash: hashOf(secret), expiresAt: { gt: now } },
    select: { id: true, userId: true, usedAt: true },
  });
  if (!link) {
    await settleFailure(keys);
    return { ok: false, reason: "invalid", message: INVALID_MESSAGE };
  }
  await client.$transaction(async (tx) => {
    // Mail off for every type; the app stays as the person had it.
    const rows = await tx.notificationPreference.findMany({
      where: { userId: link.userId, email: true },
      select: { id: true },
    });
    if (rows.length > 0) {
      await tx.notificationPreference.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { email: false },
      });
    }
    if (!link.usedAt) {
      await tx.noticeUnsubscribe.updateMany({
        where: { id: link.id, usedAt: null },
        data: { usedAt: now },
      });
    }
    // Mails still waiting for this person do not go out.
    await tx.notificationEmail.updateMany({
      where: { recipientUserId: link.userId, status: "QUEUED" },
      data: {
        status: "SKIPPED",
        reason: "La persona se dio de baja desde el correo.",
      },
    });
  });
  await refundAttempt(keys);
  return { ok: true };
}

/** Links past their date go away (the cleanup round of notices). */
export async function purgeExpiredUnsubscribeLinks(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ removed: number }> {
  const result = await forOrganization(
    organizationId,
  ).noticeUnsubscribe.deleteMany({ where: { expiresAt: { lt: now } } });
  return { removed: result.count };
}
