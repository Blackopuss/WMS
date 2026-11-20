import { SHIPMENT_PROCESS } from "@/modules/inventory";
import {
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_ORDER_PROCESS,
} from "@/modules/production";
import {
  assertValidProcessDocuments,
  type ProcessDocument,
} from "@/platform/processes";

/**
 * Documents that can follow a process of the company (WMS-74, ADR 0069),
 * checked together when the application starts: a repeated or malformed
 * key stops it. The platform never imports modules, so the engine of
 * processes receives this list. The shipment is the first (WMS-74B, ADR
 * 0071), the production order the second (WMS-28, ADR 0073) and the
 * produced batch (each report, WMS-29, ADR 0087) the third.
 */
export const processDocuments: readonly ProcessDocument[] = [
  SHIPMENT_PROCESS,
  // WMS-28 (ADR 0073).
  PRODUCTION_ORDER_PROCESS,
  // WMS-29 (ADR 0087).
  PRODUCTION_BATCH_PROCESS,
];

assertValidProcessDocuments(processDocuments);
