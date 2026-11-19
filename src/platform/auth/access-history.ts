import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_TIME_ZONE,
  describeDeviceKey,
  deviceKeyOf,
  formatDateTime,
  formatIp,
  log,
  newId,
  type DeviceKind,
} from "@/lib";
import { claimSecurityEvent, recordSecurityEvent } from "@/platform/audit";
import {
  InvalidEmailError,
  accessAlertEmail,
  sendEmail,
  type AccessAlertKind,
} from "@/platform/email";
import { notify } from "@/platform/notifications";
import { db, forOrganization } from "@/server";

import { ACCESS_ALERT_NOTICE } from "./access-notices";
import { afterResponse, auth } from "./auth";
import { assertNotTerminalSession } from "./terminal-session";
import { blockedFor, clientIp, throttleKeys } from "./throttle";

/**
 * Access history and suspicious-access alerts (WMS-68, ADR 0064). The
 * history is a reading of `security_event` (per person, append-only); the
 * alerts go by email to the owner of the account, after the response, so
 * an attempt on an account that exists takes as long as one on an email
 * without an account.
 */

/** What the history lists, with its label. */
export const ACCESS_ACTION_LABELS: Record<string, string> = {
  "sign_in.succeeded": "Entró",
  "mfa.backup_code_used": "Entró con un código de recuperación",
  "sign_in.failed": "Contraseña incorrecta",
  "mfa_code.failed": "Código de verificación incorrecto",
  "sign_in.locked": "Cuenta bloqueada por intentos fallidos",
  "pin_sign_in.succeeded": "Entró con PIN",
  "pin_sign_in.failed": "PIN incorrecto",
  "pin.locked": "PIN bloqueado por intentos fallidos",
  "session.revoked": "Cerró una de sus sesiones",
  "session.revoked_others": "Cerró sus otras sesiones",
  "session.closed_by_team": "El equipo cerró sus sesiones",
  "password.reset": "Restableció su contraseña",
  "access.alert_new_device": "Alerta: dispositivo o navegador nuevo",
  "access.alert_password_new_device":
    "Alerta: contraseña correcta desde un dispositivo nuevo",
  "access.alert_failed_attempts": "Alerta: muchos intentos fallidos",
  "access.alert_code_locked":
    "Alerta: contraseña correcta y códigos de verificación equivocados",
  "access.alert_pin_locked": "Alerta: PIN bloqueado",
};

export const ACCESS_ACTIONS = Object.keys(ACCESS_ACTION_LABELS);

/** Failures and alerts: what the history marks. */
const WARNING_ACTIONS = new Set([
  "sign_in.failed",
  "mfa_code.failed",
  "sign_in.locked",
  "pin_sign_in.failed",
  "pin.locked",
]);
const SUSPICIOUS_ACTIONS = new Set([
  "access.alert_new_device",
  "access.alert_password_new_device",
  "access.alert_failed_attempts",
  "access.alert_code_locked",
  "access.alert_pin_locked",
]);

/**
 * At most this many alert emails reach one person in a day (UTC): each one
 * takes a numbered slot whose key is unique per person, so requests at the
 * same time never go past it. What finds no slot stays in the history,
 * marked as not mailed.
 */
export const ACCESS_ALERTS_PER_DAY = 5;

/** Rows per page of the history. */
export const ACCESS_HISTORY_PAGE_SIZE = 25;

/** Window of the account's sign-in counter (one lock per window). */
const LOCK_WINDOW_MS = 15 * 60 * 1000;

const ALERT_ACTION: Record<AccessAlertKind, string> = {
  new_device: "access.alert_new_device",
  password_new_device: "access.alert_password_new_device",
  failed_attempts: "access.alert_failed_attempts",
  code_locked: "access.alert_code_locked",
  pin_locked: "access.alert_pin_locked",
};

/** Marks a device the person knows (taught, or announced by email). */
const DEVICE_KNOWN = "access.device_known";
/** One of the person's daily alert email slots. */
const MAIL_SLOT = "access.mail_slot";
/** Who handles an alert today: only that request takes a slot. */
const ALERT_CLAIM = "access.claim";

const today = () => new Date().toISOString().slice(0, 10);

function appUrl(path: string): string {
  return `${process.env.BETTER_AUTH_URL ?? ""}${path}`;
}

