"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  cancelProductionOrder,
  createProductionOrder,
  releaseProductionOrder,
  setProductionOrderAssignees,
  setRecipeArea,
  updateProductionOrder,
  type ProductionOrderField,
  type ProductionOrderResult,
  type ProductionShortage,
} from "@/modules/production";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Production orders (WMS-28, ADR 0073). Person and company always come
 * from the session; the services look for the order, its product, its
 * area and its people only in that company and the person's scope, and
 * check the permission again.
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

export type OrderFormValues = {
  quantity: string;
  areaLocationId: string;
  dueOn: string;
  priority: string;
  note: string;
  assigneeIds: string[];
};

export type OrderFormState = {
  error?: string;
  fieldErrors?: Partial<Record<ProductionOrderField, string>>;
  values: OrderFormValues;
  answers: number;
};

function readForm(formData: FormData): OrderFormValues {
  return {
    quantity: text(formData, "quantity", 30),
    areaLocationId: idOf(formData.get("areaLocationId")),
    dueOn: text(formData, "dueOn", 10),
    priority: text(formData, "priority", 10),
    note: text(formData, "note", 600),
    assigneeIds: formData
      .getAll("assigneeIds")
      .slice(0, 50)
      .map((value) => idOf(value)),
  };
}

/**
 * «Crear orden» (`productId` bound by the screen) or «Guardar» of a draft
 * (`orderId` bound). The draft copies the recipe in force again.
 */
export async function saveProductionOrderAction(
  target: { productId?: string; orderId?: string },
  previous: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const who = await actor();
  const values = readForm(formData);
  const answers = previous.answers + 1;
  let result: ProductionOrderResult;
  try {
    result = target.orderId
      ? await updateProductionOrder(who, idOf(target.orderId), values)
      : await createProductionOrder(who, {
          ...values,
          productId: idOf(target.productId),
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
  revalidatePath("/produccion");
  revalidatePath(`/produccion/${result.orderId}`);
  redirect(`/produccion/${result.orderId}`);
}

export type ProductionStepState =
  | { ok: true; summary: string }
  | {
      ok: false;
      error: string;
      shortages?: ProductionShortage[];
      mayTakeWhatThereIs?: boolean;
    };

async function step(
  orderId: string,
  work: (
    who: { organizationId: string; userId: string },
    id: string,
  ) => Promise<ProductionOrderResult>,
): Promise<ProductionStepState> {
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
          "No se pudo cambiar la orden.",
        shortages: result.shortages,
        mayTakeWhatThereIs: result.mayTakeWhatThereIs,
      };
    }
    revalidatePath("/produccion");
    revalidatePath(`/produccion/${id}`);
    return { ok: true, summary: result.summary };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/** «Liberar orden»; `takeWhatThereIs` after the person saw what is short. */
export async function releaseProductionOrderAction(
  orderId: string,
  takeWhatThereIs: boolean,
): Promise<ProductionStepState> {
  return step(orderId, (who, id) =>
    releaseProductionOrder(who, id, {
      takeWhatThereIs: takeWhatThereIs === true,
    }),
  );
}

export async function cancelProductionOrderAction(
  orderId: string,
  reason: string,
): Promise<ProductionStepState> {
  return step(orderId, (who, id) =>
    cancelProductionOrder(who, id, String(reason ?? "").slice(0, 400)),
  );
}

/** Who makes an open order (the ids are checked by the service). */
export async function setProductionPeopleAction(
  orderId: string,
  assigneeIds: string[],
): Promise<ProductionStepState> {
  const ids = Array.isArray(assigneeIds)
    ? assigneeIds.slice(0, 50).map((value) => idOf(value))
    : [];
  return step(orderId, (who, id) => setProductionOrderAssignees(who, id, ids));
}

/** The production area a recipe proposes to its orders (or none). */
export async function setRecipeAreaAction(
  productId: string,
  areaLocationId: string,
): Promise<{ ok: boolean; message: string }> {
  const who = await actor();
  try {
    const result = await setRecipeArea(
      who,
      idOf(productId),
      areaLocationId ? idOf(areaLocationId) : null,
    );
    if (!result.ok) return { ok: false, message: result.formError };
    revalidatePath(`/inventario/${idOf(productId)}/receta`);
    return { ok: true, message: result.summary };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, message };
    throw error;
  }
}
