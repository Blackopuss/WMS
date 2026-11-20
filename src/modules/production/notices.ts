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

/**
 * WMS-30B (ADR 0091): what someone reported was verified (by Calidad or,
 * without it, by who verifies produced output).
 */
export const OUTPUT_VERIFIED_NOTICE: NotificationType = {
  key: "production.output_verified",
  module: "production",
  label: "Se verificó lo que reportaste",
  description:
    "Cuando se verifica lo que reportaste como producido: cuánto se aprobó y qué pasó con lo demás.",
  defaultEnabled: true,
  visibleWith: ["production.report.create"],
};

/** WMS-31 (ADR 0093): an order someone asked for or works on was closed. */
export const ORDER_CLOSED_NOTICE: NotificationType = {
  key: "production.order_closed",
  module: "production",
  label: "Se cerró una orden de producción",
  description:
    "Cuando se cierra una orden que pediste o en la que estás asignado: cuánto se hizo.",
  defaultEnabled: true,
  visibleWith: ["production.order.read"],
};

export const PRODUCTION_NOTIFICATION_TYPES: readonly NotificationType[] = [
  REQUEST_TO_DECIDE_NOTICE,
  REQUEST_ANSWERED_NOTICE,
  ORDER_FROM_REQUEST_NOTICE,
  MATERIAL_SHORT_NOTICE,
  OUTPUT_VERIFIED_NOTICE,
  ORDER_CLOSED_NOTICE,
];
