import "server-only";

import { dec, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  activeFacilityOf,
  isLimited,
  locationScopeWhere,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { dayWindow } from "./calendar-day";
import { shiftDay } from "./cycle-counts";
import { formatValue, mayReadInventoryCosts } from "./inventory-value";
import type { InventoryActor } from "./movements";

/**
 * Inventory accuracy (WMS-55, ADR 0050), derived from the counts applied in
 * a period of the company's calendar, in the warehouse the person works in
 * and inside their scope. A row is a counted product + location + lot (a
 * line of a count): exact when what was counted equals what the system had
 * when it was counted (INV-32). Nothing is stored.
 *
 * The value of the differences is what the adjustments of those counts
 * moved, at the cost each line was written with; only for who sees costs
 * (the field does not exist for the others).
 */

export type AccuracyPeriod = "week" | "month";

/** Rows of a period read at most; beyond, the figures say so. */
export const ACCURACY_MAX_ROWS = 20_000;

export type AccuracyFigures = {
  /** First and last day of the period: «2026-11-09», «2026-11-15». */
  from: string;
  to: string;
  /** Counts applied in the period. */
  counts: number;
  /** Rows counted, and of those, how many matched. */
  rows: number;
  exact: number;
  /** «80.0» (per cent), or null without rows. */
  accuracy: string | null;
  /** «$1,250.00»: sum of the differences, at cost. Only with costs. */
  differenceValue?: string;
  /** More rows than the cap: the figures leave some out. */
  truncated: boolean;
};

export type CountAccuracy = {
  period: AccuracyPeriod;
  current: AccuracyFigures;
  previous: AccuracyFigures;
  /** Points of change against the previous period: «+5.0», «-2.5». */
  change: string | null;
};

/** Monday of the week of a day (weeks start on Monday). */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

/** First day of the month a number of months away: «2026-11-01». */
function monthStart(day: string, by: number): string {
  const at = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + by);
  return at.toISOString().slice(0, 10);
}

/** The days of the current and previous period, as [first, next) pairs. */
export function accuracyPeriods(
  today: string,
  period: AccuracyPeriod,
): { current: [string, string]; previous: [string, string] } {
  if (period === "week") {
    const monday = mondayOf(today);
    return {
      current: [monday, shiftDay(monday, 7)],
      previous: [shiftDay(monday, -7), monday],
    };
  }
  return {
    current: [monthStart(today, 0), monthStart(today, 1)],
    previous: [monthStart(today, -1), monthStart(today, 0)],
  };
}

export async function getCountAccuracy(
  actor: InventoryActor,
  options: { period?: unknown; programId?: unknown; now?: Date } = {},
): Promise<CountAccuracy> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.count_accuracy.read",
  );
  const period: AccuracyPeriod = options.period === "month" ? "month" : "week";
  const programId =
    typeof options.programId === "string" && options.programId
      ? options.programId.slice(0, 36)
      : null;
  const client = forOrganization(actor.organizationId);
  const [today, facility, scoped, costs] = await Promise.all([
    dayWindow(client, options.now ?? new Date()),
    activeFacilityOf(client, actor.userId),
    locationScopeWhere(client, actor.userId),
    mayReadInventoryCosts(actor),
  ]);
  if (!today) throw new Error("Unreadable day for accuracy");
  const days = accuracyPeriods(today.day, period);

  async function figures([first, next]: [string, string]) {
    const [start, end] = await Promise.all([
      dayWindow(client, first),
      dayWindow(client, next),
    ]);
    if (!start || !end) throw new Error("Unreadable period for accuracy");
    const counts = await client.stockCount.findMany({
      where: {
        status: "APPLIED",
        closedAt: { gte: start.range.gte, lt: end.range.gte },
        location: {
          facilityId: facility.id,
          ...(isLimited(scoped) ? scoped : {}),
        },
        ...(programId ? { programId } : {}),
      },
      orderBy: { id: "asc" },
      take: ACCURACY_MAX_ROWS,
      select: { id: true, appliedMovementId: true },
    });
    let rows = 0;
    let exact = 0;
    let truncated = counts.length >= ACCURACY_MAX_ROWS;
    for (let start = 0; start < counts.length && !truncated; start += 500) {
      const lines = await client.stockCountLine.findMany({
        where: {
          countId: {
            in: counts.slice(start, start + 500).map((count) => count.id),
          },
        },
        orderBy: { id: "asc" },
        take: ACCURACY_MAX_ROWS - rows + 1,
        select: {
          systemQuantity: true,
          captures: { select: { baseQuantity: true } },
        },
      });
      for (const line of lines) {
        if (rows >= ACCURACY_MAX_ROWS) {
          truncated = true;
          break;
        }
        rows += 1;
        const counted = line.captures.reduce(
          (sum, capture) => sum.plus(capture.baseQuantity.toString()),
          dec(0),
        );
        if (counted.equals(line.systemQuantity.toString())) exact += 1;
      }
    }
    let differenceValue: Decimal | null = null;
    if (costs) {
      differenceValue = dec(0);
      const movements = counts
        .map((count) => count.appliedMovementId)
        .filter((id): id is string => id !== null);
      for (let start = 0; start < movements.length; start += 500) {
        const lines = await client.stockMovementLine.findMany({
          where: { movementId: { in: movements.slice(start, start + 500) } },
          select: { baseQuantity: true, unitCost: true },
        });
        for (const line of lines) {
          differenceValue = differenceValue.plus(
            dec(line.baseQuantity.toString()).times(
              (line.unitCost ?? 0).toString(),
            ),
          );
        }
      }
    }
    const result: AccuracyFigures = {
      from: first,
      to: shiftDay(next, -1),
      counts: counts.length,
      rows,
      exact,
      accuracy:
        rows === 0 ? null : dec(exact).times(100).dividedBy(rows).toFixed(1),
      truncated,
    };
    if (differenceValue) result.differenceValue = formatValue(differenceValue);
    return result;
  }

  const [current, previous] = await Promise.all([
    figures(days.current),
    figures(days.previous),
  ]);
  const change =
    current.accuracy !== null && previous.accuracy !== null
      ? (() => {
          const points = dec(current.accuracy).minus(previous.accuracy);
          return `${points.isNegative() ? "" : "+"}${points.toFixed(1)}`;
        })()
      : null;
  return { period, current, previous, change };
}
