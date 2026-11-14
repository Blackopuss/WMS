import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { db, forOrganization } from "@/server";

import { isRole, type Role } from "./catalog";
import { buildScope, can, inScope, knownRoles } from "./policy";
import { resolveScopeRows } from "./scope-rows";
import { SeatLimitError, assertSeatAvailable } from "./seats";
import {
  TEAM_RULE_MESSAGES,
  checkTeamChange,
  type TeamChange,
  type TeamPerson,
  type TeamRuleReason,
} from "./team-rules";

/**
 * Team changes (USR-06, USR-07). Every change locks the company row and
 * reads both people again inside the transaction, so a decision is never
 * taken on stale roles (e.g. while the ownership is being transferred).
 * A person holds one membership per company whatever their roles: several
 * roles join their permissions and take one seat.
 */

export type TeamActionReason =
  | TeamRuleReason
  | "not_found"
  | "unchanged"
  | "no_seats"
  | "invalid_scope"
  | "scope_exceeds";

export type TeamActionResult =
  { ok: true } | { ok: false; reason: TeamActionReason; error: string };

const MESSAGES: Record<TeamActionReason, string> = {
  ...TEAM_RULE_MESSAGES,
  not_found: "Esta persona no está en tu equipo.",
  unchanged: "No hay cambios que guardar.",
  no_seats: "Tu plan no tiene lugares disponibles.",
  invalid_scope:
    "Elige almacenes y zonas que existan y estén activos. Si un almacén ya no aparece, vuelve a abrir esta ventana.",
  scope_exceeds:
    "Solo puedes dar acceso a los almacenes o zonas que tú tienes asignados.",
};

export const fail = (reason: TeamActionReason) =>
  ({ ok: false, reason, error: MESSAGES[reason] }) as const;

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export type LoadedMember = TeamPerson & {
  membershipId: string;
  status: "ACTIVE" | "DISABLED";
};

async function memberIn(
  tx: Tx,
  organizationId: string,
  ownerUserId: string,
  userId: string,
): Promise<LoadedMember | null> {
  const membership = await tx.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { id: true, status: true, roles: { select: { role: true } } },
  });
  if (!membership) return null;
  return {
    userId,
    membershipId: membership.id,
    status: membership.status,
    isOwner: ownerUserId === userId,
    roles: membership.roles.map((r) => r.role),
  };
}

/**
 * Runs `change` on `targetUserId` if the rules allow `actorUserId` to do it.
 * The actor must be an active member; the target must belong to the company.
 * Used only inside this area (team sessions, WMS-40); not in index.ts.
 */
export async function withTeamChange(
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  change: TeamChange,
  apply: (
    tx: Tx,
    target: LoadedMember & { actorIsOwner: boolean },
  ) => Promise<TeamActionResult | undefined>,
): Promise<TeamActionResult> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { ownerUserId: string }[]
    >`SELECT ownerUserId FROM organization WHERE id = ${organizationId} FOR UPDATE`;
    const owner = rows[0]?.ownerUserId;
    if (!owner) return fail("forbidden");
    const actor = await memberIn(tx, organizationId, owner, actorUserId);
    if (!actor || actor.status !== "ACTIVE") return fail("forbidden");
    const target = await memberIn(
      tx,
      organizationId,
      owner,
      String(targetUserId),
    );
    // Asked before looking at the target, so people without the permission
    // learn nothing about who is in the company.
    const rule = checkTeamChange(
      actor,
      target ?? { userId: String(targetUserId), isOwner: false, roles: [] },
      change,
    );
    if (!rule.ok && rule.reason === "forbidden") return fail("forbidden");
    if (!target) return fail("not_found");
    if (!rule.ok) return fail(rule.reason);
    return (
      (await apply(tx, { ...target, actorIsOwner: actor.isOwner === true })) ??
      ({ ok: true } as const)
    );
  });
}

