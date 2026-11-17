"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  acceptProductionRequest,
  cancelProductionRequest,
  rejectProductionRequest,
  submitProductionRequest,
  type ProductionRequestField,
  type ProductionRequestResult,
  type ProductionShortage,
} from "@/modules/production";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Production requests (WMS-28B, ADR 0075). Person and company always come
 * from the session; the services check the permission again, look for the
 * request only in that company and the person's scope, and recheck the
 * three conditions to ask under their locks.
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

export type AskFormValues = {
  quantity: string;
  areaLocationId: string;
  note: string;
};

export type AskFormState = {
  error?: string;
  fieldErrors?: Partial<Record<ProductionRequestField, string>>;
  values: AskFormValues;
  answers: number;
};

/** «Pedir producción» (`productId` bound by the screen). */
export async function askProductionAction(
  productId: string,
  previous: AskFormState,
  formData: FormData,
): Promise<AskFormState> {
  const who = await actor();
  const values = {
    quantity: text(formData, "quantity", 30),
    areaLocationId: idOf(formData.get("areaLocationId")),
    note: text(formData, "note", 400),
  };
  const answers = previous.answers + 1;
  let result: ProductionRequestResult;
  try {
    result = await submitProductionRequest(who, {
      productId: idOf(productId),
      quantity: values.quantity,
      note: values.note,
      areaLocationId: values.areaLocationId,
    });
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
  revalidatePath("/produccion/solicitudes");
  revalidatePath("/tareas");
  redirect(`/produccion/solicitudes/${result.requestId}`);
}

export type RequestStepState =
  | { ok: true; summary: string; orderId?: string }
  | {
      ok: false;
      error: string;
      /** The field the error belongs to, so the screen can point at it. */
      field?: string;
      shortages?: ProductionShortage[];
      mayTakeWhatThereIs?: boolean;
    };

async function step(
  requestId: string,
  work: (
    who: { organizationId: string; userId: string },
    id: string,
  ) => Promise<ProductionRequestResult>,
): Promise<RequestStepState> {
  const who = await actor();
  const id = idOf(requestId);
  try {
    const result = await work(who, id);
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo cambiar la solicitud.",
        ...(!result.formError && result.fieldErrors
          ? { field: Object.keys(result.fieldErrors)[0] }
          : {}),
        shortages: result.shortages,
        mayTakeWhatThereIs: result.mayTakeWhatThereIs,
      };
    }
    revalidatePath("/produccion");
    revalidatePath("/produccion/solicitudes");
    revalidatePath(`/produccion/solicitudes/${id}`);
    return {
      ok: true,
      summary: result.summary,
      ...(result.orderId ? { orderId: result.orderId } : {}),
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/**
 * «Aceptar»: the order is born in the name of who accepts. `mode`:
 * `release`, `take` (after seeing what is short) or `draft`.
 */
export async function acceptProductionRequestAction(
  requestId: string,
  input: {
    quantity: string;
    dueOn: string;
    assigneeId: string;
    mode: string;
  },
): Promise<RequestStepState> {
  const mode =
    input?.mode === "take" || input?.mode === "draft" ? input.mode : "release";
  const assignee = idOf(input?.assigneeId);
  return step(requestId, (who, id) =>
    acceptProductionRequest(who, id, {
      quantity: String(input?.quantity ?? "").slice(0, 30),
      dueOn: String(input?.dueOn ?? "").slice(0, 10),
      assigneeIds: assignee ? [assignee] : [],
      mode,
    }),
  );
}

export async function rejectProductionRequestAction(
  requestId: string,
  reason: string,
): Promise<RequestStepState> {
  return step(requestId, (who, id) =>
    rejectProductionRequest(who, id, String(reason ?? "").slice(0, 400)),
  );
}

export async function cancelProductionRequestAction(
  requestId: string,
): Promise<RequestStepState> {
  return step(requestId, (who, id) => cancelProductionRequest(who, id));
}
