import "server-only";

import { isAPIError } from "better-auth/api";
import { z } from "zod";

import { db } from "@/server";

import { auth } from "./auth";
import { normalizeBackupCode } from "./backup-codes";
import { normalizeTotpCode } from "./mfa";
import { assertNotTerminalSession } from "./terminal-session";
import {
  refundAttempt,
  reserveAttempt,
  settleFailure,
  throttleKeys,
  tooManyAttemptsMessage,
} from "./throttle";

/**
 * Confirming who is at the keyboard before a delicate action (WMS-90,
 * ADR 0090): the password again and a current code of the authenticator
 * app (or a backup code, which is spent). Never from a PIN session.
 *
 * Order of the attempt limit (PLT-06): the form of what was typed is
 * checked first; then one attempt is set aside atomically, the password and
 * the code are verified with the session of the request, and a wrong one
 * settles the failure while a right one gives the attempt back.
 */

export type StepUpField = "password" | "code";

export type StepUpResult =
  { ok: true } | { ok: false; error: string; field?: StepUpField };

const passwordSchema = z.string().min(1).max(1024);

export const STEP_UP_MESSAGES = {
  password: "Escribe tu contraseña para continuar.",
  code: "Escribe el código de 6 números de tu app o uno de tus códigos de recuperación.",
  wrongPassword: "La contraseña no es correcta.",
  wrongCode: "El código no es válido.",
  noMfa:
    "Activa la verificación en dos pasos en Configuración › Seguridad para continuar.",
} as const;

export async function confirmIdentity(
  userId: string,
  input: { password: string; code: string },
  headers: Headers,
): Promise<StepUpResult> {
  await assertNotTerminalSession(userId);
  const password = passwordSchema.safeParse(input.password);
  if (!password.success) {
    return { ok: false, error: STEP_UP_MESSAGES.password, field: "password" };
  }
  const raw = String(input.code ?? "");
  const totp = normalizeTotpCode(raw);
  const backup = totp ? null : normalizeBackupCode(raw);
  if (!totp && !backup) {
    return { ok: false, error: STEP_UP_MESSAGES.code, field: "code" };
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true },
  });
  if (!user?.twoFactorEnabled) {
    return { ok: false, error: STEP_UP_MESSAGES.noMfa, field: "code" };
  }

  const key = throttleKeys.stepUp(userId);
  const wait = await reserveAttempt([key]);
  if (wait > 0) return { ok: false, error: tooManyAttemptsMessage(wait) };

  try {
    await auth.api.verifyPassword({
      body: { password: password.data },
      headers,
    });
  } catch (error) {
    if (isAPIError(error) && error.body?.code === "INVALID_PASSWORD") {
      await settleFailure([key]);
      return {
        ok: false,
        error: STEP_UP_MESSAGES.wrongPassword,
        field: "password",
      };
    }
    await refundAttempt([key]);
    throw error;
  }

  try {
    if (totp) await auth.api.verifyTOTP({ body: { code: totp }, headers });
    else await auth.api.verifyBackupCode({ body: { code: backup! }, headers });
  } catch (error) {
    const code = isAPIError(error) ? String(error.body?.code ?? "") : "";
    if (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE") {
      await settleFailure([key]);
      return { ok: false, error: STEP_UP_MESSAGES.wrongCode, field: "code" };
    }
    await refundAttempt([key]);
    throw error;
  }

  await refundAttempt([key]);
  return { ok: true };
}
