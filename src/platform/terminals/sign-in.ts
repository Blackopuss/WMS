import "server-only";

import { log } from "@/lib";
import { recordAuditEvent, recordSecurityEvent } from "@/platform/audit";
import {
  blockedFor,
  clearAttempts,
  clientIp,
  countInWindow,
  openTerminalSession,
  pinCandidates,
  refundAttempt,
  rotateTerminalSecret,
  reserveAttempt,
  settleFailure,
  terminalOfDevice,
  throttleKeys,
  tooManyAttemptsMessage,
  verifyNoPin,
  verifyPin,
  type DeviceTerminal,
} from "@/platform/auth";
import { pendingLegalDocuments } from "@/platform/legal";
import { notify } from "@/platform/notifications";
import { readSetting } from "@/platform/settings";
import { db, forOrganization } from "@/server";

import { TERMINAL_LOCKED_NOTICE } from "./notices";
import { isPinShape } from "./pin-rules";
import { IDLE_MINUTES } from "./settings";

/**
 * «¿Quién eres?» on a shared terminal (WMS-38, ADR 0061 §4-6). Everything
 * starts from the terminal registered on this browser: without one, the
 * PIN does not exist (same answer as if nothing were there).
 */

export type TerminalPerson = { userId: string; name: string };

export type TerminalScreen = {
  terminal: { id: string; name: string; facilityName: string };
  organizationName: string;
  people: TerminalPerson[];
};

export type PinSignInResult =
  | { ok: true }
  | { ok: false; reason: "not_terminal" }
  | {
      ok: false;
      reason: "wrong" | "throttled" | "account" | "unavailable";
      message: string;
    };

export const WRONG_PIN_MESSAGE = "PIN incorrecto.";
export const ACCOUNT_SETUP_MESSAGE =
  "Entra con tu correo y contraseña para terminar de configurar tu cuenta.";

/**
 * What the terminal shows: its name and who may sign in there (whether
 * they have a PIN is never said). Null on a browser that is not an active
 * terminal.
 */
export async function getTerminalScreen(): Promise<TerminalScreen | null> {
  const terminal = await terminalOfDevice();
  if (!terminal) return null;
  const client = forOrganization(terminal.organizationId);
  const [facility, organization, people] = await Promise.all([
    client.facility.findFirst({
      where: { id: terminal.facilityId },
      select: { name: true },
    }),
    db.organization.findUnique({
      where: { id: terminal.organizationId },
      select: { name: true },
    }),
    pinCandidates(terminal.organizationId, terminal.facilityId),
  ]);
  return {
    terminal: {
      id: terminal.id,
      name: terminal.name,
      facilityName: facility?.name ?? "",
    },
    organizationName: organization?.name ?? "",
    people: people.map(({ userId, name }) => ({ userId, name })),
  };
}

/**
 * A block caused by wrong PINs: one audit line and a notice to who manages
 * the terminals of its warehouse. `person` names the person blocked (on
 * this terminal or in all of them); without it, the terminal itself. One
 * notice per block: the minute it began names it. Never breaks the answer.
 */
async function reportBlock(
  terminal: DeviceTerminal,
  person: { userId: string; everywhere: boolean } | null,
): Promise<void> {
  try {
    const client = forOrganization(terminal.organizationId);
    const minute = new Date().toISOString().slice(0, 16);
    const name = person
      ? ((
          await client.membership.findFirst({
            where: { userId: person.userId },
            select: { user: { select: { name: true } } },
          })
        )?.user.name.trim() ?? "")
      : "";
    await client.$transaction(async (tx) => {
      if (person) {
        await recordAuditEvent(tx, {
          organizationId: terminal.organizationId,
          actorUserId: null,
          action: "pin.locked",
          target: { type: "user", id: person.userId },
          metadata: { terminal: terminal.name, everywhere: person.everywhere },
        });
      } else {
        await recordAuditEvent(tx, {
          organizationId: terminal.organizationId,
          actorUserId: null,
          action: "terminal.locked",
          target: { type: "shared_terminal", id: terminal.id },
          metadata: { terminal: terminal.name },
        });
      }
      await notify(tx, TERMINAL_LOCKED_NOTICE, {
        organizationId: terminal.organizationId,
        actorUserId: null,
        to: {
          permissions: ["platform.terminal.manage"],
          facilityId: terminal.facilityId,
        },
        text: person
          ? `Se bloqueó el PIN de ${name || "una persona"} ${person.everywhere ? "en todas las terminales" : `en la terminal «${terminal.name}»`} por demasiados intentos. Se desbloquea solo o al entrar con su contraseña.`
          : `La terminal «${terminal.name}» se bloqueó 15 minutos por demasiados PIN incorrectos.`,
        href: `/configuracion/terminales/${terminal.id}`,
        key: person
          ? `pin_locked:${person.userId}:${person.everywhere ? "all" : terminal.id}:${minute}`
          : `terminal_locked:${terminal.id}:${minute}`,
      });
    });
  } catch (error) {
    log.error("terminal.lock_report_failed", error);
  }
}

/**
 * Wrong PINs on one terminal in a day that warn who manages terminals,
 * once, even if no limit blocked anything: guessing slowly, below the
 * limits, does not go unnoticed (WMS-38 review).
 */
export const PIN_DAILY_FAILURES_NOTICE = 30;
const DAY_SECONDS = 24 * 60 * 60;

