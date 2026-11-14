import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import { ForbiddenError, log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { pendingLegalDocuments } from "@/platform/legal";
import { db } from "@/server";

import { auth } from "./auth";
import { isMfaRequired, usersWhoMustUseMfa } from "./mfa-policy";
import { getCurrentSession } from "./session";
import { clientIp } from "./throttle";

/**
 * Shared terminals (WMS-38, ADR 0061): the part that runs on every
 * request. A device registered as a terminal keeps a random secret in an
 * HttpOnly cookie (only its SHA-256 is stored); a PIN session is a normal
 * Better Auth session of one person, marked with its terminal, that only
 * works on that device, for a short time, in the terminal's company and
 * without anything of account security or administration. Registering,
 * PINs and the sign-in itself live in `platform/terminals`, which depends
 * on this area (never the other way round).
 */

/** Where a terminal asks «¿Quién eres?». */
export const TERMINAL_PATH = "/terminal";

/** Where a shared terminal explains that there one enters with a PIN. */
export const TERMINAL_PASSWORD_PATH = "/terminal?aviso=contrasena";

/**
 * A rotated secret still opens the terminal this long (two tabs, a request
 * already on its way). Later, the old secret means a copied cookie.
 */
export const TERMINAL_SECRET_GRACE_MS = 2 * 60 * 1000;

/** A PIN session never lives longer than this (a long shift). */
export const TERMINAL_SESSION_MAX_HOURS = 12;

/**
 * How often the last activity of a terminal session is written (shorter
 * than the 5 minutes of WMS-40: inactivity closes these sessions).
 */
export const TERMINAL_ACTIVITY_INTERVAL_MS = 30 * 1000;

/** What a PIN session is refused (account security). */
export const TERMINAL_SESSION_MESSAGE =
  "Desde una terminal compartida no se cambia la seguridad de tu cuenta. Entra con tu correo y contraseña en tu propio dispositivo.";

/** The terminal cookie: `__Host-` (Secure, Path=/, no Domain) outside development. */
export const TERMINAL_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-wms-terminal"
    : "wms-terminal";

/** 400 days: the most a browser keeps a cookie. */
export const TERMINAL_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export const terminalCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: TERMINAL_COOKIE_MAX_AGE,
};

/**
 * Roles allowed to sign in with a PIN, by value of the company setting
 * `platform.terminal.pin_roles`. Every role of the person must be in the
 * chosen set. «administrator» is in none: whoever must use two steps never
 * signs in with a PIN (also checked with `isMfaRequired`).
 */
export const PIN_ROLE_SETS = {
  floor: ["operator", "forklift"],
  floor_supervision: ["operator", "forklift", "supervisor", "warehouse"],
  without_mfa: [
    "operator",
    "forklift",
    "supervisor",
    "warehouse",
    "buyer",
    "viewer",
    "manager",
  ],
} as const satisfies Record<string, readonly string[]>;

export type PinRoleSet = keyof typeof PIN_ROLE_SETS;

export const PIN_ROLES_SETTING_KEY = "platform.terminal.pin_roles";
export const DEFAULT_PIN_ROLES: PinRoleSet = "floor";

/** SHA-256 (hex) of a terminal secret, as stored. */
export function hashTerminalSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A new terminal secret (256 bits) and its cookie value. */
export function newTerminalSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function terminalCookieValue(terminalId: string, secret: string) {
  return `${terminalId}.${secret}`;
}

/** Splits a cookie value; null when it does not have the right shape. */
export function parseTerminalCookie(
  raw: string | undefined | null,
): { id: string; secret: string } | null {
  if (!raw || raw.length > 200) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    return null;
  }
  return { id, secret };
}

export type DeviceTerminal = {
  id: string;
  organizationId: string;
  facilityId: string;
  name: string;
};

async function readTerminalCookie(): Promise<string | undefined> {
  try {
    return (await cookies()).get(TERMINAL_COOKIE)?.value;
  } catch {
    // Outside a request (tests, scripts): no device.
    return undefined;
  }
}

/** True when this browser carries a terminal cookie (no database). */
export async function hasTerminalCookie(): Promise<boolean> {
  return parseTerminalCookie(await readTerminalCookie()) !== null;
}

/**
 * The active terminal registered on this browser, or null. The secret
 * must match a terminal that was not removed, of an id equal to the one in
 * the cookie. Cached per request.
 */
export const terminalOfDevice = cache(
  async (): Promise<DeviceTerminal | null> => {
    const parsed = parseTerminalCookie(await readTerminalCookie());
    if (!parsed) return null;
    return terminalBySecret(parsed.id, parsed.secret);
  },
);