/** Replaces the roles of a member (USR-06). Several roles join their permissions. */
export async function assignRoles(
  organizationId: string,
  actorUserId: string,
  input: { userId: string; roles: readonly string[] },
): Promise<TeamActionResult> {
  return withTeamChange(
    organizationId,
    actorUserId,
    input.userId,
    { kind: "assign_roles", roles: input.roles },
    async (tx, target) => {
      const next = knownRoles(input.roles);
      const previous = knownRoles(target.roles);
      if (next.join() === previous.join()) return fail("unchanged");
      await tx.membershipRole.deleteMany({
        where: { organizationId, membershipId: target.membershipId },
      });
      await tx.membershipRole.createMany({
        data: next.map((role) => ({
          id: newId(),
          organizationId,
          membershipId: target.membershipId,
          role,
        })),
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId,
        action: "team.roles_changed",
        target: { type: "user", id: target.userId },
        metadata: { from: previous, to: next },
      });
      return undefined;
    },
  );
}

/**
 * Disables a member (USR-07): they lose access at once and every session
 * of theirs in this company is closed (WMS-40: not their sessions in other
 * companies, which can no longer enter this one). The membership and the
 * account stay, so whatever they did keeps their name in the history.
 */
export async function disableMember(
  organizationId: string,
  actorUserId: string,
  input: { userId: string; reason?: string },
): Promise<TeamActionResult> {
  return withTeamChange(
    organizationId,
    actorUserId,
    input.userId,
    { kind: "disable" },
    async (tx, target) => {
      if (target.status === "DISABLED") return fail("unchanged");
      // Their sessions older than now never enter this company again, even
      // after a reactivation (WMS-40): signing in again is needed.
      const now = new Date();
      await tx.membership.update({
        where: { id: target.membershipId },
        data: { status: "DISABLED", sessionsRevokedAt: now },
      });
      // An offer to hand them the company dies with their access.
      await tx.ownershipTransfer.updateMany({
        where: {
          organizationId,
          toMembershipId: target.membershipId,
          status: "PENDING",
        },
        data: { status: "CANCELLED", resolvedAt: new Date() },
      });
      // Only the sessions working in this company (WMS-40, ADR 0059): the
      // person may keep working for another one, and the cut above keeps
      // those sessions out of this company.
      const closed = await tx.session.deleteMany({
        where: { userId: target.userId, activeOrganizationId: organizationId },
      });
      // Their PIN for shared terminals goes with their access (WMS-38): if
      // they come back, they set a new one.
      await tx.memberPin.deleteMany({
        where: { organizationId, userId: target.userId },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId,
        action: "team.member_disabled",
        target: { type: "user", id: target.userId },
        reason: input.reason,
        metadata: {
          roles: knownRoles(target.roles),
          sessionsClosed: closed.count,
        },
      });
      return undefined;
    },
  );
}

/** Gives a disabled member their access back, with the roles they had. */
export async function reactivateMember(
  organizationId: string,
  actorUserId: string,
  input: { userId: string },
): Promise<TeamActionResult> {
  return withTeamChange(
    organizationId,
    actorUserId,
    input.userId,
    { kind: "disable" },
    async (tx, target) => {
      if (target.status === "ACTIVE") return fail("unchanged");
      // Coming back takes a seat of the plan again (MOD-08).
      try {
        await assertSeatAvailable(tx, organizationId);
      } catch (error) {
        if (error instanceof SeatLimitError) {
          return { ok: false, reason: "no_seats", error: error.message };
        }
        throw error;
      }
      await tx.membership.update({
        where: { id: target.membershipId },
        data: { status: "ACTIVE" },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId,
        action: "team.member_reactivated",
        target: { type: "user", id: target.userId },
        metadata: { roles: knownRoles(target.roles) },
      });
      return undefined;
    },
  );
}

/** What the form sends: no warehouses = every warehouse. */
export type MemberScopeInput = {
  userId: string;
  facilities: readonly {
    facilityId: string;
    /** Locations directly in the warehouse; none = the whole warehouse. */
    zoneIds?: readonly string[];
  }[];
};

const scopeKey = (
  rows: readonly { facilityId: string; locationId: string | null }[],
) =>
  rows
    .map((row) => `${row.facilityId} ${row.locationId ?? ""}`)
    .sort()
    .join("|");

