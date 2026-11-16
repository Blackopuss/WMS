/**
 * States of a production request and the moves between them (WMS-28B, ADR
 * 0075). Pure: the one table services, screens and the database trigger
 * `production_request_transition` agree on — changing one means changing
 * the other (a new migration).
 *
 *   Por atender ──▶ Aceptada (nace la orden)
 *        │
 *        ├──────▶ Rechazada (con motivo)
 *        │
 *        └──────▶ Cancelada (por quien pidió)
 */
export const PRODUCTION_REQUEST_STATUS_LABELS = {
  SUBMITTED: "Por atender",
  ACCEPTED: "Aceptada",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
} as const;

export type ProductionRequestStatus =
  keyof typeof PRODUCTION_REQUEST_STATUS_LABELS;

export const PRODUCTION_REQUEST_STATUSES = Object.keys(
  PRODUCTION_REQUEST_STATUS_LABELS,
) as ProductionRequestStatus[];

export const isProductionRequestStatus = (
  value: unknown,
): value is ProductionRequestStatus =>
  typeof value === "string" &&
  Object.hasOwn(PRODUCTION_REQUEST_STATUS_LABELS, value);

/** Where a request may go from each state. */
export const PRODUCTION_REQUEST_TRANSITIONS: Record<
  ProductionRequestStatus,
  readonly ProductionRequestStatus[]
> = {
  SUBMITTED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: [],
  REJECTED: [],
  CANCELLED: [],
};

export const canProductionRequestTransition = (
  from: ProductionRequestStatus,
  to: ProductionRequestStatus,
): boolean => PRODUCTION_REQUEST_TRANSITIONS[from].includes(to);

/** Why a request in a state cannot be taken to another, for people. */
export function productionRequestProblem(
  from: ProductionRequestStatus,
  to: ProductionRequestStatus,
): string | null {
  if (canProductionRequestTransition(from, to)) return null;
  if (from === "ACCEPTED") return "Esta solicitud ya se aceptó.";
  if (from === "REJECTED") return "Esta solicitud ya se rechazó.";
  if (from === "CANCELLED") return "Esta solicitud ya se canceló.";
  return "Ese cambio no se puede hacer.";
}

/** «SP-0001». */
export function formatProductionRequestNumber(number: number): string {
  return `SP-${String(number).padStart(4, "0")}`;
}
