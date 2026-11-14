import "server-only";

import {
  DEVICE_KIND_LABELS,
  describeUserAgent,
  formatIp,
  type DeviceKind,
} from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { notify, type NotifyTx } from "@/platform/notifications";
import { db, forOrganization } from "@/server";

import { assertAllowed, loadSubject } from "./access";
import { isRole } from "./catalog";
import { SESSIONS_CLOSED_NOTICE } from "./notices";
import { knownRoles } from "./policy";
import { withTeamChange, type TeamActionResult, type Tx } from "./team";
import { checkTeamChange, type TeamRuleReason } from "./team-rules";

/**
 * Sessions of the team (WMS-40, ADR 0059). A session belongs to a person,
 * who may work for several companies: a company only sees and closes the
 * sessions that have it as their active company. Everything else does not
 * exist here — not listed, not counted, not closable by guessing its id.
 * Tokens and raw user agents never leave the server.
 */

/** At most this many sessions are listed for one person. */
export const MEMBER_SESSIONS_MAX = 100;

/** Longest reason accepted when closing sessions. */
export const SESSION_REVOKE_REASON_MAX = 500;

export type MemberSession = {
  id: string;
  /** «Computadora», «Teléfono», «Tableta» u «Otro». */
  device: DeviceKind;
  deviceLabel: string;
  /** «Chrome en Android», «Otro navegador». */
  label: string;
  ipAddress: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  /** The session the viewer is using right now. */
  current: boolean;
  /** Shared terminal it was opened on with a PIN (WMS-38); null otherwise. */
  terminalName: string | null;
};

export type MemberSessionsView = {
  sessions: MemberSession[];
  /** The viewer may close this person's sessions here. */
  canRevoke: boolean;
  /** Why not, when the viewer could close sessions of others; else null. */
  revokeBlocked: string | null;
};

export type SessionRevokeResult =
  { ok: true; closed: number } | { ok: false; error: string };

/** What the team screen says when a rule stops closing sessions. */
const BLOCKED: Partial<Record<TeamRuleReason, string>> = {
  owner_protected:
    "Las sesiones del titular solo las cierra el titular, en Configuración › Sesiones activas.",
  self: "Tus sesiones se cierran en Configuración › Sesiones activas.",
  administrator_reserved:
    "Solo el titular cierra las sesiones de un administrador.",
};

const SESSION_GONE = "Esa sesión ya no está abierta en tu empresa.";

/** Open sessions of `userId` in this company: the only ones that exist here. */
function companySessions(organizationId: string, userId: string) {
  return {
    userId,
    activeOrganizationId: organizationId,
    expiresAt: { gt: new Date() },
  };
}

async function teamPerson(organizationId: string, userId: string) {
  const [organization, membership] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: { ownerUserId: true },
    }),
    forOrganization(organizationId).membership.findFirst({
      where: { userId },
      select: { roles: { select: { role: true } } },
    }),
  ]);
  if (!membership) return null;
  return {
    userId,
    isOwner: organization?.ownerUserId === userId,
    roles: knownRoles(membership.roles.map((r) => r.role).filter(isRole)),
  };
}

/**
 * Sessions of a member in this company, newest activity first. Needs
 * `platform.session.read`; null when the person is not in the company.
 */
export async function listMemberSessions(
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  currentSessionId: string,
): Promise<MemberSessionsView | null> {
  await assertAllowed(organizationId, actorUserId, "platform.session.read");
  const target = await teamPerson(organizationId, String(targetUserId));
  if (!target) return null;

  const rows = await db.session.findMany({
    where: companySessions(organizationId, target.userId),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: MEMBER_SESSIONS_MAX,
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      updatedAt: true,
      lastActiveAt: true,
      terminalId: true,
    },
  });
  // Shared terminals of PIN sessions (WMS-38), read in this company only.
  const terminalIds = [
    ...new Set(rows.flatMap((row) => (row.terminalId ? [row.terminalId] : []))),
  ];
  const terminals = terminalIds.length
    ? await forOrganization(organizationId).sharedTerminal.findMany({
        where: { id: { in: terminalIds } },
        select: { id: true, name: true },
      })
    : [];
  const terminalNames = new Map(terminals.map((t) => [t.id, t.name]));
  const sessions = rows
    .map((row) => {
      const device = describeUserAgent(row.userAgent);
      return {
        id: row.id,
        device: device.kind,
        deviceLabel: DEVICE_KIND_LABELS[device.kind],
        label: device.label,
        ipAddress: formatIp(row.ipAddress),
        createdAt: row.createdAt,
        lastActiveAt: row.lastActiveAt ?? row.updatedAt,
        current: row.id === currentSessionId,
        terminalName: row.terminalId
          ? (terminalNames.get(row.terminalId) ?? null)
          : null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.lastActiveAt.getTime() - a.lastActiveAt.getTime(),
    );

  const actor = {
    ...(await loadSubject(organizationId, actorUserId)),
    userId: actorUserId,
  };
  const rule = checkTeamChange(actor, target, { kind: "revoke_sessions" });
  return {
    sessions,
    canRevoke: rule.ok,
    revokeBlocked: rule.ok ? null : (BLOCKED[rule.reason] ?? null),
  };
}

/**
 * Tells the person, inside the app, that their sessions were closed: they
 * read it when they come back. `notify` names the company in each of its
 * filters, so the plain client of this transaction (which may touch
 * `session`, a person's row the scoped client refuses) reads only this
 * company; no location is passed, the only lookup that needs the scoped
 * client.
 */
async function tellPerson(
  tx: Tx,
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  text: string,
  key: string,
) {
  const actor = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { name: true },
  });
  await notify(tx as unknown as NotifyTx, SESSIONS_CLOSED_NOTICE, {
    organizationId,
    actorUserId,
    to: { userIds: [targetUserId] },
    text: `${actor?.name.trim() || "Alguien"} ${text}`,
    href: "/configuracion",
    key,
  });
}

