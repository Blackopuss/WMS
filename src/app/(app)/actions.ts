"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  DEFAULT_AFTER_SIGN_IN,
  TERMINAL_PATH,
  requireSession,
  signOut,
  terminalOfDevice,
  touchTerminalSession,
} from "@/platform/auth";
import { leaveSupport } from "@/platform/authorization";
import { switchFacility } from "@/platform/locations";
import {
  requireOrganizationContext,
  switchOrganization,
} from "@/platform/tenancy";

/**
 * Signs out. On a shared terminal (WMS-38) it is «Cambiar de persona»:
 * the device goes back to «¿Quién eres?», not to «Ingresar».
 */
export async function signOutAction(): Promise<void> {
  const terminal = await terminalOfDevice();
  await signOut();
  redirect(terminal ? TERMINAL_PATH : "/ingresar");
}

/**
 * Keeps a PIN session alive while the person touches the screen (WMS-38):
 * writes its last activity, at most every 30 seconds. The session and its
 * person come from the request; nothing from the browser.
 */
export async function keepTerminalSessionAction(): Promise<void> {
  const { user, sessionId, terminal } = await requireSession();
  if (terminal) await touchTerminalSession(sessionId, user.id);
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
