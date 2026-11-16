import "server-only";

import { newId } from "@/lib";
import { forOrganization, type TenantDb } from "@/server";

import { getFreshEntitlements, readLimit } from "./entitlements";

/**
 * Quota counters (MOD-07). One row per company and limit keeps how much is
 * taken: what exists plus what is reserved. Taking a place is one
 * conditional UPDATE (`taken <= limit - amount`), which the database runs
 * under a row lock: with 99 of 100, two simultaneous requests cannot both
 * win.
 *
 * Callers pass their own company client or transaction, so the counter and
 * the thing counted (a product, an invitation) are written together: if
 * the transaction fails, the place is not consumed.
 *
 * Reservations hold places for work that will finish later (an import):
 * `reserveQuota` → `confirmReservation` for each item created, and
 * `releaseReservation` for what was not used.
 */

/**
 * Limit keys counted here. The entitlement of the same key sets the limit,
 * except the storage of files (WMS-67, ADR 0070): counted in KiB, limited
 * by the entitlement `file_storage_gb` and, without one, by
 * `FILE_STORAGE_DEFAULT_GB`.
 */
export const QUOTA_KEYS = [
  "active_products",
  "users",
  "file_storage_kib",
] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];

/** Entitlement of the storage limit, in GB. */
export const FILE_STORAGE_LIMIT_KEY = "file_storage_gb";
/** What a company may keep in files when its plan does not say. */
export const FILE_STORAGE_DEFAULT_GB = 5;
/** Largest storage limit; its KiB still fit the INT of the counter. */
export const FILE_STORAGE_MAX_GB = 2000;
const KIB_PER_GB = 1024 * 1024;

/** KiB a file takes in the storage quota (rounded up, at least 1). */
export const storageKib = (bytes: number): number =>
  Math.max(1, Math.ceil(bytes / 1024));

/** Storage limit in GB from what the entitlement says (null = not said). */
export const storageLimitGb = (value: number | null): number =>
  Math.min(FILE_STORAGE_MAX_GB, value ?? FILE_STORAGE_DEFAULT_GB);

/** The limit a counter is compared with; null = the company has none. */
async function limitOf(
  client: QuotaClient,
  organizationId: string,
  key: QuotaKey,
): Promise<number | null> {
  if (key !== "file_storage_kib") {
    return readLimit(client, organizationId, key);
  }
  return (await storageGbOf(client, organizationId)) * KIB_PER_GB;
}

/**
 * GB of files of a company: what its plan says now; when nothing is in
 * force (a plan that ended), the last value it had, so a renewal or «Mi
 * plan» never shows less in silence; the default only for a company that
 * never had one (ADR 0070, review B2).
 */
export async function storageGbOf(
  client: Pick<TenantDb, "entitlement">,
  organizationId: string,
): Promise<number> {
  const now = await readLimit(client, organizationId, FILE_STORAGE_LIMIT_KEY);
  if (now !== null) return storageLimitGb(now);
  const last = await client.entitlement.findFirst({
    where: { organizationId, kind: "LIMIT", key: FILE_STORAGE_LIMIT_KEY },
    orderBy: [{ validFrom: "desc" }, { id: "desc" }],
    select: { value: true },
  });
  return storageLimitGb(last?.value ?? null);
}

/** A company client or one of its transactions. */
export type QuotaClient = Pick<TenantDb, "quotaUsage" | "entitlement">;

export type QuotaResult =
  | { ok: true }
  | {
      ok: false;
      reason: "limit_reached";
      /** Null when the company has no such limit granted. */
      limit: number | null;
      /** In use + reserved when the request was refused. */
      taken: number;
    };

function checkAmount(amount: number) {
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
    throw new Error(`Invalid quota amount ${amount}`);
  }
}

/**
 * Creates the counters of a company that do not exist yet. Call it where
 * a limit is granted (provisioning), with the company row locked, so the
 * counter is already there when the first product or person arrives.
 */
export async function ensureQuotaRows(
  client: {
    quotaUsage: {
      createMany(args: {
        data: { id: string; organizationId: string; key: string }[];
        skipDuplicates: true;
      }): PromiseLike<unknown>;
    };
  },
  organizationId: string,
  keys: readonly QuotaKey[] = QUOTA_KEYS,
): Promise<void> {
  await client.quotaUsage.createMany({
    data: keys.map((key) => ({ id: newId(), organizationId, key })),
    skipDuplicates: true,
  });
}

/**
 * Makes sure the counter exists before it is updated. It looks first and
 * inserts only when the row is missing: an `INSERT IGNORE` that finds the
 * row leaves a shared lock on it until the transaction ends, and two
 * transactions holding that lock deadlock when each goes on to update
 * the counter. Reading takes no lock, so in the normal case — the row
 * exists since the plan was set — nothing here can collide.
 */
async function ensureRow(
  client: QuotaClient,
  organizationId: string,
  key: QuotaKey,
) {
  const existing = await client.quotaUsage.findFirst({
    where: { key },
    select: { id: true },
  });
  if (existing) return;
  await client.quotaUsage.createMany({
    data: [{ id: newId(), organizationId, key }],
    skipDuplicates: true,
  });
}

/** Prisma's code for «deadlock or write conflict: retry the transaction». */
const WRITE_CONFLICT = "P2034";
const DEADLOCK_TRIES = 4;

