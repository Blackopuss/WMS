/**
 * What an outbound line waits from production (WMS-79, ADR 0094). The
 * only table of states: the trigger `outbound_line_wait_transition`
 * repeats it, so changing one means changing the other (new migration).
 */
export const OUTBOUND_WAIT_STATUSES = [
  "OPEN",
  "DONE",
  "DROPPED",
  "CANCELLED",
] as const;
export type OutboundWaitStatus = (typeof OUTBOUND_WAIT_STATUSES)[number];

export const OUTBOUND_WAIT_TRANSITIONS: Record<
  OutboundWaitStatus,
  readonly OutboundWaitStatus[]
> = {
  // It closes once: everything arrived, someone stopped waiting, or the
  // order was cancelled.
  OPEN: ["DONE", "DROPPED", "CANCELLED"],
  DONE: [],
  DROPPED: [],
  CANCELLED: [],
};

export const OUTBOUND_WAIT_STATUS_LABELS: Record<OutboundWaitStatus, string> =
  {
    OPEN: "Espera producción",
    DONE: "Ya llegó lo que faltaba",
    DROPPED: "Se dejó de esperar",
    CANCELLED: "Se canceló el pedido",
  };

export function canOutboundWaitTransition(
  from: OutboundWaitStatus,
  to: OutboundWaitStatus,
): boolean {
  return OUTBOUND_WAIT_TRANSITIONS[from].includes(to);
}
