import "server-only";

import { log } from "@/lib";
import { recordAuditEvent, recordSecurityEvent } from "@/platform/audit";
import {
  blockedFor,
  clearAttempts,
  clientIp,
  openTerminalSession,
  pinCandidates,
  refundAttempt,
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
 * When a wrong PIN locked the terminal: one audit line and a notice to
 * who manages the terminals of its warehouse. Never breaks the answer.
 */
async function reportLockedTerminal(terminal: DeviceTerminal): Promise<void> {
  try {
    const client = forOrganization(terminal.organizationId);
    await client.$transaction(async (tx) => {
      await recordAuditEvent(tx, {
        organizationId: terminal.organizationId,
        actorUserId: null,
        action: "terminal.locked",
        target: { type: "shared_terminal", id: terminal.id },
        metadata: { name: terminal.name },
      });
      // One notice per block: the minute it began names it.
      const minute = new Date().toISOString().slice(0, 16);
      await notify(tx, TERMINAL_LOCKED_NOTICE, {
        organizationId: terminal.organizationId,
        actorUserId: null,
        to: {
          permissions: ["platform.terminal.manage"],
          facilityId: terminal.facilityId,
        },
        text: `La terminal «${terminal.name}» se bloqueó 15 minutos por demasiados PIN incorrectos.`,
        href: `/configuracion/terminales/${terminal.id}`,
        key: `terminal_locked:${terminal.id}:${minute}`,
      });
    });
  } catch (error) {
    log.error("terminal.lock_report_failed", error);
  }
}

/**
 * Signs a person in with their PIN on this terminal. The attempt is taken
 * before the PIN is checked, for the person and for the terminal; whoever
 * has no PIN, or may not use one here, gets the same answer, in the same
 * time, as a wrong PIN.
 */
export async function pinSignIn(
  input: { userId: unknown; pin: unknown },
  headers: Headers,
): Promise<PinSignInResult> {
  const terminal = await terminalOfDevice();
  if (!terminal) return { ok: false, reason: "not_terminal" };
  const userId = String(input.userId ?? "").slice(0, 36);
  const pin = String(input.pin ?? "").trim();
  const userKey = throttleKeys.pinUser(userId);
  const terminalKey = throttleKeys.pinTerminal(terminal.id);
  const keys = [userKey, terminalKey];
  const ip = clientIp(headers);

  const wait = await reserveAttempt(keys);
  if (wait > 0) {
    return {
      ok: false,
      reason: "throttled",
      message: tooManyAttemptsMessage(wait),
    };
  }

  try {
    const [candidate] = userId
      ? await pinCandidates(terminal.organizationId, terminal.facilityId, [
          userId,
        ])
      : [];
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

    if (!right) {
      await settleFailure(keys);
      if (candidate) {
        await recordSecurityEvent({
          userId: candidate.userId,
          action: "pin_sign_in.failed",
          metadata: { terminalId: terminal.id },
          ipAddress: ip,
        });
        if ((await blockedFor([userKey])) > 0) {
          await recordSecurityEvent({
            userId: candidate.userId,
            action: "pin.locked",
            metadata: { terminalId: terminal.id },
            ipAddress: ip,
          });
        }
      }
      if ((await blockedFor([terminalKey])) > 0) {
        await reportLockedTerminal(terminal);
      }
      return { ok: false, reason: "wrong", message: WRONG_PIN_MESSAGE };
    }

    // The right PIN: not a guess on the terminal, and the person's count
    // starts again.
    await refundAttempt([terminalKey]);
    await clearAttempts([userKey]);
    if (
      !candidate!.emailVerified ||
      (await pendingLegalDocuments(candidate!.userId)).length > 0
    ) {
      return { ok: false, reason: "account", message: ACCOUNT_SETUP_MESSAGE };
    }

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
    await recordSecurityEvent({
      userId,
      action: "pin_sign_in.succeeded",
      metadata: { terminalId: terminal.id },
      ipAddress: ip,
    });
    return { ok: true };
  } catch (error) {
    // Not a wrong guess: the attempt is given back.
    await refundAttempt(keys);
    log.error("terminal.pin_sign_in_failed", error);
    return {
      ok: false,
      reason: "unavailable",
      message: "No se pudo entrar. Inténtalo de nuevo.",
    };
  }
}
