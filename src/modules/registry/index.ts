// Public API of the module registry (MOD-02): the contracts of every module
// of the product, checked together when the application starts.
import { inventoryModule } from "@/modules/inventory";
import { purchasingModule } from "@/modules/purchasing";
import { createModuleRegistry } from "@/platform/billing";

import { crmModule } from "./announced";

export { approvalTypes } from "./approvals";
export { customFieldReservedLabels } from "./custom-fields";
export { moduleOpenWork } from "./open-work";
export { operationSettings } from "./settings";

/**
 * Installed modules. Inventario and Compras can be contracted; CRM is
 * announced but not available, so nothing can activate them yet.
 * A module added here with an unknown or circular dependency stops the
 * application from starting.
 */
export const moduleRegistry = createModuleRegistry([
  inventoryModule,
  purchasingModule,
  crmModule,
]);

export type ModuleId = "inventory" | "purchasing" | "crm";
