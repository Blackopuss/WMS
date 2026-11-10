/**
 * States of a warehouse task and the only moves between them (WMS-06,
 * especificación WMS v5 5.3). Pure: no database. The trigger
 * `warehouse_task_transition` repeats this same table in MySQL; changing
 * one means changing the other (new migration) and task-states.test.ts.
 *
 *   PENDING → ASSIGNED → ACCEPTED → PICKED_UP → DELIVERED
 *      ╰──────────────────╯   ╰→ BLOCKED ←╯
 *   BLOCKED → PENDING (released) · CANCELLED with a reason
 */

export const WAREHOUSE_TASK_STATUSES = [
  "PENDING",
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
  "DELIVERED",
  "BLOCKED",
  "CANCELLED",
] as const;
export type WarehouseTaskStatus = (typeof WAREHOUSE_TASK_STATUSES)[number];

export const WAREHOUSE_TASK_TRANSITIONS: Record<
  WarehouseTaskStatus,
  readonly WarehouseTaskStatus[]
> = {
  // Taken by whoever may do it, or given to someone by a supervisor.
  PENDING: ["ASSIGNED", "ACCEPTED", "CANCELLED"],
  // Only the person it was given to accepts it; a supervisor may take it
  // back (pending again) or cancel it.
  ASSIGNED: ["ACCEPTED", "PENDING", "CANCELLED"],
  ACCEPTED: ["PICKED_UP", "BLOCKED", "CANCELLED"],
  // The load is in hand: it is delivered or reported, never cancelled
  // (nobody would know where the goods are).
  PICKED_UP: ["DELIVERED", "BLOCKED"],
  BLOCKED: ["PENDING", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

/** Names shown in the interface. */
export const WAREHOUSE_TASK_STATUS_LABELS: Record<WarehouseTaskStatus, string> =
  {
    PENDING: "Disponible",
    ASSIGNED: "Asignada",
    ACCEPTED: "En camino al origen",
    PICKED_UP: "Recogida",
    DELIVERED: "Entregada",
    BLOCKED: "Con problema",
    CANCELLED: "Cancelada",
  };

/** States in which the task still needs someone. */
export const OPEN_TASK_STATUSES: readonly WarehouseTaskStatus[] = [
  "PENDING",
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
  "BLOCKED",
];

export function isWarehouseTaskStatus(
  value: unknown,
): value is WarehouseTaskStatus {
  return (
    typeof value === "string" &&
    (WAREHOUSE_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function canTaskTransition(
  from: WarehouseTaskStatus,
  to: WarehouseTaskStatus,
): boolean {
  return WAREHOUSE_TASK_TRANSITIONS[from].includes(to);
}

/** Why a move is not possible, in words for the person; null if it is. */
export function taskTransitionProblem(
  from: WarehouseTaskStatus,
  to: WarehouseTaskStatus,
): string | null {
  if (canTaskTransition(from, to)) return null;
  if (from === "DELIVERED") return "Esta tarea ya se entregó.";
  if (from === "CANCELLED") return "Esta tarea está cancelada.";
  if (to === "ACCEPTED" && from !== "BLOCKED")
    return "Otra persona ya tomó esta tarea.";
  if (to === "CANCELLED" && from === "PICKED_UP")
    return "La carga ya se recogió: entrégala o reporta el problema.";
  if (to === "PICKED_UP")
    return from === "PICKED_UP"
      ? "Esta carga ya se recogió."
      : "Primero toma la tarea.";
  if (to === "DELIVERED") return "Primero confirma que recogiste la carga.";
  if (from === "BLOCKED") return "Esta tarea tiene un problema por resolver.";
  return "Esta tarea ya cambió. Vuelve a abrirla.";
}

/** «T-0007». */
export function formatTaskNumber(number: number): string {
  return `T-${String(number).padStart(4, "0")}`;
}
