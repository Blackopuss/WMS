"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  DEFAULT_AFTER_SIGN_IN,
  requireSession,
  signOut,
} from "@/platform/auth";
import { leaveSupport } from "@/platform/authorization";
import { switchFacility } from "@/platform/locations";
import {
  requireOrganizationContext,
  switchOrganization,
} from "@/platform/tenancy";

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/ingresar");
}

/** Switches the session's company; the server re-checks the membership. */
export async function switchOrganizationAction(
  organizationId: string,
): Promise<{ error: string }> {
  const { user, sessionId } = await requireSession();
  const result = await switchOrganization(
    user.id,
    sessionId,
    String(organizationId),
  );
  if (!result.ok) return { error: result.error };
  // Start over in the new company: re-render everything, layout included,
  // so nothing from the previous company stays on screen.
  revalidatePath("/", "layout");
  redirect(DEFAULT_AFTER_SIGN_IN);
}

/** Support leaves the company it was looking into (PIL-12). */
export async function leaveSupportAction(): Promise<void> {
  const { user, sessionId } = await requireSession();
  await leaveSupport(user.id, sessionId);
  revalidatePath("/", "layout");
  redirect("/interno");
}

/**
 * The person starts working in another warehouse (WMS-18). Person and
 * company come from the session; the warehouse is looked for only in that
 * company.
 */
export async function switchFacilityAction(
  facilityId: string,
): Promise<{ error: string }> {
  const { user, organization } = await requireOrganizationContext();
  const result = await switchFacility(
    { organizationId: organization.id, userId: user.id },
    String(facilityId ?? "").slice(0, 36),
  );
  if (!result.ok) return { error: result.formError ?? "No se pudo cambiar." };
  revalidatePath("/", "layout");
  redirect(DEFAULT_AFTER_SIGN_IN);
}