/** Takes one of today's email slots of the person; false when none is left. */
async function takeMailSlot(userId: string): Promise<boolean> {
  const day = today();
  const used = await db.securityEvent.count({
    where: { userId, dedupeKey: { startsWith: `alert_mail:${day}:` } },
  });
  for (let slot = used + 1; slot <= ACCESS_ALERTS_PER_DAY; slot += 1) {
    if (
      await claimSecurityEvent({
        userId,
        action: MAIL_SLOT,
        dedupeKey: `alert_mail:${day}:${slot}`,
      })
    ) {
      return true;
    }
  }
  return false;
}

/**
 * At most this many access alerts reach the bell of a person in a day
 * (UTC), like the mails: each takes a numbered slot with a key unique per
 * person (review of WMS-88). What finds none stays in the history.
 */
export const ACCESS_BELL_ALERTS_PER_DAY = 5;

async function takeBellSlot(userId: string): Promise<boolean> {
  const day = today();
  const used = await db.securityEvent.count({
    where: { userId, dedupeKey: { startsWith: `bell_slot:${day}:` } },
  });
  for (let slot = used + 1; slot <= ACCESS_BELL_ALERTS_PER_DAY; slot += 1) {
    if (
      await claimSecurityEvent({
        userId,
        action: ALERT_CLAIM,
        dedupeKey: `bell_slot:${day}:${slot}`,
      })
    ) {
      return true;
    }
  }
  return false;
}

type AlertOutcome = "queued" | "duplicate" | "not_mailed";

/**
 * One alert to the owner of the account, once per `dedupeKey`. It is
 * mailed only to a confirmed address, within the daily slots, and after
 * the response; otherwise the alert stays in the history marked as not
 * mailed (once per key), and the same key may still be mailed later.
 * Never throws.
 */
async function raiseAlert(input: {
  userId: string;
  kind: AccessAlertKind;
  dedupeKey: string;
  deviceKey?: string | null;
  ipAddress?: string | null;
  /** False: never by email (e.g. someone without a PIN). */
  mail?: boolean;
}): Promise<AlertOutcome> {
  try {
    const already = await db.securityEvent.findUnique({
      where: {
        userId_dedupeKey: {
          userId: input.userId,
          dedupeKey: input.dedupeKey,
        },
      },
      select: { id: true },
    });
    if (already) return "duplicate";
    // One request per alert and day goes on: requests at the same time do
    // not each take an email slot.
    const day = today();
    if (
      !(await claimSecurityEvent({
        userId: input.userId,
        action: ALERT_CLAIM,
        dedupeKey: `claim:${input.dedupeKey}:${day}`,
      }))
    ) {
      return "duplicate";
    }
    const user = await db.user.findUnique({
      where: { id: input.userId },
      select: { email: true, name: true, emailVerified: true },
    });
    if (!user) return "not_mailed";
    const why =
      input.mail === false
        ? "no_pin"
        : !user.emailVerified
          ? "unverified"
          : (await takeMailSlot(input.userId))
            ? null
            : "daily_limit";
    const row = {
      userId: input.userId,
      action: ALERT_ACTION[input.kind],
      deviceKey: input.deviceKey ?? null,
      ipAddress: input.ipAddress ?? null,
    };
    if (why) {
      // In the history, once a day; the alert may still be mailed another
      // day (a new device is not learnt until then).
      const notMailedKey = `${input.dedupeKey}:not_mailed:${day}`;
      if (
        await claimSecurityEvent({
          ...row,
          metadata: { mail: why },
          dedupeKey: notMailedKey,
        })
      ) {
        // The bell (WMS-88): not for a PIN of someone who has none.
        if (input.mail !== false) {
          bellAlert(input.userId, input.kind, input.deviceKey, notMailedKey);
        }
      }
      return "not_mailed";
    }
    // WMS-88 (ADR 0084): the alert and its mail are written together; the
    // mail leaves after the response and is tried again if it fails. The
    // history says what really happened to it.
    const emailId = await queueAlertMail(row, input.dedupeKey, input.kind);
    if (!emailId) return "duplicate";
    afterResponse(() => deliverAccessAlertEmail(emailId).then(() => {}));
    bellAlert(input.userId, input.kind, input.deviceKey, input.dedupeKey);
    return "queued";
  } catch (error) {
    log.error("access.alert_failed", error);
    return "not_mailed";
  }
}

