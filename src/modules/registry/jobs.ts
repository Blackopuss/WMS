import {
  dailyDigestJobHandlers,
  exitImportJobHandlers,
  inventoryJobHandlers,
} from "@/modules/inventory";
import { purchasingJobHandlers } from "@/modules/purchasing";
import {
  WEBHOOK_DELIVERY_JOB,
  WEBHOOK_FANOUT_JOB,
  webhookDeliveryHandler,
  webhookFanoutHandler,
} from "@/platform/api";
import { automationJobHandlers } from "@/platform/automations";
import type { JobHandlers } from "@/platform/jobs";
import { noticeEmailJobHandlers } from "@/platform/notifications";

import { automationCatalog } from "./automations";
import { demoJobHandlers } from "./demo";
import { notificationTypes } from "./notifications";

/**
 * Background work of every module, by job type (IMP-01). The platform
 * runs the queue but never imports modules: the worker process receives
 * this list. A module adds its handlers here («inventory.import_products»).
 */
export const jobHandlers: JobHandlers = {
  ...inventoryJobHandlers,
  ...exitImportJobHandlers,
  // WMS-39B (ADR 0060): the daily summary by mail.
  ...dailyDigestJobHandlers,
  ...purchasingJobHandlers,
  // WMS-39B (ADR 0060): notices that a person asked to get by mail.
  ...noticeEmailJobHandlers(notificationTypes),
  // WMS-60 (ADR 0058): hand an event out to its destinations (outside the
  // transaction of the fact), and the signed delivery, with retries.
  [WEBHOOK_FANOUT_JOB]: webhookFanoutHandler(),
  [WEBHOOK_DELIVERY_JOB]: webhookDeliveryHandler(),
  // WMS-44 (ADR 0089): load the data of a demonstration company.
  ...demoJobHandlers,
  // WMS-64 (ADR 0092): evaluate the rules of a fact and run their actions.
  ...automationJobHandlers(automationCatalog),
};
