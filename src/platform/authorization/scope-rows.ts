import "server-only";

import type { db } from "@/server";

import { buildScope, inScope, type Scope } from "./policy";

/**
 * Turns what a form says about where a person may work (WMS-20, ADR 0038)
 * into the rows of a scope, checked against the database: the same rules
 * when a member is edited (`setMemberScope`) and when someone is invited
 * (`createInvitation`). Ids from the browser are never trusted.
 */

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** What a form sends: no warehouses = every warehouse. */
export type ScopeFacilitiesInput = readonly {
  facilityId: string;
  /** Locations directly in the warehouse; none = the whole warehouse. */
  zoneIds?: readonly string[];
}[];

export type ScopeRow = { facilityId: string; locationId: string | null };

export const MAX_SCOPE_ROWS = 500;

export type ResolvedScope =
  | {
      ok: true;
      /** Empty = no limit. */
      rows: ScopeRow[];
      facilityName: Map<string, string>;
      zoneName: Map<string, string>;
    }
  | { ok: false; reason: "invalid_scope" | "scope_exceeds" };

const invalid = { ok: false, reason: "invalid_scope" } as const;

/**
 * The rows of the scope asked for. Everything named must exist in the
 * company, active, and a zone must sit directly in its warehouse. Someone
 * who is limited hands out only what they have, never «everything»: with
 * `inheritWhenLimited` an empty request from them becomes their own scope
 * (an invitation); without it, it is refused (editing a member).
 */
export async function resolveScopeRows(
  tx: Tx,
  organizationId: string,
  actor: { userId: string; isOwner: boolean },
  facilitiesInput: unknown,
  options: { inheritWhenLimited?: boolean } = {},
): Promise<ResolvedScope> {
  // One entry per warehouse; an entry without zones opens it whole.
  const wanted = new Map<string, Set<string>>();
  for (const entry of Array.isArray(facilitiesInput)
    ? (facilitiesInput as ScopeFacilitiesInput).slice(0, MAX_SCOPE_ROWS)
    : []) {
    const facilityId = String(entry?.facilityId ?? "").slice(0, 36);
    if (facilityId === "") return invalid;
    const zones = wanted.get(facilityId) ?? new Set<string>();
    for (const zoneId of Array.isArray(entry.zoneIds)
      ? entry.zoneIds.slice(0, MAX_SCOPE_ROWS)
      : []) {
      const id = String(zoneId ?? "").slice(0, 36);
      if (id === "") return invalid;
      zones.add(id);
    }
    wanted.set(facilityId, zones);
  }
  let rows: ScopeRow[] = [...wanted].flatMap(([facilityId, zones]) =>
    zones.size === 0
      ? [{ facilityId, locationId: null as string | null }]
      : [...zones].map((locationId) => ({ facilityId, locationId })),
  );
  if (rows.length > MAX_SCOPE_ROWS) return invalid;

  const actorRows = actor.isOwner
    ? []
    : await tx.membershipScope.findMany({
        where: { organizationId, membership: { userId: actor.userId } },
        select: { facilityId: true, locationId: true },
      });
  const actorScope: Scope | null = actor.isOwner ? null : buildScope(actorRows);
  if (rows.length === 0 && actorScope !== null) {
    if (!options.inheritWhenLimited) {
      return { ok: false, reason: "scope_exceeds" };
    }
    rows = actorRows.map(({ facilityId, locationId }) => ({
      facilityId,
      locationId,
    }));
  }

  const facilityIds = [...new Set(rows.map((row) => row.facilityId))];
  const facilities = await tx.facility.findMany({
    where: { organizationId, id: { in: facilityIds } },
    select: { id: true, name: true, archivedAt: true },
  });
  if (
    facilities.length !== facilityIds.length ||
    facilities.some((facility) => facility.archivedAt !== null)
  ) {
    return invalid;
  }
  const zoneIds = rows.flatMap((row) =>
    row.locationId ? [row.locationId] : [],
  );
  const zones = await tx.location.findMany({
    where: {
      organizationId,
      id: { in: zoneIds },
      parentId: null,
      archivedAt: null,
      isTransit: null,
    },
    select: { id: true, name: true, facilityId: true },
  });
  const zoneOf = new Map(zones.map((zone) => [zone.id, zone]));
  if (
    rows.some(
      (row) =>
        row.locationId !== null &&
        zoneOf.get(row.locationId)?.facilityId !== row.facilityId,
    )
  ) {
    return invalid;
  }

  if (actorScope !== null) {
    const subject = { isOwner: false, roles: [], scope: actorScope };
    const within = rows.every((row) =>
      row.locationId === null
        ? actorScope.facilities.get(row.facilityId) === null
        : inScope(subject, {
            facilityId: row.facilityId,
            path: [row.locationId],
          }),
    );
    if (rows.length === 0 || !within) {
      return { ok: false, reason: "scope_exceeds" };
    }
  }

  return {
    ok: true,
    rows,
    facilityName: new Map(facilities.map((f) => [f.id, f.name])),
    zoneName: new Map(zones.map((zone) => [zone.id, zone.name])),
  };
}

/**
 * What is left of a stored scope today: rows whose warehouse or zone was
 * archived since are dropped. Used when an invitation is accepted.
 */
export async function stillValidScopeRows(
  tx: Pick<Tx, "facility" | "location">,
  organizationId: string,
  rows: readonly ScopeRow[],
): Promise<ScopeRow[]> {
  if (rows.length === 0) return [];
  const facilities = await tx.facility.findMany({
    where: {
      organizationId,
      id: { in: [...new Set(rows.map((row) => row.facilityId))] },
      archivedAt: null,
    },
    select: { id: true },
  });
  const open = new Set(facilities.map((facility) => facility.id));
  const zones = await tx.location.findMany({
    where: {
      organizationId,
      id: {
        in: rows.flatMap((row) => (row.locationId ? [row.locationId] : [])),
      },
      parentId: null,
      archivedAt: null,
      isTransit: null,
    },
    select: { id: true, facilityId: true },
  });
  const zoneFacility = new Map(zones.map((zone) => [zone.id, zone.facilityId]));
  return rows.filter(
    (row) =>
      open.has(row.facilityId) &&
      (row.locationId === null ||
        zoneFacility.get(row.locationId) === row.facilityId),
  );
}

/** Rows read back from a JSON column; anything malformed is dropped. */
export function readScopeRows(stored: unknown): ScopeRow[] {
  if (!Array.isArray(stored)) return [];
  return stored.slice(0, MAX_SCOPE_ROWS).flatMap((row): ScopeRow[] => {
    if (typeof row !== "object" || row === null) return [];
    const { facilityId, locationId } = row as Record<string, unknown>;
    if (
      typeof facilityId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(facilityId)
    ) {
      return [];
    }
    if (locationId === null || locationId === undefined) {
      return [{ facilityId, locationId: null }];
    }
    return typeof locationId === "string" && /^[0-9a-f-]{36}$/i.test(locationId)
      ? [{ facilityId, locationId }]
      : [];
  });
}
