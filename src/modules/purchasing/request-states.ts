/**
 * States of a purchase request and the moves between them (WMS-57, ADR
 * 0055). Pure: the one table services, screens and the database trigger
 * `purchase_request_transition` agree on — changing one means changing the
 * other (a new migration).
 *
 *   Borrador ──▶ Esperando autorización ──▶ Por atender ──▶ Convertida
 *      │  └──────────────│──────────────────────▲   │
 *      ▼                 ▼                          ▼
 *   Cancelada     Cancelada / Rechazada         Rechazada
 *
 * - Who asked sends a draft: it waits for an authorization when the rule
 *   of the company is on, else it reaches Compras directly.
 * - Who asked cancels it while it is not authorized.
 * - Compras turns it into orders once, or rejects it with a reason.
 * - Rejected, converted and cancelled are final.
 */
export const PURCHASE_REQUEST_STATUS_LABELS = {
  DRAFT: "Borrador",
  SUBMITTED: "Esperando autorización",
  APPROVED: "Por atender",
  REJECTED: "Rechazada",
  CONVERTED: "Convertida en orden",
  CANCELLED: "Cancelada",
} as const;

export type PurchaseRequestStatus = keyof typeof PURCHASE_REQUEST_STATUS_LABELS;

export const PURCHASE_REQUEST_STATUSES = Object.keys(
  PURCHASE_REQUEST_STATUS_LABELS,
) as PurchaseRequestStatus[];

export const isPurchaseRequestStatus = (
  value: unknown,
): value is PurchaseRequestStatus =>
  typeof value === "string" &&
  Object.hasOwn(PURCHASE_REQUEST_STATUS_LABELS, value);

/** Where a request may go from each state. */
export const PURCHASE_REQUEST_TRANSITIONS: Record<
  PurchaseRequestStatus,
  readonly PurchaseRequestStatus[]
> = {
  DRAFT: ["SUBMITTED", "APPROVED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["CONVERTED", "REJECTED"],
  REJECTED: [],
  CONVERTED: [],
  CANCELLED: [],
};

export const canRequestTransition = (
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): boolean => PURCHASE_REQUEST_TRANSITIONS[from].includes(to);

/** Why a request in a state cannot be taken to another, for people. */
export function requestTransitionProblem(
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): string | null {
  if (canRequestTransition(from, to)) return null;
  if (from === "CONVERTED") {
    return "Esta solicitud ya se convirtió en orden de compra.";
  }
  if (from === "REJECTED") {
    return "Esta solicitud se rechazó: ya no cambia. Si todavía lo necesitas, haz otra.";
  }
  if (from === "CANCELLED") {
    return "Esta solicitud está cancelada: ya no cambia. Si todavía lo necesitas, haz otra.";
  }
  if (from === "APPROVED" && to === "CANCELLED") {
    return "Esta solicitud ya está con Compras: no se cancela. Pídeles que la rechacen si ya no la necesitas.";
  }
  if (from === "DRAFT" && (to === "CONVERTED" || to === "REJECTED")) {
    return "Esta solicitud todavía no se envía a Compras.";
  }
  if (from === "SUBMITTED" && to === "CONVERTED") {
    return "Esta solicitud espera autorización: todavía no se puede convertir en orden.";
  }
  return "Esta solicitud ya no está en ese paso.";
}

/** «SC-0007»: how a purchase request is named to people. */
export const formatRequestNumber = (number: number) =>
  `SC-${String(number).padStart(4, "0")}`;
