/**
 * Weight and volume of one unit of a product (WMS-22B, ADR 0039): what the
 * capacity of a location is measured against. Both are optional. A product
 * controlled by weight (kilograms, grams) already says its weight, and one
 * controlled by volume its volume: the unit decides and the card keeps
 * nothing. Pure: no database.
 */
import { dec, isAppError, parseDecimal, type Decimal } from "@/lib";

import { getUnit, isUnitCode } from "./units";

/** Decimals kept: a milligram, a thousandth of a milliliter. */
export const MEASURE_SCALE = 6;
/** Largest weight (kg) or volume (L) of one unit. */
export const MAX_MEASURE = "99999999.999999";

/**
 * A weight or a volume as typed: empty = unknown; otherwise a number
 * greater than zero («0.25», «1,200»).
 */
export function parseMeasure(
  text: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return { ok: true, value: null };
  try {
    const value = parseDecimal(raw, {
      maxScale: MEASURE_SCALE,
      allowZero: false,
    });
    if (value.greaterThan(MAX_MEASURE)) {
      return { ok: false, error: "Esa cantidad es demasiado grande." };
    }
    return { ok: true, value: value.toString() };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      ok: false,
      error:
        error.code === "decimal.too_many_decimals"
          ? `Usa como máximo ${MEASURE_SCALE} decimales.`
          : "Escribe un número mayor que cero, o déjalo vacío si no lo sabes.",
    };
  }
}

type Stored = { toString(): string } | null | undefined;

/** True when the unit itself says what one unit weighs. */
export const weighsByUnit = (unitCode: string): boolean =>
  isUnitCode(unitCode) && getUnit(unitCode).dimension === "mass";

/** True when the unit itself says the volume of one unit. */
export const measuresVolumeByUnit = (unitCode: string): boolean =>
  isUnitCode(unitCode) && getUnit(unitCode).dimension === "volume";

/** Kilograms one unit of the product weighs, or null when unknown. */
export function unitWeightOf(product: {
  unitCode: string;
  unitWeight: Stored;
}): Decimal | null {
  if (weighsByUnit(product.unitCode)) {
    return dec(getUnit(product.unitCode).toReference);
  }
  return product.unitWeight ? dec(product.unitWeight.toString()) : null;
}

/** Liters one unit of the product takes, or null when unknown. */
export function unitVolumeOf(product: {
  unitCode: string;
  unitVolume: Stored;
}): Decimal | null {
  if (measuresVolumeByUnit(product.unitCode)) {
    return dec(getUnit(product.unitCode).toReference);
  }
  return product.unitVolume ? dec(product.unitVolume.toString()) : null;
}
