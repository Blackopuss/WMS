import "server-only";

import { isAllowed, loadScope } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import {
  facilityInScope,
  isLimited,
  locationScopeWhere,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import type { InventoryActor } from "./movements";
import { SETUP_SETTINGS } from "./settings";

/** Name and code the main warehouse is born with (`ensureDefaultLocation`). */
const BORN_NAME = "Principal";
const BORN_CODE = "PRINCIPAL";

/**
 * Where a company is on its way to work (IMP-12, WMS-43): its warehouse,
 * its locations, its team, how it works, its products, how much there is
 * of them and a first movement. Nothing is stored for it — no «done» flags
 * to keep in step: every answer is read from what already exists, so the
 * guide cannot say something the company does not (ADR 0083).
 */
export type FirstSteps = {
  /**
   * The warehouse was looked at: more than one active warehouse within
   * the person's reach, or the main one no longer has the name and code it
   * was born with, or it has an address.
   */
  facilityReady: boolean;
  /** Some own location (not General, staging or transit) within reach. */
  hasOwnLocations: boolean;
  /**
   * Someone else works in the company or has a pending invitation. Null
   * when the person may not see the team: then it is not read.
   */
  hasTeam: boolean | null;
  /**
   * Some setting of the setup list has a chosen value. Null when the
   * person may not change settings: then it is not read.
   */
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

export async function getFirstSteps(
  actor: InventoryActor,
): Promise<FirstSteps> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.product.read",
  );
  const client = forOrganization(organizationId);
  const [seesTeam, changesSettings, scope, scopedLocations] = await Promise.all(
    [
      isAllowed(organizationId, userId, "platform.team.read"),
      isAllowed(organizationId, userId, "platform.organization.update"),
      loadScope(client, userId),
      locationScopeWhere(client, userId),
    ],
  );
  const now = new Date();
  // One row is enough for each question: none of these counts the table
  // (the warehouses are few: at most what the plan allows).
  const [
    product,
    line,
    movement,
    facilities,
    ownLocation,
    otherMember,
    invitation,
    setting,
  ] = await Promise.all([
    client.product.findFirst({ select: { id: true } }),
    client.stockMovementLine.findFirst({ select: { id: true } }),
    client.stockMovement.findFirst({
      where: { type: { not: "INITIAL" } },
      select: { id: true },
    }),
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
        ...(isLimited(scopedLocations) ? { AND: [scopedLocations] } : {}),
      },
      select: { id: true },
    }),
    seesTeam
      ? client.membership.findFirst({
          where: { status: "ACTIVE", userId: { not: userId } },
          select: { id: true },
        })
      : null,
    seesTeam
      ? client.invitation.findFirst({
          where: { status: "PENDING", expiresAt: { gt: now } },
          select: { id: true },
        })
      : null,
    changesSettings
      ? client.organizationSetting.findFirst({
          where: { key: { in: SETUP_SETTINGS.map((each) => each.key) } },
          select: { id: true },
        })
      : null,
  ]);
  const reachable = facilities.filter((facility) =>
    facilityInScope(scope, facility.id),
  );
  const facilityReady =
    reachable.length > 1 ||
    reachable.some(
      (facility) =>
        facility.name !== BORN_NAME ||
        facility.code !== BORN_CODE ||
        Boolean(facility.address),
    );
  const hasProducts = product !== null;
  const hasStock = line !== null;
  const hasMovement = movement !== null;
  return {
    facilityReady,
    hasOwnLocations: ownLocation !== null,
    hasTeam: seesTeam ? otherMember !== null || invitation !== null : null,
    settingsChosen: changesSettings ? setting !== null : null,
    hasProducts,
    hasStock,
    hasMovement,
    complete: hasProducts && hasStock && hasMovement,
  };
}
