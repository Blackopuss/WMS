import "server-only";

import { isAPIError } from "better-auth/api";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { z } from "zod";

import { pendingLegalDocuments } from "@/platform/legal";
import { db } from "@/server";

import { knownDeviceOf, rememberDevice } from "./known-device";
import { noteFailedSignIn, noteSignIn } from "./access-history";
import { VERIFY_EMAIL_COOKIE, auth } from "./auth";
import { isMfaRequired } from "./mfa-policy";
import { resendVerification } from "./register";
import {
  TERMINAL_PASSWORD_PATH,
  TERMINAL_PATH,
  TERMINAL_SESSION_MAX_HOURS,
  checkTerminalSession,
  hasTerminalCookie,
  terminalOfDevice,
} from "./terminal-session";
import {
  clearAttempts,
  clearPinAttempts,
  clientIp,
  refundAttempt,
  reserveAttempt,
  settleFailure,
  throttleKeys,
  tooManyAttemptsMessage,
} from "./throttle";

/**
 * Session access (PLT-04). `getCurrentSession` validates the session against
 * the database (never trust the cookie alone); `requireSession` is the
 * server-side guard for protected screens and actions.
 */
export const getCurrentSession = cache(async () => {
  // Cookies come from cookies(), not the raw request headers: a server
  // action that rotates the session (e.g. enabling MFA) re-renders with the
  // new cookie, which only cookies() reflects.
  const requestHeaders = new Headers(await headers());
  requestHeaders.set("cookie", (await cookies()).toString());
  // On a shared terminal (WMS-38) sessions are never extended: a PIN
  // session ends at its fixed time and Better Auth must not push it to
  // seven days (ADR 0061 §7).
  const session = await auth.api.getSession({
    headers: requestHeaders,
    ...((await hasTerminalCookie()) ? { query: { disableRefresh: true } } : {}),
  });
  // A PIN session read on a browser without the terminal cookie (a page
  // that only looks at the session) may have been extended by Better Auth:
  // its end is put back to the fixed one, so it never lives seven days.
  if (session) {
    const { terminalId, createdAt, expiresAt } = session.session as {
      terminalId?: string | null;
      createdAt: Date;
      expiresAt: Date;
    };
    const end = new Date(
      new Date(createdAt).getTime() + TERMINAL_SESSION_MAX_HOURS * 3600_000,
    );
    if (terminalId && new Date(expiresAt) > end) {
      await db.session.updateMany({
        where: { id: session.session.id, terminalId },
        data: { expiresAt: end },
      });
    }
  }
  return session;
});

export type CurrentUser = { id: string; name: string; email: string };

/** The shared terminal a PIN session works on (WMS-38). */
export type SessionTerminal = {
  id: string;
  organizationId: string;
  facilityId: string;
  name: string;
  lastActiveAt: Date | null;
  idleSeconds: number;
};

/** Where accounts that must use MFA set it up before using the app. */
export const MFA_SETUP_PATH = "/activa-dos-pasos";

/** Where people accept new versions of the legal documents (PIL-09). */
export const LEGAL_ACCEPTANCE_PATH = "/acepta-terminos";

/**
 * Server-side guard for protected screens and actions. Accounts that must
 * use MFA (PLT-08B) and have not set it up are sent to MFA_SETUP_PATH;
 * only that screen passes `allowMissingMfa`. Accounts that have not
 * accepted the current legal documents (PIL-09) are sent first to
 * LEGAL_ACCEPTANCE_PATH, whose screen passes `allowPendingLegal` (and
 * `allowMissingMfa`, so the two gates never send to each other).
 *
 * A PIN session of a shared terminal (WMS-38, ADR 0061) is checked here on
 * every request (its device, inactivity, time and whether the person may
 * still use a PIN); when it no longer works it is deleted and the device
 * goes back to «¿Quién eres?», never to «Ingresar».
 */
export async function requireSession(
  options: { allowMissingMfa?: boolean; allowPendingLegal?: boolean } = {},
): Promise<{
  user: CurrentUser;
  sessionId: string;
  mfaEnabled: boolean;
  terminal: SessionTerminal | null;
}> {
  const session = await getCurrentSession();
  const device = await terminalOfDevice();
  if (!session) redirect(device ? TERMINAL_PATH : "/ingresar");
  const { id, name, email } = session.user;
  const mfaEnabled = Boolean(session.user.twoFactorEnabled);
  const terminalId = (session.session as { terminalId?: string | null })
    .terminalId;
  // On a shared terminal only PIN sessions work (ADR 0061 §1): a session
  // opened with a password there (or brought in some other way) is closed,
  // so nobody leaves a full session behind on a shared device.
  if (device && !terminalId) {
    await db.session.deleteMany({ where: { id: session.session.id } });
    redirect(TERMINAL_PATH);
  }
  if (terminalId) {
    const terminal = await checkTerminalSession(session.session.id, id);
    if (!terminal) redirect(TERMINAL_PATH);
    return {
      user: { id, name, email },
      sessionId: session.session.id,
      mfaEnabled,
      terminal,
    };
  }
  if (
    !options.allowPendingLegal &&
    (await pendingLegalDocuments(id)).length > 0
  ) {
    redirect(LEGAL_ACCEPTANCE_PATH);
  }
  if (!mfaEnabled && !options.allowMissingMfa && (await isMfaRequired(id))) {
    redirect(MFA_SETUP_PATH);
  }
  return {
    user: { id, name, email },
    sessionId: session.session.id,
    mfaEnabled,
    terminal: null,
  };
}

/**
 * Token of a verification link opened in this browser (kept in a cookie by
 * /confirmar-correo), only when it is for this email. Its signature and
 * expiry are checked by Better Auth when it is used.
 */
