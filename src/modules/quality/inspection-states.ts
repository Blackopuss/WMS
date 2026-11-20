/**
 * States of a verification (WMS-30B, ADR 0091): open, then decided or
 * cancelled, once. The trigger `quality_inspection_transition` repeats
 * this table: changing one means changing the other.
 */

export const INSPECTION_STATES = ["OPEN", "DECIDED", "CANCELLED"] as const;
export type InspectionState = (typeof INSPECTION_STATES)[number];

export const INSPECTION_STATE_LABELS: Record<InspectionState, string> = {
  OPEN: "Abierta",
  DECIDED: "Decidida",
  CANCELLED: "Cancelada",
};

export const INSPECTION_TRANSITIONS: Record<
  InspectionState,
  readonly InspectionState[]
> = {
  OPEN: ["DECIDED", "CANCELLED"],
  DECIDED: [],
  CANCELLED: [],
};

export function canInspectionMove(
  from: InspectionState,
  to: InspectionState,
): boolean {
  return INSPECTION_TRANSITIONS[from].includes(to);
}
