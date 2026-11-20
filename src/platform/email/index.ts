// Public API of platform/email: outgoing email and templates (PLT-03).
export {
  InvalidEmailError,
  MAX_ATTACHMENTS_BYTES,
  listDevOutbox,
  smtpSettings,
  memoryOutboxFor,
  sendEmail,
} from "./send";
export type {
  EmailAttachment,
  EmailMessage,
  SmtpSettings,
  StoredAttachment,
  StoredEmail,
} from "./send";
export {
  accessAlertEmail,
  backupCodeUsedEmail,
  backupCodesRegeneratedEmail,
  dailyDigestEmail,
  existingAccountEmail,
  invitationEmail,
  mfaDisabledEmail,
  noticeEmail,
  operationsAlertEmail,
  ownershipEmail,
  mfaEnabledEmail,
  passwordChangedEmail,
  passwordResetEmail,
  purchaseOrderEmail,
  verificationEmail,
} from "./templates";
export type { AccessAlertKind } from "./templates";
export { escapeHtml, htmlEmail } from "./html";
export type { HtmlBlock } from "./html";
