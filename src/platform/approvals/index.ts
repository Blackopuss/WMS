// Public API of platform/approvals: approval rules and requests (WMS-56, ADR 0053).
export { ApprovalExpired, assertValidApprovalTypes } from "./definitions";
export type { ApprovalContext, ApprovalTx, ApprovalType } from "./definitions";
export {
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABELS,
  APPROVAL_TRANSITIONS,
  canTransition,
} from "./states";
export type { ApprovalStatus } from "./states";
export {
  approvalRequired,
  getApprovalRules,
  readApprovalRule,
  rolesThatMayDecide,
  updateApprovalRule,
} from "./rules";
export type {
  ApprovalRuleValue,
  ApprovalRuleView,
  UpdateApprovalRuleResult,
} from "./rules";
export {
  APPROVALS_PAGE_SIZE,
  cancelApproval,
  countPendingApprovals,
  decideApproval,
  expireApprovalRequest,
  findApprovalByKey,
  findOpenApproval,
  getApprovalRequest,
  listMyApprovalRequests,
  listPendingApprovals,
  openApprovalRequest,
} from "./requests";
export type {
  ApprovalPage,
  ApprovalRequestSummary,
  ApprovalRequestView,
  CancelApprovalResult,
  DecideInput,
  DecideResult,
  OpenApprovalInput,
  OpenApprovalResult,
} from "./requests";
export {
  APPROVAL_DECIDED_NOTICE,
  APPROVAL_NOTIFICATION_TYPES,
  APPROVAL_PENDING_NOTICE,
} from "./notices";