/**
 * Runs `work` again when MySQL picks it as the victim of a deadlock. Only
 * outside a transaction: there each statement stands alone, nothing else was
 * undone and repeating it is what MySQL asks for. Inside the caller's
 * transaction the whole transaction is already rolled back, so the error
 * goes up untouched.
 *
 * It happens to the very first requests of a company whose counter does not
 * exist yet (one made before counters were created with the plan): several
 * arrive at once, each tries to create the row, and the ones that find it
 * keep a shared lock on it for an instant while another one is already
 * updating it (seen in CI, about 1 in 150 under stress).
 */
async function retryingDeadlock<T>(
  client: QuotaClient,
  work: () => Promise<T>,
): Promise<T> {
  const standalone =
    typeof (client as { $transaction?: unknown }).$transaction === "function";
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const conflict = (error as { code?: unknown }).code === WRITE_CONFLICT;
      if (!standalone || !conflict || attempt >= DEADLOCK_TRIES) throw error;
    }
  }
}

async function takenNow(client: QuotaClient, key: QuotaKey) {
  const row = await client.quotaUsage.findFirst({
    where: { key },
    select: { taken: true },
  });
  return row?.taken ?? 0;
}

async function take(
  client: QuotaClient,
  organizationId: string,
  key: QuotaKey,
  amount: number,
  reserve: boolean,
): Promise<QuotaResult> {
  checkAmount(amount);
  // Read with the client of the caller: inside a transaction, no second
  // connection is needed.
  const limit = await limitOf(client, organizationId, key);
  if (limit === null) {
    return { ok: false, reason: "limit_reached", limit, taken: 0 };
  }
  const updated = await retryingDeadlock(client, async () => {
    await ensureRow(client, organizationId, key);
    return client.quotaUsage.updateMany({
      where: { key, taken: { lte: limit - amount } },
      data: {
        taken: { increment: amount },
        ...(reserve ? { reserved: { increment: amount } } : {}),
      },
    });
  });
  if (updated.count === 1) return { ok: true };
  return {
    ok: false,
    reason: "limit_reached",
    limit,
    taken: await takenNow(client, key),
  };
}

/** Takes `amount` places for things created now (a new or reactivated product). */
export function consumeQuota(
  client: QuotaClient,
  organizationId: string,
  key: QuotaKey,
  amount = 1,
): Promise<QuotaResult> {
  return take(client, organizationId, key, amount, false);
}

/** Holds `amount` places for work that finishes later (a confirmed import). */
export function reserveQuota(
  client: QuotaClient,
  organizationId: string,
  key: QuotaKey,
  amount: number,
): Promise<QuotaResult> {
  return take(client, organizationId, key, amount, true);
}

/**
 * Turns reserved places into used ones, as each reserved item is created.
 * False when there were not that many reserved (nothing changes).
 */
export async function confirmReservation(
  client: QuotaClient,
  key: QuotaKey,
  amount = 1,
): Promise<boolean> {
  checkAmount(amount);
  const updated = await client.quotaUsage.updateMany({
    where: { key, reserved: { gte: amount } },
    data: { reserved: { decrement: amount } },
  });
  return updated.count === 1;
}

/** Gives back reserved places that were not used. False when there were not that many. */
export async function releaseReservation(
  client: QuotaClient,
  key: QuotaKey,
  amount: number,
): Promise<boolean> {
  checkAmount(amount);
  const updated = await client.quotaUsage.updateMany({
    where: { key, reserved: { gte: amount }, taken: { gte: amount } },
    data: { reserved: { decrement: amount }, taken: { decrement: amount } },
  });
  return updated.count === 1;
}

/**
 * Frees places in use (a product archived). False when that would free
 * more than is in use; reserved places are never freed this way.
 */
export async function releaseQuota(
  client: QuotaClient,
  key: QuotaKey,
  amount = 1,
): Promise<boolean> {
  checkAmount(amount);
  try {
    const updated = await client.quotaUsage.updateMany({
      where: { key, taken: { gte: amount } },
      data: { taken: { decrement: amount } },
    });
    return updated.count === 1;
  } catch (error) {
    // The database refuses to go below what is reserved.
    if (String(error).includes("quota_usage_values_check")) return false;
    throw error;
  }
}

export type QuotaUsageSummary = {
  /** Null when the company has no such limit granted. */
  limit: number | null;
  /** Things that exist and count. */
  used: number;
  /** Places held by work in progress. */
  reserved: number;
  /** Places left; 0 without a limit or when over it. */
  available: number;
};

/** Usage of one limit, for screens («Productos activos: 84 de 100»). */
export async function getQuotaUsage(
  organizationId: string,
  key: QuotaKey,
): Promise<QuotaUsageSummary> {
  const [entitlements, row] = await Promise.all([
    getFreshEntitlements(organizationId),
    forOrganization(organizationId).quotaUsage.findFirst({
      where: { key },
      select: { taken: true, reserved: true },
    }),
  ]);
  const limit =
    key === "file_storage_kib"
      ? (await storageGbOf(forOrganization(organizationId), organizationId)) *
        KIB_PER_GB
      : entitlements.limit(key);
  const taken = row?.taken ?? 0;
  const reserved = row?.reserved ?? 0;
  return {
    limit,
    used: taken - reserved,
    reserved,
    available: limit === null ? 0 : Math.max(0, limit - taken),
  };
}
