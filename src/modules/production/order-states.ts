/**
 * States of a production order and the moves between them (WMS-28, ADR
 * 0073). Pure: the one table services, screens and the database trigger
 * `production_order_transition` agree on — changing one means changing the
 * other (a new migration).
 *
 *   Borrador ──▶ Liberada ──▶ En proceso ──▶ Cerrada
 *      │            │
 *      └────────────┴──▶ Cancelada
 *
 * - A draft changes; releasing it sets its materials aside.
 * - «En proceso» arrives with the first report (WMS-29) and «Cerrada» with
 *   the close (WMS-31), also with something missing.
 * - An order with reports is not cancelled: it is closed.
 */
export const PRODUCTION_ORDER_STATUS_LABELS = {
  DRAFT: "Borrador",
  RELEASED: "Liberada",
  IN_PROGRESS: "En proceso",
  CLOSED: "Cerrada",
  CANCELLED: "Cancelada",
} as const;

export type ProductionOrderStatus = keyof typeof PRODUCTION_ORDER_STATUS_LABELS;

export const PRODUCTION_ORDER_STATUSES = Object.keys(
  PRODUCTION_ORDER_STATUS_LABELS,
) as ProductionOrderStatus[];

export const isProductionOrderStatus = (
  value: unknown,
): value is ProductionOrderStatus =>
  typeof value === "string" &&
  Object.hasOwn(PRODUCTION_ORDER_STATUS_LABELS, value);

/** Where an order may go from each state. */
export const PRODUCTION_ORDER_TRANSITIONS: Record<
  ProductionOrderStatus,
  readonly ProductionOrderStatus[]
> = {
  DRAFT: ["RELEASED", "CANCELLED"],
  RELEASED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

/** States in which an order is still open work. */
export const OPEN_PRODUCTION_STATUSES: readonly ProductionOrderStatus[] = [
  "DRAFT",
  "RELEASED",
  "IN_PROGRESS",
];

export const canProductionTransition = (
  from: ProductionOrderStatus,
  to: ProductionOrderStatus,
): boolean => PRODUCTION_ORDER_TRANSITIONS[from].includes(to);

/** Why an order in a state cannot be taken to another, for people. */
export function productionTransitionProblem(
  from: ProductionOrderStatus,
  to: ProductionOrderStatus,
): string | null {
  if (canProductionTransition(from, to)) return null;
  if (from === "CANCELLED") return "Esta orden está cancelada: ya no cambia.";
  if (from === "CLOSED") return "Esta orden está cerrada: ya no cambia.";
  if (from === "IN_PROGRESS" && to === "CANCELLED") {
    return "Esta orden ya tiene producción reportada: no se cancela, se cierra.";
  }
  if (from !== "DRAFT" && to === "RELEASED") {
    return "Esta orden ya se liberó.";
  }
  if (from !== "DRAFT") {
    return "Esta orden ya se liberó: solo un borrador cambia.";
  }
  return "Ese cambio no se puede hacer en un borrador.";
}

/** «OP-0001». */
export function formatProductionNumber(number: number): string {
  return `OP-${String(number).padStart(4, "0")}`;
}
