"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fingerprint, isAppError } from "@/lib";
import {
  CUSTOMER_RETURN_MAX_LINES,
  decideCustomerReturn,
  findConfirmation,
  findCustomerReturnByKey,
  receiveCustomerReturn,
  type CustomerReturnField,
  type CustomerReturnLineInput,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Customer returns (WMS-17). Person and company always come from the
 * session; the services look for the order, the return and its places only
 * in that company and within the person's scope, and check the permission
 * again.
 */

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: unknown) =>
  String(value ?? "")
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

export type ReturnFormValues = {
  returnedBy: string;
  reason: string;
  note: string;
  locationId: string;
  /** By line key (with an order) or "single" (without one). */
  quantities: Record<string, string>;
  serials: Record<string, string>;
  lotCode: string;
  lotExpiresOn: string;
};

export type ReturnFormState = {
  error?: string;
  fieldErrors?: Partial<Record<CustomerReturnField, string>>;
  /** By line key (with an order) or "single". */
  lineErrors?: Record<string, string>;
  capacityWarning?: { message: string; stamp: string };
  values: ReturnFormValues;
  answers: number;
};

/**
 * «Registrar devolución». With an order (`orderId`, bound by the page),
 * one quantity per row of what left (`qty:<key>`, and `serials:<key>` for
 * a product by serial); without one, the product bound by the page and
 * its quantity, lot or serials.
 */
export async function receiveReturnAction(
  bound: { orderId: string | null; productId: string | null },
  previous: ReturnFormState,
  formData: FormData,
): Promise<ReturnFormState> {
  const who = await actor();
  const orderId = bound.orderId ? idPath(bound.orderId) : null;
  const productId = bound.productId ? idPath(bound.productId) : null;
  const keys = orderId
    ? formData
        .getAll("key")
        .slice(0, CUSTOMER_RETURN_MAX_LINES)
        .map((key) => String(key).slice(0, 80))
    : ["single"];
  const values: ReturnFormValues = {
    returnedBy: text(formData, "returnedBy", 200),
    reason: text(formData, "reason", 400),
    note: text(formData, "note", 600),
    locationId: text(formData, "locationId", 36),
    quantities: Object.fromEntries(
      keys.map((key) => [key, text(formData, `qty:${key}`, 40)]),
    ),
    serials: Object.fromEntries(
      keys.map((key) => [key, text(formData, `serials:${key}`, 40_000)]),
    ),
    lotCode: text(formData, "lotCode", 80),
    lotExpiresOn: text(formData, "lotExpiresOn", 20),
  };
  const lines: CustomerReturnLineInput[] = keys.map((key) =>
    orderId
      ? {
          key,
          quantity: values.quantities[key],
          serials: values.serials[key],
        }
      : {
          productId,
          quantity: values.quantities[key],
          lotCode: values.lotCode,
          lotExpiresOn: values.lotExpiresOn,
          serials: values.serials[key],
        },
  );
  const answers = previous.answers + 1;
  const stamp = fingerprint([
    orderId ?? "",
    productId ?? "",
    values.locationId,
    ...keys.map((key) => `${key}=${values.quantities[key]}`),
  ]);
  let result;
  try {
    result = await receiveCustomerReturn(who, {
      orderId: orderId ?? undefined,
      returnedBy: values.returnedBy,
      reason: values.reason,
      note: values.note,
      locationId: values.locationId,
      idempotencyKey: text(formData, "idempotencyKey", 64),
      lines,
      // Only the button of the warning about these values carries it.
      acceptCapacity: formData.get("acceptCapacity") === stamp,
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (
    !result.ok &&
    result.reason === "over_capacity" &&
    "formError" in result
  ) {
    return {
      capacityWarning: { message: result.formError ?? "", stamp },
      values,
      answers,
    };
  }
  if (!result.ok) {
    const failure = result as {
      formError?: string;
      fieldErrors?: Partial<Record<CustomerReturnField, string>>;
      lineErrors?: Record<number, string>;
    };
    return {
      error: failure.formError,
      fieldErrors: failure.fieldErrors,
      lineErrors: Object.fromEntries(
        Object.entries(failure.lineErrors ?? {}).map(([index, message]) => [
          keys[Number(index)] ?? "single",
          message,
        ]),
      ),
      values,
      answers,
    };
  }
  revalidatePath("/pedidos");
  revalidatePath("/pedidos/devoluciones");
  redirect(`/pedidos/devoluciones/${idPath(result.returnId)}`);
}

/**
 * After a lost answer (INV-22): whether that confirmation registered a
 * return, for the person of the session and within their scope.
 */
export async function checkCustomerReturnAction(
  idempotencyKey: string,
): Promise<{ returnId: string | null }> {
  const who = await actor();
  const found = await findCustomerReturnByKey(
    who,
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { returnId: found?.returnId ?? null };
}

export type DecisionState = {
  error?: string;
  fieldErrors?: Partial<Record<CustomerReturnField, string>>;
  saved?: string;
  capacityWarning?: { message: string; stamp: string; outcome: string };
  values: {
    quantity: string;
    reason: string;
    toLocationId: string;
    serials: string;
  };
  answers: number;
};

/**
 * «Disponible», «Dañado», «Rechazado» for part or all of what a line of a
 * return still has in inspection. The button pressed says which.
 */
export async function decideReturnAction(
  bound: { returnId: string; lineId: string },
  previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const who = await actor();
  const values = {
    quantity: text(formData, "quantity", 40),
    reason: text(formData, "reason", 400),
    toLocationId: text(formData, "toLocationId", 36),
    serials: text(formData, "serials", 40_000),
  };
  const outcome = text(formData, "outcome", 20);
  const answers = previous.answers + 1;
  const stamp = fingerprint([
    bound.lineId,
    outcome,
    values.quantity,
    values.toLocationId,
  ]);
  let result;
  try {
    result = await decideCustomerReturn(who, {
      returnId: idPath(bound.returnId),
      lineId: idPath(bound.lineId),
      outcome,
      ...values,
      idempotencyKey: text(formData, "idempotencyKey", 64),
      acceptCapacity: formData.get("acceptCapacity") === stamp,
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      capacityWarning: {
        message: (result as { formError?: string }).formError ?? "",
        stamp,
        outcome,
      },
      values,
      answers,
    };
  }
  if (!result.ok) {
    const failure = result as {
      formError?: string;
      fieldErrors?: Partial<Record<CustomerReturnField, string>>;
    };
    return {
      error: failure.formError,
      fieldErrors: failure.fieldErrors,
      values,
      answers,
    };
  }
  revalidatePath("/pedidos/devoluciones");
  revalidatePath(`/pedidos/devoluciones/${idPath(bound.returnId)}`);
  return {
    saved: result.summary,
    values: { quantity: "", reason: "", toLocationId: "", serials: "" },
    answers,
  };
}

/** After a lost answer (INV-22): whether that decision was registered. */
export async function checkDecisionAction(
  idempotencyKey: string,
): Promise<{ done: boolean }> {
  const who = await actor();
  const found = await findConfirmation(
    who,
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { done: found !== null };
}