/**
 * Limits a member to certain warehouses and, inside them, to certain zones
 * (WMS-20, ADR 0038); without warehouses the limit is removed. The rows
 * are replaced whole, under the lock of the company, and the change goes
 * to the audit trail. Someone who is limited can only hand out what they
 * have. The titular is never limited (team rules).
 */
export async function setMemberScope(
  organizationId: string,
  actorUserId: string,
  input: MemberScopeInput,
): Promise<TeamActionResult> {
  return withTeamChange(
    organizationId,
    actorUserId,
    input.userId,
    { kind: "set_scope" },
    async (tx, target) => {
      const resolved = await resolveScopeRows(
        tx,
        organizationId,
        { userId: actorUserId, isOwner: target.actorIsOwner === true },
        input.facilities,
      );
      if (!resolved.ok) return fail(resolved.reason);
      const { rows, facilityName, zoneName } = resolved;

      const previous = await tx.membershipScope.findMany({
        where: { organizationId, membershipId: target.membershipId },
        select: {
          facilityId: true,
          locationId: true,
          facility: { select: { name: true } },
          location: { select: { name: true } },
        },
      });
      if (scopeKey(previous) === scopeKey(rows)) return fail("unchanged");

      await tx.membershipScope.deleteMany({
        where: { organizationId, membershipId: target.membershipId },
      });
      if (rows.length > 0) {
        await tx.membershipScope.createMany({
          data: rows.map((row) => ({
            id: newId(),
            organizationId,
            membershipId: target.membershipId,
            facilityId: row.facilityId,
            locationId: row.locationId,
          })),
        });
      }
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId,
        action: "team.scope_changed",
        target: { type: "user", id: target.userId },
        metadata: {
          changes: {
            "Dónde trabaja": {
              antes: describeScope(
                previous.map((row) => ({
                  facility: row.facility.name,
                  zone: row.location?.name ?? null,
                })),
              ),
              ahora: describeScope(
                rows.map((row) => ({
                  facility: facilityName.get(row.facilityId) ?? "",
                  zone: row.locationId
                    ? (zoneName.get(row.locationId) ?? "")
                    : null,
                })),
              ),
            },
          },
        },
      });
      return undefined;
    },
  );
}

/** «Norte; Sur (Zona A, Zona B)», or «Todos los almacenes» without rows. */
function describeScope(
  rows: readonly { facility: string; zone: string | null }[],
): string {
  if (rows.length === 0) return "Todos los almacenes";
  const byFacility = new Map<string, string[] | null>();
  for (const row of rows) {
    if (row.zone === null) byFacility.set(row.facility, null);
    else if (!byFacility.has(row.facility)) {
      byFacility.set(row.facility, [row.zone]);
    } else byFacility.get(row.facility)?.push(row.zone);
  }
  return [...byFacility]
    .sort(([a], [b]) => a.localeCompare(b, "es"))
    .map(([facility, zones]) =>
      zones ? `${facility} (${zones.sort().join(", ")})` : facility,
    )
    .join("; ");
}

/** A warehouse a member is limited to, for the team screen. */
export type MemberScopeEntry = {
  facilityId: string;
  facilityName: string;
  /** Null = the whole warehouse. */
  zones: { id: string; name: string }[] | null;
};

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  status: "ACTIVE" | "DISABLED";
  isOwner: boolean;
  roles: Role[];
  /** Where they may work (WMS-20); empty = every warehouse. */
  limitedTo: MemberScopeEntry[];
  joinedAt: Date;
};

/** Everyone in the company: titular first, then by name (USR-08). */
export async function listTeamMembers(
  organizationId: string,
): Promise<TeamMember[]> {
  const [organization, memberships] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: { ownerUserId: true },
    }),
    forOrganization(organizationId).membership.findMany({
      select: {
        userId: true,
        status: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
        roles: { select: { role: true } },
        scopes: {
          select: {
            facilityId: true,
            facility: { select: { name: true } },
            location: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);
  return memberships
    .map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      status: m.status,
      isOwner: organization?.ownerUserId === m.userId,
      roles: knownRoles(m.roles.map((r) => r.role).filter(isRole)),
      limitedTo:
        organization?.ownerUserId === m.userId ? [] : scopeEntries(m.scopes),
      joinedAt: m.createdAt,
    }))
    .sort(
      (a, b) =>
        Number(b.isOwner) - Number(a.isOwner) ||
        a.name.localeCompare(b.name, "es"),
    );
}

