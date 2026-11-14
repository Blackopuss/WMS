import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  assertNotTerminalSession,
  hashPin,
  pinCandidates,
  refundAttempt,
  reserveAttempt,
  settleFailure,
  throttleKeys,
  tooManyAttemptsMessage,
  verifyAccountPassword,
} from "@/platform/auth";
import { readSetting } from "@/platform/settings";
import { db, forOrganization } from "@/server";

import { pinProblem } from "./pin-rules";
import { PIN_LENGTH } from "./settings";
import type { TerminalActor } from "./terminals";

/**
 * The PIN of each person for the shared terminals of a company (WMS-38,
 * ADR 0061 §3). Only the person sets or removes it, with a full session
 * (never from a terminal) and confirming the account's password. It is of
 * the person in that company. Setting, changing or removing it closes the
 * person's terminal sessions in the company.
 */

export type MyPinStatus = {
  /** The person may sign in with a PIN in this company (ADR 0061 §5). */
  available: boolean;
  hasPin: boolean;
  setAt: Date | null;
  /** Digits a new PIN must have (company setting). */
  length: number;
};

export type PinResult =
  | { ok: true; summary: string }
  | {
      ok: false;
      formError?: string;
      fieldErrors?: Partial<Record<"password" | "pin" | "confirm", string>>;
    };

async function pinLengthOf(organizationId: string): Promise<number> {
  return Number(await readSetting(forOrganization(organizationId), PIN_LENGTH));
}

async function mayUsePin(actor: TerminalActor): Promise<boolean> {
  const [candidate] = await pinCandidates(actor.organizationId, null, [
    actor.userId,
  ]);
  return candidate !== undefined;
}

/** What «Mi PIN» shows. */
export async function getMyPinStatus(
  actor: TerminalActor,
): Promise<MyPinStatus> {
  const [available, row, length] = await Promise.all([
    mayUsePin(actor),
    forOrganization(actor.organizationId).memberPin.findFirst({
      where: { userId: actor.userId },
      select: { setAt: true },
    }),
    pinLengthOf(actor.organizationId),
  ]);
  return { available, hasPin: row !== null, setAt: row?.setAt ?? null, length };
}

/**
 * Checks the account's password before touching the PIN, with its own
 * attempt limit (taken before checking). Returns an error to show, or null.
 */
async function confirmPassword(
  userId: string,
  password: string,
): Promise<string | null> {
  if (!password) return "Escribe tu contraseña para continuar.";
  const key = throttleKeys.pinSetup(userId);
  const wait = await reserveAttempt([key]);
  if (wait > 0) return tooManyAttemptsMessage(wait);
  if (!(await verifyAccountPassword(userId, password))) {
    await settleFailure([key]);
    return "La contraseña no es correcta.";
  }
  await refundAttempt([key]);
  return null;
}

/** Closes the person's PIN sessions in this company. */
async function closeTerminalSessions(actor: TerminalActor): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: {
      userId: actor.userId,
      activeOrganizationId: actor.organizationId,
      terminalId: { not: null },
    },
  });
  return count;
}

const NOT_AVAILABLE =
  "En esta empresa no puedes entrar con PIN: tu rol no lo permite o usas verificación en dos pasos.";

/** Sets or changes the person's PIN. */
export async function setMyPin(
  actor: TerminalActor,
  input: { password: unknown; pin: unknown; confirm: unknown },
): Promise<PinResult> {
  await assertNotTerminalSession(actor.userId);
  if (!(await mayUsePin(actor))) return { ok: false, formError: NOT_AVAILABLE };
  const pin = String(input.pin ?? "").trim();
  const confirm = String(input.confirm ?? "").trim();
  const length = await pinLengthOf(actor.organizationId);
  const problem = pinProblem(pin, length);
  if (problem) return { ok: false, fieldErrors: { pin: problem } };
  if (confirm !== pin) {
    return { ok: false, fieldErrors: { confirm: "Los dos PIN no coinciden." } };
  }
  const passwordError = await confirmPassword(
    actor.userId,
    String(input.password ?? ""),
  );
  if (passwordError) {
    return { ok: false, fieldErrors: { password: passwordError } };
  }

  const pinHash = await hashPin(actor.organizationId, actor.userId, pin);
  const changed = await forOrganization(actor.organizationId).$transaction(
    async (tx) => {
      const existing = await tx.memberPin.findFirst({
        where: { userId: actor.userId },
        select: { id: true },
      });
      const now = new Date();
      if (existing) {
        await tx.memberPin.update({
          where: { id: existing.id },
          data: { pinHash, setAt: now },
        });
      } else {
        await tx.memberPin.create({
          data: {
            id: newId(),
            organizationId: actor.organizationId,
            userId: actor.userId,
            pinHash,
            setAt: now,
          },
        });
      }
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: existing ? "pin.changed" : "pin.set",
        target: { type: "user", id: actor.userId },
      });
      return existing !== null;
    },
  );
  await closeTerminalSessions(actor);
  return {
    ok: true,
    summary: changed
      ? "Cambiaste tu PIN. Úsalo en las terminales de tu almacén."
      : "Listo: ya puedes entrar con tu PIN en las terminales de tu almacén.",
  };
}

/** Removes the person's PIN. */
export async function removeMyPin(
  actor: TerminalActor,
  input: { password: unknown },
): Promise<PinResult> {
  await assertNotTerminalSession(actor.userId);
  const passwordError = await confirmPassword(
    actor.userId,
    String(input.password ?? ""),
  );
  if (passwordError) {
    return { ok: false, fieldErrors: { password: passwordError } };
  }
  const removed = await forOrganization(actor.organizationId).$transaction(
    async (tx) => {
      const { count } = await tx.memberPin.deleteMany({
        where: { userId: actor.userId },
      });
      if (count > 0) {
        await recordAuditEvent(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "pin.removed",
          target: { type: "user", id: actor.userId },
        });
      }
      return count > 0;
    },
  );
  await closeTerminalSessions(actor);
  return {
    ok: true,
    summary: removed
      ? "Quitaste tu PIN. Para usar una terminal, pon uno nuevo."
      : "No tenías PIN.",
  };
}
