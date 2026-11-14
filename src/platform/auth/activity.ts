import "server-only";

import { after } from "next/server";

import { log } from "@/lib";
import { db } from "@/server";

/**
 * Last activity of a session (WMS-40, ADR 0059). Better Auth only touches
 * the session row once a day (`updateAge`), so the row keeps its own
 * `lastActiveAt`, written at most every SESSION_ACTIVITY_INTERVAL_MS and
 * always after the response: never a write per request, never a lock that
 * holds a screen back.
 */

/** «Última actividad» may lag this much behind. */
export const SESSION_ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;

/** True when the stored activity is missing or older than the interval. */
export function activityIsStale(
  lastActiveAt: Date | null | undefined,
  now: Date = new Date(),
  intervalMs: number = SESSION_ACTIVITY_INTERVAL_MS,
): boolean {
  return !lastActiveAt || now.getTime() - lastActiveAt.getTime() >= intervalMs;
}

/**
 * Writes the activity of one session if it is stale. One row by primary
 * key, no transaction; the condition makes two requests at once write
 * once. Returns whether it wrote.
 */
export async function recordSessionActivity(
  sessionId: string,
  now: Date = new Date(),
  intervalMs: number = SESSION_ACTIVITY_INTERVAL_MS,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - intervalMs);
  const { count } = await db.session.updateMany({
    where: {
      id: String(sessionId),
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lte: cutoff } }],
    },
    data: { lastActiveAt: now },
  });
  return count === 1;
}

/**
 * Called by the request guard with what it already read from the session
 * row (no extra query). Schedules the write after the response; outside a
 * request (tests, scripts) it does nothing. A failure is logged, never
 * shown. A PIN session of a shared terminal passes a shorter interval
 * (WMS-38): its inactivity closes it.
 */
export function noteSessionActivity(
  sessionId: string,
  lastActiveAt: Date | null | undefined,
  intervalMs: number = SESSION_ACTIVITY_INTERVAL_MS,
): void {
  if (!activityIsStale(lastActiveAt, new Date(), intervalMs)) return;
  try {
    after(async () => {
      try {
        await recordSessionActivity(sessionId, new Date(), intervalMs);
      } catch (error) {
        log.warn("session.activity_failed", { error: String(error) });
      }
    });
  } catch {
    // Outside a request: nothing to note.
  }
}
