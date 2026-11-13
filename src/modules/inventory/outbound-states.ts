/**
 * States of an outbound order and the only moves between them (WMS-13,
 * especificación 5.2). Pure: no database. The trigger
 * `outbound_order_transition` repeats this same table in MySQL; changing
 * one means changing the other (new migration) and outbound-states.test.ts.
 *
 *   DRAFT → RELEASED → PICKING → PICKED → PACKING → PACKED → SHIPPED
 *     ╰───────╰───────────╰→ CANCELLED (with a reason)
 *   PICKED → SHIPPED (a company that does not pack, WMS-16)
 *
 * WMS-15 (ADR 0044): packing is its own step (PACKING) between picked and
 * packed. WMS-16 (ADR 0045): a company that does not pack ships straight
 * from PICKED; an order ships only inside a shipment (the trigger checks
 * it too).
 */

export const OUTBOUND_ORDER_STATUSES = [
  "DRAFT",
  "RELEASED",
  "PICKING",
  "PICKED",
  "PACKING",
  "PACKED",
  "SHIPPED",
  "CANCELLED",
] as const;
export type OutboundOrderStatus = (typeof OUTBOUND_ORDER_STATUSES)[number];

export const OUTBOUND_ORDER_TRANSITIONS: Record<
  OutboundOrderStatus,
  readonly OutboundOrderStatus[]
> = {
  DRAFT: ["RELEASED", "CANCELLED"],
  RELEASED: ["PICKING", "CANCELLED"],
  // Once picking starts the order is not cancelled: what was picked would
  // have to be put back by hand (WMS-14 kept it so). An order in picking
  // ends picked; what was short is recorded while picking or packing.
  PICKING: ["PICKED"],
  PICKED: ["PACKING", "SHIPPED"],
  PACKING: ["PACKED"],
  PACKED: ["SHIPPED"],
  SHIPPED: [],
  CANCELLED: [],
};

/** Names shown in the interface. */
export const OUTBOUND_ORDER_STATUS_LABELS: Record<OutboundOrderStatus, string> =
  {
    DRAFT: "Borrador",
    RELEASED: "Liberado",
    PICKING: "En surtido",
    PICKED: "Surtido",
    PACKING: "Empacando",
    PACKED: "Empacado",
    SHIPPED: "Despachado",
    CANCELLED: "Cancelado",
  };

export function isOutboundOrderStatus(
  value: unknown,
): value is OutboundOrderStatus {
  return (
    typeof value === "string" &&
    (OUTBOUND_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export function canOutboundTransition(
  from: OutboundOrderStatus,
  to: OutboundOrderStatus,
): boolean {
  return OUTBOUND_ORDER_TRANSITIONS[from].includes(to);
}

/** Why a move is not possible, in words for the person; null if it is. */
export function outboundTransitionProblem(
  from: OutboundOrderStatus,
  to: OutboundOrderStatus,
): string | null {
  if (canOutboundTransition(from, to)) return null;
  if (from === "CANCELLED") return "Este pedido está cancelado.";
  if (from === "SHIPPED") return "Este pedido ya salió del almacén.";
  if (to === "RELEASED") return "Este pedido ya se liberó.";
  if (to === "CANCELLED")
    return "El surtido de este pedido ya empezó: no se puede cancelar desde aquí.";
  if (to === "PACKING" || to === "PACKED") {
    if (from === "PACKED") return "Este pedido ya está empacado.";
    if (from === "PACKING" && to === "PACKING")
      return "Este pedido ya se está empacando.";
    return "Este pedido todavía no termina de surtirse.";
  }
  if (to === "SHIPPED") {
    if (from === "PACKING")
      return "Este pedido se está empacando: termina el empaque antes de que salga.";
    return "Este pedido todavía no termina de surtirse.";
  }
  return "Este pedido ya cambió. Vuelve a abrirlo.";
}

/** «PS-0007». */
export function formatOutboundNumber(number: number): string {
  return `PS-${String(number).padStart(4, "0")}`;
}