const TERMINAL_SELECT = {
  id: true,
  organizationId: true,
  facilityId: true,
  name: true,
  removedAt: true,
  secretRotatedAt: true,
} as const;

function deviceOf(terminal: {
  id: string;
  organizationId: string;
  facilityId: string;
  name: string;
}): DeviceTerminal {
  return {
    id: terminal.id,
    organizationId: terminal.organizationId,
    facilityId: terminal.facilityId,
    name: terminal.name,
  };
}

/**
 * The active terminal with that id and secret, or null. The secret rotates
 * on every PIN sign-in (ADR 0061 §1): the one before still works for a
 * short grace; after it, it can only come from a copy of the cookie, so
 * the terminal is removed, its sessions closed and who manages it warned.
 */
export async function terminalBySecret(
  id: string,
  secret: string,
  now: Date = new Date(),
): Promise<DeviceTerminal | null> {
  const hash = hashTerminalSecret(secret);
  const terminal = await db.sharedTerminal.findUnique({
    where: { secretHash: hash },
    select: TERMINAL_SELECT,
  });
  if (terminal) {
    return terminal.removedAt || terminal.id !== id ? null : deviceOf(terminal);
  }
  const rotated = await db.sharedTerminal.findFirst({
    where: { previousSecretHash: hash, id },
    select: TERMINAL_SELECT,
  });
  if (!rotated || rotated.removedAt || !rotated.secretRotatedAt) return null;
  if (
    now.getTime() - rotated.secretRotatedAt.getTime() <=
    TERMINAL_SECRET_GRACE_MS
  ) {
    return deviceOf(rotated);
  }
  await removeClonedTerminal(deviceOf(rotated));
  return null;
}

/**
 * A secret replaced long ago came back: the cookie was copied. The
 * terminal is removed (by the system), its sessions closed, the trail
 * written and who manages terminals of its warehouse warned.
 */
async function removeClonedTerminal(terminal: DeviceTerminal): Promise<void> {
  try {
    const removed = await db.$transaction(async (tx) => {
      const { count } = await tx.sharedTerminal.updateMany({
        where: { id: terminal.id, removedAt: null },
        data: { removedAt: new Date() },
      });
      if (count === 0) return false;
      const closed = await tx.session.deleteMany({
        where: { terminalId: terminal.id },
      });
      await recordAuditEvent(tx, {
        organizationId: terminal.organizationId,
        actorUserId: null,
        action: "terminal.cloned",
        target: { type: "shared_terminal", id: terminal.id },
        metadata: { name: terminal.name, sessionsClosed: closed.count },
      });
      return true;
    });
    if (!removed) return;
    // Loaded here: notifications and terminals depend on this area.
    const { notify } = await import("@/platform/notifications");
    const { TERMINAL_CLONED_NOTICE } = await import("@/platform/terminals");
    const { forOrganization } = await import("@/server");
    await forOrganization(terminal.organizationId).$transaction((tx) =>
      notify(tx, TERMINAL_CLONED_NOTICE, {
        organizationId: terminal.organizationId,
        actorUserId: null,
        to: {
          permissions: ["platform.terminal.manage"],
          facilityId: terminal.facilityId,
        },
        text: `Se quitó la terminal «${terminal.name}»: alguien usó una copia de su cookie. Para volver a usarla, regístrala de nuevo.`,
        href: "/configuracion/terminales",
        key: `terminal_cloned:${terminal.id}`,
      }),
    );
  } catch (error) {
    log.error("terminal.clone_report_failed", error);
  }
}

/**
 * Gives this browser's terminal a new secret (ADR 0061 §1), after a PIN
 * sign-in: a copy of the old cookie stops working once the grace passes.
 * Conditioned on the secret this browser sent, so two sign-ins at once
 * rotate once; only the one that rotated writes the cookie.
 */
export async function rotateTerminalSecret(
  terminal: DeviceTerminal,
): Promise<boolean> {
  const parsed = parseTerminalCookie(await readTerminalCookie());
  if (!parsed || parsed.id !== terminal.id) return false;
  const secret = newTerminalSecret();
  const { count } = await db.sharedTerminal.updateMany({
    where: {
      id: terminal.id,
      removedAt: null,
      secretHash: hashTerminalSecret(parsed.secret),
    },
    data: {
      secretHash: hashTerminalSecret(secret),
      previousSecretHash: hashTerminalSecret(parsed.secret),
      secretRotatedAt: new Date(),
    },
  });
  if (count !== 1) return false;
  (await cookies()).set(
    TERMINAL_COOKIE,
    terminalCookieValue(terminal.id, secret),
    terminalCookieOptions,
  );
  return true;
}

