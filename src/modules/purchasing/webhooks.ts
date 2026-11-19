import type { WebhookEventType } from "@/platform/api";

/**
 * Events of Compras that a company may receive by webhook (WMS-60,
 * ADR 0058). Registered in src/modules/registry/webhooks.ts. Never costs.
 */
export const RECEIPT_CONFIRMED_EVENT: WebhookEventType = {
  key: "purchasing.receipt.confirmed",
  module: "purchasing",
  label: "Recepción confirmada",
  description:
    "Al recibir mercancía de una orden de compra (solo si entró algo): lo que entró, a qué ubicación, si llegó dañado o quedó en inspección (`status`: AVAILABLE, DAMAGED o INSPECTION) y cómo quedó la orden.",
};

/**
 * WMS-84 (ADR 0079): what was rejected at the door when receiving. It
 * never entered the stock; it stays pending in the order.
 */
export const RECEIPT_REJECTED_EVENT: WebhookEventType = {
  key: "purchasing.receipt.rejected",
  module: "purchasing",
  label: "Rechazo al recibir",
  description:
    "Al rechazar mercancía en la puerta al recibir una orden de compra: qué producto, cuánto, por qué y el lote o las series que traía. No entra al inventario y sigue pendiente en la orden.",
};

export const PURCHASING_WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  RECEIPT_CONFIRMED_EVENT,
  RECEIPT_REJECTED_EVENT,
];