function cleanReason(
  value: string | undefined,
): { ok: true; reason: string | undefined } | { ok: false; error: string } {
  const reason = String(value ?? "").trim();
  if (reason.length > SESSION_REVOKE_REASON_MAX) {
    return {
      ok: false,
      error: `El motivo puede tener hasta ${SESSION_REVOKE_REASON_MAX} caracteres.`,
    };
  }
  return { ok: true, reason: reason || undefined };
}

function answer(result: TeamActionResult, closed: number): SessionRevokeResult {
  if (result.ok) return { ok: true, closed };
  return {
    ok: false,
    error: BLOCKED[result.reason as TeamRuleReason] ?? result.error,
  };
}

/**
 * Closes one session of a member, only if it is open in this company. It
 * stops working on the next request of that device. Company locked and
 * people read again inside the transaction (`withTeamChange`).
 */
export async function revokeMemberSession(
  organizationId: string,
  actorUserId: string,
  input: { userId: string; sessionId: string; reason?: string },
): Promise<SessionRevokeResult> {
  const reason = cleanReason(input.reason);
  if (!reason.ok) return reason;
  let closed = 0;
  const result = await withTeamChange(
    organizationId,
    actorUserId,
    String(input.userId),
    { kind: "revoke_sessions" },
    async (tx, target) => {
      const where = {
        ...companySessions(organizationId, target.userId),
        id: String(input.sessionId),
      };
      const session = await tx.session.findFirst({
        where,
        select: { userAgent: true },
      });
      if (!session) {
        return { ok: false, reason: "not_found", error: SESSION_GONE };
      }
      const deleted = await tx.session.deleteMany({ where });
      closed = deleted.count;
      const device = describeUserAgent(session.userAgent).label;
      await tellPerson(
        tx,
        organizationId,
        actorUserId,
        target.userId,
        `cerró tu sesión en ${device}.`,
        `session:${String(input.sessionId)}:closed`,
      );
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId,
        action: "team.session_revoked",
        target: { type: "user", id: target.userId },
        reason: reason.reason,
        metadata: { device },
      });
      return undefined;
    },
  );
  return answer(result, closed);
}

/**
 * Closes every session the member has open in this company (never the
 * ones in another company) and cuts the older ones out of it: any session
 * begun before now must sign in again to enter this company. Closing none
 * is not an error; the cut and the trace are written all the same.
 */
export async function revokeAllMemberSessions(
  organizationId: string,
  actorUserId: string,
  input: { userId: string; reason?: string },
): Promise<SessionRevokeResult> {
  const reason = cleanReason(input.reason);
  if (!reason.ok) return reason;
  let closed = 0;
  const result = await withTeamChange(
    organizationId,
    actorUserId,
    String(input.userId),
    { kind: "revoke_sessions" },
    async (tx, target) => {
      // The cut: a session of this person that began before now never
      // enters this company again, not even one that today works for
      // another company and would switch here (ADR 0059).
      const now = new Date();
      await tx.membership.update({
        where: { id: target.membershipId },
        data: { sessionsRevokedAt: now },
      });
      const deleted = await tx.session.deleteMany({
        where: companySessions(organizationId, target.userId),
      });
      closed = deleted.count;
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId,
        action: "team.sessions_revoked",
        target: { type: "user", id: target.userId },
        reason: reason.reason,
        metadata: { sessions: closed },
      });
      await tellPerson(
        tx,
        organizationId,
        actorUserId,
        target.userId,
        "cerró todas tus sesiones en la empresa. Para volver a entrar, inicia sesión otra vez.",
        `sessions:${target.membershipId}:${now.toISOString()}`,
      );
      return undefined;
    },
  );
  return answer(result, closed);
}
