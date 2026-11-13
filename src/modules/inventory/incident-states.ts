/**
 * States of an incident and the only moves between them (WMS-39, ADR
 * 0057). Pure: no database. The trigger `incident_transition` repeats this
 * same table in MySQL; changing one means changing the other (new
 * migration) and incident-states.test.ts.
 *
 *   OPEN → IN_PROGRESS → RESOLVED | DISMISSED
 *   OPEN → RESOLVED | DISMISSED
 */

export const INCIDENT_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "DISMISSED",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_TRANSITIONS: Record<
  IncidentStatus,
  readonly IncidentStatus[]
> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "DISMISSED"],
  IN_PROGRESS: ["RESOLVED", "DISMISSED"],
  RESOLVED: [],
  DISMISSED: [],
};

/** Names shown in the interface. */
export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: "Abierta",
  IN_PROGRESS: "En atención",
  RESOLVED: "Resuelta",
  DISMISSED: "Descartada",
};

export function isIncidentStatus(value: unknown): value is IncidentStatus {
  return (
    typeof value === "string" &&
    (INCIDENT_STATUSES as readonly string[]).includes(value)
  );
}

export function canIncidentTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

/** Still waiting for someone: open or being attended. */
export const OPEN_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  "OPEN",
  "IN_PROGRESS",
];

/** What kind of problem it is: a fixed, generic list (any industry). */
export const INCIDENT_KINDS = [
  "DAMAGED_GOODS",
  "MISPLACED",
  "UNSAFE_LOCATION",
  "BROKEN_EQUIPMENT",
  "OTHER",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  DAMAGED_GOODS: "Mercancía dañada",
  MISPLACED: "No está donde debería",
  UNSAFE_LOCATION: "Ubicación bloqueada o insegura",
  BROKEN_EQUIPMENT: "Equipo descompuesto",
  OTHER: "Otro",
};

export function isIncidentKind(value: unknown): value is IncidentKind {
  return (
    typeof value === "string" &&
    (INCIDENT_KINDS as readonly string[]).includes(value)
  );
}

/** «INC-0007». */
export function formatIncidentNumber(number: number): string {
  return `INC-${String(number).padStart(4, "0")}`;
}
