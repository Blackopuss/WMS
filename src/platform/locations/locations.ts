import "server-only";

import { assertModulePermission } from "@/platform/billing";
import { forOrganization } from "@/server";

import { activeFacilityOf } from "./facilities";

export type LocationActor = { organizationId: string; userId: string };

/**
 * General of the warehouse the person works in (WMS-18). Read-only lookup;
 * the actor always comes from the active session.
 */
export async function getDefaultLocation(actor: LocationActor) {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.location.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.location.findFirst({
    where: { isDefault: true, facilityId: facility.id },
    select: {
      id: true,
      name: true,
      isDefault: true,
      facility: { select: { id: true, name: true } },
    },
  });
}
