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
): boolean {
  return (
    !lastActiveAt ||
    now.getTime() - lastActiveAt.getTime() >= SESSION_ACTIVITY_INTERVAL_MS
  );
}

/**
 * Writes the activity of one session if it is stale. One row by primary
 * key, no transaction; the condition makes two requests at once write
 * once. Returns whether it wrote.
 */
export async function recordSessionActivity(
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - SESSION_ACTIVITY_INTERVAL_MS);
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
 * shown.
 */
export function noteSessionActivity(
  sessionId: string,
  lastActiveAt: Date | null | undefined,
): void {
  if (!activityIsStale(lastActiveAt)) return;
  try {
    after(async () => {
      try {
        await recordSessionActivity(sessionId);
      } catch (error) {
        log.warn("session.activity_failed", { error: String(error) });
      }
    });
  } catch {
    // Outside a request: nothing to note.
  }
}
