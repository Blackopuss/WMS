// Public API of platform/authorization: Predefined roles and permission checks (USR).
export {
  OWNER_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  ROLE_MODULE,
  ROLE_PERMISSIONS,
  isPermission,
  isRole,
} from "./catalog";
export type { Permission, Role } from "./catalog";
export {
  OWNER_ONLY_PERMISSIONS,
  buildScope,
  can,
  canAll,
  canAny,
  isOwnerOnly,
  knownRoles,
  inScope,
  permissionsOf,
  scopeOf,
} from "./policy";
export type { Place, Scope, Subject } from "./policy";
export { loadScope, seesWholeCompany } from "./scope";
export type { ScopeReader } from "./scope";
export {
  FORBIDDEN_MESSAGE,
  OWNER_ONLY_MESSAGE,
  assertAllowed,
  assertOwnerAction,
  getAccess,
  isAllowed,
  loadSubject,
  requireOwnerAction,
  requirePermission,
} from "./access";
export type { Access } from "./access";
export {
  TEAM_RULE_MESSAGES,
  assignableRoles,
  checkInvitationRoles,
  checkTeamChange,
} from "./team-rules";
export type {
  TeamChange,
  TeamPerson,
  TeamRuleReason,
  TeamRuleResult,
} from "./team-rules";
export {
  OWNERSHIP_MESSAGES,
  OWNERSHIP_OFFER_DAYS,
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  getPendingOwnershipTransfer,
  offerOwnershipTransfer,
} from "./ownership";
export type {
  OfferOwnershipResult,
  OwnershipActionResult,
  OwnershipReason,
  PendingOwnershipTransfer,
} from "./ownership";
export {
  INVITATION_DAYS,
  INVITATION_PATH,
  cancelInvitation,
  createInvitation,
  hashInvitationToken,
  listPendingInvitations,
  resendInvitation,
} from "./invitations";
export type {
  CreateInvitationResult,
  InvitationActionResult,
  InvitationField,
  PendingInvitation,
} from "./invitations";
export {
  ACCEPT_INVITATION_MESSAGES,
  acceptInvitation,
  acceptInvitationAsNewUser,
  previewInvitation,
} from "./invitation-accept";
export type {
  AcceptAsNewUserResult,
  AcceptInvitationReason,
  AcceptInvitationResult,
  InvitationPreview,
} from "./invitation-accept";
export {
  assignRoles,
  countSeatsInUse,
  disableMember,
  listScopeOptions,
  listTeamMembers,
  reactivateMember,
  setMemberScope,
} from "./team";
export type {
  MemberScopeEntry,
  MemberScopeInput,
  ScopeOption,
  TeamActionReason,
  TeamActionResult,
  TeamMember,
} from "./team";
export {
  SeatLimitError,
  assertSeatAvailable,
  getSeatUsage,
  lockOrganization,
  seatLimitMessage,
} from "./seats";
export type { SeatUsage } from "./seats";
export {
  SUPPORT_ACCESS_HOURS,
  enterSupport,
  getSupportAccess,
  grantSupportAccess,
  leaveSupport,
  listOpenSupportAccess,
  revokeSupportAccess,
} from "./support";
export type { EnterSupportResult, SupportAccessView } from "./support";
export {
  MEMBER_SESSIONS_MAX,
  SESSION_REVOKE_REASON_MAX,
  listMemberSessions,
  revokeAllMemberSessions,
  revokeMemberSession,
} from "./team-sessions";
export type {
  MemberSession,
  MemberSessionsView,
  SessionRevokeResult,
} from "./team-sessions";
export { SESSIONS_CLOSED_NOTICE, TEAM_NOTIFICATION_TYPES } from "./notices";