/** Counts a wrong PIN of the terminal in its day and warns at the mark. */
async function countDailyFailure(terminal: DeviceTerminal): Promise<void> {
  try {
    const count = await countInWindow(
      `pin:terminal-day:${terminal.id}`,
      DAY_SECONDS,
    );
    if (count !== PIN_DAILY_FAILURES_NOTICE) return;
    const day = new Date().toISOString().slice(0, 10);
    await forOrganization(terminal.organizationId).$transaction(async (tx) => {
      await notify(tx, TERMINAL_LOCKED_NOTICE, {
        organizationId: terminal.organizationId,
        actorUserId: null,
        to: {
          permissions: ["platform.terminal.manage"],
          facilityId: terminal.facilityId,
        },
        text: `La terminal «${terminal.name}» lleva ${PIN_DAILY_FAILURES_NOTICE} PIN incorrectos en las últimas 24 horas. Revisa quién la está usando.`,
        href: `/configuracion/terminales/${terminal.id}`,
        key: `pin_daily_failures:${terminal.id}:${day}`,
      });
    });
  } catch (error) {
    log.error("terminal.daily_failures_report_failed", error);
  }
}

/** What a blocked attempt says (it never tells whose block it is). */
export function blockedMessage(seconds: number): string {
  return `${tooManyAttemptsMessage(seconds)} Si es tu PIN, entra con tu contraseña desde tu propio dispositivo para desbloquearlo.`;
}

/**
 * Signs a person in with their PIN on this terminal. The attempt is taken
 * before the PIN is checked: for the person on this terminal (low), for
 * the person in every terminal (higher) and for the terminal. Whoever has
 * no PIN, or may not use one here, gets the same answer, in the same time,
 * as a wrong PIN. A right PIN rotates the terminal's secret. Someone whose
 * account is not ready (email not confirmed, documents to accept) is told
 * so before the PIN is looked at: the answer never confirms a PIN.
 */
export async function pinSignIn(
  input: { userId: unknown; pin: unknown },
  headers: Headers,
): Promise<PinSignInResult> {
  const terminal = await terminalOfDevice();
  if (!terminal) return { ok: false, reason: "not_terminal" };
  const userId = String(input.userId ?? "").slice(0, 36);
  const pin = String(input.pin ?? "").trim();
  const hereKey = throttleKeys.pinUserTerminal(userId, terminal.id);
  const userKey = throttleKeys.pinUser(userId);
  const terminalKey = throttleKeys.pinTerminal(terminal.id);
  const keys = [hereKey, userKey, terminalKey];
  const ip = clientIp(headers);

  const wait = await reserveAttempt(keys);
  if (wait > 0) {
    return { ok: false, reason: "throttled", message: blockedMessage(wait) };
  }

  // Until the PIN has been checked, a failure is not a guess and gives the
  // attempt back; after it, the attempt stays counted.
  let checked = false;
  try {
    const [candidate] = userId
      ? await pinCandidates(terminal.organizationId, terminal.facilityId, [
          userId,
        ])
      : [];
    // Decided before the PIN, so this answer never tells it was right.
    if (
      candidate &&
      (!candidate.emailVerified ||
        (await pendingLegalDocuments(candidate.userId)).length > 0)
    ) {
      await refundAttempt(keys);
      return { ok: false, reason: "account", message: ACCOUNT_SETUP_MESSAGE };
    }
    const stored = candidate
      ? await forOrganization(terminal.organizationId).memberPin.findFirst({
          where: { userId: candidate.userId },
          select: { pinHash: true },
        })
      : null;
    const right =
      stored && isPinShape(pin)
        ? await verifyPin(stored.pinHash, terminal.organizationId, userId, pin)
        : await verifyNoPin(pin);
    checked = true;

    if (!right) {
      await settleFailure(keys);
      await countDailyFailure(terminal);
      if (candidate) {
        await recordSecurityEvent({
          userId: candidate.userId,
          action: "pin_sign_in.failed",
          metadata: { terminalId: terminal.id },
          ipAddress: ip,
        });
        const everywhere = (await blockedFor([userKey])) > 0;
        if (everywhere || (await blockedFor([hereKey])) > 0) {
          await recordSecurityEvent({
            userId: candidate.userId,
            action: "pin.locked",
            metadata: { terminalId: terminal.id, everywhere },
            ipAddress: ip,
          });
          await reportBlock(terminal, { userId: candidate.userId, everywhere });
        }
      }
      if ((await blockedFor([terminalKey])) > 0) {
        await reportBlock(terminal, null);
      }
      return { ok: false, reason: "wrong", message: WRONG_PIN_MESSAGE };
    }

    // The right PIN: not a guess on the terminal, and the person's counts
    // start again.
    await refundAttempt([terminalKey]);
    await clearAttempts([hereKey, userKey]);

    const client = forOrganization(terminal.organizationId);
    const idleMinutes = Number(await readSetting(client, IDLE_MINUTES));
    // What the person does on the floor is of this terminal's warehouse.
    await client.$transaction(async (tx) => {
      await tx.membership.updateMany({
        where: { userId, status: "ACTIVE" },
        data: { activeFacilityId: terminal.facilityId },
      });
      await tx.sharedTerminal.update({
        where: { id: terminal.id },
        data: { lastUsedAt: new Date() },
      });
    });
    await openTerminalSession({
      userId,
      terminal,
      idleSeconds: idleMinutes * 60,
      headers,
    });
    // A copy of the cookie taken before now stops working (ADR 0061 §1).
    await rotateTerminalSecret(terminal);
    await recordSecurityEvent({
      userId,
      action: "pin_sign_in.succeeded",
      metadata: { terminalId: terminal.id },
      ipAddress: ip,
    });
    return { ok: true };
  } catch (error) {
    if (!checked) await refundAttempt(keys);
    log.error("terminal.pin_sign_in_failed", error);
    return {
      ok: false,
      reason: "unavailable",
      message: "No se pudo entrar. Inténtalo de nuevo.",
    };
  }
}
