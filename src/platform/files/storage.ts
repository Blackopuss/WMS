import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { S3Client, StorageConfigError, readS3Config } from "./s3-client";

/**
 * Where the bytes of private files live (IMP-02, ADR 0014; WMS-67, ADR
 * 0070): a folder of the server (`disk`, by default) or a bucket compatible
 * with S3 such as Cloudflare R2 (`s3`), chosen by `FILE_STORAGE_DRIVER` when
 * used. Nothing reaches a file by its path or its key: only `platform/files`
 * reads here, after checking whose the file is.
 *
 * Keys are built by the service from ids ("<organizationId>/<fileId>");
 * anything else is refused, so a key can never leave its folder nor name
 * another object.
 */

const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
const COMPANY = /^[0-9a-f-]{36}$/;

export function isStorageKey(key: string): boolean {
  return KEY.test(key);
}

function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error("Invalid storage key");
  return key;
}

/** A place that keeps bytes by key. */
export type StorageDriver = {
  readonly name: "disk" | "s3" | "backup";
  put(key: string, bytes: Uint8Array, sha256: string): Promise<void>;
  /** Null when the bytes are not there. */
  get(key: string): Promise<Buffer | null>;
  /** The `sha256` it holds (null when unknown); null when not there. */
  head(key: string): Promise<{ sha256: string | null } | null>;
  /** Removing what is not there counts as done. */
  remove(key: string): Promise<void>;
  /** Keys under a company, a page at a time. For operations only. */
  list(
    organizationId: string,
    continuation?: string,
  ): Promise<{
    keys: { key: string; lastModified: Date | null }[];
    next: string | null;
  }>;
};

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function diskRoot(): string {
  return path.resolve(
    process.env.FILE_STORAGE_DIR ?? path.join(process.cwd(), "storage"),
  );
}

function diskDriver(): StorageDriver {
  const root = diskRoot();
  const locate = (key: string) => path.join(root, ...key.split("/"));
  const readOrNull = async (file: string) => {
    try {
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    name: "disk",
    // The whole file or nothing: a temporary name first, then renamed.
    async put(key, bytes) {
      const target = locate(key);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, target);
    },
    get: (key) => readOrNull(locate(key)),
    async head(key) {
      const bytes = await readOrNull(locate(key));
      return bytes ? { sha256: sha(bytes) } : null;
    },
    async remove(key) {
      await rm(locate(key), { force: true });
    },
    async list(organizationId) {
      const folder = path.join(root, organizationId);
      let names: string[];
      try {
        names = await readdir(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { keys: [], next: null };
        }
        throw error;
      }
      const keys = [];
      for (const name of names.sort()) {
        const key = `${organizationId}/${name}`;
        if (!KEY.test(key)) continue;
        const info = await stat(path.join(folder, name));
        keys.push({ key, lastModified: info.mtime });
      }
      return { keys, next: null };
    },
  };
}

function s3Driver(name: "s3" | "backup"): StorageDriver {
  const client = new S3Client(
    readS3Config(name === "s3" ? "FILE_STORAGE_S3_" : "FILE_BACKUP_S3_"),
  );
  return {
    name,
    put: (key, bytes, sha256) => client.put(key, bytes, sha256),
    get: (key) => client.get(key),
    async head(key) {
      const found = await client.head(key);
      return found ? { sha256: found.sha256 } : null;
    },
    remove: (key) => client.remove(key),
    async list(organizationId, continuation) {
      const page = await client.list(`${organizationId}/`, continuation);
      return {
        keys: page.keys.filter((k) => KEY.test(k.key)),
        next: page.next,
      };
    },
  };
}

export type StorageTarget = "disk" | "s3" | "backup";

/** The configured driver, or the one named (the copy script). */
export function storageDriver(target?: StorageTarget): StorageDriver {
  const chosen = target ?? configuredDriver();
  return chosen === "disk" ? diskDriver() : s3Driver(chosen);
}

/** What `FILE_STORAGE_DRIVER` says; `disk` when empty. */
export function configuredDriver(): "disk" | "s3" {
  const value = (process.env.FILE_STORAGE_DRIVER ?? "").trim() || "disk";
  if (value !== "disk" && value !== "s3") {
    throw new StorageConfigError("FILE_STORAGE_DRIVER must be disk or s3");
  }
  return value;
}

export async function putBytes(
  key: string,
  bytes: Uint8Array,
  sha256 = sha(bytes),
): Promise<void> {
  await storageDriver().put(checkKey(key), bytes, sha256);
}

/** Null when the bytes are not there. */
export async function getBytes(key: string): Promise<Buffer | null> {
  return storageDriver().get(checkKey(key));
}

export async function removeBytes(key: string): Promise<void> {
  await storageDriver().remove(checkKey(key));
}

/** For operations: the keys a company holds in a driver. */
export async function listCompanyKeys(
  driver: StorageDriver,
  organizationId: string,
): Promise<{ key: string; lastModified: Date | null }[]> {
  if (!COMPANY.test(organizationId)) throw new Error("Invalid company id");
  const all: { key: string; lastModified: Date | null }[] = [];
  let next: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const result = await driver.list(organizationId, next);
    all.push(...result.keys);
    if (!result.next) break;
    next = result.next;
  }
  return all;
}

export type StorageProbe = {
  ok: boolean;
  driver: "disk" | "s3";
  /** Milliseconds the round trip took. */
  ms: number;
  /** Why it failed, without secrets: «put (403 AccessDenied)». */
  error?: string;
};

/**
 * Health of the storage (`/api/salud`, PIL-04): writes, reads back and
 * removes a small object under `salud/`, apart from the keys of the
 * companies. The worker calls it every few minutes, never a request.
 */
export async function pingStorage(): Promise<StorageProbe> {
  const started = Date.now();
  let driver: "disk" | "s3" = "disk";
  try {
    driver = configuredDriver();
    const key = `salud/${randomUUID()}`;
    const bytes = randomBytes(32);
    const digest = sha(bytes);
    if (driver === "disk") {
      // A file of its own name at the root, removed at once: never a
      // folder that looks like a company.
      const file = path.join(diskRoot(), `.salud-${randomUUID()}`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      const back = await readFile(file);
      await rm(file, { force: true });
      if (sha(back) !== digest) throw new Error("read back differs");
    } else {
      const client = new S3Client(readS3Config("FILE_STORAGE_S3_"));
      await client.put(key, bytes, digest);
      const back = await client.get(key);
      await client.remove(key);
      if (!back || sha(back) !== digest) throw new Error("read back differs");
    }
    return { ok: true, driver, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      driver,
      ms: Date.now() - started,
      error:
        error instanceof Error
          ? error.message.slice(0, 200)
          : "unknown storage error",
    };
  }
}
