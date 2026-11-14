import { INVENTORY_SETTINGS } from "@/modules/inventory";
import { PURCHASING_SETTINGS } from "@/modules/purchasing";
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
  // WMS-38: shown on Configuración › Terminales compartidas, not in
  // Operación (one place each).
  ...TERMINAL_SETTINGS,
];

assertValidRegistry(operationSettings);
