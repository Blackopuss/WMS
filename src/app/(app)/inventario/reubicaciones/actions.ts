"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { acceptSlottingSuggestion } from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Relocation suggestions (WMS-65, ADR 0086). Person and company come from
 * the session; the form sends only the ids of the suggestion it showed.
 * The service decides it again (quantity included), checks the permissions
 * and creates the transfer task with `createTask`.
 */

export type AcceptState =
  | { ok: true; taskId: string; summary: string }
  | { ok: false; error: string }
  | null;

const id = (formData: FormData, name: string) =>
  String(formData.get(name) ?? "").slice(0, 36);

export async function acceptSuggestionAction(
  _previous: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await acceptSlottingSuggestion(
      { organizationId: organization.id, userId: user.id },
      {
        kind: String(formData.get("kind") ?? "").slice(0, 20),
        productId: id(formData, "productId"),
        fromLocationId: id(formData, "fromLocationId"),
        lotId: id(formData, "lotId") || null,
        toLocationId: id(formData, "toLocationId"),
      },
    );
    if (!result.ok) return { ok: false, error: result.formError };
    revalidatePath("/inventario/reubicaciones");
    revalidatePath("/tareas");
    return { ok: true, taskId: result.taskId, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
