import "server-only";

import { lockRows, type TenantDb } from "@/server";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/**
 * The one door to the warehouses of a company (WMS-76, ADR 0074).
 *
 * - Exclusive, every warehouse at once (`lockAllFacilities`): who changes
 *   the set of warehouses or the location tree (creating, editing or
 *   archiving a warehouse; creating, editing, moving or archiving a
 *   location). They lock no product.
 * - Exclusive, one warehouse (`ensureStagingLocation`): after the products
 *   and before any location. A transfer between warehouses takes its two
 *   first (it locks no product), and `ensureTransitLocation` takes again
 *   the destination it already holds.
 * - Shared, one warehouse (`lockRows(…, { mode: "share" })`): a document
 *   that must not be created in an area whose use is changing (production
 *   orders), before anything else.
 *
 * Always through `lockRows`, so always by the primary key, in id order:
 * never with an `UPDATE … WHERE organizationId`, which walks a secondary
 * index first (the unique index (organizationId, id) that every foreign key
 * to a warehouse checks) and closed a circle with whoever held a warehouse
 * by its primary key and wrote a row pointing to it.
 *
 * Reads the ids first and locks them; a warehouse committed in between (a
 * new one is created only under these same locks, so at most once) is
 * locked on the next turn. Ids are UUIDv7, so a newer warehouse sorts
 * after the ones already held and the id order holds.
 */
export async function lockAllFacilities(tx: Tx): Promise<void> {
  const held = new Set<string>();
  for (;;) {
    const rows = await tx.facility.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const missing = rows.map((row) => row.id).filter((id) => !held.has(id));
    if (missing.length === 0) return;
    await lockRows(tx, "facility", missing);
    for (const id of missing) held.add(id);
  }
}