// ---------------------------------------------------------------------------
// The mail of an alert (WMS-88, ADR 0084)

/** Tries of one alert mail, the first included. */
export const ACCESS_ALERT_MAIL_ATTEMPTS = 5;
/** Waits before each try again (after the 1st, 2nd, 3rd and 4th). */
const ALERT_MAIL_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** A try that holds its row longer than this died: another may take it. */
const ALERT_MAIL_CLAIM_STALE_MS = 5 * 60_000;
/** Rows one round of the worker tries at most. */
const ALERT_MAIL_ROUND_MAX = 50;
/**
 * Mails are kept as long as their alert (review of WMS-88): the history
 * says what happened to each one for as long as it lists the alert.
 */
export const ACCESS_ALERT_MAIL_KEEP_DAYS = 366;

/**
 * Writes the alert row and its mail together (the row once per key).
 * Returns the id of the mail, or null when the alert already existed.
 */
async function queueAlertMail(
  row: {
    userId: string;
    action: string;
    deviceKey: string | null;
    ipAddress: string | null;
  },
  dedupeKey: string,
  kind: AccessAlertKind,
): Promise<string | null> {
  try {
    return await db.$transaction(async (tx) => {
      await recordSecurityEvent(
        { ...row, metadata: { mail: "queued" }, dedupeKey },
        tx,
      );
      const event = await tx.securityEvent.findUnique({
        where: { userId_dedupeKey: { userId: row.userId, dedupeKey } },
        select: { id: true, createdAt: true },
      });
      if (!event) throw new Error("alert row not written");
      const id = newId();
      await tx.accessAlertEmail.create({
        data: {
          id,
          userId: row.userId,
          securityEventId: event.id,
          kind,
          deviceKey: row.deviceKey,
          ipAddress: row.ipAddress,
          occurredAt: event.createdAt,
          nextAttemptAt: event.createdAt,
        },
      });
      return id;
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "P2002") return null;
    throw error;
  }
}

export type AlertMailOutcome = "sent" | "retry" | "failed" | "not_taken";

/**
 * One try of the mail of an alert. The try takes the row with a
 * conditional update (`claimToken`): two processes never send the same
 * row at once, and only the try that holds it closes it. Sent: `SENT`.
 * Failed: it waits for its next try, and after ACCESS_ALERT_MAIL_ATTEMPTS
 * ends `FAILED`. The address is read from the account now, only when it
 * is confirmed. It takes no slot of the daily limit (the alert took one).
 * Never throws.
 */
export async function deliverAccessAlertEmail(
  emailId: string,
  now: Date = new Date(),
): Promise<AlertMailOutcome> {
  const token = newId();
  try {
    const taken = await db.accessAlertEmail.updateMany({
      where: {
        id: emailId,
        status: "QUEUED",
        attempts: { lt: ACCESS_ALERT_MAIL_ATTEMPTS },
        nextAttemptAt: { lte: now },
        OR: [
          { claimedAt: null },
          {
            claimedAt: {
              lt: new Date(now.getTime() - ALERT_MAIL_CLAIM_STALE_MS),
            },
          },
        ],
      },
      data: { claimToken: token, claimedAt: now, attempts: { increment: 1 } },
    });
    if (taken.count === 0) return "not_taken";
    const row = await db.accessAlertEmail.findUnique({
      where: { id: emailId },
    });
    if (!row || row.claimToken !== token) return "not_taken";
    const close = async (
      data: Parameters<typeof db.accessAlertEmail.updateMany>[0]["data"],
    ) => {
      await db.accessAlertEmail.updateMany({
        where: { id: row.id, claimToken: token, status: "QUEUED" },
        data,
      });
    };
    const user = await db.user.findUnique({
      where: { id: row.userId },
      select: { email: true, name: true, emailVerified: true },
    });
    if (!user || !user.emailVerified) {
      await close({
        status: "FAILED",
        claimToken: null,
        reason: "El correo de la cuenta no está confirmado.",
      });
      return "failed";
    }
    const membership = await db.membership.findFirst({
      where: { userId: row.userId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { organization: { select: { timeZone: true } } },
    });
    try {
      await sendEmail(
        accessAlertEmail({
          to: user.email,
          name: user.name,
          kind: row.kind as AccessAlertKind,
          when: formatDateTime(
            row.occurredAt,
            membership?.organization.timeZone ?? DEFAULT_TIME_ZONE,
          ),
          device: describeDeviceKey(row.deviceKey)?.label ?? "Otro navegador",
          ipAddress: formatIp(row.ipAddress),
          recoverUrl: appUrl("/recuperar-contrasena"),
          historyUrl: appUrl("/configuracion/accesos"),
        }),
      );
    } catch (error) {
      // Never the error itself in the log: it may carry the address.
      log.warn("access.alert_email_failed", {
        emailId: row.id,
        attempt: row.attempts,
      });
      if (
        error instanceof InvalidEmailError ||
        row.attempts >= ACCESS_ALERT_MAIL_ATTEMPTS
      ) {
        await close({
          status: "FAILED",
          claimToken: null,
          reason:
            error instanceof InvalidEmailError
              ? "El correo no se pudo armar con los datos de la cuenta."
              : "No se pudo entregar el correo después de varios intentos.",
        });
        return "failed";
      }
      const wait =
        ALERT_MAIL_RETRY_MS[
          Math.min(row.attempts, ALERT_MAIL_RETRY_MS.length) - 1
        ]!;
      await close({
        claimToken: null,
        claimedAt: null,
        nextAttemptAt: new Date(now.getTime() + wait),
        reason: "No se pudo entregar; se volverá a intentar.",
      });
      return "retry";
    }
    await close({
      status: "SENT",
      sentAt: new Date(),
      claimToken: null,
      reason: null,
    });
    return "sent";
  } catch (error) {
    log.error("access.alert_email_try_failed", error, { emailId });
    return "not_taken";
  }
}

/**
 * The worker, every minute: tries again the alert mails whose turn came
 * (and those whose try died holding them). Safe to run twice at once.
 */
export async function retryAccessAlertEmails(
  now: Date = new Date(),
): Promise<{ tried: number; sent: number; abandoned: number }> {
  // A try that died holding its row after using the last attempt never
  // got a result: it ends as failed (review of WMS-88).
  const abandoned = await db.accessAlertEmail.updateMany({
    where: {
      status: "QUEUED",
      attempts: { gte: ACCESS_ALERT_MAIL_ATTEMPTS },
      OR: [
        { claimedAt: null },
        {
          claimedAt: {
            lt: new Date(now.getTime() - ALERT_MAIL_CLAIM_STALE_MS),
          },
        },
      ],
    },
    data: {
      status: "FAILED",
      claimToken: null,
      reason: "El último intento se interrumpió sin saber si salió.",
    },
  });
  const due = await db.accessAlertEmail.findMany({
    where: {
      status: "QUEUED",
      attempts: { lt: ACCESS_ALERT_MAIL_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [
        { claimedAt: null },
        {
          claimedAt: {
            lt: new Date(now.getTime() - ALERT_MAIL_CLAIM_STALE_MS),
          },
        },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: ALERT_MAIL_ROUND_MAX,
    select: { id: true },
  });
  let sent = 0;
  for (const row of due) {
    if ((await deliverAccessAlertEmail(row.id, now)) === "sent") sent += 1;
  }
  return { tried: due.length, sent, abandoned: abandoned.count };
}

// ---------------------------------------------------------------------------
// In the bell (WMS-88, ADR 0084)

/** Companies of a person that get the notice of an alert, at most. */
const BELL_COMPANIES_MAX = 20;

function bellText(kind: AccessAlertKind, deviceKey?: string | null): string {
  const device = describeDeviceKey(deviceKey)?.label ?? "un navegador";
  switch (kind) {
    case "new_device":
      return `Alerta de seguridad: entraron a tu cuenta desde ${device}. Si no fuiste tú, cambia tu contraseña.`;
    case "password_new_device":
      return `Alerta de seguridad: escribieron bien tu contraseña desde ${device} y falló el código. Si no fuiste tú, cambia tu contraseña.`;
    case "failed_attempts":
      return "Alerta de seguridad: bloqueamos tu cuenta un rato por muchos intentos fallidos.";
    case "code_locked":
      return "Alerta de seguridad: escribieron bien tu contraseña y fallaron varias veces el código. Cambia tu contraseña.";
    case "pin_locked":
      return "Alerta de seguridad: bloqueamos tu PIN un rato por muchos intentos fallidos.";
  }
}

/**
 * The alert also as a notice of the bell, in each company where the person
 * is an active member, after the response. Once per alert (its key). The
 * text speaks of the person's own account: never of another company, never
 * the IP. Never throws.
 */
function bellAlert(
  userId: string,
  kind: AccessAlertKind,
  deviceKey: string | null | undefined,
  key: string,
): void {
  afterResponse(() => writeBellAlert(userId, kind, deviceKey, key));
}

export async function writeBellAlert(
  userId: string,
  kind: AccessAlertKind,
  deviceKey: string | null | undefined,
  key: string,
): Promise<void> {
  try {
    if (!(await takeBellSlot(userId))) return;
    const memberships = await db.membership.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      take: BELL_COMPANIES_MAX,
      select: { organizationId: true },
    });
    for (const { organizationId } of memberships) {
      await forOrganization(organizationId).$transaction((tx) =>
        notify(tx, ACCESS_ALERT_NOTICE, {
          organizationId,
          actorUserId: null,
          to: { userIds: [userId] },
          text: bellText(kind, deviceKey),
          href: "/configuracion/accesos",
          key: `access:${key}`,
        }),
      );
    }
  } catch (error) {
    log.error("access.bell_alert_failed", error);
  }
}

/** Whether the person knows this device, and any device at all. */
async function knownDevices(userId: string, deviceKey: string) {
  // Both by the unique (userId, dedupeKey) index: they never scan the
  // person's failures.
  const [device, any] = await Promise.all([
    db.securityEvent.findUnique({
      where: {
        userId_dedupeKey: { userId, dedupeKey: `device:${deviceKey}` },
      },
      select: { id: true },
    }),
    db.securityEvent.findFirst({
      where: { userId, dedupeKey: { startsWith: "device:" } },
      select: { id: true },
    }),
  ]);
  return { known: Boolean(device), anyKnown: Boolean(any) };
}

async function learnDevice(userId: string, deviceKey: string) {
  await claimSecurityEvent({
    userId,
    action: DEVICE_KNOWN,
    deviceKey,
    dedupeKey: `device:${deviceKey}`,
  });
}

/**
 * A successful entry. With a password (`sign_in.succeeded`,
 * `mfa.backup_code_used`) it checks the device: the person's first
 * device is only learnt; after that, a device never seen raises one alert
 * and is learnt only when the alert was mailed (a device seen without the
 * person hearing of it alerts again on its next entry). A PIN entry
 * (`terminal`) is recorded with its terminal and company and never
 * alerts (the terminal is a device of the company).
 */
export async function noteSignIn(input: {
  userId: string;
  action:
    "sign_in.succeeded" | "mfa.backup_code_used" | "pin_sign_in.succeeded";
  headers: Headers;
  metadata?: Record<string, string | number | boolean | null>;
  terminal?: { id: string; organizationId: string };
}): Promise<void> {
  const deviceKey = deviceKeyOf(input.headers.get("user-agent"));
  const ipAddress = clientIp(input.headers);
  await recordSecurityEvent({
    userId: input.userId,
    action: input.action,
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.terminal ? { terminalId: input.terminal.id } : {}),
    },
    ipAddress,
    deviceKey,
    organizationId: input.terminal?.organizationId ?? null,
  });
  if (input.terminal) return;
  try {
    const { known, anyKnown } = await knownDevices(input.userId, deviceKey);
    if (known) return;
    if (!anyKnown) {
      await learnDevice(input.userId, deviceKey);
      return;
    }
    const outcome = await raiseAlert({
      userId: input.userId,
      kind: "new_device",
      dedupeKey: `new_device:${deviceKey}`,
      deviceKey,
      ipAddress,
    });
    // Learnt only once the person was told; a request that lost the race
    // leaves it to the one that sends.
    if (outcome === "queued") await learnDevice(input.userId, deviceKey);
  } catch (error) {
    log.error("access.device_check_failed", error);
  }
}

/**
 * Many wrong passwords or codes blocked the person's account: one alert
 * per person per day, whatever goes on.
 */
export async function alertFailedAttempts(
  userId: string,
  headers: Headers | null,
): Promise<void> {
  await raiseAlert({
    userId,
    kind: "failed_attempts",
    dedupeKey: `failed_attempts:${today()}`,
    deviceKey: headers ? deviceKeyOf(headers.get("user-agent")) : null,
    ipAddress: headers ? clientIp(headers) : null,
  });
}

/**
 * Wrong PINs blocked the person's PIN on a shared terminal: one alert per
 * person per day, apart from the account's. Only by email when the person
 * has a PIN (anyone at a terminal can pick a coworker's name).
 */
export async function alertPinLocked(
  userId: string,
  hasPin: boolean,
): Promise<void> {
  await raiseAlert({
    userId,
    kind: "pin_locked",
    dedupeKey: `pin_locked:${today()}`,
    mail: hasPin,
  });
}

/**
 * A wrong password for `email`. All of it runs after the response
 * (`afterResponse`): looking the person up, the row of an account that
 * exists and, when its counter is blocked, one `sign_in.locked` per window
 * and the alert. So the answer takes the same time whether the account
 * exists or not.
 */
export function noteFailedSignIn(email: string, headers: Headers): void {
  afterResponse(() => recordFailedSignIn(email, headers));
}

async function recordFailedSignIn(
  email: string,
  headers: Headers,
): Promise<void> {
  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) return;
    await recordSecurityEvent({
      userId: user.id,
      action: "sign_in.failed",
      ipAddress: clientIp(headers),
      deviceKey: deviceKeyOf(headers.get("user-agent")),
    });
    if ((await blockedFor([throttleKeys.signInAccount(email)])) > 0) {
      await noteLock(user.id, "password", headers);
    }
  } catch (error) {
    log.error("access.failed_sign_in_note_failed", error);
  }
}

