// Public API of platform/auth: identity, sessions and MFA (PLT).
export {
  RESET_PASSWORD_MINUTES,
  TOTP_DIGITS,
  VERIFICATION_HOURS,
  VERIFY_EMAIL_COOKIE,
  auth,
} from "./auth";
export type { Session } from "./auth";
export {
  confirmTotpEnrollment,
  getMfaStatus,
  isMfaRequired,
  normalizeTotpCode,
  startTotpEnrollment,
  verifySignInCode,
} from "./mfa";
export type {
  ConfirmTotpResult,
  MfaStatus,
  SignInCodeResult,
  StartTotpResult,
} from "./mfa";
export { disableMfa, regenerateBackupCodes } from "./mfa-recovery";
export {
  ACCESS_ACTIONS,
  ACCESS_ACTION_LABELS,
  ACCESS_ALERTS_PER_DAY,
  ACCESS_ALERT_MAIL_ATTEMPTS,
  ACCESS_HISTORY_PAGE_SIZE,
  PURGEABLE_SECURITY_ACTIONS,
  SECURITY_EVENT_KEEP_DAYS,
  alertFailedAttempts,
  alertPinLocked,
  deliverAccessAlertEmail,
  listMyAccessHistory,
  noteSignIn,
  purgeExpiredSecurityEvents,
  readAccessHistory,
  retryAccessAlertEmails,
} from "./access-history";
export {
  ACCESS_ALERT_NOTICE,
  ACCESS_NOTIFICATION_TYPES,
} from "./access-notices";
export type {
  AccessHistoryPage,
  AccessHistoryRow,
  AlertMailOutcome,
} from "./access-history";
export { BACKUP_CODE_COUNT, normalizeBackupCode } from "./backup-codes";
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";
export { verifyAccountPassword } from "./account-password";
export { hashPin, verifyNoPin, verifyPin } from "./pin-hash";
export { usersWhoMustUseMfa } from "./mfa-policy";
export { requestPasswordReset, resetPassword } from "./recovery";
export type {
  PasswordResetRequestResult,
  PasswordResetResult,
} from "./recovery";
export { DEFAULT_AFTER_SIGN_IN, safeRedirectPath } from "./redirect";
export { registerUser, resendVerification } from "./register";
export type {
  RegisterField,
  RegisterInput,
  RegisterResult,
  ResendResult,
} from "./register";
export {
  LEGAL_ACCEPTANCE_PATH,
  MFA_SETUP_PATH,
  getCurrentSession,
  refuseOnTerminal,
  requireSession,
  signIn,
  signOut,
} from "./session";
export type { CurrentUser, SessionTerminal, SignInResult } from "./session";
export {
  DEFAULT_PIN_ROLES,
  PIN_CANDIDATES_MAX,
  PIN_ROLES_SETTING_KEY,
  PIN_ROLE_SETS,
  TERMINAL_ACTIVITY_INTERVAL_MS,
  TERMINAL_COOKIE,
  TERMINAL_SECRET_GRACE_MS,
  TERMINAL_PASSWORD_PATH,
  TERMINAL_PATH,
  TERMINAL_SESSION_MAX_HOURS,
  TERMINAL_SESSION_MESSAGE,
  assertNotTerminalSession,
  hashTerminalSecret,
  newTerminalSecret,
  openTerminalSession,
  pinCandidates,
  rotateTerminalSecret,
  terminalBySecret,
  terminalCookieOptions,
  terminalCookieValue,
  terminalOfDevice,
  terminalSessionExpiry,
  terminalUserOfRequest,
  touchTerminalSession,
} from "./terminal-session";
export type {
  DeviceTerminal,
  PinCandidate,
  PinRoleSet,
} from "./terminal-session";
export {
  SESSION_ACTIVITY_INTERVAL_MS,
  activityIsStale,
  noteSessionActivity,
  recordSessionActivity,
} from "./activity";
export {
  listActiveSessions,
  revokeOtherSessions,
  revokeSession,
} from "./sessions";
export type { ActiveSession } from "./sessions";
export { handleAuthRequest, isAllowedAuthRequest } from "./http";
export {
  blockedFor,
  clearAttempts,
  clearPinAttempts,
  clientIp,
  recordAttempt,
  refundAttempt,
  reserveAttempt,
  countInWindow,
  settleFailure,
  throttleKeys,
  tooManyAttemptsMessage,
} from "./throttle";
export { insertInvitedAccount, prepareInvitedAccount } from "./invited-account";
export type {
  InvitedAccountField,
  PreparedInvitedAccount,
} from "./invited-account";
