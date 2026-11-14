import {
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
  // WMS-60 (ADR 0058): hand an event out to its destinations (outside the
  // transaction of the fact), and the signed delivery, with retries.
  [WEBHOOK_FANOUT_JOB]: webhookFanoutHandler(),
  [WEBHOOK_DELIVERY_JOB]: webhookDeliveryHandler(),
};
