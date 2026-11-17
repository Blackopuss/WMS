import "server-only";

import { lockRows, shareFacilityRow, type TenantDb } from "@/server";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/**
 * The one door to the warehouses of a company (WMS-76, ADR 0074; WMS-82,
 * ADR 0077).
 *
 * - Exclusive, every warehouse at once (`lockAllFacilities`): who changes
 *   the set of warehouses or the location tree (creating, editing or
 *   archiving a warehouse; creating, editing, moving or archiving a
 *   location). They lock no product.
 * - Exclusive, one warehouse (`ensureStagingLocation`): after the products
 *   and before any location. A transfer between warehouses takes its two
 *   first (it locks no product), and `ensureTransitLocation` takes again
 *   the destination it already holds.
 * - Shared, one warehouse (`holdOpenFacility`): who creates a document of
 *   that warehouse without locking first one of its locations, after its
 *   products and before any location (WMS-82).
 *
 * Always through `lockRows`, so always by the primary key, in id order:
 * never with an `UPDATE … WHERE organizationId`, which walks a secondary
 * index first (the unique index (organizationId, id) that every foreign key
 * to a warehouse checks) and closed a circle with whoever held a warehouse
 * by its primary key and wrote a row pointing to it.
 */

/**
 * Thrown by `lockAllFacilities` when a warehouse appeared, between reading
 * and locking, with an id lower than one already held (UUIDv7 from another
 * instance with its clock behind): locking it now would be out of order.
 * The caller runs its whole transaction again (`retryingFacilitySet`).
 */
export class FacilitySetChanged extends Error {
  constructor() {
    super("the set of warehouses changed while locking it");
  }
}

/**
 * Every warehouse of the company, exclusive, in id order. Reads the ids and
 * locks them; a warehouse committed in between (a new one is created only
 * under these same locks, so at most once) is locked on the next turn if it
 * sorts after the ones held, and otherwise the transaction starts over.
 */
export async function lockAllFacilities(tx: Tx): Promise<void> {
  const held = new Set<string>();
  let highest = "";
  for (;;) {
    const rows = await tx.facility.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const missing = rows.map((row) => row.id).filter((id) => !held.has(id));
    if (missing.length === 0) return;
    if (held.size > 0 && missing.some((id) => id < highest)) {
      throw new FacilitySetChanged();
    }
    await lockRows(tx, "facility", missing);
    for (const id of missing) held.add(id);
    highest = missing[missing.length - 1] ?? highest;
  }
}

/** Runs `work` again (at most three times) after `FacilitySetChanged`. */
export async function retryingFacilitySet<T>(
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof FacilitySetChanged) || attempt >= 3) throw error;
    }
  }
}

/**
 * WMS-82 (ADR 0077): the warehouse of a document about to be created,
 * shared, and whether it is still open. `null` when it does not exist in
 * the company or is archived: the caller refuses with its own message. Call
 * it after the products (if any) and before any location; never take the
 * same warehouse in exclusive afterwards (`ensureStagingLocation` goes
 * first when both are needed).
 */
export async function holdOpenFacility(
  tx: Tx,
  facilityId: string,
): Promise<{ id: string; name: string } | null> {
  // The archived mark is read by the locking statement itself, so it is the
  // last committed one even in a transaction that read something before.
  const held = await shareFacilityRow(tx, facilityId);
  if (!held || held.archived) return null;
  const facility = await tx.facility.findFirst({
    where: { id: held.id },
    select: { id: true, name: true },
  });
  return facility;
}

/** What a service says when the warehouse of a new document is archived. */
export const ARCHIVED_FACILITY_MESSAGE =
  "Este almacén se archivó: elige otro almacén para trabajar.";
