// Public API of platform/notifications: notices inside the app (WMS-39, ADR 0057).
export {
  NOTIFICATION_TEXT_MAX,
  assertValidNotificationTypes,
  noticeText,
} from "./definitions";
export type { NotificationType } from "./definitions";
export { NOTIFY_MAX_RECIPIENTS, memberName, notify } from "./notify";
export type {
  NotifyInput,
  NotifyRecipients,
  NotifyResult,
  NotifyTx,
} from "./notify";
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