async function noteLock(
  userId: string,
  step: "password" | "code",
  headers: Headers,
): Promise<void> {
  const window = Math.floor(Date.now() / LOCK_WINDOW_MS);
  const locked = await claimSecurityEvent({
    userId,
    action: "sign_in.locked",
    metadata: { step },
    dedupeKey: `locked:${step}:${window}`,
    ipAddress: clientIp(headers),
    deviceKey: deviceKeyOf(headers.get("user-agent")),
  });
  if (!locked) return;
  if (step === "password") {
    await alertFailedAttempts(userId, headers);
    return;
  }
  // Wrong codes after the right password: its own alert and key, so a
  // password lock caused by anyone the same day never silences it.
  await raiseAlert({
    userId,
    kind: "code_locked",
    dedupeKey: `code_locked:${today()}`,
    deviceKey: deviceKeyOf(headers.get("user-agent")),
    ipAddress: clientIp(headers),
  });
}

/**
 * Person of the pending second step of signing in: Better Auth keeps it in
 * its challenge (`verification`), named by the signed `two_factor` cookie.
 * The signature (HMAC-SHA256 with the app secret, the format of
 * better-call) is checked before reading; anything else is null.
 */
export async function challengeUserId(
  headers: Headers,
): Promise<string | null> {
  try {
    const context = await auth.$context;
    const name = context.createAuthCookie("two_factor").name;
    const raw = (headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    if (!raw || raw.length > 512) return null;
    const value = decodeURIComponent(raw);
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const identifier = value.slice(0, dot);
    const signature = Buffer.from(value.slice(dot + 1), "base64");
    const expected = createHmac("sha256", context.secret)
      .update(identifier)
      .digest();
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      return null;
    }
    const challenge = await db.verification.findFirst({
      where: { identifier, expiresAt: { gt: new Date() } },
      select: { value: true },
    });
    return challenge && /^[0-9a-f-]{36}$/i.test(challenge.value)
      ? challenge.value
      : null;
  } catch (error) {
    log.error("access.challenge_read_failed", error);
    return null;
  }
}

