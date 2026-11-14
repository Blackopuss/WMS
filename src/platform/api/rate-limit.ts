import "server-only";

import { db } from "@/server";

/**
 * Calls per minute of an API key and of its company (WMS-60, ADR 0058).
 * Fixed window, one row per counter (`api_rate_window`), reused in each
 * window: nothing to clean. Every step is one statement on one row in
 * autocommit, so two calls never wait on each other's rows (IMP-S13) and
 * nothing is read before it is counted:
 *
 * 1. count one more while the window is open and below the maximum;
 * 2. else, start a new window over an expired one;
 * 3. else, create the row; if it exists, the window is full.
 */
export const RATE_WINDOW_MS = 60_000;

export type RateDecision = { ok: true } | { ok: false; retryAfter: number };

export async function takeRateWindow(
  key: string,
  max: number,
  options: { now?: Date; windowMs?: number } = {},
): Promise<RateDecision> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  const openSince = new Date(now.getTime() - windowMs);
  for (let attempt = 0; attempt < 3; attempt++) {
    const counted = await db.apiRateWindow.updateMany({
      where: { key, windowStart: { gt: openSince }, count: { lt: max } },
      data: { count: { increment: 1 } },
    });
    if (counted.count === 1) return { ok: true };
    const restarted = await db.apiRateWindow.updateMany({
      where: { key, windowStart: { lte: openSince } },
      data: { windowStart: now, count: 1 },
    });
    if (restarted.count === 1) return { ok: true };
    const row = await db.apiRateWindow.findUnique({
      where: { key },
      select: { windowStart: true, count: true },
    });
    if (row) {
      if (row.windowStart.getTime() <= openSince.getTime()) continue;
      // The window is open and has room: another call restarted it (or
      // counted) between the two updates above. Count again; answering
      // «limited» here would refuse calls that are within the limit every
      // time a window ends under load.
      if (row.count < max) continue;
      const ends = row.windowStart.getTime() + windowMs;
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((ends - now.getTime()) / 1000)),
      };
    }
    try {
      await db.apiRateWindow.create({
        data: { key, windowStart: now, count: 1 },
      });
      return { ok: true };
    } catch (error) {
      // Created at the same moment by another call: count again.
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  return { ok: false, retryAfter: 1 };
}

/** The counter of a key and of a company. */
export const rateKeys = {
  key: (keyId: string) => `api:key:${keyId}`,
  company: (organizationId: string) => `api:org:${organizationId}`,
};
