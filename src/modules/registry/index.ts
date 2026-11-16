// Public API of the module registry (MOD-02): the contracts of every module
// of the product, checked together when the application starts.
import { inventoryModule } from "@/modules/inventory";
import { productionModule } from "@/modules/production";
import { purchasingModule } from "@/modules/purchasing";
import { qualityModule } from "@/modules/quality";
import { createModuleRegistry } from "@/platform/billing";

import { crmModule } from "./announced";

export { approvalTypes } from "./approvals";
export { customFieldReservedLabels } from "./custom-fields";
export { moduleOpenWork } from "./open-work";
export { notificationTypes } from "./notifications";
export { operationSettings } from "./settings";
export { webhookEventTypes } from "./webhooks";

/**
 * Installed modules. Inventario and Compras can be contracted; Producción
 * and Calidad (WMS-59) and CRM are announced but not available, so nothing
 * can activate them yet.
 * A module added here with an unknown or circular dependency stops the
 * application from starting.
 */
export const moduleRegistry = createModuleRegistry([
  inventoryModule,
  purchasingModule,
  productionModule,
  qualityModule,
  crmModule,
]);

export type ModuleId =
  "inventory" | "purchasing" | "production" | "quality" | "crm";
