import {
  DIMENSIONS,
  DIMENSION_LABELS,
  QUANTITY_STEPS,
  STEP_LABELS,
  unitsOfDimension,
} from "@/platform/catalog";

export type UnitGroup = {
  label: string;
  units: {
    code: string;
    label: string;
    fractional: boolean;
    /** The unit itself says the weight (kilograms) or the volume (liters). */
    measures: "weight" | "volume" | null;
  }[];
};

/** Units grouped by dimension, ready for the product form (INV-06). */
export function unitGroups(): UnitGroup[] {
  return DIMENSIONS.map((dimension) => ({
    label: DIMENSION_LABELS[dimension],
    units: unitsOfDimension(dimension).map((unit) => ({
      code: unit.code,
      label: `${unit.name.charAt(0).toUpperCase()}${unit.name.slice(1)} (${unit.symbol})`,
      fractional: unit.fractional,
      measures:
        dimension === "mass"
          ? ("weight" as const)
          : dimension === "volume"
            ? ("volume" as const)
            : null,
    })),
  }));
}

export function stepOptions(): { value: string; label: string }[] {
  return QUANTITY_STEPS.map((value) => ({ value, label: STEP_LABELS[value] }));
}
