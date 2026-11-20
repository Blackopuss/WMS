import { dec, type Decimal } from "@/lib";

/**
 * Pure rules of the warehouse indicators (WMS-32, ADR 0082): which days a
 * period covers, rotation and days of inventory, and medians of times.
 */

/** Longest period, in days of the company's calendar. */
export const KPI_MAX_DAYS = 92;

export const KPI_PRESETS = ["7", "30", "90", "mes", "anterior"] as const;
export type KpiPreset = (typeof KPI_PRESETS)[number];
export const KPI_DEFAULT_PRESET: KpiPreset = "30";

export type KpiPeriod = {
  /** First and last day, year-month-day. */
  from: string;
  to: string;
  /** The day after the last: the period is [from, next). */
  next: string;
  /** How many days it covers. */
  days: number;
  /** The preset used, or null when the days were written by hand. */
  preset: KpiPreset | null;
  /** The days written asked for more than `KPI_MAX_DAYS`: it was cut. */
  clipped: boolean;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real day written as year-month-day, or null. */
export function parseDay(value: unknown): string | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const probe = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(probe.getTime())) return null;
  return probe.toISOString().slice(0, 10) === value ? value : null;
}

/** A day moved some days: «2026-11-30» + 1 = «2026-12-01». */
export function shiftDay(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

/** Days from one day to another (to − from). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

function monthStart(day: string, by: number): string {
  const at = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + by);
  return at.toISOString().slice(0, 10);
}

/**
 * The period asked for in the address, relative to today (a day of the
 * company's calendar). Days written by hand win when both are valid, end
 * no later than today and the first is not after the last; otherwise the
 * preset, and an unknown preset is the default one.
 */
export function resolvePeriod(
  today: string,
  asked: { preset?: unknown; from?: unknown; to?: unknown },
): KpiPeriod {
  const from = parseDay(asked.from);
  const to = parseDay(asked.to);
  if (from && to && from <= to && to <= today) {
    const wanted = daysBetween(from, to) + 1;
    const clipped = wanted > KPI_MAX_DAYS;
    const first = clipped ? shiftDay(to, 1 - KPI_MAX_DAYS) : from;
    return {
      from: first,
      to,
      next: shiftDay(to, 1),
      days: daysBetween(first, to) + 1,
      preset: null,
      clipped,
    };
  }
  const preset: KpiPreset = KPI_PRESETS.includes(asked.preset as KpiPreset)
    ? (asked.preset as KpiPreset)
    : KPI_DEFAULT_PRESET;
  let first: string;
  let last = today;
  if (preset === "mes") {
    first = monthStart(today, 0);
  } else if (preset === "anterior") {
    first = monthStart(today, -1);
    last = shiftDay(monthStart(today, 0), -1);
  } else {
    first = shiftDay(today, 1 - Number(preset));
  }
  return {
    from: first,
    to: last,
    next: shiftDay(last, 1),
    days: daysBetween(first, last) + 1,
    preset,
    clipped: false,
  };
}

/**
 * Rotation of a product in a period: what left ÷ the average of the stock
 * it started and ended with. Null without average stock. Two decimals, but
 * a rotation above zero never reads as «0.00»: below 0.01 it keeps two
 * significant digits («0.0005»).
 */
export function rotationOf(
  exits: Decimal | string,
  start: Decimal | string,
  end: Decimal | string,
): string | null {
  const average = dec(start).plus(end).dividedBy(2);
  if (!average.greaterThan(0)) return null;
  const exact = dec(exits).dividedBy(average);
  if (exact.greaterThan(0) && exact.lessThan("0.01")) {
    return exact.toSignificantDigits(2).toFixed();
  }
  return exact.toFixed(2);
}

/**
 * Days the stock lasts at the pace of the period: days × average stock ÷
 * what left, with exact decimals (never from the rounded rotation); whole
 * days. Null when nothing left or there was no stock.
 */
export function daysOfInventory(
  days: number,
  exits: Decimal | string,
  start: Decimal | string,
  end: Decimal | string,
): string | null {
  const average = dec(start).plus(end).dividedBy(2);
  if (!dec(exits).greaterThan(0) || !average.greaterThan(0)) return null;
  return dec(days).times(average).dividedBy(exits).toFixed(0);
}

/** The value at a share (0 to 1) of sorted numbers, nearest rank. */
export function percentile(values: readonly number[], share: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** Median and 90th percentile of durations in milliseconds. */
export function timeFigures(durations: readonly number[]): {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
} {
  return {
    count: durations.length,
    medianMs: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
  };
}

/** Share of a whole, one decimal: «75.0»; null without a whole. */
export function shareOf(part: number, whole: number): string | null {
  return whole === 0 ? null : dec(part).times(100).dividedBy(whole).toFixed(1);
}

/** «1 h 20 min», «35 min», «2 d 4 h»: a duration for a person. */
export function durationText(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

/** The day of the company's calendar a moment falls on: «2026-11-12». */
export function calendarDay(at: Date, timeZone: string): string {
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

/**
 * An order left on time when the day of the company's calendar its
 * shipment left on is not after its day of departure (`dueOn`).
 */
export function shippedOnTime(
  shippedAt: Date | null,
  dueOn: string,
  timeZone: string,
): boolean {
  return shippedAt !== null && calendarDay(shippedAt, timeZone) <= dueOn;
}

/** Last day of the month a day is in: «2026-02-10» → «2026-02-28». */
function monthEnd(day: string): string {
  return shiftDay(monthStart(day, 1), -1);
}

/**
 * The period a period is compared with (WMS-34, ADR 0085): the same days
 * right before it; for «Mes anterior», the whole month before; for «Este
 * mes» (the 1st to today), the same days of the month before, never past
 * its end.
 */
export function previousPeriod(period: KpiPeriod): KpiPeriod {
  let from: string;
  let to: string;
  if (period.preset === "anterior") {
    from = monthStart(period.from, -1);
    to = monthEnd(from);
  } else if (period.preset === "mes") {
    from = monthStart(period.from, -1);
    const sameDays = shiftDay(from, period.days - 1);
    const end = monthEnd(from);
    to = sameDays < end ? sameDays : end;
  } else {
    to = shiftDay(period.from, -1);
    from = shiftDay(to, 1 - period.days);
  }
  return {
    from,
    to,
    next: shiftDay(to, 1),
    days: daysBetween(from, to) + 1,
    preset: null,
    clipped: false,
  };
}

/**
 * Change of a count against the previous period: «Subió 12 (25.0 %)»,
 * «Bajó 3», «Sin cambio». The share only when the previous is not zero.
 * Words, not «+»/«−»: a cell starting with a sign would reach a
 * spreadsheet as a neutralized formula («'+12»).
 */
export function countChange(now: number, before: number): string {
  const diff = now - before;
  if (diff === 0) return "Sin cambio";
  const verb = diff > 0 ? "Subió" : "Bajó";
  const text = `${verb} ${Math.abs(diff).toLocaleString("es-MX")}`;
  if (before === 0) return text;
  const share = dec(Math.abs(diff)).times(100).dividedBy(before).toFixed(1);
  return `${text} (${share} %)`;
}

/** Change of a share in points: «Subió 5.0 puntos»; «—» without one. */
export function shareChange(now: string | null, before: string | null) {
  if (now === null || before === null) return "—";
  const diff = dec(now).minus(before);
  if (diff.isZero()) return "Sin cambio";
  return `${diff.greaterThan(0) ? "Subió" : "Bajó"} ${diff.abs().toFixed(1)} puntos`;
}

/** Change of a time: «12 min más rápido», «1 h más lento»; «—» without one. */
export function timeChange(now: number | null, before: number | null) {
  if (now === null || before === null) return "—";
  const diff = now - before;
  if (Math.abs(diff) < 60_000) return "Sin cambio";
  return `${durationText(Math.abs(diff))} ${diff < 0 ? "más rápido" : "más lento"}`;
}
