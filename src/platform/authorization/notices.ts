import type { NotificationType } from "@/platform/notifications";

/**
 * Notices of the team (WMS-40, ADR 0059): the person whose sessions were
 * closed from the team screen learns it when they come back. Registered
 * with the modules' types in src/modules/registry/notifications.ts.
 */
export const SESSIONS_CLOSED_NOTICE: NotificationType = {
  key: "team.sessions_closed",
  module: null,
  label: "Cierran tus sesiones",
  description:
    "Cuando el titular o un administrador cierra una o todas tus sesiones en la empresa.",
  defaultEnabled: true,
};

/**
 * Transfer of the company (WMS-90, ADR 0090): the person offered it, the
 * titular when it is declined, the person whose offer was cancelled and the
 * previous titular when it is accepted.
 */
export const OWNERSHIP_NOTICE: NotificationType = {
  key: "team.ownership",
  module: null,
  label: "Transferencia de la empresa",
  description:
    "Cuando te ofrecen la titularidad de la empresa, cuando se cancela esa oferta y cuando la persona a quien la ofreciste responde.",
  defaultEnabled: true,
};

export const TEAM_NOTIFICATION_TYPES: readonly NotificationType[] = [
  SESSIONS_CLOSED_NOTICE,
  OWNERSHIP_NOTICE,
];
