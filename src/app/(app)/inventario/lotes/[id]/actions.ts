"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { changeLotExpiry } from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

export type LotExpiryState = {
  ok?: true;
  summary?: string;
  error?: string;
  field?: "expiresOn" | "reason";
  values: { expiresOn: string; reason: string };
  /** Bumped on every answer, so the fields show what was sent. */
  answers: number;
};

/**
 * Corrects the expiry date of a lot (WMS-21). The lot is bound by the page
 * and looked for only inside the company of the session; person and
 * company come from the session.
 */
export async function changeLotExpiryAction(
  lotId: string,
  previous: LotExpiryState,
  formData: FormData,
): Promise<LotExpiryState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    expiresOn: String(formData.get("expiresOn") ?? "").slice(0, 20),
    reason: String(formData.get("reason") ?? "").slice(0, 400),
  };
  const answers = previous.answers + 1;
  const id = String(lotId ?? "").slice(0, 36);
  try {
    const result = await changeLotExpiry(
      { organizationId: organization.id, userId: user.id },
      { lotId: id, ...values },
    );
    if (!result.ok) {
      return { error: result.error, field: result.field, values, answers };
    }
    revalidatePath(`/inventario/lotes/${id}`);
    revalidatePath("/inventario/por-caducar");
    return {
      ok: true,
      summary: result.summary,
      values: { expiresOn: values.expiresOn, reason: "" },
      answers,
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
}
