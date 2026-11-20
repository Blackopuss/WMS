"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { closeProductionOrder } from "@/modules/production";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * «Cerrar orden» (WMS-31, ADR 0093). Person and company come from the
 * session; the service looks for the order only in that company and the
 * person's scope, and checks `production.order.close` again. Closing is
 * idempotent: sent twice, it answers that it was already closed.
 */

export type CloseFormState = {
  ok?: boolean;
  summary?: string;
  error?: string;
  fieldErrors?: { reason?: string };
  values: { reason: string };
  answers: number;
};

export async function closeProductionOrderAction(
  orderId: string,
  previous: CloseFormState,
  formData: FormData,
): Promise<CloseFormState> {
  const { user, organization } = await requireOrganizationContext();
  const id = String(orderId ?? "").slice(0, 36);
  const reason = String(formData.get("reason") ?? "").slice(0, 400);
  const answers = previous.answers + 1;
  try {
    const result = await closeProductionOrder(
      { organizationId: organization.id, userId: user.id },
      id,
      reason,
    );
    if (!result.ok) {
      return {
        error: result.fieldErrors?.reason ? undefined : result.formError,
        fieldErrors: result.fieldErrors,
        values: { reason },
        answers,
      };
    }
    revalidatePath("/produccion");
    revalidatePath(`/produccion/${result.orderId}`);
    return { ok: true, summary: result.summary, values: { reason }, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values: { reason }, answers };
    }
    throw error;
  }
}
