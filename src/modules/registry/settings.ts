import { INVENTORY_SETTINGS } from "@/modules/inventory";
import { PURCHASING_SETTINGS } from "@/modules/purchasing";
import { NOTIFICATION_SETTINGS } from "@/platform/notifications";
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
  ...PURCHASING_SETTINGS,
  // WMS-39B (ADR 0060): whether the company sends notices by mail.
  ...NOTIFICATION_SETTINGS,
];

assertValidRegistry(operationSettings);
