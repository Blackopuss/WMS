import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Producción (WMS-28, ADR 0073). Read inside the
 * transaction that decides, with `readSetting`.
 */

/**
 * How the materials of a released order reach the line (D3, P2): consumed
 * where they are set aside (by default), or brought to the production area
 * with «Surtir a producción» tasks.
 */
export const MATERIALS_MODE = {
  key: "production.materials.mode",
  module: "production",
  area: "Producción",
  label: "Materiales de una orden liberada",
  options: [
    {
      value: "direct",
      label: "Se toman de donde están",
      help: "Liberar aparta cada material donde está; producción lo usa de ahí.",
    },
    {
      value: "issue",
      label: "Se surten al área de producción",
      help: "Liberar aparta cada material y crea tareas para llevarlo al área de la orden.",
    },
  ],
  defaultValue: "direct",
} as const satisfies SettingDefinition;

/** Whether an order may be released when a material does not reach. */
export const RELEASE_SHORT = {
  key: "production.release.short",
  module: "production",
  area: "Producción",
  label: "Liberar una orden sin todos los materiales",
  options: [
    {
      value: "ask",
      label: "Preguntar",
      help: "Dice qué falta y deja liberar con lo que hay.",
    },
    {
      value: "block",
      label: "No liberar",
      help: "La orden se libera solo cuando alcanzan todos los materiales.",
    },
  ],
  defaultValue: "ask",
} as const satisfies SettingDefinition;

export const PRODUCTION_SETTINGS: readonly SettingDefinition[] = [
  MATERIALS_MODE,
  RELEASE_SHORT,
];
