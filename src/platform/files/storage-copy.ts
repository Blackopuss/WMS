import "server-only";

import { createHash } from "node:crypto";

import { storageKib } from "@/platform/entitlements";
import { forOrganization } from "@/server";

import {
  configuredDriver,
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
  /**
   * Read back what this run copied and compare its hash. What was skipped
   * was already checked by the hash its destination keeps (`HEAD`), so a
   * daily backup does not download the whole bucket again.
   */
  verify?: boolean;
  /** Read back everything, skipped included (slow: downloads it all). */
  verifyAll?: boolean;
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

/** What each problem means and how it is fixed, for the person who runs it. */
export const COPY_PROBLEM_HELP: Record<CopyProblem["kind"], string> = {
  missing:
    "el origen no tiene los bytes: búscalos en otro almacenamiento o en un respaldo y vuelve a correr la copia desde ahí",
  corrupt:
    "los bytes del origen no son los guardados (su sha256 no coincide): no se copiaron; recupéralos de un respaldo",
  differs:
    "el respaldo ya tiene esa llave con otro contenido o sin su sha256 y nunca se reemplaza: revísalo a mano y, si está mal, bórralo del bucket de respaldo para que la siguiente copia lo escriba",
  failed:
    "el almacenamiento no respondió o rechazó la petición (credenciales, permisos de listar y leer, red): corrígelo y vuelve a correr",
  unverified:
    "lo leído del destino no coincide aunque se escribió: en el respaldo revísalo y bórralo a mano para que se copie otra vez; en otro destino se reescribió una vez y siguió sin coincidir",
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

type LiveFile = { id: string; storageKey: string; sha256: string };

/** Reads from the source, checks against the row and writes. */
async function copyOne(
  source: StorageDriver,
  target: StorageDriver,
  file: LiveFile,
): Promise<"ok" | "missing" | "corrupt"> {
  const bytes = await source.get(file.storageKey);
  if (!bytes) return "missing";
  if (sha(bytes) !== file.sha256) return "corrupt";
  await target.put(file.storageKey, bytes, file.sha256);
  return "ok";
}

async function matches(target: StorageDriver, file: LiveFile) {
  const back = await target.get(file.storageKey);
  return back !== null && sha(back) === file.sha256;
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
  // The application still reads the disk: removing it would lose files.
  if (options.removeSource && configuredDriver() === "disk") {
    throw new Error(
      "removeSource only once FILE_STORAGE_DRIVER is s3 (the app still reads the disk)",
    );
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
        let copied = false;
        if (there && there.sha256 === file.sha256) {
          summary.skipped++;
        } else if (there && !replaceable) {
          problem({
            kind: "differs",
            ...where,
            detail: there.sha256 ? "otro sha256" : "sin sha256",
          });
          continue;
        } else {
          const result = await copyOne(source, target, file);
          if (result !== "ok") {
            problem({ kind: result, ...where });
            continue;
          }
          summary.copied++;
          copied = true;
        }
        // What is removed from the disk is always read back first.
        if (
          (options.verify && copied) ||
          options.verifyAll ||
          options.removeSource
        ) {
          if (!(await matches(target, file))) {
            // A destination that may be replaced gets one more write.
            const again =
              replaceable && (await copyOne(source, target, file)) === "ok"
                ? await matches(target, file)
                : false;
            if (!again) {
              problem({ kind: "unverified", ...where });
              continue;
            }
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

export type StorageRecount = {
  organizationId: string;
  /** What the counter `file_storage_kib` says (in use + reserved). */
  counted: number;
  /** What the live files take, counted again now. */
  actual: number;
};

/**
 * The storage counter against the live files, company by company (ADR
 * 0070, review B7): a deploy or `volver` while the previous version
 * uploads or removes files may leave them apart. It only shows the
 * difference; correcting it is a decision of whoever runs it.
 */
export async function recountStorage(
  organizationIds: Iterable<string> | AsyncIterable<string>,
): Promise<StorageRecount[]> {
  const out: StorageRecount[] = [];
  for await (const organizationId of organizationIds) {
    const client = forOrganization(organizationId);
    const counter = await client.quotaUsage.findFirst({
      where: { key: "file_storage_kib" },
      select: { taken: true },
    });
    let actual = 0;
    let after: string | undefined;
    for (;;) {
      const page: { id: string; size: number }[] =
        await client.storedFile.findMany({
          where: { deletedAt: null },
          orderBy: { id: "asc" },
          take: PAGE,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
          select: { id: true, size: true },
        });
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      for (const row of page) actual += storageKib(row.size);
    }
    const counted = counter?.taken ?? 0;
    if (counted !== actual) out.push({ organizationId, counted, actual });
  }
  return out;
}
