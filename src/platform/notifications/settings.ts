import type { SettingDefinition } from "@/platform/settings";

/**
 * Whether the company sends notices by mail at all (WMS-39B, ADR 0060). On
 * by default: each person still has to ask for it, type by type. Off, no
 * mail is asked for and what was waiting does not go out; the notices in
 * the app stay as they are. A platform setting (no module), registered in
 * src/modules/registry/settings.ts.
 */
export const NOTICE_EMAIL_CHANNEL = {
  key: "platform.notices.email",
  module: null,
  area: "Avisos",
  label: "Avisos por correo",
  options: [
    {
      value: "on",
      label: "Cada persona decide",
      help: "Quien lo pida en «Avisos que recibo» también los recibe por correo.",
    },
    {
      value: "off",
      label: "Nadie recibe avisos por correo",
      help: "Los avisos se ven solo dentro de la app.",
    },
  ],
  defaultValue: "on",
} as const satisfies SettingDefinition;

export const NOTIFICATION_SETTINGS: readonly SettingDefinition[] = [
  NOTICE_EMAIL_CHANNEL,
];
