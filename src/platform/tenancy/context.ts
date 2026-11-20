import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import {
  TERMINAL_PATH,
  noteSessionActivity,
  requireSession,
  type CurrentUser,
  type SessionTerminal,
} from "@/platform/auth";
import { db } from "@/server";

import { CREATE_ORGANIZATION_PATH } from "./organizations";
import { supportWindowFor } from "./support";

/**
 * Active company (PLT-11). Each session works in one company, stored on
 * the session row in the database (never in a cookie the browser could
 * change). Every request re-checks that the person still has an active
 * membership there; if not, it falls back to another company of theirs or
 * to /crear-empresa. Business code receives `organizationId` only from here.
 */

export type ActiveOrganization = {
  id: string;
  name: string;
  timeZone: string;
  currency: string;
  /** The person is the company's titular (Organization.ownerUserId). */
  isOwner: boolean;
  /**
   * Platform support looking into the company with its titular's leave
   * (PIL-12): read-only, until this moment. Null for its members.
   */
  supportUntil: Date | null;
  /**
   * Demonstration company (WMS-44, ADR 0089): fictitious data. Read in the
   * same query as the company; it opens no shortcut of permissions.
   */
  isDemo: boolean;
};

export type OrganizationContext = {
  user: CurrentUser;
  sessionId: string;
  mfaEnabled: boolean;
  organization: ActiveOrganization;
  /** The shared terminal of a PIN session (WMS-38); null otherwise. */
  terminal: SessionTerminal | null;
};

export type MyOrganization = { id: string; name: string };

/** Where a session goes when its companies closed it (WMS-40). */
export const SIGN_IN_AGAIN_PATH = "/ingresar";

export const SIGN_IN_AGAIN_MESSAGE =
  "Vuelve a iniciar sesión para entrar a esta empresa.";

/** A PIN session works only in its terminal's company (WMS-38). */
export const TERMINAL_SWITCH_MESSAGE =
  "En una terminal compartida no se cambia de empresa.";

/** Companies where the person is an active member, oldest first. */
export async function listMyOrganizations(
  userId: string,
): Promise<MyOrganization[]> {
  const memberships = await db.membership.findMany({
    where: { userId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { organization: { select: { id: true, name: true } } },
  });
  return memberships.map((m) => m.organization);
}

/**
 * Resolves the session's company: the stored one if the membership is
 * still active, otherwise the oldest active membership (saved back to the
 * session). Null when the person belongs to no company.
 */
export async function resolveActiveOrganization(
  userId: string,
  sessionId: string,
): Promise<ActiveOrganization | null> {
  return (await resolveWithActivity(userId, sessionId)).organization;
}

/**
 * A membership this session may work in: active, and not closed for the
 * person after the session began («Cerrar todas sus sesiones» or disabling
 * write `sessionsRevokedAt`, WMS-40). A session older than that cut must
 * sign in again to enter the company; it may keep working in others.
 */
function usableMembership(userId: string, sessionCreatedAt: Date) {
  return {
    userId,
    status: "ACTIVE" as const,
    OR: [
      { sessionsRevokedAt: null },
      { sessionsRevokedAt: { lt: sessionCreatedAt } },
    ],
  };
}

type Resolved = {
  organization: ActiveOrganization | null;
  lastActiveAt: Date | null;
  /** No company, but one would take this person after signing in again. */
  signInAgain: boolean;
};

/**
 * The same, plus the session's last activity read in the same query
 * (WMS-40): the request guard uses it to decide whether to note activity.
 */
async function resolveWithActivity(
  userId: string,
  sessionId: string,
  onlyOrganizationId?: string,
): Promise<Resolved> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      userId: true,
      activeOrganizationId: true,
      lastActiveAt: true,
      createdAt: true,
    },
  });
  if (!session || session.userId !== userId) {
    return { organization: null, lastActiveAt: null, signInAgain: false };
  }
  const organization = await organizationOf(
    userId,
    sessionId,
    session,
    onlyOrganizationId,
  );
  const signInAgain =
    !organization &&
    (await db.membership.count({ where: { userId, status: "ACTIVE" } })) > 0;
  return { organization, lastActiveAt: session.lastActiveAt, signInAgain };
}

