/**
 * Capacity and restrictions of a location (WMS-22B, ADR 0039). Pure rules,
 * shared by the services, the screens and the tests.
 *
 * A capacity has up to three limits, each optional: units (the quantities
 * of every product added up, each in its own unit), weight in kilograms and
 * volume in cubic meters. A limit of a location counts everything inside
 * it, its descendants included.
 */
import { dec, formatDecimal, isAppError, parseDecimal } from "@/lib";

export const CAPACITY_MEASURES = ["units", "weight", "volume"] as const;
export type CapacityMeasure = (typeof CAPACITY_MEASURES)[number];

/** The limits of a location; null = no limit in that measure. */
export type CapacityLimits = Record<CapacityMeasure, string | null>;

export const NO_CAPACITY: CapacityLimits = {
  units: null,
  weight: null,
  volume: null,
};

/** Largest capacity accepted: beyond it, it is a typing mistake. */
export const MAX_CAPACITY = "999999999999.999";

/** Decimals of a capacity: grams, liters, thousandths of a unit. */
export const CAPACITY_SCALE = 3;

/** Products a location may be limited to. */
export const MAX_RESTRICTED_PRODUCTS = 200;

/** Liters in a cubic meter: products say liters, locations cubic meters. */
export const LITERS_PER_CUBIC_METER = 1000;

/**
 * A limit as typed: empty = no limit; otherwise a number greater than
 * zero with up to three decimals («500», «1,250.5»).
 */
export function parseCapacity(
  text: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return { ok: true, value: null };
  try {
    const value = parseDecimal(raw, {
      maxScale: CAPACITY_SCALE,
      allowZero: false,
    });
    if (value.greaterThan(MAX_CAPACITY)) {
      return { ok: false, error: "Esa cantidad es demasiado grande." };
    }
    return { ok: true, value: value.toString() };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      ok: false,
      error:
        error.code === "decimal.too_many_decimals"
          ? `Usa como máximo ${CAPACITY_SCALE} decimales.`
          : "Escribe un número mayor que cero, o déjalo vacío si no hay límite.",
    };
  }
}

/**
 * «500 unidades», «1 unidad», «1,250.5 kg», «2.4 m³». Rounded for people
 * to `scale` decimals; what is kept and compared is always exact.
 */
export function formatCapacityAmount(
  measure: CapacityMeasure,
  amount: string,
  scale: number = CAPACITY_SCALE,
): string {
  const value = dec(amount).toDecimalPlaces(scale);
  const text = formatDecimal(value);
  if (measure === "weight") return `${text} kg`;
  if (measure === "volume") return `${text} m³`;
  return `${text} ${value.equals(1) ? "unidad" : "unidades"}`;
}

/**
 * Decimals to show an amount with next to a limit: the usual three, or as
 * many as it takes so that a little over never reads as exactly full.
 */
export function scaleToTell(amount: string, limit: string): number {
  const exact = dec(amount);
  const max = dec(limit);
  let scale = CAPACITY_SCALE;
  while (
    scale < 9 &&
    !exact.equals(max) &&
    exact.toDecimalPlaces(scale).equals(max)
  ) {
    scale++;
  }
  return scale;
}

/** «120 de 500 unidades», «100.5 de 100 kg»: the unit is said once. */
export function formatCapacityUse(
  measure: CapacityMeasure,
  amount: string,
  limit: string,
): string {
  const shown = formatDecimal(
    dec(amount).toDecimalPlaces(scaleToTell(amount, limit)),
  );
  return `${shown} de ${formatCapacityAmount(measure, limit)}`;
}

/** «500 unidades · 1,000 kg», or null without any limit. */
export function describeCapacity(limits: CapacityLimits): string | null {
  const parts = CAPACITY_MEASURES.flatMap((measure) =>
    limits[measure] === null
      ? []
      : [formatCapacityAmount(measure, limits[measure])],
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** True when a capacity sets no limit at all. */
export const isUnlimited = (limits: CapacityLimits): boolean =>
  CAPACITY_MEASURES.every((measure) => limits[measure] === null);

/** A product code as it is compared: capitals and accents do not count. */
export const foldCode = (code: string): string =>
  code.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es").trim();

/**
 * The product codes typed in a box, one per line or separated by commas:
 * trimmed, without repeats.
 */
export function splitProductCodes(text: unknown): string[] {
  const raw = typeof text === "string" ? text : "";
  const seen = new Set<string>();
  const codes: string[] = [];
  let start = 0;
  // Walked by hand: what a person pastes here has no pattern to trust.
  for (let index = 0; index <= raw.length; index++) {
    const char = raw[index];
    if (
      index < raw.length &&
      char !== "\n" &&
      char !== "\r" &&
      char !== "," &&
      char !== ";"
    ) {
      continue;
    }
    const code = raw.slice(start, index).trim();
    start = index + 1;
    if (code === "") continue;
    const folded = foldCode(code);
    if (seen.has(folded)) continue;
    seen.add(folded);
    codes.push(code);
  }
  return codes;
}
