import { INVENTORY_SETTINGS } from "@/modules/inventory";
import {
  assertValidRegistry,
  type SettingDefinition,
} from "@/platform/settings";

/**
 * Operation settings of every module (WMS-49), checked together when the
 * application starts: a repeated key or a default that is not an option
 * stops it. A module with settings adds its list here.
 */
export const operationSettings: readonly SettingDefinition[] = [
  ...INVENTORY_SETTINGS,
];

assertValidRegistry(operationSettings);
