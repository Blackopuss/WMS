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
/** Notes looked at per company and round. */
const BATCH = 200;

export type StorageCleanupRound = {
  removed: number;
  kept: number;
  failed: number;
};

/**
 * For each note older than 15 minutes: when a live file has that key (the
 * upload did end), only the note goes; otherwise the bytes go and then the
 * note. A failure adds an attempt with its reason (never a secret) and is
 * tried again in the next round. Safe to run twice at once: removing what
 * is not there counts as done.
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
    },
    orderBy: { id: "asc" },
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
      await client.storageCleanup.updateMany({
        where: { id: note.id },
        data: { attempts: { increment: 1 }, lastError: reason },
      });
      log.warn("storage_cleanup_failed", { organizationId, reason });
    }
  }
  return round;
}
