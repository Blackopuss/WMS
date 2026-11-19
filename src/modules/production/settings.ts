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

/**
 * WMS-28B (ADR 0075): how close to its minimum a product must be to offer it
 * in «Queda poco» to who may ask for production (P8): available at or below
 * minimum × (1 + margin).
 */
export const LOW_MARGIN = {
  key: "production.request.low_margin",
  module: "production",
  area: "Producción",
  label: "Productos que se ofrecen para pedir producción",
  options: [
    {
      value: "0",
      label: "En su mínimo o debajo",
      help: "Solo lo que ya llegó a su mínimo.",
    },
    {
      value: "10",
      label: "Hasta 10 % arriba del mínimo",
      help: "Lo que está en su mínimo o hasta 10 % arriba.",
    },
    {
      value: "25",
      label: "Hasta 25 % arriba del mínimo",
      help: "Lo que está en su mínimo o hasta 25 % arriba.",
    },
    {
      value: "50",
      label: "Hasta 50 % arriba del mínimo",
      help: "Lo que está en su mínimo o hasta la mitad arriba.",
    },
  ],
  defaultValue: "25",
} as const satisfies SettingDefinition;



/**
 * WMS-29 (ADR 0087, D5): a photo of what was made with each report.
 * Required by default (D5); the founder may change it.
 */
export const REPORT_PHOTO = {
  key: "production.report.photo",
  module: "production",
  area: "Producción",
  label: "Foto al reportar producción",
  options: [
    {
      value: "required",
      label: "Obligatoria",
      help: "Cada reporte lleva al menos una foto de lo que se hizo.",
    },
    {
      value: "optional",
      label: "Opcional",
      help: "Quien reporta puede agregar fotos si quiere.",
    },
    {
      value: "off",
      label: "Sin fotos",
      help: "Los reportes no piden ni aceptan fotos.",
    },
  ],
  defaultValue: "required",
} as const satisfies SettingDefinition;

export const PRODUCTION_SETTINGS: readonly SettingDefinition[] = [
  MATERIALS_MODE,
  RELEASE_SHORT,
  LOW_MARGIN,
  REPORT_PHOTO,
];
