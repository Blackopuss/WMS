import "server-only";

import { log } from "@/lib";
import { forOrganization } from "@/server";

import { isStorageKey, removeBytes } from "./storage";

/**
 * Bytes left without a live file (WMS-67, ADR 0070). Every key that may
 * end up so is written down in `storage_cleanup` first: before an upload,
 * and in the transaction that marks a file removed. When the normal path
 * ends, it removes its own note; what is left is handled here, by the round
 * `platform.storage_cleanup`.
 */

/** A note younger than this may belong to an upload still in course. */
export const STORAGE_CLEANUP_AFTER_MS = 15 * 60 * 1000;
/** A note this old still waiting says the storage does not clean up. */
export const STORAGE_CLEANUP_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
/** Notes looked at per company and round. */
const BATCH = 200;
/** Wait after the n-th failure: 15 min, 30, 1 h, 2 h… at most a day. */
export const cleanupBackoffMs = (attempts: number): number =>
  Math.min(
    STORAGE_CLEANUP_STUCK_AFTER_MS,
    15 * 60 * 1000 * 2 ** (attempts - 1),
  );

export type StorageCleanupRound = {
  removed: number;
  kept: number;
  failed: number;
};

/**
 * For each note older than 15 minutes and due:
 *
 * 1. **Claim it** (`claimedAt`, set once, committed before anything else).
 *    The transaction of `storeFile` removes its note only while it is
 *    unclaimed and aborts otherwise, so from this moment that upload can
 *    never end in a live row: removing its bytes is safe however long it
 *    took (ADR 0070, review M1).
 * 2. Read it again: gone means its upload ended first (its row is live) or
 *    another round finished it.
 * 3. A live file with that key (a note of before claims): only the note.
 * 4. Otherwise the bytes go and then the note. A failure adds an attempt
 *    with its reason (never a secret) and a growing wait, so what keeps
 *    failing does not hold back what is new; it is never dropped.
 *
 * Safe to run twice at once: removing what is not there counts as done.
 */
export async function processStorageCleanup(
  organizationId: string,
  options: { now?: Date } = {},
): Promise<StorageCleanupRound> {
  const now = options.now ?? new Date();
  const client = forOrganization(organizationId);
  const notes = await client.storageCleanup.findMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - STORAGE_CLEANUP_AFTER_MS) },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ attempts: "asc" }, { id: "asc" }],
    take: BATCH,
    select: { id: true, storageKey: true },
  });
  const round: StorageCleanupRound = { removed: 0, kept: 0, failed: 0 };
  for (const note of notes) {
    const key = note.storageKey;
    // A note always names a key of its own company.
    if (!isStorageKey(key) || !key.startsWith(`${organizationId}/`)) {
      log.error("storage_cleanup_foreign_key", undefined, { organizationId });
      await client.storageCleanup.deleteMany({ where: { id: note.id } });
      continue;
    }
    await client.storageCleanup.updateMany({
      where: { id: note.id, claimedAt: null },
      data: { claimedAt: now },
    });
    const current = await client.storageCleanup.findFirst({
      where: { id: note.id },
      select: { attempts: true },
    });
    if (!current) {
      round.kept++;
      continue;
    }
    const live = await client.storedFile.findFirst({
      where: { id: key.split("/")[1]!, storageKey: key, deletedAt: null },
      select: { id: true },
    });
    if (live) {
      await client.storageCleanup.deleteMany({ where: { id: note.id } });
      round.kept++;
      continue;
    }
    try {
      await removeBytes(key);
      await client.storageCleanup.deleteMany({ where: { id: note.id } });
      round.removed++;
    } catch (error) {
      round.failed++;
      const reason =
        error instanceof Error ? error.message.slice(0, 200) : "unknown";
      const attempts = current.attempts + 1;
      await client.storageCleanup.updateMany({
        where: { id: note.id },
        data: {
          attempts,
          lastError: reason,
          nextAttemptAt: new Date(now.getTime() + cleanupBackoffMs(attempts)),
        },
      });
      log.warn("storage_cleanup_failed", { organizationId, reason, attempts });
    }
  }
  return round;
}
