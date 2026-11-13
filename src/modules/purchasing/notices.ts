import type { NotificationType } from "@/platform/notifications";

/**
 * What Compras notifies about (WMS-39, ADR 0057); registered in
 * src/modules/registry/notifications.ts.
 */
export const REQUEST_TO_ATTEND_NOTICE: NotificationType = {
  key: "purchasing.request_to_attend",
  module: "purchasing",
  label: "Hay una solicitud de compra por atender",
  description:
    "Cuando una solicitud de compra de tu almacén llega a Compras (quien compra).",
  defaultEnabled: true,
};

export const REQUEST_ANSWERED_NOTICE: NotificationType = {
  key: "purchasing.request_answered",
  module: "purchasing",
  label: "Respuesta a tu solicitud de compra",
  description:
    "Cuando Compras convierte en orden o rechaza una solicitud que hiciste.",
  defaultEnabled: true,
};

export const PURCHASING_NOTIFICATION_TYPES: readonly NotificationType[] = [
  REQUEST_TO_ATTEND_NOTICE,
  REQUEST_ANSWERED_NOTICE,
];
