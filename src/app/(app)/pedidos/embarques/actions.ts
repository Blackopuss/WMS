"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  addShipmentOrders,
  cancelShipment,
  createShipment,
  dispatchShipment,
  getShipment,
  removeShipmentOrder,
  updateShipment,
  type ShipmentField,
  type ShipmentResult,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Shipments (WMS-16). Person and company always come from the session; the
 * services look for the shipment and its orders only in that company and
 * within the person's scope, and check the permission again.
 */

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: unknown) =>
  String(value ?? "")
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const orderIdsOf = (formData: FormData) =>
  formData
    .getAll("orderId")
    .slice(0, 200)
    .map((value) => idPath(value));

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

export type ShipmentHeaderValues = {
  carrier: string;
  trackingNumber: string;
  vehiclePlate: string;
  driverName: string;
  note: string;
};

const headerOf = (formData: FormData): ShipmentHeaderValues => ({
  carrier: text(formData, "carrier", 200),
  trackingNumber: text(formData, "trackingNumber", 200),
  vehiclePlate: text(formData, "vehiclePlate", 40),
  driverName: text(formData, "driverName", 200),
  note: text(formData, "note", 600),
});

export type ShipmentFormState = {
  error?: string;
  fieldErrors?: Partial<Record<ShipmentField, string>>;
  saved?: string;
  values: ShipmentHeaderValues & { orderIds: string[] };
  answers: number;
};

/** «Armar embarque»: the orders chosen and the transport data. */
export async function createShipmentAction(
  previous: ShipmentFormState,
  formData: FormData,
): Promise<ShipmentFormState> {
  const who = await actor();
  const values = { ...headerOf(formData), orderIds: orderIdsOf(formData) };
  const answers = previous.answers + 1;
  let result: ShipmentResult;
  try {
    result = await createShipment(who, values);
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
  redirect(`/pedidos/embarques/${idPath(result.shipmentId)}`);
}

/** Changes the transport data of a draft. */
export async function updateShipmentAction(
  shipmentId: string,
  previous: ShipmentFormState,
  formData: FormData,
): Promise<ShipmentFormState> {
  const who = await actor();
  const values = { ...headerOf(formData), orderIds: [] };
  const answers = previous.answers + 1;
  let result: ShipmentResult;
  try {
    result = await updateShipment(who, idPath(shipmentId), values);
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
  revalidatePath(`/pedidos/embarques/${idPath(shipmentId)}`);
  return { saved: result.summary, values, answers };
}

export type ShipmentStepState =
  { ok: true; summary: string } | { ok: false; error: string };

async function step(
  work: (who: {
    organizationId: string;
    userId: string;
  }) => Promise<ShipmentResult>,
  shipmentId: string,
): Promise<ShipmentStepState> {
  const who = await actor();
  let result: ShipmentResult;
  try {
    result = await work(who);
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.formError ??
        Object.values(result.fieldErrors ?? {})[0] ??
        "No se pudo. Vuelve a intentarlo.",
    };
  }
  revalidatePath("/pedidos");
  revalidatePath(`/pedidos/embarques/${idPath(shipmentId)}`);
  return { ok: true, summary: result.summary };
}

/** Adds the orders checked to a draft. */
export async function addShipmentOrdersAction(
  shipmentId: string,
  orderIds: string[],
): Promise<ShipmentStepState> {
  const ids = (Array.isArray(orderIds) ? orderIds : [])
    .slice(0, 200)
    .map((id) => idPath(id));
  return step(
    (who) => addShipmentOrders(who, idPath(shipmentId), ids),
    shipmentId,
  );
}

export async function removeShipmentOrderAction(
  shipmentId: string,
  orderId: string,
): Promise<ShipmentStepState> {
  return step(
    (who) => removeShipmentOrder(who, idPath(shipmentId), idPath(orderId)),
    shipmentId,
  );
}

export async function cancelShipmentAction(
  shipmentId: string,
  reason: string,
): Promise<ShipmentStepState> {
  return step(
    (who) =>
      cancelShipment(
        who,
        idPath(shipmentId),
        String(reason ?? "").slice(0, 400),
      ),
    shipmentId,
  );
}

/** «Confirmar salida»: irreversible; the client verifies a lost answer. */
export async function dispatchShipmentAction(
  shipmentId: string,
): Promise<ShipmentStepState> {
  return step((who) => dispatchShipment(who, idPath(shipmentId)), shipmentId);
}

/**
 * After a lost answer (INV-22): whether the shipment already left, for the
 * person of the session and within their scope.
 */
export async function checkShipmentAction(
  shipmentId: string,
): Promise<{ shipped: boolean }> {
  const who = await actor();
  const shipment = await getShipment(who, idPath(shipmentId));
  return { shipped: shipment?.status === "SHIPPED" };
}
