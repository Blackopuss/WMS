import "server-only";

import { cache } from "react";

import { ForbiddenError } from "@/lib";
import { terminalUserOfRequest } from "@/platform/auth";
import {
  requireOrganizationContext,
  supportWindowFor,
  type OrganizationContext,
} from "@/platform/tenancy";
import { db, delegationOf, forOrganization } from "@/server";

import type { Permission, Role } from "./catalog";
import {
  buildScope,
  can,
  type SubjectLimit,
  isOwnerOnly,
  knownRoles,
  permissionsOf,
  type Subject,
} from "./policy";

/**
 * Authorization against the database (USR-02). The subject is read on every
 * request from the active membership and the company's titular; nothing
 * comes from the browser. No active membership → no permissions, even for
 * the titular.
 */

export const FORBIDDEN_MESSAGE = "No tienes permiso para hacer esto.";
export const OWNER_ONLY_MESSAGE =
  "Solo el titular de la empresa puede hacer esto.";

const NOBODY: Subject = { isOwner: false, roles: [] };
const SUPPORT: Subject = { isOwner: false, roles: ["viewer"], support: true };

/** Titular flag and roles of the person in that company. */
export async function loadSubject(
  organizationId: string,
  userId: string,
): Promise<Subject> {
  // WMS-60: inside a call of an API key, its creator is cut down to the key.
  const delegated = delegationOf(organizationId, userId);
  if (delegated.kind === "foreign") return NOBODY;
  const subject = await loadMemberSubject(organizationId, userId);
  if (delegated.kind === "none") return subject;
  // A key never acts as platform support: without membership, nothing.
  if (subject.support === true) return NOBODY;
  return { ...subject, limit: limitOf(delegated.delegation) };
}

/** The cut of an API key (WMS-60): its permissions and, if limited, its warehouse. */
export function limitOf(delegation: {
  permissions: readonly string[];
  facilityId: string;
  facilityOnly: boolean;
}): SubjectLimit {
  return {
    permissions: new Set(delegation.permissions),
    scope: delegation.facilityOnly
      ? { facilities: new Map([[delegation.facilityId, null]]) }
      : null,
  };
}

async function loadMemberSubject(
  organizationId: string,
  userId: string,
): Promise<Subject> {
  const membership = await forOrganization(organizationId).membership.findFirst(
    {
      where: { userId, status: "ACTIVE" },
      select: {
        roles: { select: { role: true } },
        scopes: { select: { facilityId: true, locationId: true } },
      },
    },
  );
  if (!membership) {
    // Support with the titular's leave reads like Consulta, nothing more
    // (PIL-12): no writing, no exports, no costs, no titular powers.
    return (await supportWindowFor(organizationId, userId)) ? SUPPORT : NOBODY;
  }
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { ownerUserId: true },
  });
  const isOwner = organization?.ownerUserId === userId;
  // Where the person may work (WMS-20); the titular is never limited, and
  // without a limit the subject carries no scope at all.
  const scope = isOwner ? null : buildScope(membership.scopes);
  // A PIN session of a shared terminal (WMS-38): the person of this request
  // is cut down by the policy, in every check of the request.
  const terminal = (await terminalUserOfRequest()) === userId;
  return {
    isOwner,
    roles: membership.roles.map((r) => r.role),
    ...(scope ? { scope } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

/** Decision for one person, company and permission. */
export async function isAllowed(
  organizationId: string,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  return can(await loadSubject(organizationId, userId), permission);
}

/** Throws ForbiddenError unless the person holds the permission. */
export async function assertAllowed(
  organizationId: string,
  userId: string,
  permission: Permission,
): Promise<void> {
  if (!(await isAllowed(organizationId, userId, permission))) {
    throw new ForbiddenError("permission_denied", FORBIDDEN_MESSAGE, {
      permission,
    });
  }
}

export type Access = OrganizationContext & {
  roles: Role[];
  permissions: ReadonlySet<Permission>;
  can: (permission: Permission) => boolean;
};

/** Session, active company and permissions of the request. Cached per request. */
export const getAccess = cache(async (): Promise<Access> => {
  const context = await requireOrganizationContext();
  const subject = await loadSubject(context.organization.id, context.user.id);
  const permissions = permissionsOf(subject);
  return {
    ...context,
    roles: knownRoles(subject.roles),
    permissions,
    can: (permission) => permissions.has(permission),
  };
});

/**
 * Guard for business screens and Server Actions: session + active company +
 * permission. Throws ForbiddenError when the permission is missing.
 */
export async function requirePermission(
  permission: Permission,
): Promise<Access> {
  const access = await getAccess();
  if (!access.can(permission)) {
    throw new ForbiddenError("permission_denied", FORBIDDEN_MESSAGE, {
      permission,
    });
  }
  return access;
}

/**
 * Guard for actions reserved to the titular (USR-03A): contracting,
 * cancelling, payment method, transfer. Checks the titular in the database
 * (not a role, not the session) and that the permission is a reserved one,
 * so it cannot be used by mistake for something a role could do.
 */
export async function assertOwnerAction(
  organizationId: string,
  userId: string,
  permission: Permission,
): Promise<void> {
  if (!isOwnerOnly(permission)) {
    throw new Error(`"${permission}" is not reserved to the titular`);
  }
  const subject = await loadSubject(organizationId, userId);
  if (subject.isOwner !== true || !can(subject, permission)) {
    throw new ForbiddenError("owner_only", OWNER_ONLY_MESSAGE, { permission });
  }
}

/** Same as assertOwnerAction for the current request. */
export async function requireOwnerAction(
  permission: Permission,
): Promise<Access> {
  const access = await getAccess();
  await assertOwnerAction(access.organization.id, access.user.id, permission);
  return access;
}
