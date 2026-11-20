import type { NotificationType } from "@/platform/notifications";

/**
 * Notices of automations (WMS-64, ADR 0092), registered in
 * src/modules/registry/notifications.ts.
 */
export const RULE_FIRED_NOTICE: NotificationType = {
  key: "automations.rule_fired",
  module: null,
  label: "Una automatización te avisa",
  description:
    "Cuando una regla de Configuración › Automatizaciones avisa a tu rol o a ti.",
  defaultEnabled: true,
};

export const RULE_PAUSED_NOTICE: NotificationType = {
  key: "automations.rule_paused",
  module: null,
  label: "Una automatización se apagó sola",
  description:
    "A quien administra: una regla dejó de ejecutarse por fallas seguidas, por su módulo o porque su persona ya no puede hacer lo que pide.",
  defaultEnabled: true,
  visibleWith: ["platform.organization.update"],
};

export const AUTOMATION_NOTIFICATION_TYPES: readonly NotificationType[] = [
  RULE_FIRED_NOTICE,
  RULE_PAUSED_NOTICE,
];
