/**
 * States of a picking wave and the only moves between them (WMS-25, ADR
 * 0054). Pure: no database. The trigger `pick_wave_transition` repeats this
 * same table in MySQL; changing one means changing the other (new
 * migration) and wave-states.test.ts.
 *
 *   OPEN → DONE       (by itself: none of its picking tasks is open)
 *     ╰──→ CANCELLED  (with a reason: it only ungroups its orders)
 */

export const PICK_WAVE_STATUSES = ["OPEN", "DONE", "CANCELLED"] as const;
export type PickWaveStatus = (typeof PICK_WAVE_STATUSES)[number];

export const PICK_WAVE_TRANSITIONS: Record<
  PickWaveStatus,
  readonly PickWaveStatus[]
> = {
  OPEN: ["DONE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

/** Names shown in the interface. */
export const PICK_WAVE_STATUS_LABELS: Record<PickWaveStatus, string> = {
  OPEN: "Abierta",
  DONE: "Terminada",
  CANCELLED: "Cancelada",
};

export function isPickWaveStatus(value: unknown): value is PickWaveStatus {
  return (
    typeof value === "string" &&
    (PICK_WAVE_STATUSES as readonly string[]).includes(value)
  );
}

export function canWaveTransition(
  from: PickWaveStatus,
  to: PickWaveStatus,
): boolean {
  return PICK_WAVE_TRANSITIONS[from].includes(to);
}

/** Why a move is not possible, in words for the person; null if it is. */
export function waveTransitionProblem(
  from: PickWaveStatus,
  to: PickWaveStatus,
): string | null {
  if (canWaveTransition(from, to)) return null;
  if (from === "DONE") return "Esta ola ya se terminó de surtir.";
  if (from === "CANCELLED") return "Esta ola está cancelada.";
  return "Esta ola ya cambió. Vuelve a abrirla.";
}

/** «OL-0007». */
export function formatWaveNumber(number: number): string {
  return `OL-${String(number).padStart(4, "0")}`;
}