function scopeEntries(
  rows: readonly {
    facilityId: string;
    facility: { name: string };
    location: { id: string; name: string } | null;
  }[],
): MemberScopeEntry[] {
  const entries = new Map<string, MemberScopeEntry>();
  for (const row of rows) {
    const entry = entries.get(row.facilityId) ?? {
      facilityId: row.facilityId,
      facilityName: row.facility.name,
      zones: [],
    };
    // A row for the whole warehouse wins over its zones.
    if (row.location === null) entry.zones = null;
    else entry.zones?.push(row.location);
    entries.set(row.facilityId, entry);
  }
  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      zones:
        entry.zones?.sort((a, b) => a.name.localeCompare(b.name, "es")) ?? null,
    }))
    .sort((a, b) => a.facilityName.localeCompare(b.facilityName, "es"));
}

/** A warehouse and the zones that can be chosen in it, for the team screen. */
export type ScopeOption = {
  id: string;
  name: string;
  /** Active locations directly in the warehouse. */
  zones: { id: string; name: string }[];
  /** False when who asks holds only some zones of it. */
  wholeAllowed: boolean;
};

/**
 * The warehouses and zones this person may hand out when limiting someone
 * (WMS-20): all of the company, or only their own when they are limited.
 * Nothing for who cannot change the team.
 */
export async function listScopeOptions(
  organizationId: string,
  actorUserId: string,
): Promise<{ options: ScopeOption[]; actorLimited: boolean }> {
  const client = forOrganization(organizationId);
  const [organization, membership] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: { ownerUserId: true },
    }),
    client.membership.findFirst({
      where: { userId: actorUserId, status: "ACTIVE" },
      select: {
        roles: { select: { role: true } },
        scopes: { select: { facilityId: true, locationId: true } },
      },
    }),
  ]);
  if (!membership) return { options: [], actorLimited: false };
  const isOwner = organization?.ownerUserId === actorUserId;
  const actor = {
    isOwner,
    roles: membership.roles.map((r) => r.role),
    scope: isOwner ? null : buildScope(membership.scopes),
  };
  if (!can(actor, "platform.team.assign_roles")) {
    return { options: [], actorLimited: false };
  }
  const facilities = await client.facility.findMany({
    where: { archivedAt: null },
    take: 500,
    select: {
      id: true,
      name: true,
      isDefault: true,
      locations: {
        where: { parentId: null, archivedAt: null, isTransit: null },
        take: 500,
        select: { id: true, name: true, isDefault: true },
      },
    },
  });
  const options = facilities
    .filter((facility) => inScope(actor, { facilityId: facility.id }))
    .sort(
      (a, b) =>
        Number(b.isDefault === true) - Number(a.isDefault === true) ||
        a.name.localeCompare(b.name, "es"),
    )
    .map((facility) => ({
      id: facility.id,
      name: facility.name,
      zones: facility.locations
        .filter((zone) =>
          inScope(actor, { facilityId: facility.id, path: [zone.id] }),
        )
        .sort(
          (a, b) =>
            Number(b.isDefault === true) - Number(a.isDefault === true) ||
            a.name.localeCompare(b.name, "es", { numeric: true }),
        )
        .map((zone) => ({ id: zone.id, name: zone.name })),
      // With only some zones of their own, they cannot hand out the whole.
      wholeAllowed:
        actor.scope === null ||
        actor.isOwner ||
        actor.scope.facilities.get(facility.id) === null,
    }));
  return { options, actorLimited: actor.scope !== null && !isOwner };
}

/**
 * Seats in use: one per active member, whatever their roles. Pending
 * invitations are added by the plan quota (MOD-08).
 */
export async function countSeatsInUse(organizationId: string): Promise<number> {
  return forOrganization(organizationId).membership.count({
    where: { status: "ACTIVE" },
  });
}
