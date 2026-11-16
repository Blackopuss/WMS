import "server-only";

import { existsSync } from "node:fs";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { recentErrorCount } from "@/lib";
import { db } from "@/server";

/**
 * Health of the installation (BAS-11, PIL-04), for an uptime monitor that
 * polls /api/salud: database, worker, queue, last backup and errors. It
 * answers with states only (never data of a company) and reads across
 * companies on purpose: it is operations, not business data.
 */

export type CheckState = "ok" | "falla" | "sin_configurar";
export type Health = {
  ok: boolean;
  checks: {
    database: CheckState;
    worker: CheckState;
    queue: CheckState;
    backup: CheckState;
    errors: CheckState;
    /** Files storage (WMS-67): what the worker's last probe said. */
    storage: CheckState;
  };
};

/** The worker writes its heartbeat this often; older than this is down. */
export const HEARTBEAT_EVERY_MS = 15_000;
export const WORKER_DOWN_AFTER_MS = 2 * 60 * 1000;
/** A job ready to run that nobody took in this long: the queue is stuck. */
export const QUEUE_STUCK_AFTER_MS = 10 * 60 * 1000;
/** Backups run daily; a missed one shows after this. */
export const BACKUP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
/** The worker probes the storage of files this often (WMS-67). */
export const STORAGE_CHECK_EVERY_MS = 5 * 60 * 1000;
/** A probe older than this does not say the storage answers. */
export const STORAGE_CHECK_STALE_AFTER_MS = 15 * 60 * 1000;
/** A cleanup note older than this says the storage does not clean up. */
export const STORAGE_CLEANUP_STUCK_MS = 24 * 60 * 60 * 1000;
/** Errors in 15 minutes from which the server counts as failing. */
export const ERROR_ALERT_THRESHOLD = 20;

export function heartbeatFile(): string {
  return (
    process.env.WORKER_HEARTBEAT_FILE ??
    path.join(process.cwd(), ".local", "worker-heartbeat.json")
  );
}

/** Called by the worker on a timer: «I am alive». */
export async function writeWorkerHeartbeat(workerId: string): Promise<void> {
  const file = heartbeatFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ workerId, at: new Date().toISOString() }),
  );
}

function storageCheckFile(): string {
  return path.join(path.dirname(heartbeatFile()), "almacenamiento.json");
}

/**
 * Called by the worker after probing the storage (`pingStorage` of
 * platform/files): never a request of a person. Only the state, the driver
 * and the time; the reason goes to the log, not to /api/salud.
 */
export async function writeStorageCheck(probe: {
  ok: boolean;
  driver: string;
  ms: number;
}): Promise<void> {
  const file = storageCheckFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      ok: probe.ok,
      driver: probe.driver,
      ms: probe.ms,
      at: new Date().toISOString(),
    }),
  );
}

async function storageState(now: number): Promise<CheckState> {
  let saved: { ok?: unknown; at?: unknown };
  try {
    saved = JSON.parse(await readFile(storageCheckFile(), "utf8"));
  } catch {
    return "sin_configurar";
  }
  const at = Date.parse(String(saved.at ?? ""));
  if (Number.isNaN(at) || now - at > STORAGE_CHECK_STALE_AFTER_MS) {
    return "falla";
  }
  return saved.ok === true ? "ok" : "falla";
}

async function lastHeartbeat(): Promise<number | null> {
  try {
    const { at } = JSON.parse(await readFile(heartbeatFile(), "utf8")) as {
      at?: string;
    };
    const time = Date.parse(at ?? "");
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

/** Mark left by a backup that failed, next to the status file. */
function backupFailedFile(statusFile: string): string {
  return `${statusFile}.fallido`;
}

async function lastBackup(): Promise<number | null | undefined> {
  const file = process.env.BACKUP_STATUS_FILE;
  if (!file) return undefined;
  try {
    // `respaldo` leaves this mark when it fails (PIL-04): alert now, not
    // when the last good one gets old. The next good backup removes it.
    if (existsSync(backupFailedFile(file))) return null;
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export async function checkHealth(now = Date.now()): Promise<Health> {
  let database: CheckState = "ok";
  let queue: CheckState = "ok";
  try {
    await db.$queryRaw`SELECT 1`;
    const waiting = await db.job.findFirst({
      where: {
        status: "PENDING",
        runAt: { lte: new Date(now - QUEUE_STUCK_AFTER_MS) },
      },
      select: { id: true },
    });
    queue = waiting ? "falla" : "ok";
  } catch {
    database = "falla";
    queue = "falla";
  }

  const beat = await lastHeartbeat();
  const worker: CheckState =
    beat !== null && now - beat < WORKER_DOWN_AFTER_MS ? "ok" : "falla";

  const backupAt = await lastBackup();
  const backup: CheckState =
    backupAt === undefined
      ? "sin_configurar"
      : backupAt !== null && now - backupAt < BACKUP_STALE_AFTER_MS
        ? "ok"
        : "falla";

  const errors: CheckState =
    recentErrorCount(now) >= ERROR_ALERT_THRESHOLD ? "falla" : "ok";

  let storage = await storageState(now);
  // Bytes waiting to be removed for more than a day (ADR 0070, review B6):
  // the storage answers the probe but does not clean up (a bucket lock, a
  // token without delete). A small table, read across companies.
  if (storage === "ok" && database === "ok") {
    try {
      const stuck = await db.storageCleanup.findFirst({
        where: { createdAt: { lt: new Date(now - STORAGE_CLEANUP_STUCK_MS) } },
        select: { id: true },
      });
      if (stuck) storage = "falla";
    } catch {
      storage = "falla";
    }
  }

  const checks = { database, worker, queue, backup, errors, storage };
  return {
    ok: Object.values(checks).every((state) => state !== "falla"),
    checks,
  };
}
