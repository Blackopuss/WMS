import "server-only";

import { isInternalHref, newId } from "@/lib";
import { forOrganization } from "@/server";

import type { NotificationType } from "./definitions";

/**
 * Reading and marking notices (WMS-39, ADR 0057). A notice exists only for
 * its recipient: everything here filters by the person of the session, so
 * the notice of somebody else in the same company «does not exist». The
 * identity always comes from the session (`actor`), never from a form.
 */

type Actor = { organizationId: string; userId: string };

export const NOTIFICATIONS_PAGE_SIZE = 25;
/** What the bell shows at once. */
export const RECENT_NOTIFICATIONS = 8;
/** Read notices are kept this many days, then the round removes them. */
export const READ_NOTICE_DAYS = 90;
/** Where a notice leads when its stored destination is not valid. */
const FALLBACK_HREF = "/avisos";

export type NotificationView = {
  id: string;
  text: string;
  href: string;
  typeKey: string;
  createdAt: Date;
  read: boolean;
};

const SELECT = {
  id: true,
  text: true,
  href: true,
  typeKey: true,
  createdAt: true,
  readAt: true,
} as const;

function view(row: {
  id: string;
  text: string;
  href: string;
  typeKey: string;
  createdAt: Date;
  readAt: Date | null;
}): NotificationView {
  return {
    id: row.id,
    text: row.text,
    // Checked again on the way out (defense in depth).
    href: isInternalHref(row.href) ? row.href : FALLBACK_HREF,
    typeKey: row.typeKey,
    createdAt: row.createdAt,
    read: row.readAt !== null,
  };
}

/**
 * How many notices the person has not read: one count over the index
 * (company, recipient, readAt). The layout calls it on every screen.
 */
export async function countUnreadNotifications(actor: Actor): Promise<number> {
  return forOrganization(actor.organizationId).notification.count({
    where: { recipientUserId: actor.userId, readAt: null },
  });
}

/** The latest notices of the person, for the bell, with the unread count. */
export async function listRecentNotifications(
  actor: Actor,
): Promise<{ unread: number; items: NotificationView[] }> {
  const client = forOrganization(actor.organizationId);
  const [unread, rows] = await Promise.all([
    countUnreadNotifications(actor),
    client.notification.findMany({
      where: { recipientUserId: actor.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_NOTIFICATIONS,
      select: SELECT,
    }),
  ]);
  return { unread, items: rows.map(view) };
}

export type NotificationPage = {
  rows: NotificationView[];
  total: number;
  unread: number;
  page: number;
  pageCount: number;
};

/** Every notice of the person, newest first, a page at a time. */
export async function listNotifications(
  actor: Actor,
  options: { page?: number } = {},
): Promise<NotificationPage> {
  const client = forOrganization(actor.organizationId);
  const where = { recipientUserId: actor.userId };
  const [total, unread] = await Promise.all([
    client.notification.count({ where }),
    countUnreadNotifications(actor),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / NOTIFICATIONS_PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Math.floor(Number(options.page) || 1)),
    pageCount,
  );
  const rows = await client.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * NOTIFICATIONS_PAGE_SIZE,
    take: NOTIFICATIONS_PAGE_SIZE,
    select: SELECT,
  });
  return { rows: rows.map(view), total, unread, page, pageCount };
}

export type OpenNotificationResult =
  { ok: true; href: string } | { ok: false; reason: "not_found" };

/**
 * Marks one notice of the person read and says where it leads. The notice
 * of anybody else does not exist. Opening it again just leads there.
 */
export async function openNotification(
  actor: Actor,
  notificationId: string,
): Promise<OpenNotificationResult> {
  const client = forOrganization(actor.organizationId);
  const id = String(notificationId ?? "").slice(0, 36);
  const row = await client.notification.findFirst({
    where: { id, recipientUserId: actor.userId },
    select: { id: true, href: true, readAt: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.readAt === null) {
    await client.notification.updateMany({
      where: { id: row.id, recipientUserId: actor.userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
  return {
    ok: true,
    href: isInternalHref(row.href) ? row.href : FALLBACK_HREF,
  };
}

/** Marks every unread notice of the person read; says how many. */
export async function markAllNotificationsRead(
  actor: Actor,
): Promise<{ count: number }> {
  const result = await forOrganization(
    actor.organizationId,
  ).notification.updateMany({
    where: { recipientUserId: actor.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { count: result.count };
}

// ---------------------------------------------------------------------------
// Preferences

export type NotificationPreferenceView = {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
};

/** Each type the person may hear about, with whether it is on for them. */
export async function getNotificationPreferences(
  actor: Actor,
  types: readonly NotificationType[],
  modules: (moduleId: string) => boolean,
): Promise<NotificationPreferenceView[]> {
  const rows = await forOrganization(
    actor.organizationId,
  ).notificationPreference.findMany({
    where: { userId: actor.userId },
    select: { typeKey: true, enabled: true },
  });
  const chosen = new Map(rows.map((row) => [row.typeKey, row.enabled]));
  return types
    .filter((type) => type.module === null || modules(type.module))
    .map((type) => ({
      key: type.key,
      label: type.label,
      description: type.description,
      enabled: chosen.get(type.key) ?? type.defaultEnabled,
    }));
}

export type SetPreferenceResult =
  { ok: true } | { ok: false; reason: "not_found" };

/**
 * Turns a type on or off for the person. Back to its default, the row is
 * removed: only what the person changed is stored.
 */
export async function setNotificationPreference(
  actor: Actor,
  types: readonly NotificationType[],
  typeKey: string,
  enabled: boolean,
): Promise<SetPreferenceResult> {
  const type = types.find((each) => each.key === String(typeKey));
  if (!type) return { ok: false, reason: "not_found" };
  const client = forOrganization(actor.organizationId);
  await client.$transaction(async (tx) => {
    const existing = await tx.notificationPreference.findFirst({
      where: { userId: actor.userId, typeKey: type.key },
      select: { id: true },
    });
    if (enabled === type.defaultEnabled) {
      if (existing) {
        await tx.notificationPreference.deleteMany({
          where: { id: existing.id },
        });
      }
      return;
    }
    if (existing) {
      await tx.notificationPreference.updateMany({
        where: { id: existing.id },
        data: { enabled },
      });
    } else {
      await tx.notificationPreference.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          userId: actor.userId,
          typeKey: type.key,
          enabled,
        },
      });
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cleaning up (a round of the worker)

/**
 * Removes the company's notices read more than READ_NOTICE_DAYS ago.
 * Unread ones stay. Safe to run again: the second time nothing is left.
 */
export async function purgeReadNotifications(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ removed: number }> {
  const before = new Date(now.getTime() - READ_NOTICE_DAYS * 86_400_000);
  const result = await forOrganization(organizationId).notification.deleteMany({
    where: { readAt: { not: null, lt: before } },
  });
  return { removed: result.count };
}
