/**
 * Approval types of Compras (WMS-57, ADR 0055): their keys and names,
 * apart from their effects so the services that ask can name them without
 * importing the effects.
 */
export const PURCHASE_REQUEST_APPROVAL = {
  key: "purchasing.request",
  label: "Solicitudes de compra",
} as const;
