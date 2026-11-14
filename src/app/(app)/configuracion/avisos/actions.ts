"use server";

import { revalidatePath } from "next/cache";

import { notificationTypes } from "@/modules/registry";
import { setNotificationPreference } from "@/platform/notifications";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Turns a type of notice on or off for the person of the session, in the
 * app or by mail (WMS-39, WMS-39B). Only the person's own preference: the
 * identity comes from the session, and only types of the registry are
 * accepted.
 */
export async function setNotificationPreferenceAction(
  formData: FormData,
): Promise<void> {
  const { user, organization } = await requireOrganizationContext();
  await setNotificationPreference(
    { organizationId: organization.id, userId: user.id },
    notificationTypes,
    String(formData.get("type") ?? "").slice(0, 80),
    formData.get("enabled") === "1",
    formData.get("channel") === "email" ? "email" : "app",
  );
  revalidatePath("/configuracion/avisos");
}
