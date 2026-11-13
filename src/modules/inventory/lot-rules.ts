/**
 * Lots (WMS-21, ADR 0040): the pure rules. No database.
 *
 * A lot is identified by its code inside its product. The code is kept
 * without extra spaces and in capitals, so «l-01» and «L-01 » are the same
 * lot. Its expiry date is a day of the calendar («2027-03-05»), never a
 * moment: a lot is good through that day and expired from the next.
 */

export const LOT_CODE_MAX = 64;

export type LotCodeResult =
  { ok: true; code: string } | { ok: false; error: string };

/** The code of a lot as it is kept, or why it cannot be one. */
export function normalizeLotCode(value: unknown): LotCodeResult {
  const text = String(value ?? "");
  if (/[\u0000-\u001f\u007f]/.test(text.trim())) {
    return { ok: false, error: "Quita los saltos de línea o tabuladores." };
  }
  const code = text.trim().replace(/\s+/g, " ").toUpperCase();
  if (code === "") return { ok: false, error: "Escribe el lote." };
  if (code.length > LOT_CODE_MAX) {
    return {
      ok: false,
      error: `El lote es demasiado largo (máximo ${LOT_CODE_MAX} caracteres).`,
    };
  }
  return { ok: true, code };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** «2027-03-05» when it is a real day of the calendar; null otherwise. */
export function parseLotDay(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = DAY.exec(text);
  if (!match) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // «2027-02-31» is read as March 3: not what was written.
  if (date.toISOString().slice(0, 10) !== text) return null;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2200 ? text : null;
}

/** A calendar day as the DATE column takes it. */
export const lotDayToDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** The calendar day of a DATE column. */
export const lotDayOf = (date: Date | null | undefined): string | null =>
  date ? date.toISOString().slice(0, 10) : null;

/** «05/03/2027». */
export function formatLotDay(day: string): string {
  const [year = "", month = "", date = ""] = day.split("-");
  return `${date}/${month}/${year}`;
}

/** Whole days from one calendar day to another (negative = already past). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (lotDayToDate(to).getTime() - lotDayToDate(from).getTime()) / 86_400_000,
  );
}

/** The day `days` after a calendar day. */
export function addDays(day: string, days: number): string {
  const date = lotDayToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A lot is good through its expiry day. */
export const isExpired = (expiresOn: string | null, today: string) =>
  expiresOn !== null && expiresOn < today;

/** «caducó hace 3 días», «caduca hoy», «caduca en 12 días». */
export function expiryText(expiresOn: string, today: string): string {
  const days = daysBetween(today, expiresOn);
  if (days < 0) {
    return days === -1 ? "caducó ayer" : `caducó hace ${-days} días`;
  }
  if (days === 0) return "caduca hoy";
  return days === 1 ? "caduca mañana" : `caduca en ${days} días`;
}

/** «Lote L-01 · caduca 05/03/2027», for selectors and summaries. */
export function lotLabel(lot: {
  code: string;
  expiresOn: string | null;
}): string {
  return lot.expiresOn
    ? `Lote ${lot.code} · caduca ${formatLotDay(lot.expiresOn)}`
    : `Lote ${lot.code}`;
}

export const PRODUCT_TRACKINGS = ["NONE", "LOT"] as const;
export type ProductTracking = (typeof PRODUCT_TRACKINGS)[number];

export const LOT_EXPIRY_RULES = ["NONE", "OPTIONAL", "REQUIRED"] as const;
export type LotExpiryRule = (typeof LOT_EXPIRY_RULES)[number];
