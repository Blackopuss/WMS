import type { NotificationType } from "@/platform/notifications";

/**
 * Notices of shared terminals (WMS-38, ADR 0061 §1 and §6). Registered
 * with the modules' types in src/modules/registry/notifications.ts;
 * `platform/auth` loads the clone notice when it detects a copied cookie.
 */
export const TERMINAL_LOCKED_NOTICE: NotificationType = {
  key: "platform.terminal_locked",
  module: null,
  label: "PIN incorrectos en una terminal",
  description:
    "Cuando una terminal compartida o el PIN de una persona se bloquean un rato por demasiados PIN incorrectos, o una terminal junta muchos en un día.",
  defaultEnabled: true,
};

export const TERMINAL_CLONED_NOTICE: NotificationType = {
  key: "platform.terminal_cloned",
  module: null,
  label: "Terminal quitada por copia de su cookie",
  description:
    "Cuando el sistema quita una terminal compartida porque alguien usó una copia de su cookie.",
  defaultEnabled: true,
};

export const TERMINAL_NOTIFICATION_TYPES: readonly NotificationType[] = [
  TERMINAL_LOCKED_NOTICE,
  TERMINAL_CLONED_NOTICE,
];
