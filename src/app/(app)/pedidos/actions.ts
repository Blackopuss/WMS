"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  cancelOutboundOrder,
  createOutboundOrder,
  releaseOutboundOrder,
  removeOutboundLine,
  setOutboundLine,
  type OutboundField,
  type OutboundResult,
  type OutboundShortage,
} from "@/modules/inventory";
import { listProducts } from "@/platform/catalog";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Outbound orders (WMS-13). Person and company always come from the
 * session; the services look for the order and its products only in that
 * company and check the permission again.
 */

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

const idOf = (value: unknown) => String(value ?? "").slice(0, 36);

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

export type CreateOutboundState = {
  error?: string;
  fieldErrors?: Partial<Record<OutboundField, string>>;
  values: {
    recipient: string;
    reference: string;
    address: string;
    dueOn: string;
    priority: string;
    note: string;
  };
  answers: number;
};

export async function createOutboundAction(
  previous: CreateOutboundState,
  formData: FormData,
): Promise<CreateOutboundState> {
  const who = await actor();
  const values = {
    recipient: text(formData, "recipient", 200),
    reference: text(formData, "reference", 150),
    address: text(formData, "address", 350),
    dueOn: text(formData, "dueOn", 10),
    priority: text(formData, "priority", 10),
    note: text(formData, "note", 600),
  };
  const answers = previous.answers + 1;
  let result: OutboundResult;
  try {
    result = await createOutboundOrder(who, values);
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  }
  revalidatePath("/pedidos");
  redirect(`/pedidos/${result.orderId}`);
}

export type LineFormState = {
  error?: string;
  fieldErrors?: Partial<Record<"code" | "quantity", string>>;
  saved?: string;
  values: { code: string; quantity: string };
  answers: number;
};

/**
 * Adds a product to a draft by its code (SKU or barcode, typed or
 * scanned), or changes the quantity of the one already there.
 */
export async function addOutboundLineAction(
  orderId: string,
  previous: LineFormState,
  formData: FormData,
): Promise<LineFormState> {
  const who = await actor();
  const values = {
    code: text(formData, "code", 100).trim(),
    quantity: text(formData, "quantity", 40),
  };
  const answers = previous.answers + 1;
  if (!values.code) {
    return {
      fieldErrors: { code: "Escribe o escanea la clave del producto." },
      values,
      answers,
    };
  }
  try {
    const found = await listProducts(who, {
      search: values.code,
      pageSize: 1,
    });
    if (!found.exact) {
      return {
        fieldErrors: {
          code: "No encontramos un producto con esa clave o código de barras.",
        },
        values,
        answers,
      };
    }
    const result = await setOutboundLine(who, idOf(orderId), {
      productId: found.exact.id,
      quantity: values.quantity,
    });
    if (!result.ok) {
      return {
        error: result.formError,
        fieldErrors: {
          code: result.fieldErrors?.productId,
          quantity: result.fieldErrors?.quantity,
        },
        values,
        answers,
      };
    }
    revalidatePath(`/pedidos/${idOf(orderId)}`);
    return {
      saved: result.summary,
      values: { code: "", quantity: "" },
      answers,
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
}

export type OutboundStepState =
  | { ok: true; summary: string }
  | { ok: false; error: string; shortages?: OutboundShortage[] };

async function step(
  orderId: string,
  work: (
    who: { organizationId: string; userId: string },
    id: string,
  ) => Promise<OutboundResult>,
): Promise<OutboundStepState> {
  const who = await actor();
  const id = idOf(orderId);
  try {
    const result = await work(who, id);
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo cambiar el pedido.",
        shortages: result.shortages,
      };
    }
    revalidatePath("/pedidos");
    revalidatePath(`/pedidos/${id}`);
    return { ok: true, summary: result.summary };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

export async function removeOutboundLineAction(
  orderId: string,
  lineId: string,
): Promise<OutboundStepState> {
  return step(orderId, (who, id) => removeOutboundLine(who, id, idOf(lineId)));
}

export async function releaseOutboundAction(
  orderId: string,
  takeWhatThereIs: boolean,
): Promise<OutboundStepState> {
  return step(orderId, (who, id) =>
    releaseOutboundOrder(who, id, {
      takeWhatThereIs: takeWhatThereIs === true,
    }),
  );
}

export async function cancelOutboundAction(
  orderId: string,
  reason: string,
): Promise<OutboundStepState> {
  return step(orderId, (who, id) =>
    cancelOutboundOrder(who, id, String(reason ?? "").slice(0, 400)),
  );
}
