"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { operationSettings } from "@/modules/registry";
import { setStagingLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { requireOrganizationContext } from "@/platform/tenancy";

export type SettingFormState = {
  ok?: true;
  message?: string;
  error?: string;
  /** Counts answers: remounts the options with what was sent. */
  answers: number;
};

/**
 * Changes one operation setting (WMS-49). Person and company come from the
 * session; the service checks the permission, the module and the value
 * against the registry.
 */
export async function updateSettingAction(
  prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const { user, organization } = await requireOrganizationContext();
  const answers = prev.answers + 1;
  try {
    const result = await updateOperationSetting(
      { organizationId: organization.id, userId: user.id },
      operationSettings,
      String(formData.get("key") ?? "").slice(0, 80),
      String(formData.get("value") ?? "").slice(0, 80),
    );
    if (!result.ok) return { error: result.error, answers };
    revalidatePath("/configuracion/operacion");
    // WMS-56: the settings of an approval are shown with its rule.
    revalidatePath("/configuracion/aprobaciones");
    // WMS-38: the settings of shared terminals are shown on their screen.
    revalidatePath("/configuracion/terminales");
    // WMS-42: and those of equipment on theirs.
    revalidatePath("/configuracion/equipos-del-almacen");
    // WMS-43: and the first ones, in the setup guide.
    revalidatePath("/configuracion/inicial");
    return { ok: true, message: result.summary, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, answers };
    }
    throw error;
  }
}

/** Chooses the staging location; looked for only inside the company. */
export async function setStagingAction(
  prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const { user, organization } = await requireOrganizationContext();
  const answers = prev.answers + 1;
  try {
    const result = await setStagingLocation(
      { organizationId: organization.id, userId: user.id },
      String(formData.get("locationId") ?? "").slice(0, 36),
    );
    if (!result.ok) {
      return {
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo cambiar.",
        answers,
      };
    }
    revalidatePath("/configuracion/operacion");
    return {
      ok: true,
      message: "Lo que se surta desde ahora irá a esa ubicación.",
      answers,
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, answers };
    }
    throw error;
  }
}
