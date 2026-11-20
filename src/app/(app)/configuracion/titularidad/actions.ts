"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ForbiddenError } from "@/lib";
import {
  acceptOwnershipWithConfirmation,
  cancelOwnershipFromScreen,
  declineOwnershipFromScreen,
  offerOwnershipWithConfirmation,
  type OwnershipScreenField,
} from "@/platform/authorization";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Transfer of the company (WMS-90, ADR 0090). Company and person come from
 * the session, never from the form; the services check titular, offer,
 * password and code again.
 */

export type OwnershipFormState = {
  error?: string;
  field?: OwnershipScreenField;
  values?: { toUserId: string; roles: string[] };
  answers: number;
};

const PATH = "/configuracion/titularidad";

async function guarded<T>(
  run: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export async function offerOwnershipAction(
  prev: OwnershipFormState,
  formData: FormData,
): Promise<OwnershipFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    toUserId: String(formData.get("toUserId") ?? ""),
    roles: formData.getAll("roles").map(String),
  };
  const requestHeaders = await headers();
  const result = await guarded(() =>
    offerOwnershipWithConfirmation(
      organization.id,
      user.id,
      {
        toUserId: values.toUserId,
        previousOwnerRoles: values.roles,
        password: String(formData.get("password") ?? ""),
        code: String(formData.get("code") ?? ""),
      },
      requestHeaders,
    ),
  );
  if (!result.ok) {
    return {
      error: result.error,
      ...("field" in result && result.field ? { field: result.field } : {}),
      values,
      answers: prev.answers + 1,
    };
  }
  revalidatePath(PATH);
  revalidatePath("/configuracion");
  return { answers: prev.answers + 1 };
}

export async function acceptOwnershipAction(
  prev: OwnershipFormState,
  formData: FormData,
): Promise<OwnershipFormState> {
  const { user, organization } = await requireOrganizationContext();
  const requestHeaders = await headers();
  const result = await guarded(() =>
    acceptOwnershipWithConfirmation(
      organization.id,
      user.id,
      {
        transferId: String(formData.get("transferId") ?? ""),
        password: String(formData.get("password") ?? ""),
        code: String(formData.get("code") ?? ""),
      },
      requestHeaders,
    ),
  );
  if (!result.ok) {
    return {
      error: result.error,
      ...("field" in result && result.field ? { field: result.field } : {}),
      answers: prev.answers + 1,
    };
  }
  revalidatePath("/", "layout");
  redirect(`${PATH}?aceptada=1`);
}

export async function cancelOwnershipAction(
  prev: OwnershipFormState,
): Promise<OwnershipFormState> {
  const { user, organization } = await requireOrganizationContext();
  const result = await guarded(() =>
    cancelOwnershipFromScreen(organization.id, user.id),
  );
  if (!result.ok) return { error: result.error, answers: prev.answers + 1 };
  revalidatePath(PATH);
  revalidatePath("/configuracion");
  return { answers: prev.answers + 1 };
}

export async function declineOwnershipAction(
  prev: OwnershipFormState,
  formData: FormData,
): Promise<OwnershipFormState> {
  const { user, organization } = await requireOrganizationContext();
  const result = await guarded(() =>
    declineOwnershipFromScreen(
      organization.id,
      user.id,
      String(formData.get("transferId") ?? ""),
    ),
  );
  if (!result.ok) return { error: result.error, answers: prev.answers + 1 };
  revalidatePath("/configuracion");
  redirect("/configuracion");
}
