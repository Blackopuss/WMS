/**
 * Rules of an inspection plan (WMS-30A, ADR 0067), pure: no database. What
 * a check point may hold, how big a sample is and whether an answer
 * passes. The services of the plans and, later, the inspection (WMS-30B)
 * use these and nothing else to decide.
 */
import {
  Decimal,
  dec,
  isAppError,
  parseDecimal,
  type DecimalInput,
} from "@/lib";

/** Check points a version may have. */
export const MAX_PLAN_POINTS = 30;
/** Options of a «one of a list» point. */
export const MAX_POINT_OPTIONS = 20;
/** Defects in use (not archived) a company may have. */
export const MAX_ACTIVE_DEFECTS = 100;

export const POINT_KINDS = ["CHECK", "NUMBER", "CHOICE", "TEXT"] as const;
export type PointKind = (typeof POINT_KINDS)[number];

export const POINT_KIND_LABELS: Record<PointKind, string> = {
  CHECK: "Sí o no",
  NUMBER: "Número con rango",
  CHOICE: "Opción de una lista",
  TEXT: "Texto",
};

export const SAMPLINGS = ["DEFAULT", "FULL", "SAMPLE"] as const;
export type PlanSampling = (typeof SAMPLINGS)[number];

export const SAMPLING_LABELS: Record<PlanSampling, string> = {
  DEFAULT: "Como diga el ajuste de la empresa",
  FULL: "Completa",
  SAMPLE: "Por muestra",
};

export const SAMPLE_RULES = ["FIXED", "PERCENT"] as const;
export type SampleRuleKind = (typeof SAMPLE_RULES)[number];

