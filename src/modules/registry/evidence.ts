import { reachesIncident } from "@/modules/inventory";
import type { EvidenceOwners } from "@/platform/files";
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
};
