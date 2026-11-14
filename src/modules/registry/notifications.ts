import { INVENTORY_NOTIFICATION_TYPES } from "@/modules/inventory";
import { PURCHASING_NOTIFICATION_TYPES } from "@/modules/purchasing";
import { API_NOTIFICATION_TYPES } from "@/platform/api";
import { APPROVAL_NOTIFICATION_TYPES } from "@/platform/approvals";
import {
  assertValidNotificationTypes,
  type NotificationType,
} from "@/platform/notifications";

/**
 * What each module (and the approval engine) may notify about (WMS-39,
 * ADR 0057), checked together when the application starts: a repeated or
 * malformed key stops it. The platform never imports modules, so the
 * preferences screen receives this list. A module with notices adds its
 * list here.
 */
export const notificationTypes: readonly NotificationType[] = [
  ...APPROVAL_NOTIFICATION_TYPES,
  ...API_NOTIFICATION_TYPES,
  ...INVENTORY_NOTIFICATION_TYPES,
  ...PURCHASING_NOTIFICATION_TYPES,
];

assertValidNotificationTypes(notificationTypes);
