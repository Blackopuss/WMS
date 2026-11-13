"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  addRequestLine,
  cancelPurchaseRequest,
  convertPurchaseRequest,
  createPurchaseRequest,
  rejectPurchaseRequest,
  removeRequestLine,
  submitPurchaseRequest,
  updateRequestLine,
  type RequestField,
} from "@/modules/purchasing";
import { requireOrganizationContext } from "@/platform/tenancy";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const forbidden = (error: unknown): string | null =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

export type RequestFormState = {
  fieldErrors: Partial<Record<RequestField, string>>;
  formError?: string;
  /** What the person had written, to show it again after a refusal. */
  values: {
    capture: string;
    quantity: string;
    neededOn: string;
    notes: string;
  };
  /** Changes with every answer, so selects show what was chosen. */
  answers: number;
};

const valuesOf = (formData: FormData): RequestFormState["values"] => ({
  capture: String(formData.get("capture") ?? "base").slice(0, 40),
  quantity: String(formData.get("quantity") ?? "").slice(0, 40),
  neededOn: String(formData.get("neededOn") ?? "").slice(0, 10),
  notes: String(formData.get("notes") ?? "").slice(0, 2000),
});

/**
 * Starts a purchase request with its first product (WMS-57). Person and
 * company come from the session; the product is bound by the page and the
 * service looks for it only inside the company.
 */
export async function createPurchaseRequestAction(
  productId: string,
  prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = valuesOf(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await createPurchaseRequest(
      { organizationId: organization.id, userId: user.id },
      { ...values, productId: String(productId) },
    );
  } catch (error) {
    const message = forbidden(error);
    if (message)
      return { fieldErrors: {}, formError: message, values, answers };
    throw error;
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      values,
      answers,
    };
  }
  revalidatePath("/compras/solicitudes");
  redirect(`/compras/solicitudes/${idPath(result.requestId)}`);
}

/** Adds a product to the person's draft. */
export async function addRequestLineAction(
  requestId: string,
  productId: string,
  prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = valuesOf(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await addRequestLine(
      { organizationId: organization.id, userId: user.id },
      String(requestId),
      {
        productId: String(productId),
        capture: values.capture,
        quantity: values.quantity,
      },
    );
  } catch (error) {
    const message = forbidden(error);
    if (message)
      return { fieldErrors: {}, formError: message, values, answers };
    throw error;
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      values,
      answers,
    };
  }
  revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
  redirect(`/compras/solicitudes/${idPath(requestId)}`);
}

/** Changes how much of a product the person's draft asks for. */
export async function updateRequestLineAction(
  requestId: string,
  lineId: string,
  prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = valuesOf(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await updateRequestLine(
      { organizationId: organization.id, userId: user.id },
      String(lineId),
      { capture: values.capture, quantity: values.quantity },
    );
  } catch (error) {
    const message = forbidden(error);
    if (message)
      return { fieldErrors: {}, formError: message, values, answers };
    throw error;
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      values,
      answers,
    };
  }
  revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
  redirect(`/compras/solicitudes/${idPath(requestId)}`);
}

export type RequestActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; lineErrors?: Record<string, string> };

/** Takes a product out of the person's draft. */
export async function removeRequestLineAction(
  requestId: string,
  lineId: string,
): Promise<RequestActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await removeRequestLine(
      { organizationId: organization.id, userId: user.id },
      String(lineId),
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.formError ?? "No se pudo quitar el producto.",
      };
    }
    revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
    return { ok: true, message: "Producto quitado de la solicitud." };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/**
 * Sends the person's request: to Compras, or to be authorized first when
 * the rule of the company says so. Sending twice sends once.
 */
export async function submitPurchaseRequestAction(
  requestId: string,
): Promise<RequestActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await submitPurchaseRequest(
      { organizationId: organization.id, userId: user.id },
      String(requestId),
    );
    revalidatePath("/compras/solicitudes");
    revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
    if (result.ok) {
      return { ok: true, message: "Solicitud enviada a Compras." };
    }
    if (result.reason === "pending_approval") {
      return { ok: true, message: result.message };
    }
    return {
      ok: false,
      error: result.formError ?? "No se pudo enviar la solicitud.",
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/** Who asked withdraws the request while it is not authorized. */
export async function cancelPurchaseRequestAction(
  requestId: string,
): Promise<RequestActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await cancelPurchaseRequest(
      { organizationId: organization.id, userId: user.id },
      String(requestId),
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.formError ?? "No se pudo cancelar la solicitud.",
      };
    }
    revalidatePath("/compras/solicitudes");
    revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
    return { ok: true, message: "Solicitud cancelada." };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/** Compras says no to a request it was to attend, with its reason. */
export async function rejectPurchaseRequestAction(
  requestId: string,
  reason: string,
): Promise<RequestActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await rejectPurchaseRequest(
      { organizationId: organization.id, userId: user.id },
      String(requestId),
      { reason: String(reason ?? "").slice(0, 1000) },
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.fieldErrors.reason ??
          result.formError ??
          "No se pudo rechazar la solicitud.",
      };
    }
    revalidatePath("/compras/solicitudes");
    revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
    return { ok: true, message: "Solicitud rechazada." };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

export type ConvertState = {
  error?: string;
  lineErrors?: Record<string, string>;
  /** The supplier chosen for each line, to show it again after a refusal. */
  chosen: Record<string, string>;
  answers: number;
};

/**
 * Turns a request into one draft order per supplier. The form sends only
 * which supplier for each line (`supplier:<id of the line>`); converting
 * twice converts once.
 */
export async function convertPurchaseRequestAction(
  requestId: string,
  prev: ConvertState,
  formData: FormData,
): Promise<ConvertState> {
  const { user, organization } = await requireOrganizationContext();
  const chosen: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("supplier:") && typeof value === "string") {
      chosen[key.slice(9, 45)] = value.slice(0, 36);
    }
  }
  const answers = prev.answers + 1;
  let result;
  try {
    result = await convertPurchaseRequest(
      { organizationId: organization.id, userId: user.id },
      String(requestId),
      { suppliers: chosen },
    );
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, chosen, answers };
    throw error;
  }
  if (!result.ok) {
    return {
      error: result.formError ?? "No se pudo crear la orden.",
      lineErrors: result.lineErrors,
      chosen,
      answers,
    };
  }
  revalidatePath("/compras");
  revalidatePath("/compras/solicitudes");
  revalidatePath(`/compras/solicitudes/${idPath(requestId)}`);
  const first = result.orders[0];
  redirect(
    result.orders.length === 1 && first
      ? `/compras/ordenes/${idPath(first.orderId)}`
      : `/compras/solicitudes/${idPath(requestId)}`,
  );
}
