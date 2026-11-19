import { INVENTORY_APPROVAL_TYPES } from "@/modules/inventory";
import { PRODUCTION_APPROVAL_TYPES } from "@/modules/production";
import { PURCHASING_APPROVAL_TYPES } from "@/modules/purchasing";
import {
  assertValidApprovalTypes,
  type ApprovalType,
} from "@/platform/approvals";

/**
 * What each module may ask to authorize (WMS-56, ADR 0053), checked
 * together when the application starts: a repeated or malformed key stops
 * it. The platform never imports modules, so its approval services
 * receive this list. A module with approval types adds its list here.
 */
export const approvalTypes: readonly ApprovalType[] = [
  ...INVENTORY_APPROVAL_TYPES,
  ...PURCHASING_APPROVAL_TYPES,
  ...PRODUCTION_APPROVAL_TYPES,
];

assertValidApprovalTypes(approvalTypes);
