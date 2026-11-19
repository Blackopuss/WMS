import "server-only";

import { loadScope, type Scope } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import {
  MAIN_FACILITY_CODE,
  MAIN_FACILITY_NAME,
  facilityInScope,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import type { InventoryActor } from "./movements";
import { SETUP_SETTINGS } from "./settings";

/**
 * Where a company is on its way to work (IMP-12, WMS-43): its warehouse,
 * its locations, its team, how it works, its products, how much there is
 * of them and a first movement. Nothing is stored for it — no «done» flags
 * to keep in step: every answer is read from what already exists, so the
 * guide cannot say something the company does not (ADR 0083).
 *
 * Products, stock and the first movement are of the whole company (the
 * catalog has no warehouse; they are yes-or-no answers, without figures,
 * as before WMS-43). Warehouse and locations are read within the person's
 * reach. A null means «not read».
 */
export type FirstSteps = {
  /**
   * The warehouse was looked at: more than one active warehouse within
   * the person's reach, or the main one no longer has the name and code it
   * was born with, or it has an address.
   */
  facilityReady: boolean | null;
  /** Some own location (not General, staging or transit) within reach. */
  hasOwnLocations: boolean | null;
  /**
   * Someone besides the first person works in the company (two active
   * memberships, whoever looks) or there is a pending invitation.
   */
  hasTeam: boolean | null;
  /** Some setting of the setup list has a chosen value. */
  settingsChosen: boolean | null;
  /** There is at least one product in the catalog. */
  hasProducts: boolean;
  /** Some product has stock: an initial balance or anything that entered. */
  hasStock: boolean;
  /** Something moved after the starting stock: an entry, an exit… */
  hasMovement: boolean;
  /** Products, stock and a movement: the company already operates. */
  complete: boolean;
};

/**
 * What the caller already knows from the session (the screen has the
 * person's access): no permission is read twice. Without it, nothing of
 * the team or the settings is read.
 *
 * This service trusts its caller for `seesTeam` and `changesSettings`:
 * today only Server Components pass them from `access.can`. Whoever
 * exposes it through a Server Action or the API checks those permissions
 * on the server first (ADR 0083).
 */
export type FirstStepsOptions = {
  /** The person may see the team (`platform.team.read`). */
  seesTeam?: boolean;
  /** The person may change settings (`platform.organization.update`). */
  changesSettings?: boolean;
  /**
   * Only what the guide on Inicio needs: once something moved after the
   * starting stock every earlier step is done or skipped, so the rest is
   * not read (null).
   */
  whileSettingUp?: boolean;
};

export async function getFirstSteps(
  actor: InventoryActor,
  options: FirstStepsOptions = {},
): Promise<FirstSteps> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.product.read",
  );
  const client = forOrganization(organizationId);
  // One row is enough for each question: none of these counts the table.
  const [product, line, movement] = await Promise.all([
    client.product.findFirst({ select: { id: true } }),
    client.stockMovementLine.findFirst({ select: { id: true } }),
    client.stockMovement.findFirst({
      where: { type: { not: "INITIAL" } },
      select: { id: true },
    }),
  ]);
  const hasProducts = product !== null;
  const hasStock = line !== null;
  const hasMovement = movement !== null;
  const base = {
    hasProducts,
    hasStock,
    hasMovement,
    complete: hasProducts && hasStock && hasMovement,
  };
  if (options.whileSettingUp && hasMovement) {
    return {
      facilityReady: null,
      hasOwnLocations: null,
      hasTeam: null,
      settingsChosen: null,
      ...base,
    };
  }

  const scope = await loadScope(client, userId);
  const now = new Date();
  const [facilities, ownLocation, members, invitation, setting] =
    await Promise.all([
      // The warehouses are few: at most what the plan allows.
      client.facility.findMany({
        where: { archivedAt: null },
        select: { id: true, name: true, code: true, address: true },
        take: 200,
      }),
      client.location.findFirst({
        where: {
          archivedAt: null,
          isDefault: null,
          isStaging: null,
          isTransit: null,
          ...reachWhere(scope),
        },
        select: { id: true },
      }),
      options.seesTeam
        ? client.membership.findMany({
            where: { status: "ACTIVE" },
            select: { id: true },
            take: 2,
          })
        : null,
      options.seesTeam
        ? client.invitation.findFirst({
            where: { status: "PENDING", expiresAt: { gt: now } },
            select: { id: true },
          })
        : null,
      options.changesSettings
        ? client.organizationSetting.findFirst({
            where: { key: { in: SETUP_SETTINGS.map((each) => each.key) } },
            select: { id: true },
          })
        : null,
    ]);
  const reachable = facilities.filter((facility) =>
    facilityInScope(scope, facility.id),
  );
  return {
    facilityReady:
      reachable.length > 1 ||
      reachable.some(
        (facility) =>
          facility.name !== MAIN_FACILITY_NAME ||
          facility.code !== MAIN_FACILITY_CODE ||
          Boolean(facility.address),
      ),
    hasOwnLocations: ownLocation !== null,
    hasTeam: options.seesTeam
      ? (members?.length ?? 0) > 1 || invitation !== null
      : null,
    settingsChosen: options.changesSettings ? setting !== null : null,
    ...base,
  };
}

/**
 * Locations within reach without reading the tree: a whole warehouse, or
 * one of the person's zones or a place directly inside one. A zone is
 * itself an own location, so for the yes-or-no question this is enough.
 */
function reachWhere(scope: Scope | null) {
  if (scope === null) return {};
  const OR: object[] = [];
  for (const [facilityId, zones] of scope.facilities) {
    if (zones === null) {
      OR.push({ facilityId });
    } else if (zones.size > 0) {
      const ids = [...zones];
      OR.push({
        facilityId,
        OR: [{ id: { in: ids } }, { parentId: { in: ids } }],
      });
    }
  }
  // Prisma reads an empty OR as «nothing».
  return { OR };
}
