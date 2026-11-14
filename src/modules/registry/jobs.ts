import {
  exitImportJobHandlers,
  inventoryJobHandlers,
} from "@/modules/inventory";
import { purchasingJobHandlers } from "@/modules/purchasing";
import { WEBHOOK_DELIVERY_JOB, webhookDeliveryHandler } from "@/platform/api";
import type { JobHandlers } from "@/platform/jobs";

/**
 * Background work of every module, by job type (IMP-01). The platform
 * runs the queue but never imports modules: the worker process receives
 * this list. A module adds its handlers here («inventory.import_products»).
 */
export const jobHandlers: JobHandlers = {
  ...inventoryJobHandlers,
  ...exitImportJobHandlers,
  ...purchasingJobHandlers,
  // WMS-60 (ADR 0058): signed delivery of a webhook event, with retries.
  [WEBHOOK_DELIVERY_JOB]: webhookDeliveryHandler(),
};
