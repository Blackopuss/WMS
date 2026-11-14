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

export const TEAM_NOTIFICATION_TYPES: readonly NotificationType[] = [
  SESSIONS_CLOSED_NOTICE,
];
