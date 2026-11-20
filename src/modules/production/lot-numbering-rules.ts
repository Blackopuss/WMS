/**
 * How a company names the lots it produces (WMS-29, ADR 0087; D8): prefix,
 * date, consecutive. Pure: no database.
 *
 *   «CR-» + «2611» + «-» + «0001» = «CR-2611-0001»
 *
 * Without a rule of its own a report's lot is «OP-0001-01» (the order and
 * the number of the report in it).
 */

export const LOT_DATE_FORMATS = ["NONE", "YYYY", "YYMM", "YYMMDD"] as const;
export type LotDateFormat = (typeof LOT_DATE_FORMATS)[number];
export const LOT_RESETS = ["NEVER", "YEAR", "MONTH"] as const;
export type LotReset = (typeof LOT_RESETS)[number];
export const LOT_SEQUENCE_SCOPES = ["PRODUCT", "COMPANY"] as const;
export type LotSequenceScope = (typeof LOT_SEQUENCE_SCOPES)[number];

export const LOT_DATE_LABELS: Record<LotDateFormat, string> = {
  NONE: "Sin fecha",
  YYYY: "Año (AAAA)",
  YYMM: "Año y mes (AAMM)",
  YYMMDD: "Año, mes y día (AAMMDD)",
};
export const LOT_RESET_LABELS: Record<LotReset, string> = {
  NEVER: "Nunca",
  YEAR: "Cada año",
  MONTH: "Cada mes",
};
export const LOT_SCOPE_LABELS: Record<LotSequenceScope, string> = {
  PRODUCT: "Cada producto",
  COMPANY: "Toda la empresa",
};

export type LotNumberingRule = {
  prefix: string;
  dateFormat: LotDateFormat;
  digits: number;
  resetEvery: LotReset;
  sequenceScope: LotSequenceScope;
};

export const PREFIX_PATTERN = /^[A-Za-z0-9-]{0,12}$/;

/** The part of the date, from a calendar day «2026-11-19». */
function datePart(format: LotDateFormat, day: string): string {
  const [year = "", month = "", date = ""] = day.split("-");
  switch (format) {
    case "NONE":
      return "";
    case "YYYY":
      return year;
    case "YYMM":
      return `${year.slice(2)}${month}`;
    case "YYMMDD":
      return `${year.slice(2)}${month}${date}`;
  }
}

/** The period a consecutive belongs to: '', «2026» or «202611». */
export function lotPeriod(reset: LotReset, day: string): string {
  const [year = "", month = ""] = day.split("-");
  if (reset === "YEAR") return year;
  if (reset === "MONTH") return `${year}${month}`;
  return "";
}

/** The code of a lot with this rule, on that day, with that number. */
export function formatLotCode(
  rule: LotNumberingRule,
  day: string,
  number: number,
): string {
  const date = datePart(rule.dateFormat, day);
  const consecutive = String(number).padStart(rule.digits, "0");
  return `${rule.prefix.toUpperCase()}${date ? `${date}-` : ""}${consecutive}`;
}

/** «OP-0001-01»: the lot of a report when the company has no rule. */
export function defaultLotCode(orderNumberText: string, report: number) {
  return `${orderNumberText}-${String(report).padStart(2, "0")}`;
}

/** «R-01». */
export function formatReportNumber(number: number): string {
  return `R-${String(number).padStart(2, "0")}`;
}