/** The role set the company allows with a PIN (its setting or the default). */
export async function pinRoleSetOf(
  organizationId: string,
): Promise<readonly string[]> {
  const row = await db.organizationSetting.findFirst({
    where: { organizationId, key: PIN_ROLES_SETTING_KEY },
    select: { value: true },
  });
  const value =
    row && Object.hasOwn(PIN_ROLE_SETS, row.value)
      ? (row.value as PinRoleSet)
      : DEFAULT_PIN_ROLES;
  return PIN_ROLE_SETS[value];
}

export type PinCandidate = {
  userId: string;
  name: string;
  /** Correo confirmado: without it a right PIN does not sign in. */
  emailVerified: boolean;
};

/** At most this many people are offered on a terminal. */
export const PIN_CANDIDATES_MAX = 300;

/**
 * People who may sign in with a PIN on a terminal of this company and
 * warehouse (ADR 0061 §5), by name: active members whose scope reaches
 * the warehouse, whose every role is allowed by the company, who do not
 * use two steps (required or chosen). Whether they have a PIN is not
 * looked at: the list never tells. With `userIds`, only those; with
 * `facilityId` null, in any warehouse of the company (whether the person
 * may set a PIN at all).
 */
export async function pinCandidates(
  organizationId: string,
  facilityId: string | null,
  userIds?: readonly string[],
): Promise<PinCandidate[]> {
  const allowed = new Set(await pinRoleSetOf(organizationId));
  const memberships = await db.membership.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      ...(userIds ? { userId: { in: userIds.map(String) } } : {}),
      user: { twoFactorEnabled: false },
    },
    select: {
      userId: true,
      roles: { select: { role: true } },
      scopes: { select: { facilityId: true } },
      user: { select: { name: true, emailVerified: true } },
    },
  });
  const fit = memberships.filter(
    (m) =>
      m.roles.length > 0 &&
      m.roles.every((r) => allowed.has(r.role)) &&
      (facilityId === null ||
        m.scopes.length === 0 ||
        m.scopes.some((s) => s.facilityId === facilityId)),
  );
  if (fit.length === 0) return [];
  // The rule of isMfaRequired, for the whole list at once.
  const mustUseMfa = await usersWhoMustUseMfa(fit.map((m) => m.userId));
  return fit
    .filter((m) => !mustUseMfa.has(m.userId))
    .map((m) => ({
      userId: m.userId,
      name: m.user.name.trim() || "Sin nombre",
      emailVerified: m.user.emailVerified,
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "es", { sensitivity: "base" }) ||
        (a.userId < b.userId ? -1 : 1),
    )
    .slice(0, PIN_CANDIDATES_MAX);
}

/**
 * Opens the PIN session of a person on a terminal (ADR 0061 §4): closes
 * whatever session the terminal had (one person at a time), creates a
 * Better Auth session of that person marked with the terminal, in the
 * terminal's company, and sets its signed cookie on this browser. Only
 * `platform/terminals` calls it, after checking the PIN.
 */
export async function openTerminalSession(input: {
  userId: string;
  terminal: DeviceTerminal;
  idleSeconds: number;
  headers: Headers;
}): Promise<void> {
  const context = await auth.$context;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + TERMINAL_SESSION_MAX_HOURS * 60 * 60 * 1000,
  );
  const token = randomBytes(24).toString("base64url");
  await db.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { terminalId: input.terminal.id } });
    await tx.session.create({
      data: {
        id: newId(),
        token,
        userId: input.userId,
        expiresAt,
        createdAt: now,
        lastActiveAt: now,
        ipAddress: clientIp(input.headers),
        userAgent: (input.headers.get("user-agent") ?? "").slice(0, 1000),
        activeOrganizationId: input.terminal.organizationId,
        terminalId: input.terminal.id,
        terminalIdleSeconds: input.idleSeconds,
      },
    });
  });
  // The same signed cookie Better Auth writes: token.HMAC-SHA256(secret).
  const signature = createHmac("sha256", context.secret)
    .update(token)
    .digest("base64");
  const { name, attributes } = context.authCookies.sessionToken;
  (await cookies()).set(name, `${token}.${signature}`, {
    httpOnly: true,
    secure: attributes.secure ?? process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: attributes.path ?? "/",
    maxAge: TERMINAL_SESSION_MAX_HOURS * 60 * 60,
  });
}

