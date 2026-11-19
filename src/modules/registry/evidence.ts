import { reachesIncident, reachesTask } from "@/modules/inventory";
import type { EvidenceOwners } from "@/platform/files";
import { reachesProductionReport } from "@/modules/production";
import { reachesPurchaseReceipt } from "@/modules/purchasing";
import { processStepReach } from "@/platform/processes";

import { processDocuments } from "./processes";

/**
 * Who reaches the record a photo of evidence belongs to (WMS-37, ADR
 * 0063). The platform asks these functions before opening a photo; a kind
 * without its function «does not exist» for everybody. A step that adds a
 * kind of record with photos (production reports, quality inspections,
 * process stages) adds its function here.
 */
export const evidenceOwners: EvidenceOwners = {
  incident: reachesIncident,
  // WMS-74: a step of a process, for who reads its document.
  process_step: processStepReach(processDocuments),
  // WMS-37B (ADR 0076): a warehouse task, for who reaches it.
  warehouse_task: reachesTask,
  // WMS-84 (ADR 0079): a receipt, for what was rejected at the door.
  purchase_receipt: reachesPurchaseReceipt,
  // WMS-29 (ADR 0087): a production report, for who reaches its order.
  production_report: reachesProductionReport,
};