async function organizationOf(
  userId: string,
  sessionId: string,
  session: { activeOrganizationId: string | null; createdAt: Date },
  onlyOrganizationId?: string,
): Promise<ActiveOrganization | null> {
  const select = {
    organization: {
      select: {
        id: true,
        name: true,
        timeZone: true,
        currency: true,
        ownerUserId: true,
        isDemo: true,
      },
    },
  } as const;
  const usable = usableMembership(userId, session.createdAt);

  let membership = session.activeOrganizationId
    ? await db.membership.findFirst({
        where: { ...usable, organizationId: session.activeOrganizationId },
        select,
      })
    : null;

  // A PIN session (WMS-38) works in its terminal's company or nowhere: no
  // support window, no fallback to another company.
  if (onlyOrganizationId !== undefined) {
    if (!membership || session.activeOrganizationId !== onlyOrganizationId) {
      return null;
    }
    const { ownerUserId, ...organization } = membership.organization;
    return {
      ...organization,
      isOwner: ownerUserId === userId,
      supportUntil: null,
    };
  }

  // Support is in a company where it has no membership, while the
  // titular's access stays open (PIL-12).
  if (!membership && session.activeOrganizationId) {
    const window = await supportWindowFor(session.activeOrganizationId, userId);
    if (window) {
      const company = await db.organization.findUnique({
        where: { id: session.activeOrganizationId },
        select: {
          id: true,
          name: true,
          timeZone: true,
          currency: true,
          isDemo: true,
        },
      });
      if (company) {
        return { ...company, isOwner: false, supportUntil: window.until };
      }
    }
  }

  if (!membership) {
    membership = await db.membership.findFirst({
      where: usable,
      orderBy: { createdAt: "asc" },
      select,
    });
    const fallback = membership?.organization.id ?? null;
    if (fallback !== session.activeOrganizationId) {
      await db.session.update({
        where: { id: sessionId },
        data: { activeOrganizationId: fallback },
      });
    }
  }
  if (!membership) return null;

  const { ownerUserId, ...organization } = membership.organization;
  return {
    ...organization,
    isOwner: ownerUserId === userId,
    supportUntil: null,
  };
}

/**
 * Guard for every business screen and action: valid session (and MFA when
 * required) plus an active company. People without one are sent to create
 * it. Cached per request.
 */
export const requireOrganizationContext = cache(
  async (): Promise<OrganizationContext> => {
    const session = await requireSession();
    const { terminal } = session;
    const { organization, lastActiveAt, signInAgain } =
      await resolveWithActivity(
        session.user.id,
        session.sessionId,
        terminal?.organizationId,
      );
    if (terminal) {
      if (!organization) {
        // Its company no longer takes this person: the PIN session is over
        // and the terminal asks «¿Quién eres?» again.
        await db.session.deleteMany({
          where: { id: session.sessionId, userId: session.user.id },
        });
        redirect(TERMINAL_PATH);
      }
      // No activity is noted from requests: the bell and periodic
      // refreshes would keep an abandoned session alive. Only the person's
      // touches count (keepTerminalSessionAction, ADR 0061 §7).
      return { ...session, organization };
    }
    if (!organization && signInAgain) {
      // Its companies closed this person's sessions (WMS-40) and it works
      // in no other: it is of no use any more. Signing in again opens a
      // session that may enter them.
      await db.session.deleteMany({
        where: { id: session.sessionId, userId: session.user.id },
      });
      redirect(SIGN_IN_AGAIN_PATH);
    }
    if (!organization) redirect(CREATE_ORGANIZATION_PATH);
    // «Última actividad» of the team's sessions (WMS-40): at most every few
    // minutes, after the response.
    noteSessionActivity(session.sessionId, lastActiveAt);
    return { ...session, organization };
  },
);

export type SwitchOrganizationResult =
  { ok: true } | { ok: false; error: string };

/**
 * Makes another company the session's active one, only if the person is an
 * active member there. The same answer for "no such company" and "not a
 * member", so identifiers of other companies reveal nothing.
 */
export async function switchOrganization(
  userId: string,
  sessionId: string,
  organizationId: string,
): Promise<SwitchOrganizationResult> {
  const terminalSession = await db.session.count({
    where: { id: sessionId, userId, terminalId: { not: null } },
  });
  if (terminalSession > 0) return { ok: false, error: TERMINAL_SWITCH_MESSAGE };
  const membership = await db.membership.findFirst({
    where: { userId, organizationId: String(organizationId), status: "ACTIVE" },
    select: { id: true, sessionsRevokedAt: true },
  });
  if (!membership) {
    return { ok: false, error: "No tienes acceso a esa empresa." };
  }
  // The company closed this person's sessions after this one began
  // (WMS-40): only a new session enters it.
  if (membership.sessionsRevokedAt) {
    const session = await db.session.findFirst({
      where: { id: sessionId, userId },
      select: { createdAt: true },
    });
    if (session && session.createdAt <= membership.sessionsRevokedAt) {
      return { ok: false, error: SIGN_IN_AGAIN_MESSAGE };
    }
  }
  const updated = await db.session.updateMany({
    where: { id: sessionId, userId },
    data: { activeOrganizationId: organizationId },
  });
  return updated.count === 1
    ? { ok: true }
    : {
        ok: false,
        error: "Tu sesión ya no es válida. Inicia sesión de nuevo.",
      };
}
