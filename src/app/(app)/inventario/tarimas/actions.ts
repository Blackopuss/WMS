"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fingerprint, isAppError } from "@/lib";
import {
  closeContainer,
  moveContainer,
  packStock,
  unpackStock,
  type ContainerField,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const actorOf = async () => {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
};

export type PackState = {
  error?: string;
  fieldErrors?: Partial<Record<ContainerField, string>>;
  values: {
    source: string;
    containerCode: string;
    kind: string;
    quantity: string;
    serials: string;
  };
  answers: number;
};

/**
 * Packs loose stock of a product in a container (WMS-53): a new one or the
 * one fixed by the page. The product is bound by the page; person and
 * company come from the session and the service looks for product,
 * location and container only in that company. Goes to the container.
 */
export async function packAction(
  bound: { productId: string; containerId: string | null },
  previous: PackState,
  formData: FormData,
): Promise<PackState> {
  const actor = await actorOf();
  const values = {
    // «<location>» or, for a product by lot, «<location>|<lot>».
    source: text(formData, "source", 80),
    containerCode: text(formData, "containerCode", 200),
    kind: text(formData, "kind", 200),
    quantity: text(formData, "quantity", 40),
    serials: text(formData, "serials", 40_000),
  };
  const [locationId = "", lotId = ""] = values.source.split("|");
  const answers = previous.answers + 1;
  let result;
  try {
    result = await packStock(actor, {
      locationId: locationId.slice(0, 36),
      lotId: lotId.slice(0, 36),
      productId: String(bound.productId).slice(0, 36),
      containerId: bound.containerId
        ? String(bound.containerId).slice(0, 36)
        : undefined,
      containerCode: values.containerCode,
      kind: values.kind,
      quantity: values.quantity,
      serials: values.serials,
    });
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
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
  revalidatePath("/inventario/tarimas");
  redirect(`/inventario/tarimas/${idPath(result.containerId)}?listo=1`);
}

export type MoveState = {
  error?: string;
  fieldErrors?: Partial<Record<ContainerField, string>>;
  saved?: string;
  /** Movement written, to open it from the answer. */
  containerId?: string;
  capacityWarning?: { message: string; stamp: string };
  values: { containerCode: string; locationCode: string };
  answers: number;
  /** Moves done with this form: each one confirms with its own key. */
  moved: number;
};

/**
 * Moves a container with one scan (WMS-53): its label (or the one fixed by
 * its page) and the label of the place. The key of the confirmation comes
 * with the form; person and company from the session.
 */
export async function moveContainerAction(
  containerId: string | null,
  previous: MoveState,
  formData: FormData,
): Promise<MoveState> {
  const actor = await actorOf();
  const values = {
    containerCode: text(formData, "containerCode", 200),
    locationCode: text(formData, "locationCode", 200),
  };
  const answers = previous.answers + 1;
  const stamp = fingerprint([
    String(containerId ?? values.containerCode),
    values.locationCode.trim().toUpperCase(),
  ]);
  let result;
  try {
    result = await moveContainer(actor, {
      containerId: containerId ? String(containerId).slice(0, 36) : undefined,
      containerCode: containerId ? undefined : values.containerCode,
      locationCode: values.locationCode,
      idempotencyKey: text(formData, "idempotencyKey", 64),
      acceptCapacity: formData.get("acceptCapacity") === stamp,
    });
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers, moved: previous.moved };
    }
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      capacityWarning: { message: result.formError, stamp },
      values,
      answers,
      moved: previous.moved,
    };
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
      moved: previous.moved,
    };
  }
  revalidatePath("/inventario/tarimas");
  revalidatePath(`/inventario/tarimas/${idPath(result.containerId)}`);
  revalidatePath("/movimientos");
  return {
    saved: result.summary,
    containerId: result.containerId,
    values: { containerCode: "", locationCode: "" },
    answers,
    moved: previous.moved + (result.repeated ? 0 : 1),
  };
}

export type UnpackState = {
  error?: string;
  fieldErrors?: Partial<Record<ContainerField, string>>;
  saved?: string;
  values: { itemId: string; quantity: string; serials: string };
  answers: number;
};

/**
 * Takes part of what a container holds out of it, loose in the same place
 * (WMS-53). The container is bound by the page; person and company from
 * the session.
 */
export async function unpackAction(
  containerId: string,
  previous: UnpackState,
  formData: FormData,
): Promise<UnpackState> {
  const actor = await actorOf();
  const values = {
    itemId: text(formData, "itemId", 36),
    quantity: text(formData, "quantity", 40),
    serials: text(formData, "serials", 40_000),
  };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await unpackStock(actor, {
      containerId: String(containerId).slice(0, 36),
      ...values,
    });
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
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
  revalidatePath(`/inventario/tarimas/${idPath(containerId)}`);
  return {
    saved: result.summary,
    // The same choice stays selected; what was typed is emptied.
    values: { itemId: values.itemId, quantity: "", serials: "" },
    answers,
  };
}

/** Takes a container apart (WMS-53); bound by the page. */
export async function closeContainerAction(
  containerId: string,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const actor = await actorOf();
  let result;
  try {
    result = await closeContainer(actor, String(containerId).slice(0, 36));
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.formError ??
        Object.values(result.fieldErrors)[0] ??
        "No se pudo desarmar.",
    };
  }
  revalidatePath("/inventario/tarimas");
  revalidatePath(`/inventario/tarimas/${idPath(containerId)}`);
  return { ok: true, summary: result.summary };
}
