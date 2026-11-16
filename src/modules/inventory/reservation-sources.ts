/**
 * Names of the documents that hold reservations (`stock_reservation.
 * sourceType`). Pure: no database, no framework, so a script outside
 * Next.js (the reconciliation, `npm run stock:reconcile`) can read them
 * without loading the services that write reservations.
 */

/** Reservations of an outbound order are per line. */
export const OUTBOUND_LINE_SOURCE = "outbound_order_line";

/**
 * Reservations of a production order are per material line (WMS-28, ADR
 * 0073): the order sets each material aside where it will be taken from,
 * and a «Surtir a producción» task moves it to the area, where it stays
 * reserved for the same line.
 */
export const PRODUCTION_ORDER_LINE_SOURCE = "production_order_line";
