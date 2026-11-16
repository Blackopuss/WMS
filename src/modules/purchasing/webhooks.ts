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
    "Al recibir mercancía de una orden de compra: lo que entró, a qué ubicación, si llegó dañado o quedó en inspección (`status`: AVAILABLE, DAMAGED o INSPECTION) y cómo quedó la orden.",
};

export const PURCHASING_WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  RECEIPT_CONFIRMED_EVENT,
];
