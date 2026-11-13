/**
 * Approval types of Compras (WMS-57, ADR 0055): their keys and names,
 * apart from their effects so the services that ask can name them without
 * importing the effects. What deciding takes lives here too: the request
 * names it to notify who may decide (WMS-39).
 */
export const PURCHASE_REQUEST_APPROVAL = {
  key: "purchasing.request",
  label: "Solicitudes de compra",
  // Authorizing a purchase takes being able to buy.
  decidePermissions: ["purchasing.order.create"],
} as const;
