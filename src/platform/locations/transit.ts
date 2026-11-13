import "server-only";

import { newId } from "@/lib";
import { lockRows, type TenantDb } from "@/server";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** Name of the transit location of a warehouse when it is created. */
export const TRANSIT_NAME = "En tránsito entre almacenes";

/**
 * Filter for every query that lists or offers locations (WMS-19, ADR 0048):
 * the transit location belongs to transfers only and is never shown,
 * chosen, scanned or put in a scope.
 */
export const NOT_TRANSIT = { isTransit: null } as const;

/**
 * The place of a warehouse where what another warehouse sent waits, in
 * transit (WMS-19): one per warehouse (`isTransit`), at its root, created
 * the first time a transfer goes to it. Only transfers write in it, always
 * IN_TRANSIT (triggers). Call it inside the transaction that needs it,
 * before taking product or location locks: it locks the facility.
 */
export async function ensureTransitLocation(
  tx: Tx,
  organizationId: string,
  facilityId: string,
): Promise<{ id: string }> {
  const existing = await tx.location.findFirst({
    where: { isTransit: true, facilityId },
    select: { id: true },
  });
  if (existing) return existing;
  const [locked] = await lockRows(tx, "facility", [facilityId]);
  if (!locked)
    throw new Error(`Company ${organizationId} has no warehouse ${facilityId}`);
  const again = await tx.location.findFirst({
    where: { isTransit: true, facilityId },
    select: { id: true },
  });
  if (again) return again;
  // At the root, in the widest level of the warehouse.
  const level = await tx.locationLevel.findFirst({
    where: { facilityId },
    orderBy: { depth: "asc" },
    select: { id: true },
  });
  if (!level) throw new Error(`Warehouse ${facilityId} has no levels`);
  // Names are unique at the root: a place the business already called so
  // keeps its name.
  let name = TRANSIT_NAME;
  for (let n = 2; ; n++) {
    const taken = await tx.location.findFirst({
      where: { facilityId, parentId: null, name },
      select: { id: true },
    });
    if (!taken) break;
    name = `${TRANSIT_NAME} ${n}`;
  }
  const id = newId();
  await tx.location.create({
    data: {
      id,
      organizationId,
      facilityId,
      name,
      levelId: level.id,
      type: "DOCK",
      isTransit: true,
    },
  });
  return { id };
}
