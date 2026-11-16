import type { WebhookEventType } from "@/platform/api";

/**
 * Events of Inventario that a company may receive by webhook (WMS-60,
 * ADR 0058). Registered in src/modules/registry/webhooks.ts. The body
 * carries ids, numbers of documents and quantities as text; never costs
 * nor names of people.
 */
export const SHIPMENT_DISPATCHED_EVENT: WebhookEventType = {
  key: "inventory.shipment.dispatched",
  module: "inventory",
  label: "Embarque despachado",
  description:
    "Al confirmar la salida de un embarque: sus pedidos y lo que salió de cada uno.",
};

export const ADJUSTMENT_APPLIED_EVENT: WebhookEventType = {
  key: "inventory.adjustment.applied",
  module: "inventory",
  label: "Ajuste aplicado",
  description:
    "Al corregir existencias (a mano, con autorización o al aplicar un conteo): lo que había, lo que quedó y la diferencia.",
};

export const STOCK_STATUS_CHANGED_EVENT: WebhookEventType = {
  key: "inventory.stock_status.changed",
  module: "inventory",
  label: "Cambio de estado de existencias",
  description:
    "Al pasar existencias de un estado a otro (disponible, dañado, cuarentena, en restauración…), también al decidir una devolución de cliente.",
};

export const INVENTORY_WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  SHIPMENT_DISPATCHED_EVENT,
  ADJUSTMENT_APPLIED_EVENT,
  STOCK_STATUS_CHANGED_EVENT,
];
