import { dec, type Decimal } from "@/lib";

/**
 * Pure rules of a verification (WMS-30B, ADR 0091): where it comes from,
 * what may be decided and whether a decision adds up.
 */

export const INSPECTION_ORIGIN_KINDS = [
  "PRODUCTION",
  "RECEIPT",
  "CUSTOMER_RETURN",
  "OTHER",
] as const;
export type InspectionOriginKind = (typeof INSPECTION_ORIGIN_KINDS)[number];

export const ORIGIN_KIND_LABELS: Record<InspectionOriginKind, string> = {
  PRODUCTION: "Lo producido",
  RECEIPT: "Lo recibido de un proveedor",
  CUSTOMER_RETURN: "Lo devuelto por un cliente",
  OTHER: "Otro",
};

/** The origin of a plan (ADR 0067) for each kind; «Otro» has no plan. */
export const PLAN_ORIGIN: Record<
  InspectionOriginKind,
  "produced" | "received" | "returned" | null
> = {
  PRODUCTION: "produced",
  RECEIPT: "received",
  CUSTOMER_RETURN: "returned",
  OTHER: null,
};

/** States a verification may take stock from. */
export const INSPECTED_STATUSES = ["INSPECTION", "QUARANTINE"] as const;
export type InspectedStatus = (typeof INSPECTED_STATUSES)[number];

/** Where what is counted may end. */
export const INSPECTION_OUTCOMES = [
  "AVAILABLE",
  "REJECTED",
  "DAMAGED",
  "QUARANTINE",
  "REPAIR",
] as const;
export type InspectionOutcome = (typeof INSPECTION_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<InspectionOutcome, string> = {
  AVAILABLE: "Aprobadas",
  REJECTED: "Rechazadas (no cumplen)",
  DAMAGED: "Dañadas",
  QUARANTINE: "En cuarentena",
  REPAIR: "A restauración",
};

/** Why what was expected is not there (P4). */
export const MISSING_CAUSES = ["MERMA", "OVER_REPORTED", "OTHER"] as const;
export type MissingCause = (typeof MISSING_CAUSES)[number];

export const CAUSE_LABELS: Record<MissingCause, string> = {
  MERMA: "Merma (se rompieron o se perdieron)",
  OVER_REPORTED: "Eran menos desde el inicio",
  OTHER: "Otra causa",
};

/** The destinations a verification offers for its origin and state. */
export function outcomesFor(
  origin: InspectionOriginKind,
  status: InspectedStatus,
): InspectionOutcome[] {
  const all =
    origin === "CUSTOMER_RETURN"
      ? INSPECTION_OUTCOMES.filter((each) => each !== "QUARANTINE")
      : [...INSPECTION_OUTCOMES];
  return all.filter((each) => each !== status);
}

/** The causes of a missing piece a verification offers for its origin. */
export function causesFor(origin: InspectionOriginKind): MissingCause[] {
  if (origin === "CUSTOMER_RETURN") return [];
  if (origin === "PRODUCTION") return [...MISSING_CAUSES];
  return MISSING_CAUSES.filter((each) => each !== "OVER_REPORTED");
}

export const formatInspectionNumber = (number: number) =>
  `IN-${String(number).padStart(4, "0")}`;

/** «IN-0012», «in 12», «IN12» → 12; anything else, null. */
export function inspectionNumberOf(text: string): number | null {
  const match = /^\s*in[\s-]?0*(\d{1,7})\s*$/i.exec(text);
  return match ? Number(match[1]) : null;
}

export type DecisionTotals =
  | { ok: true; counted: Decimal; approved: Decimal; missing: Decimal }
  | { ok: false; error: string };

/**
 * Whether a decision adds up (PC-4): what was counted (the destinations)
 * plus what is missing (the causes) is exactly what was expected; nothing
 * is counted beyond it.
 */
export function decisionTotals(
  expected: Decimal | string,
  outcomes: readonly { status: InspectionOutcome; quantity: Decimal }[],
  missing: readonly { quantity: Decimal }[],
): DecisionTotals {
  const total = dec(expected.toString());
  const counted = outcomes.reduce(
    (sum, each) => sum.plus(each.quantity),
    dec(0),
  );
  const approved = outcomes
    .filter((each) => each.status === "AVAILABLE")
    .reduce((sum, each) => sum.plus(each.quantity), dec(0));
  const lost = missing.reduce((sum, each) => sum.plus(each.quantity), dec(0));
  if (counted.greaterThan(total)) {
    return {
      ok: false,
      error:
        "Contaste más de lo que se esperaba: desde aquí no se crean existencias. Avísale al encargado.",
    };
  }
  if (!counted.plus(lost).equals(total)) {
    return {
      ok: false,
      error: counted.plus(lost).lessThan(total)
        ? "Falta decidir parte de lo que se esperaba: reparte lo contado y di qué pasó con lo que falta."
        : "Lo que no está, más lo contado, pasa de lo que se esperaba.",
    };
  }
  return { ok: true, counted, approved, missing: lost };
}

/**
 * Whether the decision needs at least one photo: always when part of what
 * was expected is missing (a difference in the quantity, P4), when an
 * answered point asks for one, and when rejecting or putting in quarantine
 * if the company asks for it (`quality.evidence.photo`, ADR 0067).
 */
export function needsPhoto(input: {
  missing: Decimal;
  pointAsksPhoto: boolean;
  rejectsOrQuarantines: boolean;
  evidenceSetting: string;
}): boolean {
  if (input.missing.greaterThan(0)) return true;
  if (input.pointAsksPhoto) return true;
  return input.rejectsOrQuarantines && input.evidenceSetting === "required";
}
