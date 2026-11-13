"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import type { BellNotice } from "@/components";
import {
  countUnreadNotifications,
  listRecentNotifications,
  markAllNotificationsRead,
  openNotification,
} from "@/platform/notifications";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Notices of the person (WMS-39, ADR 0057). Person and company always come
 * from the session; the services only ever touch that person's notices,
 * so the id of somebody else's notice does not exist here.
 */
async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

/** The bell: the latest notices and the unread count (reads only). */
export async function loadNotificationsAction(): Promise<{
  unread: number;
  items: BellNotice[];
}> {
  const result = await listRecentNotifications(await actor());
  return {
    unread: result.unread,
    items: result.items.map((item) => ({
      id: item.id,
      text: item.text,
      href: item.href,
      createdAt: item.createdAt.toISOString(),
      read: item.read,
    })),
  };
}

/** The bell's number, when the screen changes (reads only). */
export async function countNotificationsAction(): Promise<number> {
  return countUnreadNotifications(await actor());
}

/** Marks the notice read and goes where it leads (an internal path). */
export async function openNotificationAction(formData: FormData) {
  const result = await openNotification(
    await actor(),
    String(formData.get("id") ?? ""),
  );
  revalidatePath("/", "layout");
  redirect(result.ok ? result.href : "/avisos");
}

/** Every unread notice of the person, read. */
export async function markAllNotificationsReadAction(): Promise<{
  count: number;
}> {
  const result = await markAllNotificationsRead(await actor());
  revalidatePath("/avisos");
  return result;
}

/** The same from the page's form: it paints again with everything read. */
export async function markAllReadFormAction(): Promise<void> {
  await markAllNotificationsRead(await actor());
  revalidatePath("/", "layout");
}