/**
 * A wrong code in the second step of signing in: whoever typed it knew
 * the password. Recorded; when it comes from a device the person does not
 * know, an alert (once a day per device); and when the code locked the account
 * (Better Auth sets `lockedUntil` on the wrong code that reaches its
 * limit, still answering «invalid code»), the lock and its alert. Never
 * throws.
 */
export async function noteFailedCode(
  headers: Headers,
  method: "totp" | "backup",
): Promise<void> {
  try {
    const userId = await challengeUserId(headers);
    if (!userId) return;
    const deviceKey = deviceKeyOf(headers.get("user-agent"));
    const ipAddress = clientIp(headers);
    await recordSecurityEvent({
      userId,
      action: "mfa_code.failed",
      metadata: { method },
      ipAddress,
      deviceKey,
    });
    const { known, anyKnown } = await knownDevices(userId, deviceKey);
    if (anyKnown && !known) {
      await raiseAlert({
        userId,
        kind: "password_new_device",
        // Once a day per device: this alert does not teach the device, so
        // a later try from the same (coarse) device warns again.
        dedupeKey: `password_new_device:${deviceKey}:${today()}`,
        deviceKey,
        ipAddress,
      });
    }
    const twoFactor = await db.twoFactor.findUnique({
      where: { userId },
      select: { lockedUntil: true },
    });
    if (twoFactor?.lockedUntil && twoFactor.lockedUntil > new Date()) {
      await noteLock(userId, "code", headers);
    }
  } catch (error) {
    log.error("access.failed_code_note_failed", error);
  }
}

