"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { removeMyPin, setMyPin } from "@/platform/terminals";
import { requireOrganizationContext } from "@/platform/tenancy";

export type PinFormState = {
  ok?: true;
  message?: string;
  formError?: string;
  fieldErrors?: Partial<Record<"password" | "pin" | "confirm", string>>;
  answers: number;
};

/**
 * Sets, changes or removes the person's own PIN for shared terminals
 * (WMS-38). Person and company come from the session; the service refuses
 * a PIN session and asks for the account's password.
 */
export async function pinAction(
  prev: PinFormState,
  formData: FormData,
): Promise<PinFormState> {
  const { user, organization } = await requireOrganizationContext();
  const actor = { organizationId: organization.id, userId: user.id };
  const answers = prev.answers + 1;
  const password = String(formData.get("password") ?? "").slice(0, 1024);
  try {
    const result =
      formData.get("intent") === "remove"
        ? await removeMyPin(actor, { password })
        : await setMyPin(actor, {
            password,
            pin: String(formData.get("pin") ?? "").slice(0, 20),
            confirm: String(formData.get("confirm") ?? "").slice(0, 20),
          });
    if (!result.ok) {
      return {
        formError: result.formError,
        fieldErrors: result.fieldErrors,
        answers,
      };
    }
    revalidatePath("/configuracion/pin");
    return { ok: true, message: result.summary, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { formError: error.message, answers };
    }
    throw error;
  }
}