export type TerminalSessionRow = {
  id: string;
  userId: string;
  createdAt: Date;
  lastActiveAt: Date | null;
  terminalId: string;
  terminalIdleSeconds: number;
};

/** Why a terminal session no longer works, or null when it does. */
export function terminalSessionExpiry(
  row: Pick<
    TerminalSessionRow,
    "createdAt" | "lastActiveAt" | "terminalIdleSeconds"
  >,
  now: Date = new Date(),
): "idle" | "too_long" | null {
  const since = (row.lastActiveAt ?? row.createdAt).getTime();
  if (now.getTime() - since > row.terminalIdleSeconds * 1000) return "idle";
  if (
    now.getTime() - row.createdAt.getTime() >
    TERMINAL_SESSION_MAX_HOURS * 60 * 60 * 1000
  ) {
    return "too_long";
  }
  return null;
}

export type ValidTerminalSession = DeviceTerminal & {
  lastActiveAt: Date | null;
  /** Inactivity that closes it, copied from the setting when it opened. */
  idleSeconds: number;
};

/**
 * Checks a PIN session on this request (ADR 0061 §7): its terminal is the
 * one registered on this browser and still active, it has not been idle
 * nor open too long, and the person may still sign in with a PIN there
 * (roles, scope, two steps, legal documents, verified email). Returns the
 * terminal, or null after deleting the session (it is of no use any more).
 */
export async function checkTerminalSession(
  sessionId: string,
  userId: string,
): Promise<ValidTerminalSession | null> {
  const row = await db.session.findFirst({
    where: { id: sessionId, userId },
    select: {
      createdAt: true,
      lastActiveAt: true,
      terminalId: true,
      terminalIdleSeconds: true,
      activeOrganizationId: true,
    },
  });
  const device = await terminalOfDevice();
  const valid =
    row?.terminalId != null &&
    row.terminalIdleSeconds != null &&
    device?.id === row.terminalId &&
    row.activeOrganizationId === device.organizationId &&
    terminalSessionExpiry({
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      terminalIdleSeconds: row.terminalIdleSeconds,
    }) === null &&
    (await stillMayUsePin(device, userId));
  if (!valid || !device) {
    await db.session.deleteMany({ where: { id: sessionId, userId } });
    return null;
  }
  return {
    ...device,
    lastActiveAt: row?.lastActiveAt ?? null,
    idleSeconds: row?.terminalIdleSeconds ?? 0,
  };
}

async function stillMayUsePin(
  terminal: DeviceTerminal,
  userId: string,
): Promise<boolean> {
  if (await isMfaRequired(userId)) return false;
  if ((await pendingLegalDocuments(userId)).length > 0) return false;
  const [candidate] = await pinCandidates(
    terminal.organizationId,
    terminal.facilityId,
    [userId],
  );
  return candidate?.emailVerified === true;
}

/**
 * The person of the request when it was made with a PIN session, or null
 * (no request, no session, or a session opened with a password). Read from
 * the session already loaded for the request: no extra query.
 */
export const terminalUserOfRequest = cache(async (): Promise<string | null> => {
  try {
    await headers();
  } catch {
    // No request (worker, scripts, tests): there is no terminal.
    return null;
  }
  // Inside a request a failure to read the session is not «no terminal»:
  // it propagates, so the cut never fails open.
  const session = await getCurrentSession();
  const terminalId = (
    session?.session as { terminalId?: string | null } | undefined
  )?.terminalId;
  return terminalId ? session!.user.id : null;
});

/**
 * Refuses account security (two steps, sessions, PIN) to a PIN session
 * (ADR 0061 §8). Every such service calls it with the person it acts on.
 */
export async function assertNotTerminalSession(userId: string): Promise<void> {
  if ((await terminalUserOfRequest()) === userId) {
    throw new ForbiddenError("terminal_session", TERMINAL_SESSION_MESSAGE);
  }
}

/**
 * Keeps a terminal session alive while the person touches the screen:
 * writes its last activity, at most every TERMINAL_ACTIVITY_INTERVAL_MS
 * (one row by primary key, conditioned). Returns whether it wrote.
 */
export async function touchTerminalSession(
  sessionId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - TERMINAL_ACTIVITY_INTERVAL_MS);
  const { count } = await db.session.updateMany({
    where: {
      id: String(sessionId),
      userId,
      terminalId: { not: null },
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lte: cutoff } }],
    },
    data: { lastActiveAt: now },
  });
  return count === 1;
}