/**
 * Better Auth answered that the account is locked by wrong codes: someone
 * has the password. One lock per window and the alert. Never throws.
 */
export async function noteCodeLock(headers: Headers): Promise<void> {
  try {
    const userId = await challengeUserId(headers);
    if (userId) await noteLock(userId, "code", headers);
  } catch (error) {
    log.error("access.code_lock_note_failed", error);
  }
}

export type AccessHistoryRow = {
  id: string;
  action: string;
  label: string;
  at: Date;
  deviceKind: DeviceKind | null;
  device: string | null;
  ipAddress: string | null;
  /** Shared terminal of a PIN entry or failure, when it is readable. */
  terminalName: string | null;
  /** «warning»: a failure or lock; «suspicious»: an alert. */
  tone: "normal" | "warning" | "suspicious";
  /** For an alert: whether the email went out, and why not. */
  mailText: string | null;
};

const MAIL_TEXT: Record<string, string> = {
  // Before WMS-88 «sent» meant «scheduled»: that is all that is known.
  sent: "Se programó el correo de alerta.",
  // WMS-88: the mail row is gone only when the alert itself is about to go.
  queued: "Se programó el correo de alerta.",
  daily_limit: `No se envió correo: ya se habían enviado ${ACCESS_ALERTS_PER_DAY} alertas ese día.`,
  unverified: "No se envió correo: el correo de la cuenta no está confirmado.",
  no_pin: "No se envió correo: no tiene PIN.",
};

