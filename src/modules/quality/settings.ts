import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Calidad (WMS-30A, ADR 0067). Read inside the
 * transaction that decides, with `readSetting`.
 */

/**
 * How the quality is checked when the plan of the product says «as the
 * company setting», or there is no plan for that origin (D6). The quantity
 * is always counted in full (D5).
 */
export const SAMPLING_DEFAULT = {
  key: "quality.sampling.default",
  module: "quality",
  area: "Calidad",
  label: "Revisión de calidad si el plan no la dice",
  options: [
    {
      value: "full",
      label: "Completa",
      help: "Se revisa la calidad de todo lo que espera verificación.",
    },
    {
      value: "sample",
      label: "Por muestra",
      help: "Se revisa una parte; quien inspecciona anota cuántas revisó.",
    },
  ],
  defaultValue: "full",
} as const satisfies SettingDefinition;

/**
 * Whether rejecting or putting in quarantine asks for a photo (applied by
 * WMS-30B). A difference in the quantity always asks for one (P4).
 */
export const EVIDENCE_PHOTO = {
  key: "quality.evidence.photo",
  module: "quality",
  area: "Calidad",
  label: "Foto al rechazar o poner en cuarentena",
  options: [
    {
      value: "optional",
      label: "Opcional",
      help: "Quien inspecciona decide si la toma.",
    },
    {
      value: "required",
      label: "Obligatoria",
      help: "No se rechaza ni se pone en cuarentena sin foto.",
    },
  ],
  defaultValue: "optional",
} as const satisfies SettingDefinition;

export const QUALITY_SETTINGS: readonly SettingDefinition[] = [
  SAMPLING_DEFAULT,
  EVIDENCE_PHOTO,
];
