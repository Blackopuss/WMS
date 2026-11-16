import { INVENTORY_SETTINGS } from "@/modules/inventory";
import { PRODUCTION_SETTINGS } from "@/modules/production";
import { PURCHASING_SETTINGS } from "@/modules/purchasing";
import { QUALITY_SETTINGS } from "@/modules/quality";
import { NOTIFICATION_SETTINGS } from "@/platform/notifications";
import {
  assertValidRegistry,
  type SettingDefinition,
} from "@/platform/settings";
import { TERMINAL_SETTINGS } from "@/platform/terminals";

/**
 * Operation settings of every module (WMS-49), checked together when the
 * application starts: a repeated key or a default that is not an option
 * stops it. A module with settings adds its list here.
 */
export const operationSettings: readonly SettingDefinition[] = [
  ...INVENTORY_SETTINGS,
  ...PURCHASING_SETTINGS,
  // WMS-28 (ADR 0073): how materials reach the line and incomplete releases.
  ...PRODUCTION_SETTINGS,
  // WMS-30A (ADR 0067): sampling and photos of Calidad.
  ...QUALITY_SETTINGS,
  // WMS-39B (ADR 0060): whether the company sends notices by mail.
  ...NOTIFICATION_SETTINGS,
  // WMS-38: shown on Configuración › Terminales compartidas, not in
  // Operación (one place each).
  ...TERMINAL_SETTINGS,
];

assertValidRegistry(operationSettings);
