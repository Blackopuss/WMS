"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  disposeStock,
  findDisposalConfirmation,
  type DisposalField,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

export type DisposeState = {
  error?: string;
  fieldErrors?: Partial<Record<DisposalField, string>>;
  /** What happened, after a write-off that went through. */
  saved?: string;
  values: {
    /** «<ubicación>|<estado>» or «<ubicación>|<estado>|<lote>». */
    source: string;
    quantity: string;
    reason: string;
    serials?: string;
  };
  /** Bumped on every answer, so selects show what was sent. */
  answers: number;
};

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/**
 * Writes off damaged or rejected stock of a product (WMS-30-0, ADR 0068).
 * With the company's rule on, it asks for an authorization instead and
 * opens the request (WMS-83, ADR 0078).
 * The product is bound by the page; person and company come from the
 * session, and the service looks for product and location only there.
 */
export async function disposeAction(
  productId: string,
  previous: DisposeState,
  formData: FormData,
): Promise<DisposeState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    source: text(formData, "source", 120),
    quantity: text(formData, "quantity", 40),
    reason: text(formData, "reason", 600),
    serials: text(formData, "serials", 40_000),
  };
  const [locationId = "", status = "", lotId = ""] = values.source.split("|");
  const answers = previous.answers + 1;
  let result;
  try {
    result = await disposeStock(
      { organizationId: organization.id, userId: user.id },
      {
        productId: String(productId).slice(0, 36),
        locationId: locationId.slice(0, 36),
        status: status.slice(0, 20),
        lotId: lotId.slice(0, 36),
        quantity: values.quantity,
        serials: values.serials,
        reason: values.reason,
        idempotencyKey: text(formData, "idempotencyKey", 64),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok && result.reason === "pending_approval") {
    // WMS-83 (ADR 0078): nothing was thrown away; it waits for an
    // authorization, which shows what was asked and why.
    revalidatePath("/aprobaciones");
    redirect(`/aprobaciones/${result.requestId}?pedida=1`);
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  }
  revalidatePath(`/inventario/${String(productId)}`);
  revalidatePath("/movimientos");
  return {
    saved: result.summary,
    values: { ...values, quantity: "", reason: "", serials: "" },
    answers,
  };
}

/**
 * Whether a write-off whose answer was lost went through (INV-22): only
 * movements of this person, of this company.
 */
export async function checkDisposalAction(
  idempotencyKey: string,
): Promise<{ done: boolean }> {
  const { user, organization } = await requireOrganizationContext();
  const found = await findDisposalConfirmation(
    { organizationId: organization.id, userId: user.id },
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { done: found !== null };
}
