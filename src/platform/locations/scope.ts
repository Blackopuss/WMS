import "server-only";

import { ForbiddenError } from "@/lib";
import { inScope, loadScope, type Scope } from "@/platform/authorization";
import type { TenantDb } from "@/server";

/**
 * Scope by warehouse and zone applied to locations (WMS-20, ADR 0038). The
 * decision is `inScope` of the authorization policy; here a location id is
 * turned into the place the policy decides about (its warehouse and its
 * ancestors), always read from the database: an id that comes from the
 * browser is never trusted.
 *
 * Every service that reads or moves stock of a location calls
 * `assertLocationsInScope` with the ids it works on, and every list of
 * locations or of what happens in them adds `locationScopeWhere`.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
export type LocationScopeReader = Pick<Tx, "membership" | "location">;

export const OUT_OF_SCOPE_MESSAGE =
  "Esa ubicación está fuera de los almacenes o zonas que tienes asignados.";
export const FACILITY_OUT_OF_SCOPE_MESSAGE =
  "Ese almacén no está entre los que tienes asignados.";

// Ids of a location's ancestors, as deep as a warehouse can be.
const A1 = { select: { id: true } } as const;
const A2 = { select: { id: true, parent: A1 } } as const;
const A3 = { select: { id: true, parent: A2 } } as const;
const A4 = { select: { id: true, parent: A3 } } as const;
const A5 = { select: { id: true, parent: A4 } } as const;
const A6 = { select: { id: true, parent: A5 } } as const;
const A7 = { select: { id: true, parent: A6 } } as const;
const ANCESTORS = { select: { id: true, parent: A7 } } as const;

type WithAncestors = { id: string; parent?: WithAncestors | null };

function pathIds(location: WithAncestors): string[] {
  const ids: string[] = [];
  let node: WithAncestors | null | undefined = location;
  for (let step = 0; node && step < 16; step++) {
    ids.push(node.id);
    node = node.parent;
  }
  return ids;
}

const limitedSubject = (scope: Scope) => ({
  isOwner: false,
  roles: [],
  scope,
});

/** True when the person may work somewhere in that warehouse. */
export function facilityInScope(
  scope: Scope | null,
  facilityId: string,
): boolean {
  return scope === null || inScope(limitedSubject(scope), { facilityId });
}

/**
 * The ids, among the given ones, of locations outside the person's scope.
 * Ids that are not locations of the company are not reported: each service
 * already answers for what does not exist.
 */
export async function locationsOutOfScope(
  client: LocationScopeReader,
  userId: string,
  locationIds: readonly (string | null | undefined)[],
): Promise<string[]> {
  const ids = [
    ...new Set(
      locationIds.filter(
        (id): id is string => typeof id === "string" && id !== "",
      ),
    ),
  ];
  if (ids.length === 0) return [];
  const scope = await loadScope(client, userId);
  if (scope === null) return [];
  const rows = await client.location.findMany({
    where: { id: { in: ids } },
    select: { id: true, facilityId: true, parent: ANCESTORS },
  });
  const subject = limitedSubject(scope);
  return rows
    .filter(
      (row) =>
        !inScope(subject, { facilityId: row.facilityId, path: pathIds(row) }),
    )
    .map((row) => row.id);
}

/**
 * Throws ForbiddenError when one of the locations is outside the person's
 * scope. Call it with the client of the transaction, before reading stock
 * or writing anything about those locations.
 */
export async function assertLocationsInScope(
  client: LocationScopeReader,
  userId: string,
  locationIds: readonly (string | null | undefined)[],
): Promise<void> {
  const outside = await locationsOutOfScope(client, userId, locationIds);
  if (outside.length > 0) {
    throw new ForbiddenError("location_out_of_scope", OUT_OF_SCOPE_MESSAGE, {
      locationIds: outside,
    });
  }
}

/** True when the person may work somewhere in that warehouse. */
export async function isFacilityInScope(
  client: LocationScopeReader,
  userId: string,
  facilityId: string,
): Promise<boolean> {
  return facilityInScope(await loadScope(client, userId), facilityId);
}

/** Throws ForbiddenError when the person may not work in that warehouse. */
export async function assertFacilityInScope(
  client: LocationScopeReader,
  userId: string,
  facilityId: string,
): Promise<void> {
  if (!(await isFacilityInScope(client, userId, facilityId))) {
    throw new ForbiddenError(
      "facility_out_of_scope",
      FACILITY_OUT_OF_SCOPE_MESSAGE,
      { facilityId },
    );
  }
}

/**
 * Throws ForbiddenError unless the whole warehouse is open to the person:
 * for what belongs to the warehouse and not to one location (its levels, a
 * new location directly in it).
 */
export async function assertWholeFacilityInScope(
  client: LocationScopeReader,
  userId: string,
  facilityId: string,
): Promise<void> {
  const scope = await loadScope(client, userId);
  if (scope !== null && scope.facilities.get(facilityId) !== null) {
    throw new ForbiddenError(
      "facility_out_of_scope",
      FACILITY_OUT_OF_SCOPE_MESSAGE,
      { facilityId },
    );
  }
}

/** A filter on `location` rows; an empty object when nothing limits. */
export type LocationScopeWhere =
  | Record<string, never>
  | { OR: ({ facilityId: { in: string[] } } | { id: { in: string[] } })[] };

/**
 * The filter that keeps only locations inside the person's scope, for a
 * Prisma `where` on `location` (or on a relation to it). Without a limit
 * it is `{}`. Zones are resolved to the ids of everything they hold.
 */
export async function locationScopeWhere(
  client: LocationScopeReader,
  userId: string,
): Promise<LocationScopeWhere> {
  const scope = await loadScope(client, userId);
  if (scope === null) return {};
  const whole: string[] = [];
  const zoned: string[] = [];
  for (const [facilityId, zones] of scope.facilities) {
    if (zones === null) whole.push(facilityId);
    else zoned.push(facilityId);
  }
  const inside: string[] = [];
  if (zoned.length > 0) {
    const rows = await client.location.findMany({
      where: { facilityId: { in: zoned } },
      select: { id: true, facilityId: true, parentId: true },
    });
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const list = children.get(row.parentId) ?? [];
      list.push(row.id);
      children.set(row.parentId, list);
    }
    const known = new Map(rows.map((row) => [row.id, row.facilityId]));
    const seen = new Set<string>();
    for (const facilityId of zoned) {
      // A zone counts only inside the warehouse its row names.
      const pending = [...(scope.facilities.get(facilityId) ?? [])].filter(
        (id) => known.get(id) === facilityId,
      );
      while (pending.length > 0) {
        const id = pending.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        inside.push(id);
        pending.push(...(children.get(id) ?? []));
      }
    }
  }
  return { OR: [{ facilityId: { in: whole } }, { id: { in: inside } }] };
}

/** True when a scope filter limits something. */
export const isLimited = (where: LocationScopeWhere): boolean => "OR" in where;
