import "server-only";

import { newId } from "@/lib";
import { lockRows, type TenantDb } from "@/server";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** Name of the staging location when it is created. */
export const STAGING_NAME = "Preparación";

/**
 * The place where picked goods wait to be packed and shipped (WMS-14): one
 * per facility (`isStaging`), created the first time an order is released.
 * A root location already called «Preparación» becomes it. Call it inside
 * the transaction that needs it; it locks the facility, like every change
 * to the tree (after the products, never before).
 */
export async function ensureStagingLocation(
  tx: Tx,
  organizationId: string,
): Promise<{ id: string; name: string }> {
  const existing = await tx.location.findFirst({
    where: { isStaging: true },
    select: { id: true, name: true },
  });
  if (existing) return existing;
  const facility = await tx.facility.findFirst({ select: { id: true } });
  if (!facility) throw new Error(`Company ${organizationId} has no facility`);
  await lockRows(tx, "facility", [facility.id]);
  const again = await tx.location.findFirst({
    where: { isStaging: true },
    select: { id: true, name: true },
  });
  if (again) return again;
  const named = await tx.location.findFirst({
    where: {
      facilityId: facility.id,
      parentId: null,
      name: STAGING_NAME,
      kind: { not: "GENERAL" },
    },
    select: { id: true, name: true, archivedAt: true },
  });
  if (named) {
    await tx.location.update({
      where: { id: named.id },
      data: { isStaging: true, archivedAt: null },
    });
    return { id: named.id, name: named.name };
  }
  const id = newId();
  await tx.location.create({
    data: {
      id,
      organizationId,
      facilityId: facility.id,
      name: STAGING_NAME,
      kind: "ZONE",
      isStaging: true,
    },
  });
  return { id, name: STAGING_NAME };
}
