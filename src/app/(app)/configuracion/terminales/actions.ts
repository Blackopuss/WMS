"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  TERMINAL_COOKIE,
  TERMINAL_PATH,
  signOut,
  terminalCookieOptions,
  terminalOfDevice,
} from "@/platform/auth";
import { registerTerminal, removeTerminal } from "@/platform/terminals";
import { requireOrganizationContext } from "@/platform/tenancy";

export type RegisterTerminalState = {
  formError?: string;
  fieldErrors?: Partial<Record<"name" | "facilityId", string>>;
  values?: { name: string; facilityId: string };
  answers: number;
};

/**
 * Registers this browser as a shared terminal (WMS-38, ADR 0061 §1).
 * Person and company come from the session; the terminal's secret goes
 * into an HttpOnly cookie of this browser, and the person's own session
 * here is closed: a shared device does not keep an administrator signed in.
 */
export async function registerTerminalAction(
  prev: RegisterTerminalState,
  formData: FormData,
): Promise<RegisterTerminalState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    name: String(formData.get("name") ?? "").slice(0, 200),
    facilityId: String(formData.get("facilityId") ?? "").slice(0, 36),
  };
  const answers = prev.answers + 1;
  try {
    const result = await registerTerminal(
      { organizationId: organization.id, userId: user.id },
      values,
    );
    if (!result.ok) {
      return {
        formError: result.formError,
        fieldErrors: result.fieldErrors,
        values,
        answers,
      };
    }
    (await cookies()).set(
      TERMINAL_COOKIE,
      result.cookieValue,
      terminalCookieOptions,
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { formError: error.message, values, answers };
    }
    throw error;
  }
  await signOut();
  redirect(TERMINAL_PATH);
}

export type RemoveTerminalState = { error?: string };

/** Removes a terminal: its secret stops working and its sessions close. */
export async function removeTerminalAction(
  _prev: RemoveTerminalState,
  formData: FormData,
): Promise<RemoveTerminalState> {
  const { user, organization } = await requireOrganizationContext();
  const terminalId = String(formData.get("terminalId") ?? "").slice(0, 36);
  const device = await terminalOfDevice();
  try {
    const result = await removeTerminal(
      { organizationId: organization.id, userId: user.id },
      terminalId,
      String(formData.get("reason") ?? "").slice(0, 1000),
    );
    if (!result.ok) return { error: result.error };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message };
    }
    throw error;
  }
  // This very browser was that terminal: its cookie is of no use now.
  if (device?.id === terminalId) (await cookies()).delete(TERMINAL_COOKIE);
  revalidatePath("/configuracion/terminales");
  redirect("/configuracion/terminales");
}