export const DEFECT_SEVERITIES = ["MINOR", "MAJOR", "CRITICAL"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const SEVERITY_LABELS: Record<DefectSeverity, string> = {
  MINOR: "Menor",
  MAJOR: "Mayor",
  CRITICAL: "Crítica",
};

/** Where what waits for verification comes from. */
export const INSPECTION_ORIGINS = ["produced", "received", "returned"] as const;
export type InspectionOrigin = (typeof INSPECTION_ORIGINS)[number];

export const ORIGIN_LABELS: Record<InspectionOrigin, string> = {
  produced: "Lo producido",
  received: "Lo recibido",
  returned: "Lo devuelto por clientes",
};

export type SampleRule =
  | { kind: "FIXED"; quantity: string }
  | { kind: "PERCENT"; percent: number; min: string; max: string | null };

/**
 * How the quality is checked once the company setting is applied: all of
 * it, or a sample. `rule: null` = sample without a size: who inspects says
 * how many they checked (ADR 0067).
 */
export type Sampling =
  { mode: "full" } | { mode: "sample"; rule: SampleRule | null };

/** Values of the setting `quality.sampling.default`. */
export type SamplingDefault = "full" | "sample";

/** The sampling of a plan with the company setting applied. */
export function resolveSampling(
  plan: { sampling: PlanSampling; rule: SampleRule | null } | null,
  settingValue: string,
): Sampling {
  if (plan?.sampling === "FULL") return { mode: "full" };
  if (plan?.sampling === "SAMPLE") {
    return { mode: "sample", rule: plan.rule };
  }
  return settingValue === "sample"
    ? { mode: "sample", rule: null }
    : { mode: "full" };
}

/** Rounds up to a multiple of `step` (the increment of the product). */
function ceilToStep(value: Decimal, step: Decimal): Decimal {
  return value.div(step).ceil().times(step);
}

/**
 * How much of `quantity` is checked with `rule`: a fixed amount, or the
 * percentage rounded up to the product's step, at least the minimum and at
 * most the cap; never more than there is.
 */
export function sampleSize(
  rule: SampleRule,
  quantity: DecimalInput,
  step: DecimalInput,
): Decimal {
  const total = dec(quantity);
  if (total.lte(0)) return dec(0);
  const increment = dec(step);
  // Every amount goes up to the step of the product as it is today: a
  // rule saved with another step never asks for «2.5 piezas».
  let size: Decimal;
  if (rule.kind === "FIXED") {
    size = ceilToStep(dec(rule.quantity), increment);
  } else {
    size = ceilToStep(total.times(rule.percent).div(100), increment);
    const min = ceilToStep(dec(rule.min), increment);
    if (size.lt(min)) size = min;
    if (rule.max !== null) {
      const max = ceilToStep(dec(rule.max), increment);
      if (size.gt(max)) size = max;
    }
  }
  return Decimal.min(size, total);
}

/** One line, without repeated spaces. */
export function cleanText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compares names as the database does: without capitals or accents. */
export function foldText(text: string): string {
  return cleanText(text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Decimals kept for the range of a number point. */
const RANGE_SCALE = 4;
/** Decimals accepted in an answer (what an instrument shows). */
const ANSWER_SCALE = 10;
const RANGE_MAX = new Decimal("999999999999999");

/**
 * A number typed by a person, or null when empty. The decimal separator is
 * the point; a comma is refused instead of guessed («0,500» could be half
 * or five hundred).
 */
function parseNumber(
  raw: unknown,
  scale: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = cleanText(raw);
  if (text === "") return { ok: true, value: null };
  if (text.includes(",")) {
    return {
      ok: false,
      error:
        "Usa punto para los decimales y sin separar miles, por ejemplo 1250.5.",
    };
  }
  try {
    const value = parseDecimal(text, { maxScale: scale, allowNegative: true });
    if (value.abs().gt(RANGE_MAX)) {
      return { ok: false, error: "El número es demasiado grande." };
    }
    return { ok: true, value: value.toString() };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      ok: false,
      error:
        error.code === "decimal.too_many_decimals"
          ? `Usa como máximo ${scale} decimales.`
          : "Escribe un número, por ejemplo 12.5 o -4.",
    };
  }
}

/** A limit of the range of a number point, or null when empty. */
export function parseRangeValue(raw: unknown) {
  return parseNumber(raw, RANGE_SCALE);
}

export type PointInput = {
  label?: unknown;
  kind?: unknown;
  required?: unknown;
  photo?: unknown;
  minValue?: unknown;
  maxValue?: unknown;
  unitLabel?: unknown;
  /** Options that pass, one per line. */
  passOptions?: unknown;
  /** Options that do not pass, one per line. */
  failOptions?: unknown;
};

export type PointField = "label" | "kind" | "range" | "unit" | "options";

export type ParsedPoint = {
  label: string;
  kind: PointKind;
  required: boolean;
  photo: boolean;
  minValue: string | null;
  maxValue: string | null;
  unitLabel: string | null;
  options: { label: string; acceptable: boolean }[];
};

function lines(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map(cleanText)
    .filter((line) => line !== "");
}

/**
 * Reads a check point as typed: a name, a kind and what passes. A number
 * has a minimum, a maximum or both; a list has at least two options and at
 * least one that passes; yes-or-no and text carry nothing else.
 */
export function parsePoint(
  input: PointInput,
):
  | { ok: true; point: ParsedPoint }
  | { ok: false; error: string; field: PointField } {
  const label = cleanText(input.label);
  if (label === "") {
    return { ok: false, field: "label", error: "Escribe qué se revisa." };
  }
  if (label.length > 80) {
    return {
      ok: false,
      field: "label",
      error: "Usa como máximo 80 caracteres.",
    };
  }
  const kind = String(input.kind ?? "") as PointKind;
  if (!POINT_KINDS.includes(kind)) {
    return { ok: false, field: "kind", error: "Elige qué se anota." };
  }
  const point: ParsedPoint = {
    label,
    kind,
    required: input.required === true,
    photo: input.photo === true,
    minValue: null,
    maxValue: null,
    unitLabel: null,
    options: [],
  };
  if (kind === "NUMBER") {
    const min = parseRangeValue(input.minValue);
    if (!min.ok) return { ok: false, field: "range", error: min.error };
    const max = parseRangeValue(input.maxValue);
    if (!max.ok) return { ok: false, field: "range", error: max.error };
    if (min.value === null && max.value === null) {
      return {
        ok: false,
        field: "range",
        error: "Escribe el mínimo, el máximo o los dos.",
      };
    }
    if (
      min.value !== null &&
      max.value !== null &&
      dec(min.value).gt(max.value)
    ) {
      return {
        ok: false,
        field: "range",
        error: "El mínimo no puede ser mayor que el máximo.",
      };
    }
    const unit = cleanText(input.unitLabel);
    if (unit.length > 20) {
      return {
        ok: false,
        field: "unit",
        error: "Usa como máximo 20 caracteres.",
      };
    }
    point.minValue = min.value;
    point.maxValue = max.value;
    point.unitLabel = unit === "" ? null : unit;
  }
  if (kind === "CHOICE") {
    const seen = new Set<string>();
    const passing = new Set<string>();
    let both: string | null = null;
    const add = (raw: unknown, acceptable: boolean) => {
      for (const option of lines(raw)) {
        if (option.length > 60) return option;
        const key = foldText(option);
        if (!acceptable && passing.has(key)) both ??= option;
        if (seen.has(key)) continue;
        seen.add(key);
        if (acceptable) passing.add(key);
        point.options.push({ label: option, acceptable });
      }
      return null;
    };
    const tooLong =
      add(input.passOptions, true) ?? add(input.failOptions, false);
    if (!tooLong && both) {
      return {
        ok: false,
        field: "options",
        error: `«${both}» está en las dos listas: déjalo solo en una.`,
      };
    }
    if (tooLong) {
      return {
        ok: false,
        field: "options",
        error: `«${tooLong.slice(0, 30)}…»: usa como máximo 60 caracteres por opción.`,
      };
    }
    if (!point.options.some((option) => option.acceptable)) {
      return {
        ok: false,
        field: "options",
        error: "Escribe al menos una opción que cumple.",
      };
    }
    if (point.options.length < 2) {
      return {
        ok: false,
        field: "options",
        error: "Una lista lleva al menos dos opciones.",
      };
    }
    if (point.options.length > MAX_POINT_OPTIONS) {
      return {
        ok: false,
        field: "options",
        error: `Una lista admite hasta ${MAX_POINT_OPTIONS} opciones.`,
      };
    }
  }
  return { ok: true, point };
}

/** A check point as WMS-30B reads it. */
export type PlanPoint = {
  id: string;
  label: string;
  kind: PointKind;
  required: boolean;
  photo: boolean;
  minValue: string | null;
  maxValue: string | null;
  unitLabel: string | null;
  options: { id: string; label: string; acceptable: boolean }[];
};

/** «skipped»: an optional point left without answer. */
export type Judgement = "pass" | "fail" | "noted" | "skipped";

/**
 * Whether an answer to a point passes: yes-or-no passes with «yes», a
 * number inside its range (ends included), an option marked as passing; a
 * text answer is only noted. An empty answer is refused when the point is
 * required and skipped when it is not. The answer comes as typed:
 * «yes»/«no», a number with a point for decimals (up to 10), the id of an
 * option or a note.
 */
export function judgeAnswer(
  point: PlanPoint,
  raw: string,
): { ok: true; result: Judgement } | { ok: false; error: string } {
  const answer = cleanText(raw);
  if (answer === "") {
    return point.required
      ? { ok: false, error: "Este punto es obligatorio." }
      : { ok: true, result: "skipped" };
  }
  switch (point.kind) {
    case "CHECK":
      if (answer !== "yes" && answer !== "no") {
        return { ok: false, error: "Elige sí o no." };
      }
      return { ok: true, result: answer === "yes" ? "pass" : "fail" };
    case "NUMBER": {
      const parsed = parseNumber(answer, ANSWER_SCALE);
      if (!parsed.ok) return parsed;
      const value = dec(parsed.value!);
      const below = point.minValue !== null && value.lt(point.minValue);
      const above = point.maxValue !== null && value.gt(point.maxValue);
      return { ok: true, result: below || above ? "fail" : "pass" };
    }
    case "CHOICE": {
      const option = point.options.find((each) => each.id === answer);
      if (!option) return { ok: false, error: "Elige una de las opciones." };
      return { ok: true, result: option.acceptable ? "pass" : "fail" };
    }
    case "TEXT":
      if (answer.length > 500) {
        return { ok: false, error: "Usa como máximo 500 caracteres." };
      }
      return { ok: true, result: "noted" };
  }
}

/** «Mínimo 2 · máximo 5 mm», for screens. */
export function rangeText(point: {
  minValue: string | null;
  maxValue: string | null;
  unitLabel: string | null;
}): string {
  const unit = point.unitLabel ? ` ${point.unitLabel}` : "";
  if (point.minValue !== null && point.maxValue !== null) {
    return `De ${point.minValue} a ${point.maxValue}${unit}`;
  }
  if (point.minValue !== null) return `Al menos ${point.minValue}${unit}`;
  return `Como mucho ${point.maxValue}${unit}`;
}
