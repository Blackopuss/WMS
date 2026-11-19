import type { NotificationType } from "@/platform/notifications";

/**
 * The access alerts of the person's own account, also in the bell (WMS-88,
 * ADR 0084). Only in the app: the alert already has a mail of its own.
 */
export const ACCESS_ALERT_NOTICE: NotificationType = {
  key: "platform.access_alert",
  module: null,
  label: "Alertas de seguridad de tu cuenta",
  description:
    "Cuando alguien entra a tu cuenta desde un dispositivo nuevo o falla muchas veces. El correo de la alerta llega siempre.",
  defaultEnabled: true,
  channels: "app_only",
};

export const ACCESS_NOTIFICATION_TYPES: readonly NotificationType[] = [
  ACCESS_ALERT_NOTICE,
];
