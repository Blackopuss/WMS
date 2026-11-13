/**
 * States of a shipment and the only moves between them (WMS-16, ADR 0045).
 * Pure: no database. The trigger `shipment_transition` repeats this same
 * table in MySQL; changing one means changing the other (new migration)
 * and shipment-states.test.ts.
 *
 *   DRAFT → SHIPPED
 *     ╰───→ CANCELLED (with a reason)
 */

export const SHIPMENT_STATUSES = ["DRAFT", "SHIPPED", "CANCELLED"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_TRANSITIONS: Record<
  ShipmentStatus,
  readonly ShipmentStatus[]
> = {
  DRAFT: ["SHIPPED", "CANCELLED"],
  SHIPPED: [],
  CANCELLED: [],
};

/** Names shown in the interface. */
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  DRAFT: "Por confirmar",
  SHIPPED: "Despachado",
  CANCELLED: "Cancelado",
};

export function isShipmentStatus(value: unknown): value is ShipmentStatus {
  return (
    typeof value === "string" &&
    (SHIPMENT_STATUSES as readonly string[]).includes(value)
  );
}

export function canShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

/** Why a move is not possible, in words for the person; null if it is. */
export function shipmentTransitionProblem(
  from: ShipmentStatus,
  to: ShipmentStatus,
): string | null {
  if (canShipmentTransition(from, to)) return null;
  if (from === "SHIPPED") return "Este embarque ya salió del almacén.";
  if (from === "CANCELLED") return "Este embarque está cancelado.";
  return "Este embarque ya cambió. Vuelve a abrirlo.";
}

/** «EM-0007». */
export function formatShipmentNumber(number: number): string {
  return `EM-${String(number).padStart(4, "0")}`;
}
