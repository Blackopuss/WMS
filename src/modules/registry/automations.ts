import {
  INVENTORY_AUTOMATION_ACTIONS,
  INVENTORY_AUTOMATION_TRIGGERS,
} from "@/modules/inventory";
import { PURCHASING_AUTOMATION_TRIGGERS } from "@/modules/purchasing";
import {
  assertValidAutomationCatalog,
  NOTIFY_ACTION,
  type AutomationCatalog,
} from "@/platform/automations";

/**
 * What each module offers to automations (WMS-64, ADR 0092): triggers and
 * actions, checked together when the application starts. The platform
 * never imports modules, so the rules screen, the jobs and the round
 * receive this catalog. A module with triggers or actions adds them here.
 */
export const automationCatalog: AutomationCatalog = {
  triggers: [
    ...INVENTORY_AUTOMATION_TRIGGERS,
    ...PURCHASING_AUTOMATION_TRIGGERS,
  ],
  actions: [NOTIFY_ACTION, ...INVENTORY_AUTOMATION_ACTIONS],
};

assertValidAutomationCatalog(
  automationCatalog.triggers,
  automationCatalog.actions,
);
