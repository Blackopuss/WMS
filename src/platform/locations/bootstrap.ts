import "server-only";

import { newId, NotFoundError } from "@/lib";
import type { TransactionClient } from "@/server";

type LocationTransaction = Pick<
  TransactionClient,
  "$queryRaw" | "facility" | "location"
>;

/**
 * System provisioning, not a user-facing write operation. Call only with
 * the transaction that creates the company (or repairs its initial data).
 * It must support the organization row lock; no connection is opened here.
 * All reads/writes carry the caller's trusted organizationId explicitly.
 */
export async function ensureDefaultLocation(
  tx: LocationTransaction,
  organizationId: string,
) {
  // Serializes concurrent/repeated provisioning, even before a facility exists.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM organization WHERE id = ${organizationId} FOR UPDATE
  `;
  if (rows.length !== 1) {
    throw new NotFoundError("organization_not_found", "La empresa no existe.");
  }

  // The main warehouse (WMS-18): there is always one.
  const facility =
    (await tx.facility.findFirst({
      where: { organizationId, isDefault: true },
    })) ??
    (await tx.facility.create({
      data: {
        id: newId(),
        organizationId,
        name: "Principal",
        code: "PRINCIPAL",
        isDefault: true,
      },
    }));
  const location = await tx.location.upsert({
    where: {
      organizationId_facilityId_isDefault: {
        organizationId,
        facilityId: facility.id,
        isDefault: true,
      },
    },
    update: {},
    create: {
      id: newId(),
      organizationId,
      facilityId: facility.id,
      name: "General",
      kind: "GENERAL",
      isDefault: true,
    },
  });
  return { facility, location };
}
