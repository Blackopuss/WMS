import { SHIPMENT_PROCESS } from "@/modules/inventory";
import {
  assertValidProcessDocuments,
  type ProcessDocument,
} from "@/platform/processes";

/**
 * Documents that can follow a process of the company (WMS-74, ADR 0069),
 * checked together when the application starts: a repeated or malformed
 * key stops it. The platform never imports modules, so the engine of
 * processes receives this list. The shipment is the first (WMS-74B, ADR
 * 0071); the order of production and the produced batch arrive with
 * WMS-28 and WMS-29, and each adds its `ProcessDocument` here.
 */
export const processDocuments: readonly ProcessDocument[] = [SHIPMENT_PROCESS];

assertValidProcessDocuments(processDocuments);
