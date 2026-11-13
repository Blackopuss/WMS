"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { approvalTypes } from "@/modules/registry";
import { updateApprovalRule } from "@/platform/approvals";
import { requireOrganizationContext } from "@/platform/tenancy";

export type RuleFormState = {
  ok?: true;
  message?: string;
  error?: string;
  /** Counts answers: remounts the checkboxes with what they should show. */
  answers: number;
  /** What was sent, kept when it is refused. */
  values?: { enabled: boolean; roles: string[]; allowSelfApproval: boolean };
};

/**
 * Changes the rule of one approval type (WMS-56). Person and company come
 * from the session; the service checks the permission, the module and
 * that every chosen role may do the operation.
 */
export async function updateApprovalRuleAction(
  prev: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  const { user, organization } = await requireOrganizationContext();
  const answers = prev.answers + 1;
  const values = {
    enabled: formData.get("enabled") === "1",
    roles: formData.getAll("roles").map((role) => String(role).slice(0, 40)),
    allowSelfApproval: formData.get("allowSelfApproval") === "1",
  };
  try {
    const result = await updateApprovalRule(
      { organizationId: organization.id, userId: user.id },
      approvalTypes,
      String(formData.get("key") ?? "").slice(0, 80),
      values,
    );
    if (!result.ok) return { error: result.error, answers, values };
    revalidatePath("/configuracion/aprobaciones");
    revalidatePath("/aprobaciones");
    return { ok: true, message: result.summary, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, answers, values };
    }
    throw error;
  }
}
