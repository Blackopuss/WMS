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
 * WMS-21 (ADR 0040): every read of the balance says which rows it wants.
 *
 * - `availableOfLot(lotId)`: the one row of a lot (or of «no lot», with
 *   null) in a location. What writes a balance reads it with this, next to
 *   product and location.
 * - `AVAILABLE_ANY_LOT`: the available rows of every lot. Totals use it
 *   (minimums, suggestions, what is free of a product, what waits to be
 *   put away).
 */
export const availableOfLot = (lotId: string | null | undefined) =>
  ({ status: "AVAILABLE", lotKey: lotId ?? "" }) as const;

export const AVAILABLE_ANY_LOT = { status: "AVAILABLE" } as const;

/** Lot columns of a line or a new balance: `lotKey` = COALESCE(lotId, ''). */
export const lotColumns = (lotId: string | null | undefined) => ({
  lotId: lotId ?? null,
  lotKey: lotId ?? "",
});
