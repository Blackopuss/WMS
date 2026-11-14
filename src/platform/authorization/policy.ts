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
   * A PIN session of a shared terminal (WMS-38, ADR 0061 §8): of its
   * platform permissions it keeps only TERMINAL_PLATFORM_KEEP — no team,
   * sessions, audit, plan, configuration, terminals or support — and it
   * never exports in bulk nor reads costs (`keptAtTerminal`).
   */
  terminal?: boolean;
  /**
   * Where the person may work (WMS-20). Absent or null = every warehouse.
   * It never limits the titular.
   */
  scope?: Scope | null;
  /**
   * WMS-60 (ADR 0058): an API key acts for the person who created it, cut
   * down to what the key allows. Its permissions are intersected with the
   * person's and its scope with the person's (the titular's scope never
   * limits them, the scope of their key does).
   */
  limit?: SubjectLimit;
};

/** What an API key leaves of its creator's power (WMS-60). */
export type SubjectLimit = {
  permissions: ReadonlySet<string>;
  /** Null: the key adds no limit of place. */
  scope: Scope | null;
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
  const own = subject.isOwner === true ? null : (subject.scope ?? null);
  return intersectScopes(own, subject.limit?.scope ?? null);
}

/**
 * The places both scopes open (WMS-60): a warehouse open in both, with
 * the zones of the one that has zones (both: the zones of one that are
 * inside, or contain, the other's are not known here, so only the zones
 * named by both stay). Null on either side means no limit from it.
 */
export function intersectScopes(
  a: Scope | null,
  b: Scope | null,
): Scope | null {
  if (a === null) return b;
  if (b === null) return a;
  const facilities = new Map<string, ReadonlySet<string> | null>();
  for (const [facilityId, zonesA] of a.facilities) {
    if (!b.facilities.has(facilityId)) continue;
    const zonesB = b.facilities.get(facilityId) ?? null;
    if (zonesA === null) facilities.set(facilityId, zonesB);
    else if (zonesB === null) facilities.set(facilityId, zonesA);
    else {
      facilities.set(
        facilityId,
        new Set([...zonesA].filter((zone) => zonesB.has(zone))),
      );
    }
  }
  return { facilities };
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

/**
 * Platform permissions a PIN session keeps (WMS-38): what screens of the
 * floor read to know the company and its modules. Every other
 * `platform.*` permission is cut, whatever the roles say.
 */
export const TERMINAL_PLATFORM_KEEP: readonly Permission[] = [
  "platform.organization.read",
  "platform.module.read",
  "platform.capacity.read",
];

/**
 * Besides the platform, a PIN session never takes data out in bulk
 * (`*.export.create` and the reports: the file would stay on the shared
 * device) nor reads costs (WMS-38). It keeps only the documents of one
 * operation that carry no costs, named here. Recording a cost (a receipt
 * updating the last cost) shows nothing and stays. Deciding approvals is
 * refused in the approval engine.
 */
export const TERMINAL_EXPORT_KEEP: readonly Permission[] = [
  "inventory.shipment.export",
  "inventory.facility_transfer.export",
];

export const TERMINAL_COST_PERMISSIONS: readonly Permission[] = [
  "inventory.cost.read",
  "purchasing.cost.read",
];

/** True when a PIN session keeps this permission of its roles. */
export function keptAtTerminal(permission: Permission): boolean {
  if (permission.startsWith("platform.")) {
    return TERMINAL_PLATFORM_KEEP.includes(permission);
  }
  if (permission.endsWith(".export") || permission.endsWith(".export.create")) {
    return TERMINAL_EXPORT_KEEP.includes(permission);
  }
  return !TERMINAL_COST_PERMISSIONS.includes(permission);
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
  const limited = subject.limit
    ? new Set([...granted].filter((p) => subject.limit?.permissions.has(p)))
    : granted;
  if (subject.support === true) {
    return new Set([...limited].filter((p) => p.endsWith(".read")));
  }
  if (subject.terminal === true) {
    // WMS-38: on top of the API key's cut (WMS-60), never instead of it.
    return new Set([...limited].filter(keptAtTerminal));
  }
  return limited;
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
