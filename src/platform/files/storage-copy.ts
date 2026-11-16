import "server-only";

import { createHash } from "node:crypto";

import { forOrganization } from "@/server";

import {
  isStorageKey,
  listCompanyKeys,
  storageDriver,
  type StorageDriver,
  type StorageTarget,
} from "./storage";

/**
 * Copies the bytes the database references from one storage to another
 * (WMS-67, ADR 0070): moving the files of the disk to R2, going back,
 * copying to the backup bucket and restoring from it. Operations only
 * (`scripts/storage-copy.mts`); it reads across companies on purpose.
 *
 * - Repeatable: what the destination already holds with the same hash is
 *   skipped.
 * - What is read from the source is checked against the hash of its row
 *   before it is written anywhere.
 * - It never removes nor replaces anything in the backup bucket. It removes
 *   from the source only with `removeSource` (only from the disk), and only
 *   a file whose copy was read back and matched.
 */

export type CopyOptions = {
  from: StorageTarget;
  to: StorageTarget;
  /** Read each copy back and compare its hash. */
  verify?: boolean;
  /** Remove from the disk what was copied and verified. */
  removeSource?: boolean;
  /** The companies to go through, in order (the script reads them all). */
  organizationIds: Iterable<string> | AsyncIterable<string>;
  /** Line by line, for the person who runs it. */
  onProblem?: (problem: CopyProblem) => void;
};

export type CopyProblem = {
  kind: "missing" | "corrupt" | "differs" | "failed" | "unverified";
  organizationId: string;
  fileId: string;
  detail?: string;
};

export type CopySummary = {
  companies: number;
  files: number;
  copied: number;
  skipped: number;
  removed: number;
  problems: number;
};

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const PAGE = 500;

async function* liveFiles(organizationId: string) {
  let after: string | undefined;
  for (;;) {
    const page: { id: string; storageKey: string; sha256: string }[] =
      await forOrganization(organizationId).storedFile.findMany({
        where: { deletedAt: null },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: { id: true, storageKey: true, sha256: true },
      });
    if (page.length === 0) return;
    after = page[page.length - 1]!.id;
    yield* page;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown";
}

export async function copyStoredFiles(
  options: CopyOptions,
): Promise<CopySummary> {
  if (options.from === options.to) {
    throw new Error("The source and the destination are the same");
  }
  if (options.removeSource && (options.from !== "disk" || !options.verify)) {
    throw new Error("removeSource only from disk and with verify");
  }
  const source: StorageDriver = storageDriver(options.from);
  const target: StorageDriver = storageDriver(options.to);
  const replaceable = options.to !== "backup";
  const summary: CopySummary = {
    companies: 0,
    files: 0,
    copied: 0,
    skipped: 0,
    removed: 0,
    problems: 0,
  };
  const problem = (item: CopyProblem) => {
    summary.problems++;
    options.onProblem?.(item);
  };

  for await (const organizationId of options.organizationIds) {
    summary.companies++;
    for await (const file of liveFiles(organizationId)) {
      summary.files++;
      const where = { organizationId, fileId: file.id };
      if (
        !isStorageKey(file.storageKey) ||
        !file.storageKey.startsWith(`${organizationId}/`)
      ) {
        problem({ kind: "failed", ...where, detail: "invalid key" });
        continue;
      }
      try {
        const there = await target.head(file.storageKey);
        if (there && there.sha256 === file.sha256) {
          summary.skipped++;
        } else if (there && !replaceable) {
          problem({ kind: "differs", ...where, detail: "kept as it is" });
          continue;
        } else {
          const bytes = await source.get(file.storageKey);
          if (!bytes) {
            problem({ kind: "missing", ...where });
            continue;
          }
          if (sha(bytes) !== file.sha256) {
            problem({ kind: "corrupt", ...where });
            continue;
          }
          await target.put(file.storageKey, bytes, file.sha256);
          summary.copied++;
        }
        if (options.verify) {
          const back = await target.get(file.storageKey);
          if (!back || sha(back) !== file.sha256) {
            problem({ kind: "unverified", ...where });
            continue;
          }
        }
        if (options.removeSource) {
          await source.remove(file.storageKey);
          summary.removed++;
        }
      } catch (error) {
        problem({ kind: "failed", ...where, detail: message(error) });
      }
    }
  }
  return summary;
}

export type StrayObject = {
  organizationId: string;
  key: string;
  lastModified: Date | null;
};

/**
 * Objects of a storage that no live file references and no cleanup note
 * names: what to look at by hand. It removes nothing.
 */
export async function auditStorage(
  targetName: StorageTarget,
  organizationIds: Iterable<string> | AsyncIterable<string>,
): Promise<StrayObject[]> {
  const target = storageDriver(targetName);
  const stray: StrayObject[] = [];
  for await (const organizationId of organizationIds) {
    const client = forOrganization(organizationId);
    const keys = await listCompanyKeys(target, organizationId);
    if (keys.length === 0) continue;
    const ids = keys.map((k) => k.key.split("/")[1]!);
    const known = new Set<string>();
    for (let at = 0; at < ids.length; at += PAGE) {
      const slice = ids.slice(at, at + PAGE);
      const rows = await client.storedFile.findMany({
        where: { id: { in: slice }, deletedAt: null },
        select: { storageKey: true },
      });
      for (const row of rows) known.add(row.storageKey);
      const notes = await client.storageCleanup.findMany({
        where: {
          storageKey: { in: slice.map((id) => `${organizationId}/${id}`) },
        },
        select: { storageKey: true },
      });
      for (const note of notes) known.add(note.storageKey);
    }
    for (const item of keys) {
      if (!known.has(item.key)) stray.push({ organizationId, ...item });
    }
  }
  return stray;
}
