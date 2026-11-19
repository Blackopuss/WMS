import "server-only";

import { newId, NotFoundError } from "@/lib";
import type { TransactionClient } from "@/server";

import { DEFAULT_LEVEL_NAMES } from "./levels";

type LocationTransaction = Pick<
  TransactionClient,
  "$queryRaw" | "facility" | "location" | "locationLevel"
>;

/** Name and code the main warehouse is born with (WMS-18; WMS-43 reads them). */
export const MAIN_FACILITY_NAME = "Principal";
export const MAIN_FACILITY_CODE = "PRINCIPAL";

/**
 * The levels a new warehouse starts with (WMS-22A); the company changes
 * them in Ubicaciones. Call it in the transaction that creates the
 * warehouse.
 */
export async function createDefaultLevels(
  // The raw client of company provisioning or the company client.
  tx: {
    locationLevel: {
      createMany(args: {
        data: {
          id: string;
          organizationId: string;
          facilityId: string;
          depth: number;
          name: string;
        }[];
      }): PromiseLike<unknown>;
    };
  },
  organizationId: string,
  facilityId: string,
) {
  await tx.locationLevel.createMany({
    data: DEFAULT_LEVEL_NAMES.map((name, index) => ({
      id: newId(),
      organizationId,
      facilityId,
      depth: index + 1,
      name,
    })),
  });
}

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
  let facility = await tx.facility.findFirst({
    where: { organizationId, isDefault: true },
  });
  if (!facility) {
    facility = await tx.facility.create({
      data: {
        id: newId(),
        organizationId,
        name: MAIN_FACILITY_NAME,
        code: MAIN_FACILITY_CODE,
        isDefault: true,
      },
    });
    await createDefaultLevels(tx, organizationId, facility.id);
  }
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
      isDefault: true,
    },
  });
  return { facility, location };
}