type MailState = { status: string; attempts: number } | undefined;

function mailTextOf(
  action: string,
  metadata: unknown,
  mail: MailState,
): string | null {
  if (!SUSPICIOUS_ACTIONS.has(action)) return null;
  // WMS-88: what really happened to the mail.
  if (mail) {
    if (mail.status === "SENT") return "Se envió el correo de alerta.";
    if (mail.status === "FAILED")
      return "No se pudo enviar el correo de alerta.";
    return mail.attempts > 0
      ? "El correo de alerta no ha salido; se volverá a intentar."
      : "El correo de alerta está programado.";
  }
  const said = (metadata as { mail?: unknown } | null)?.mail;
  return typeof said === "string" ? (MAIL_TEXT[said] ?? null) : null;
}

export type AccessHistoryPage = {
  rows: AccessHistoryRow[];
  page: number;
  pageCount: number;
  total: number;
};

type HistoryWhere = {
  userId: string;
  action: { in: string[] };
  OR?: object[];
};

/**
 * One page of a person's history for `where` (built by who decides what
 * the viewer may see), newest first. The page is clamped to the last one.
 * Terminal names are read in each terminal's own company.
 */
export async function readAccessHistory(
  where: HistoryWhere,
  requestedPage: number,
): Promise<AccessHistoryPage> {
  const total = await db.securityEvent.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / ACCESS_HISTORY_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pageCount);
  const events = await db.securityEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * ACCESS_HISTORY_PAGE_SIZE,
    take: ACCESS_HISTORY_PAGE_SIZE,
    select: {
      id: true,
      action: true,
      metadata: true,
      ipAddress: true,
      eventOrganizationId: true,
      deviceKey: true,
      createdAt: true,
    },
  });
  const terminalOf = (metadata: unknown): string | null => {
    const id = (metadata as { terminalId?: unknown } | null)?.terminalId;
    return typeof id === "string" ? id : null;
  };
  const byCompany = new Map<string, Set<string>>();
  for (const event of events) {
    const terminalId = terminalOf(event.metadata);
    if (!terminalId || !event.eventOrganizationId) continue;
    const ids = byCompany.get(event.eventOrganizationId) ?? new Set<string>();
    ids.add(terminalId);
    byCompany.set(event.eventOrganizationId, ids);
  }
  const alertIds = events
    .filter((event) => SUSPICIOUS_ACTIONS.has(event.action))
    .map((event) => event.id);
  const mails = new Map(
    (alertIds.length > 0
      ? await db.accessAlertEmail.findMany({
          where: { securityEventId: { in: alertIds } },
          select: { securityEventId: true, status: true, attempts: true },
        })
      : []
    ).map((row) => [row.securityEventId, row]),
  );
  const names = new Map<string, string>();
  for (const [organizationId, ids] of byCompany) {
    const terminals = await forOrganization(
      organizationId,
    ).sharedTerminal.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    for (const terminal of terminals) names.set(terminal.id, terminal.name);
  }
  const rows = events.map((event) => {
    const device = describeDeviceKey(event.deviceKey);
    const terminalId = terminalOf(event.metadata);
    return {
      id: event.id,
      action: event.action,
      label: ACCESS_ACTION_LABELS[event.action] ?? event.action,
      at: event.createdAt,
      deviceKind: device?.kind ?? null,
      device: device?.label ?? null,
      ipAddress: formatIp(event.ipAddress),
      terminalName: terminalId ? (names.get(terminalId) ?? null) : null,
      tone: SUSPICIOUS_ACTIONS.has(event.action)
        ? ("suspicious" as const)
        : WARNING_ACTIONS.has(event.action)
          ? ("warning" as const)
          : ("normal" as const),
      mailText: mailTextOf(event.action, event.metadata, mails.get(event.id)),
    };
  });
  return { rows, page, pageCount, total };
}

