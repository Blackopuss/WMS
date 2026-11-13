import type { NotificationType } from "@/platform/notifications";

/**
 * Notices of the approval engine (WMS-39, ADR 0057): who may decide hears
 * that something waits for them; who asked hears the answer. Registered
 * with the modules' types in src/modules/registry/notifications.ts.
 */
export const APPROVAL_PENDING_NOTICE: NotificationType = {
  key: "approvals.pending",
  module: null,
  label: "Algo espera tu autorización",
  description: "Cuando alguien pide una autorización que tú puedes dar.",
  defaultEnabled: true,
};

export const APPROVAL_DECIDED_NOTICE: NotificationType = {
  key: "approvals.decided",
  module: null,
  label: "Respuesta a lo que pediste autorizar",
  description: "Cuando se autoriza, se rechaza o vence algo que pediste.",
  defaultEnabled: true,
};

export const APPROVAL_NOTIFICATION_TYPES: readonly NotificationType[] = [
  APPROVAL_PENDING_NOTICE,
  APPROVAL_DECIDED_NOTICE,
];
