import "server-only";

import { DEFAULT_TIME_ZONE } from "@/lib";
import type { forOrganization } from "@/server";

import { startOfDay } from "./movements";

/**
 * A day of the company's calendar (its time zone) as the moments it starts
 * and ends at: what «today» or «that day» means in a count or a filter
 * (WMS-73). Never a day of UTC.
 */
export type DayWindow = {
  /** «2026-11-12». */
  day: string;
  /** For a Prisma filter on a date column. */
  range: { gte: Date; lt: Date };
};

type Client = Pick<ReturnType<typeof forOrganization>, "membership">;

/** The calendar day of a moment in a time zone: «2026-11-12». */
function dayOf(at: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

/** The day after, as a date of the calendar. */
function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The window of a day of the company: of the day a moment falls in, or of
 * a day written as year-month-day (from an address). Null when what was
 * written is not a day.
 */
export async function dayWindow(
  client: Client,
  of: Date | string,
): Promise<DayWindow | null> {
  const membership = await client.membership.findFirst({
    select: { organization: { select: { timeZone: true } } },
  });
  const timeZone = membership?.organization.timeZone ?? DEFAULT_TIME_ZONE;
  let day: string;
  if (typeof of === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(of)) return null;
    // A day that does not exist (month 13, day 45) is not a day.
    const probe = new Date(`${of}T00:00:00Z`);
    if (
      Number.isNaN(probe.getTime()) ||
      probe.toISOString().slice(0, 10) !== of
    ) {
      return null;
    }
    day = of;
  } else {
    day = dayOf(of, timeZone);
  }
  const start = startOfDay(day, timeZone);
  const end = startOfDay(nextDay(day), timeZone);
  if (!start || !end) return null;
  return { day, range: { gte: start, lt: end } };
}
