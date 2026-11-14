import type { NotificationType } from "@/platform/notifications";

/**
 * Notices of shared terminals (WMS-38, ADR 0061 §6). Registered with the
 * modules' types in src/modules/registry/notifications.ts.
 */
export const TERMINAL_LOCKED_NOTICE: NotificationType = {
  key: "platform.terminal_locked",
  module: null,
  label: "Terminal bloqueada por intentos",
  description:
    "Cuando una terminal compartida se bloquea un rato por demasiados PIN incorrectos.",
  defaultEnabled: true,
};

export const TERMINAL_NOTIFICATION_TYPES: readonly NotificationType[] = [
  TERMINAL_LOCKED_NOTICE,
];