function pendingVerification(
  requestHeaders: Headers,
  email: string,
): string | null {
  const cookie = requestHeaders.get("cookie") ?? "";
  const raw = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${VERIFY_EMAIL_COOKIE}=`))
    ?.slice(VERIFY_EMAIL_COOKIE.length + 1);
  if (!raw || raw.length > 2048) return null;
  const token = decodeURIComponent(raw);
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { email?: unknown };
    return typeof payload.email === "string" &&
      payload.email.toLowerCase() === email.toLowerCase()
      ? token
      : null;
  } catch {
    return null;
  }
}

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(1024),
});

export type SignInResult =
  | { ok: true }
  /** This browser is a shared terminal: there one enters with a PIN. */
  | { ok: false; reason: "terminal" }
  | { ok: false; reason: "invalid" | "unverified" | "unavailable" }
  /** Password accepted; no session until the MFA code is confirmed. */
  | { ok: false; reason: "mfa" }
  | { ok: false; reason: "throttled"; message: string };

/**
 * Signs in with email and password; Better Auth sets the session cookie.
 * Unknown email and wrong password give the same answer (no enumeration).
 * Repeated failures block the submitted email and the client IP for a while
 * (PLT-06); while blocked, even the right password is refused.
 */
export async function signIn(
  input: { email: string; password: string },
  requestHeaders: Headers,
  afterVerifying = false,
): Promise<SignInResult> {
  // On a shared terminal there is no sign-in with a password (WMS-38).
  if (await terminalOfDevice()) return { ok: false, reason: "terminal" };
  const parsed = signInSchema.safeParse(input);
  const ip = clientIp(requestHeaders);
  const email = parsed.success ? parsed.data.email : "";
  const keys = [throttleKeys.signInIp(ip)];
  // WMS-95: on a device where this email already signed in, its attempts
  // are counted for the device, so a stranger who blocks the email (five
  // wrong passwords) does not keep its owner out. Elsewhere, per email.
  const device = email ? knownDeviceOf(requestHeaders, email) : null;
  const accountKeys = email
    ? [
        device
          ? throttleKeys.signInDevice(device, email)
          : throttleKeys.signInAccount(email),
      ]
    : [];
  keys.push(...accountKeys);

  // The attempt is counted before the password is checked: requests sent
  // all at once each take a place, and those past the limit are refused.
  const wait = await reserveAttempt(keys);
  if (wait > 0) {
    return {
      ok: false,
      reason: "throttled",
      message: tooManyAttemptsMessage(wait),
    };
  }
  if (!parsed.success || !email || !parsed.data.password) {
    await settleFailure(keys);
    return { ok: false, reason: "invalid" };
  }

  try {
    const result = await auth.api.signInEmail({
      body: parsed.data,
      headers: requestHeaders,
    });
    await clearAttempts([throttleKeys.signInAccount(email), ...accountKeys]);
    await refundAttempt([throttleKeys.signInIp(ip)]);
    // MFA on: Better Auth kept no session and set a short-lived challenge
    // cookie; the code is checked by verifySignInCode (./mfa.ts), which
    // remembers the device once the second step is done too.
    if ("twoFactorRedirect" in result && result.twoFactorRedirect) {
      return { ok: false, reason: "mfa" };
    }
    await rememberDevice(email);
    // The password proves who it is: a PIN blocked after wrong tries works
    // again (WMS-38, ADR 0061 §6).
    await clearPinAttempts(result.user.id);
    // WMS-68: the entry, its device, and an alert for a new one.
    await noteSignIn({
      userId: result.user.id,
      action: "sign_in.succeeded",
      metadata: { mfa: false },
      headers: requestHeaders,
    });
    return { ok: true };
  } catch (error) {
    if (isAPIError(error)) {
      if (error.body?.code === "EMAIL_NOT_VERIFIED") {
        // Right password: not a guessing attempt on the account. The IP
        // keeps the attempt: each one costs a password hash.
        await clearAttempts([
          throttleKeys.signInAccount(email),
          ...accountKeys,
        ]);
        // The verification link was opened in this browser and whoever
        // knows the password is here: both proofs, the email is confirmed
        // and the sign-in goes on (security audit 2: the link alone left a
        // stranger's password on the mailbox owner's account).
        const token = pendingVerification(requestHeaders, email);
        if (token && !afterVerifying) {
          try {
            await auth.api.verifyEmail({ query: { token } });
            return signIn(input, requestHeaders, true);
          } catch (verifyError) {
            if (!isAPIError(verifyError)) throw verifyError;
            // Expired or used: a new link below.
          }
        }
        // A new link, through the limited resend (never one per attempt).
        await resendVerification({ email }, requestHeaders);
        return { ok: false, reason: "unverified" };
      }
      if (error.status === "UNAUTHORIZED" || error.statusCode === 401) {
        await settleFailure(keys);
        // WMS-68: the history of an account that exists, and the alert
        // when its counter blocked it, all after the response.
        noteFailedSignIn(email, requestHeaders);
        return { ok: false, reason: "invalid" };
      }
    }
    // Not a wrong guess: the attempt is given back.
    await refundAttempt(keys);
    console.error("signIn failed", error);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Screens of signing in, registering, codes and invitations call it first:
 * on a shared terminal they send to «¿Quién eres?», which explains that a
 * password is used on another device (ADR 0061 §1).
 */
export async function refuseOnTerminal(): Promise<void> {
  if (await terminalOfDevice()) redirect(TERMINAL_PASSWORD_PATH);
}

/** Revokes the current session in the database and clears the cookie. */
export async function signOut(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
}
