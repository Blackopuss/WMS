/**
 * States of an approval request (WMS-56, ADR 0053). Pure. The trigger
 * `approval_request_transition` repeats this table in the database:
 * changing one means changing the other (a new migration).
 */

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: "Esperando autorización",
  APPROVED: "Autorizada",
  REJECTED: "Rechazada",
  CANCELLED: "Retirada",
  EXPIRED: "Vencida",
};

/** A request is decided once: from pending to one final state. */
export const APPROVAL_TRANSITIONS: Record<
  ApprovalStatus,
  readonly ApprovalStatus[]
> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED", "EXPIRED"],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}
