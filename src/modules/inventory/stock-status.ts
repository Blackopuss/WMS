/**
 * State of stock (ADR 0033, WMS-10). Pure: no database.
 *
 * - «Hay» (on hand) adds every state: what is physically there.
 * - «Disponible» is only AVAILABLE (minus reservations, WMS-12): the only
 *   stock that can be picked, taken out, moved freely, counted or reserved.
 */

export const STOCK_STATUSES = [
  "AVAILABLE",
  "RECEIVING",
  "INSPECTION",
  "QUARANTINE",
  "DAMAGED",
  "REJECTED",
  "IN_TRANSIT",
  "BLOCKED",
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Names shown in the interface. */
export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  AVAILABLE: "Disponible",
  RECEIVING: "En recepción",
  INSPECTION: "En inspección",
  QUARANTINE: "En cuarentena",
  DAMAGED: "Dañado",
  REJECTED: "Rechazado",
  IN_TRANSIT: "En tránsito",
  BLOCKED: "Bloqueado",
};

export function isStockStatus(value: unknown): value is StockStatus {
  return (
    typeof value === "string" &&
    (STOCK_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The balance rows every current operation works on: available and without
 * a lot. Spread into a `where` of `stockBalance` next to product and
 * location; a new row gets the same values from the column defaults.
 */
export const AVAILABLE_STOCK = { status: "AVAILABLE", lotKey: "" } as const;
