"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { approvalTypes } from "@/modules/registry";
import { cancelApproval, decideApproval } from "@/platform/approvals";
import { requireOrganizationContext } from "@/platform/tenancy";

export type DecisionState = {
  ok?: true;
  message?: string;
  error?: string;
  /** The reason as typed, kept when it is refused. */
  reason?: string;
};

/**
 * Approves or rejects a request (WMS-56). The request id is bound by the
 * page; person and company come from the session. The service checks the
 * rule in force, the roles, the permission of the operation and the scope
 * under the request's lock.
 */
export async function decideApprovalAction(
  requestId: string,
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const { user, organization } = await requireOrganizationContext();
  const decision = formData.get("decision") === "reject" ? "reject" : "approve";
  const reason = String(formData.get("reason") ?? "").slice(0, 600);
  try {
    const result = await decideApproval(
      { organizationId: organization.id, userId: user.id },
      approvalTypes,
      String(requestId),
      { decision, reason },
    );
    revalidatePath("/aprobaciones");
    revalidatePath(`/aprobaciones/${String(requestId).slice(0, 36)}`);
    if (!result.ok) return { error: result.error, reason };
    revalidatePath("/inventario");
    revalidatePath("/movimientos");
    revalidatePath("/conteos");
    return { ok: true, message: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, reason };
    }
    throw error;
  }
}

/** Who asked withdraws a pending request; only theirs (the service checks). */
export async function cancelApprovalAction(
  requestId: string,
): Promise<DecisionState> {
  const { user, organization } = await requireOrganizationContext();
  const result = await cancelApproval(
    { organizationId: organization.id, userId: user.id },
    approvalTypes,
    String(requestId),
  );
  revalidatePath("/aprobaciones");
  revalidatePath(`/aprobaciones/${String(requestId).slice(0, 36)}`);
  revalidatePath("/conteos");
  if (!result.ok) return { error: result.error };
  return { ok: true, message: "Retiraste la solicitud: no se aplicó nada." };
}
