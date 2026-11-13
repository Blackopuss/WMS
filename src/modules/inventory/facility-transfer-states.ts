/**
 * States of a transfer between warehouses and the only moves between them
 * (WMS-19, ADR 0048). Pure: no database. The trigger
 * `facility_transfer_transition` repeats this same table in MySQL; changing
 * one means changing the other (new migration) and
 * facility-transfer-states.test.ts.
 *
 *   DRAFT → SENT → RECEIVED (when nothing of it is left in transit)
 *   DRAFT → CANCELLED
 */

export const FACILITY_TRANSFER_STATUSES = [
  "DRAFT",
  "SENT",
  "RECEIVED",
  "CANCELLED",
] as const;
export type FacilityTransferStatus =
  (typeof FACILITY_TRANSFER_STATUSES)[number];

export const FACILITY_TRANSFER_TRANSITIONS: Record<
  FacilityTransferStatus,
  readonly FacilityTransferStatus[]
> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
};

/** Names shown in the interface. */
export const FACILITY_TRANSFER_STATUS_LABELS: Record<
  FacilityTransferStatus,
  string
> = {
  DRAFT: "Borrador",
  SENT: "En camino",
  RECEIVED: "Recibido",
  CANCELLED: "Cancelado",
};

export function isFacilityTransferStatus(
  value: unknown,
): value is FacilityTransferStatus {
  return (
    typeof value === "string" &&
    (FACILITY_TRANSFER_STATUSES as readonly string[]).includes(value)
  );
}

export function canFacilityTransferTransition(
  from: FacilityTransferStatus,
  to: FacilityTransferStatus,
): boolean {
  return FACILITY_TRANSFER_TRANSITIONS[from].includes(to);
}

/** How what did not arrive is settled (WMS-19). */
export const TRANSFER_RESOLUTIONS = ["LOST", "RETURNED"] as const;
export type TransferResolution = (typeof TRANSFER_RESOLUTIONS)[number];

export function isTransferResolution(
  value: unknown,
): value is TransferResolution {
  return (
    typeof value === "string" &&
    (TRANSFER_RESOLUTIONS as readonly string[]).includes(value)
  );
}

/** «TR-0007». */
export function formatFacilityTransferNumber(number: number): string {
  return `TR-${String(number).padStart(4, "0")}`;
}

/** «TR-12», «tr 0012» → 12; null when it is not a transfer number. */
export function parseFacilityTransferNumber(text: string): number | null {
  const match = /^TR[\s-]*0*(\d{1,9})$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
