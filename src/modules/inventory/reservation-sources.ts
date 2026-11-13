/**
 * Names of the documents that hold reservations (`stock_reservation.
 * sourceType`). Pure: no database, no framework, so a script outside
 * Next.js (the reconciliation, `npm run stock:reconcile`) can read them
 * without loading the services that write reservations.
 */

/** Reservations of an outbound order are per line. */
export const OUTBOUND_LINE_SOURCE = "outbound_order_line";
