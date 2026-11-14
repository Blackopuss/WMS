// Public API of platform/notifications: notices inside the app (WMS-39, ADR 0057).
export {
  NOTIFICATION_TEXT_MAX,
  assertValidNotificationTypes,
  isEmailOnly,
  noticeText,
} from "./definitions";
export type { NotificationType } from "./definitions";
export {
  NOTICE_EMAIL_GAP_MS,
  NOTICE_EMAIL_GROUP_MS,
  NOTICE_EMAIL_JOB_TYPE,
  NOTIFY_MAX_RECIPIENTS,
  memberName,
  nextMailAt,
  notify,
} from "./notify";
export type {
  NoticeRequirement,
  NotifyInput,
  NotifyRecipients,
  NotifyResult,
  NotifyTx,
} from "./notify";
export {
  NOTICE_EMAIL_LINES,
  appLink,
  companySendsNoticeEmails,
  emailSubscribers,
  failNoticeEmails,
  isEmailChannelOn,
  memberAddress,
  noticeEmailJobHandlers,
  purgeFinishedNoticeEmails,
  sendNoticeEmails,
  wantsEmail,
} from "./emails";
export type { NoticeEmailOutcome } from "./emails";
export { NOTICE_EMAIL_CHANNEL, NOTIFICATION_SETTINGS } from "./settings";
export {
  NOTIFICATIONS_PAGE_SIZE,
  READ_NOTICE_DAYS,
  RECENT_NOTIFICATIONS,
  countUnreadNotifications,
  getNotificationPreferences,
  listNotifications,
  listRecentNotifications,
  markAllNotificationsRead,
  openNotification,
  purgeReadNotifications,
  setNotificationPreference,
} from "./notifications";
export type {
  NotificationPage,
  NotificationPreferenceView,
  NotificationView,
  OpenNotificationResult,
  SetPreferenceResult,
} from "./notifications";