/**
 * The person's own history, complete. A PIN session of a shared terminal
 * does not see it (account security is not touched there, ADR 0061).
 */
export async function listMyAccessHistory(
  userId: string,
  page = 1,
): Promise<AccessHistoryPage> {
  await assertNotTerminalSession(userId);
  return readAccessHistory({ userId, action: { in: ACCESS_ACTIONS } }, page);
}

// ---------------------------------------------------------------------------
// Retention (WMS-88, ADR 0084)

/**
 * Access events and the internal rows of a day are kept this long. The
 * database allows deleting nothing younger (trigger
 * `security_event_no_delete`): changing it is a migration too.
 */
export const SECURITY_EVENT_KEEP_DAYS = 365;

/**
 * What the retention may delete: the events the history lists (alerts
 * included) and the rows of a day. Never `access.device_known` nor the
 * events that are not accesses. The trigger repeats this list.
 */
export const PURGEABLE_SECURITY_ACTIONS: readonly string[] = [
  ...ACCESS_ACTIONS,
  MAIL_SLOT,
  ALERT_CLAIM,
];

const PURGE_BATCH = 1000;
const PURGE_BATCHES = 20;

/**
 * The round of the worker (hourly): access events older than
 * SECURITY_EVENT_KEEP_DAYS (one day more, so the clock of the app never
 * asks before the database allows), and alert mails that ended more than
 * ACCESS_ALERT_MAIL_KEEP_DAYS ago. In batches by id. Safe to repeat.
 */
export async function purgeExpiredSecurityEvents(
  now: Date = new Date(),
): Promise<{ events: number; mails: number }> {
  const before = new Date(
    now.getTime() - (SECURITY_EVENT_KEEP_DAYS + 1) * 86_400_000,
  );
  let events = 0;
  for (let batch = 0; batch < PURGE_BATCHES; batch += 1) {
    const rows = await db.securityEvent.findMany({
      where: {
        createdAt: { lt: before },
        action: { in: [...PURGEABLE_SECURITY_ACTIONS] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PURGE_BATCH,
      select: { id: true },
    });
    if (rows.length === 0) break;
    const removed = await db.securityEvent.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    events += removed.count;
    if (rows.length < PURGE_BATCH) break;
  }
  const mails = await db.accessAlertEmail.deleteMany({
    where: {
      status: { not: "QUEUED" },
      createdAt: {
        lt: new Date(now.getTime() - ACCESS_ALERT_MAIL_KEEP_DAYS * 86_400_000),
      },
    },
  });
  return { events, mails: mails.count };
}
