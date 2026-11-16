/**
 * States of a version of a process (WMS-74, ADR 0069). The trigger
 * `process_version_transition` repeats this table: change both together.
 */
export const PROCESS_VERSION_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "RETIRED",
] as const;
export type ProcessVersionStatus = (typeof PROCESS_VERSION_STATUSES)[number];

export const PROCESS_VERSION_TRANSITIONS: Record<
  ProcessVersionStatus,
  readonly ProcessVersionStatus[]
> = {
  DRAFT: ["PUBLISHED"],
  PUBLISHED: ["RETIRED"],
  RETIRED: [],
};

export function canTransition(
  from: ProcessVersionStatus,
  to: ProcessVersionStatus,
): boolean {
  return PROCESS_VERSION_TRANSITIONS[from].includes(to);
}

export const STAGE_STATE_LABELS = {
  WAITING: "En espera",
  READY: "Por hacer",
  DONE: "Hecha",
  SKIPPED: "Saltada",
} as const;

export const STEP_ACTION_LABELS = {
  COMPLETED: "Terminó",
  OPERATION: "Se registró la operación",
  SKIPPED: "Saltó",
  BACK: "Regresó",
  TAKEN: "Tomó",
  RELEASED: "Liberó",
  ASSIGNED: "Asignó",
} as const;
