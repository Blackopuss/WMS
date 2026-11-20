"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  archiveFacility,
  createFacility,
  reactivateFacility,
  updateFacility,
  type FacilityField,
} from "@/platform/locations";
import { requireOrganizationContext } from "@/platform/tenancy";

export type FacilityFormState = {
  error?: string;
  fieldErrors?: Partial<Record<FacilityField, string>>;
  message?: string;
  values?: { name: string; code: string; address: string };
};

const valuesOf = (formData: FormData) => ({
  name: String(formData.get("name") ?? "").slice(0, 200),
  code: String(formData.get("code") ?? "").slice(0, 40),
  address: String(formData.get("address") ?? "").slice(0, 400),
});

/** A new warehouse (WMS-18); person and company come from the session. */
export async function createFacilityAction(
  _prev: FacilityFormState,
  formData: FormData,
): Promise<FacilityFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = valuesOf(formData);
  try {
    const result = await createFacility(
      { organizationId: organization.id, userId: user.id },
      values,
    );
    if (!result.ok) {
      return {
        error: result.formError,
        fieldErrors: result.fieldErrors,
        values,
      };
    }
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values };
    }
    throw error;
  }
  revalidatePath("/", "layout");
  redirect("/configuracion/almacenes?creado=1");
}

/** Changes name, code or address; looked for only in the company. */
export async function updateFacilityAction(
  facilityId: string,
  _prev: FacilityFormState,
  formData: FormData,
): Promise<FacilityFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = valuesOf(formData);
  try {
    const result = await updateFacility(
      { organizationId: organization.id, userId: user.id },
      String(facilityId ?? "").slice(0, 36),
      values,
    );
    if (!result.ok) {
      return {
        error: result.formError,
        fieldErrors: result.fieldErrors,
        values,
      };
    }
    revalidatePath("/", "layout");
    return { message: result.summary, values };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values };
    }
    throw error;
  }
}

/** Archives an empty warehouse; looked for only in the company. */
export async function archiveFacilityAction(
  facilityId: string,
): Promise<FacilityFormState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await archiveFacility(
      { organizationId: organization.id, userId: user.id },
      String(facilityId ?? "").slice(0, 36),
    );
    if (!result.ok) return { error: result.formError };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath("/", "layout");
  redirect("/configuracion/almacenes?archivado=1");
}

/**
 * Brings an archived warehouse back (WMS-85, ADR 0088); looked for only in
 * the company, person and company from the session.
 */
export async function reactivateFacilityAction(
  facilityId: string,
): Promise<FacilityFormState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await reactivateFacility(
      { organizationId: organization.id, userId: user.id },
      String(facilityId ?? "").slice(0, 36),
    );
    if (!result.ok) return { error: result.formError };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath("/", "layout");
  redirect("/configuracion/almacenes?reactivado=1");
}
