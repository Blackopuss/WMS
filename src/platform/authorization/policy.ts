/**
 * Central authorization decision (USR-02). Pure: no database, no session.
 * Deny by default: a permission is granted only if the titular list or one
 * of the person's roles names it. Unknown roles and unknown permissions
 * grant nothing.
 */
import {
  OWNER_PERMISSIONS,
  ROLE_PERMISSIONS,
  isPermission,
  isRole,
  type Permission,
  type Role,
} from "./catalog";

/** Who is asking, inside one company. */
export type Subject = {
  /** The person is the company's titular (Organization.ownerUserId). */
  isOwner: boolean;
  /** Roles of their active membership. Values outside the catalog are ignored. */
  roles: readonly string[];
  /**
   * Platform support with the titular's leave (PIL-12): of its roles it
   * keeps only what reads, never what writes or takes data out (exports).
   */
  support?: boolean;
  /**
   * Where the person may work (WMS-20). Absent or null = every warehouse.
   * It never limits the titular.
   */
  scope?: Scope | null;
};

/**
 * Warehouses a person is limited to (WMS-20, ADR 0038). For each one,
 * `null` opens the whole warehouse and a set opens only those locations
 * and what they hold (zones). A warehouse that is not here is closed.
 */
export type Scope = {
  facilities: ReadonlyMap<string, ReadonlySet<string> | null>;
};

/**
 * A place to decide about: its warehouse and, for a location, the ids of
 * the location and of every location that contains it. Without `path` the
 * question is about the warehouse itself.
 */
export type Place = { facilityId: string; path?: readonly string[] };

/** Builds a scope from its stored rows; no rows = no limit (null). */
export function buildScope(
  rows: readonly { facilityId: string; locationId: string | null }[],
): Scope | null {
  if (rows.length === 0) return null;
  const facilities = new Map<string, Set<string> | null>();
  for (const row of rows) {
    if (row.locationId === null) {
      facilities.set(row.facilityId, null);
    } else if (!facilities.has(row.facilityId)) {
      facilities.set(row.facilityId, new Set([row.locationId]));
    } else {
      // A row for the whole warehouse wins over its zones.
      facilities.get(row.facilityId)?.add(row.locationId);
    }
  }
  return { facilities };
}

/** The scope that limits the subject, or null when nothing does. */
export function scopeOf(subject: Subject): Scope | null {
  if (subject.isOwner === true) return null;
  return subject.scope ?? null;
}

/**
 * True when the place is inside the subject's scope. A warehouse counts as
 * inside when the person may work in any part of it; a location, when its
 * warehouse is open or one of its ancestors (or itself) is an open zone.
 */
export function inScope(subject: Subject, place: Place): boolean {
  const scope = scopeOf(subject);
  if (!scope) return true;
  if (!scope.facilities.has(place.facilityId)) return false;
  const zones = scope.facilities.get(place.facilityId);
  if (!zones) return true;
  if (!place.path) return zones.size > 0;
  return place.path.some((id) => zones.has(id));
}

/** Known roles of the subject, without repeats, in catalog order. */
export function knownRoles(roles: readonly string[]): Role[] {
  return [...new Set(roles.filter(isRole))].sort();
}

/** Every permission of the subject: roles combine by union (USR-06). */
export function permissionsOf(subject: Subject): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  if (subject.isOwner === true) {
    for (const permission of OWNER_PERMISSIONS) granted.add(permission);
  }
  for (const role of knownRoles(subject.roles)) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  if (subject.support === true) {
    return new Set([...granted].filter((p) => p.endsWith(".read")));
  }
  return granted;
}

/**
 * True only when the subject holds the permission and, when the decision
 * is about a place, that place is inside their scope (WMS-20).
 */
export function can(
  subject: Subject,
  permission: Permission,
  place?: Place,
): boolean {
  if (!isPermission(permission)) return false;
  if (!permissionsOf(subject).has(permission)) return false;
  return place === undefined || inScope(subject, place);
}

/** True when the subject holds every permission of the list (and it is not empty). */
export function canAll(
  subject: Subject,
  permissions: readonly Permission[],
): boolean {
  if (permissions.length === 0) return false;
  const granted = permissionsOf(subject);
  return permissions.every((p) => isPermission(p) && granted.has(p));
}

/** True when the subject holds at least one permission of the list. */
export function canAny(
  subject: Subject,
  permissions: readonly Permission[],
): boolean {
  const granted = permissionsOf(subject);
  return permissions.some((p) => isPermission(p) && granted.has(p));
}

/**
 * Actions reserved to the titular (USR-03A): what the titular can do and no
 * role grants, alone or combined. Contracting, cancelling and the payment
 * method are here; a test fails if a role ever receives one of them.
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] =
  OWNER_PERMISSIONS.filter((permission) =>
    Object.values(ROLE_PERMISSIONS).every((list) => !list.includes(permission)),
  );

export function isOwnerOnly(permission: Permission): boolean {
  return OWNER_ONLY_PERMISSIONS.includes(permission);
}
