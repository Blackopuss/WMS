import type { NotificationType } from "@/platform/notifications";

/**
 * What Producción notifies about (WMS-28B, ADR 0075); registered in
 * src/modules/registry/notifications.ts.
 */
export const REQUEST_TO_DECIDE_NOTICE: NotificationType = {
  key: "production.request_to_decide",
  module: "production",
  label: "Hay una solicitud de producción por atender",
  description:
    "Cuando alguien de un área que alcanzas pide producir algo que está por acabarse.",
  defaultEnabled: true,
  visibleWith: ["production.request.decide"],
};

export const REQUEST_ANSWERED_NOTICE: NotificationType = {
  key: "production.request_answered",
  module: "production",
  label: "Respuesta a tu solicitud de producción",
  description: "Cuando aceptan o rechazan una solicitud de producción tuya.",
  defaultEnabled: true,
  visibleWith: ["production.request.create"],
};

export const ORDER_FROM_REQUEST_NOTICE: NotificationType = {
  key: "production.order_from_request",
  module: "production",
  label: "Nació una orden de producción de una solicitud",
  description:
    "Cuando se acepta una solicitud de un área que alcanzas y nace su orden de producción.",
  defaultEnabled: true,
  visibleWith: ["production.request.decide", "production.order.cancel"],
};

/** WMS-29 (ADR 0087): «Avisar que falta material» from an order. */
export const MATERIAL_SHORT_NOTICE: NotificationType = {
  key: "production.material_short",
  module: "production",
  label: "Falta material en una orden de producción",
  description:
    "Cuando quien produce en un área que alcanzas avisa que no le alcanza el material de una orden.",
  defaultEnabled: true,
  visibleWith: ["production.request.decide", "production.order.release"],
};

export const PRODUCTION_NOTIFICATION_TYPES: readonly NotificationType[] = [
  REQUEST_TO_DECIDE_NOTICE,
  REQUEST_ANSWERED_NOTICE,
  ORDER_FROM_REQUEST_NOTICE,
  MATERIAL_SHORT_NOTICE,
];
