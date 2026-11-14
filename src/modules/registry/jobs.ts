import {
  dailyDigestJobHandlers,
  exitImportJobHandlers,
  inventoryJobHandlers,
} from "@/modules/inventory";
import { purchasingJobHandlers } from "@/modules/purchasing";
import type { JobHandlers } from "@/platform/jobs";
import { noticeEmailJobHandlers } from "@/platform/notifications";

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
};
