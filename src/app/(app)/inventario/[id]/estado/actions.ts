"use server";

import { revalidatePath } from "next/cache";

import { fingerprint, isAppError } from "@/lib";
import { changeStockStatus, type StatusChangeField } from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

export type StatusChangeState = {
  error?: string;
  fieldErrors?: Partial<Record<StatusChangeField, string>>;
  /** What happened, after a change that went through. */
  saved?: string;
  /**
   * Where it ends up would be left above its capacity and the company only
   * warns (WMS-22B): nothing changed. `stamp` marks the values the warning
   * is about; the button that accepts it sends it back.
   */
  capacityWarning?: { message: string; stamp: string };
  values: {
    locationId: string;
    from: string;
    /** The lot that changes, for a product by lot (WMS-21); "" otherwise. */
    lotId: string;
    to: string;
    /** Where it ends up; "" = it stays where it is (WMS-22B). */
    toLocationId: string;
    quantity: string;
    reason: string;
  };
  /** Bumped on every answer, so selects show what was sent. */
  answers: number;
};

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/**
 * Changes the state of stock of a product in a location (WMS-11). The
 * product is bound by the page; person and company come from the session,
 * and the service looks for product and location only in that company.
 */
export async function changeStatusAction(
  productId: string,
  previous: StatusChangeState,
  formData: FormData,
): Promise<StatusChangeState> {
  const { user, organization } = await requireOrganizationContext();
  // «<ubicación>|<estado>»: one select says where and in what state.
  // WMS-21: with a third part, the lot, for a product by lot.
  const [locationId = "", from = "", lotId = ""] = text(
    formData,
    "source",
    100,
  ).split("|");
  const values = {
    locationId: locationId.slice(0, 36),
    from: from.slice(0, 20),
    lotId: lotId.slice(0, 36),
    to: text(formData, "to", 20),
    toLocationId: text(formData, "toLocationId", 36),
    quantity: text(formData, "quantity", 40),
    reason: text(formData, "reason", 600),
  };
  const answers = previous.answers + 1;
  const stamp = fingerprint([
    String(productId),
    values.locationId,
    values.from,
    values.to,
    values.toLocationId,
    values.quantity,
    values.lotId,
  ]);
  let result;
  try {
    result = await changeStockStatus(
      { organizationId: organization.id, userId: user.id },
      {
        ...values,
        productId: String(productId).slice(0, 36),
        idempotencyKey: text(formData, "idempotencyKey", 64),
        // Only the button of the warning about these values carries it.
        acceptCapacity: formData.get("acceptCapacity") === stamp,
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      capacityWarning: { message: result.formError, stamp },
      values,
      answers,
    };
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
  // Empty the form for the next change; keep the place chosen.
  return {
    saved: result.summary,
    values: { ...values, quantity: "", reason: "" },
    answers,
  };
}
