import { SHIPMENT_PROCESS } from "@/modules/inventory";
import { PRODUCTION_ORDER_PROCESS } from "@/modules/production";
import {
  assertValidProcessDocuments,
  type ProcessDocument,
} from "@/platform/processes";

/**
 * Documents that can follow a process of the company (WMS-74, ADR 0069),
 * checked together when the application starts: a repeated or malformed
 * key stops it. The platform never imports modules, so the engine of
 * processes receives this list. The shipment is the first (WMS-74B, ADR
 * 0071) and the production order the second (WMS-28, ADR 0073); the
 * produced batch arrives with WMS-29 and adds its `ProcessDocument` here.
 */
export const processDocuments: readonly ProcessDocument[] = [
  SHIPMENT_PROCESS,
  // WMS-28 (ADR 0073).
  PRODUCTION_ORDER_PROCESS,
];

assertValidProcessDocuments(processDocuments);
