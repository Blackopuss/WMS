import "server-only";

import { assertModulePermission } from "@/platform/billing";
import {
  readCustomFieldValuesOf,
  type CustomValuesOfRecords,
} from "@/platform/custom-fields";
import { forOrganization } from "@/server";

import { locationScopeWhere } from "./scope";

/**
 * The custom fields of some locations and their values (WMS-58), only of
 * the ones the person may work in (WMS-20): a location out of scope «does
 * not exist» here either. The one way to read them.
 */
export async function getLocationCustomValues(
  actor: { organizationId: string; userId: string },
  locationIds: readonly string[],
): Promise<CustomValuesOfRecords> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.location.read",
  );
  const client = forOrganization(actor.organizationId);
  const visible = await client.location.findMany({
    where: {
      id: { in: [...new Set(locationIds.map(String))].slice(0, 5_000) },
      ...(await locationScopeWhere(client, actor.userId)),
    },
    select: { id: true },
  });
  return readCustomFieldValuesOf(
    client,
    "LOCATION",
    visible.map((location) => location.id),
  );
}
