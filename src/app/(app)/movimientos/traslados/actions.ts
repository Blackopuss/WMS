"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fingerprint, isAppError } from "@/lib";
import {
  FACILITY_TRANSFER_MAX_LINES,
  addFacilityTransferLine,
  cancelFacilityTransfer,
  createFacilityTransfer,
  findConfirmation,
  findFacilityTransferByKey,
  receiveFacilityTransfer,
  removeFacilityTransferLine,
  resolveFacilityTransfer,
  sendFacilityTransfer,
  type FacilityTransferField,
  type FacilityTransferResult,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Transfers between warehouses (WMS-19). Person and company always come
 * from the session; the services look for the transfer, its warehouses and
 * places only in that company and within the person's scope, and check the
 * permission again.
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

const ficha = (transferId: string) =>
  `/movimientos/traslados/${idPath(transferId)}`;

function refreshTransfer(transferId: string) {
  revalidatePath("/movimientos/traslados");
  revalidatePath(ficha(transferId));
  revalidatePath("/inicio");
}

export type TransferFormState = {
  error?: string;
  fieldErrors?: Partial<Record<FacilityTransferField, string>>;
  /** By id of the transfer line. */
  lineErrors?: Record<string, string>;
  saved?: string;
  capacityWarning?: { message: string; stamp: string };
  values: Record<string, string>;
  answers: number;
};

function failed(
  result: FacilityTransferResult | { ok: false; formError?: string },
  values: Record<string, string>,
  answers: number,
): TransferFormState {
  const failure = result as {
    formError?: string;
    fieldErrors?: Partial<Record<FacilityTransferField, string>>;
    lineErrors?: Record<string, string>;
  };
  return {
    error: failure.formError,
    fieldErrors: failure.fieldErrors,
    lineErrors: failure.lineErrors,
    values,
    answers,
  };
}

/** «Nuevo traslado»: a draft to another warehouse, then its card. */
export async function createTransferAction(
  previous: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const who = await actor();
  const values = {
    toFacilityId: text(formData, "toFacilityId", 36),
    note: text(formData, "note", 600),
  };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await createFacilityTransfer(who, {
      ...values,
      idempotencyKey: text(formData, "idempotencyKey", 64),
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok) return failed(result, values, answers);
  revalidatePath("/movimientos/traslados");
  redirect(ficha(result.transferId));
}

/** After a lost answer (INV-22): the draft that confirmation created. */
export async function checkCreatedTransferAction(
  idempotencyKey: string,
): Promise<{ transferId: string | null }> {
  const who = await actor();
  const found = await findFacilityTransferByKey(
    who,
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { transferId: found?.transferId ?? null };
}

/** Adds a product to a draft (the product is bound by the page). */
export async function addTransferLineAction(
  bound: { transferId: string; productId: string },
  previous: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const who = await actor();
  const values = {
    source: text(formData, "source", 80),
    quantity: text(formData, "quantity", 40),
    serials: text(formData, "serials", 40_000),
  };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await addFacilityTransferLine(who, {
      transferId: idPath(bound.transferId),
      productId: idPath(bound.productId),
      ...values,
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok) return failed(result, values, answers);
  refreshTransfer(bound.transferId);
  redirect(ficha(bound.transferId));
}

/** «Quitar» a product of a draft. */
export async function removeTransferLineAction(bound: {
  transferId: string;
  lineId: string;
}): Promise<void> {
  const who = await actor();
  try {
    await removeFacilityTransferLine(who, {
      transferId: idPath(bound.transferId),
      lineId: idPath(bound.lineId),
    });
  } catch (error) {
    if (!forbidden(error)) throw error;
  }
  refreshTransfer(bound.transferId);
}

/** «Enviar»: what the draft lists leaves and waits in transit. */
export async function sendTransferAction(
  bound: { transferId: string },
  previous: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const who = await actor();
  const values = { carrier: text(formData, "carrier", 200) };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await sendFacilityTransfer(who, {
      transferId: idPath(bound.transferId),
      carrier: values.carrier,
      idempotencyKey: text(formData, "idempotencyKey", 64),
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok) return failed(result, values, answers);
  refreshTransfer(bound.transferId);
  return { saved: result.summary, values: { carrier: "" }, answers };
}

/** «Cancelar traslado»: only a draft, with a reason. */
export async function cancelTransferAction(
  bound: { transferId: string },
  previous: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const who = await actor();
  const values = { reason: text(formData, "reason", 400) };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await cancelFacilityTransfer(who, {
      transferId: idPath(bound.transferId),
      reason: values.reason,
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok) return failed(result, values, answers);
  refreshTransfer(bound.transferId);
  return { saved: result.summary, values: { reason: "" }, answers };
}

/**
 * «Recibir»: for each line (`line` fields), what arrived well
 * (`qty:<line>`, `serials:<line>`) and damaged (`damaged:<line>`,
 * `damagedSerials:<line>`), into one place of the destination.
 */
export async function receiveTransferAction(
  bound: { transferId: string },
  previous: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const who = await actor();
  const lineIds = formData
    .getAll("line")
    .slice(0, FACILITY_TRANSFER_MAX_LINES)
    .map((id) => idPath(id));
  const values: Record<string, string> = {
    locationId: text(formData, "locationId", 36),
    note: text(formData, "note", 600),
  };
  for (const id of lineIds) {
    for (const field of ["qty", "serials", "damaged", "damagedSerials"]) {
      values[`${field}:${id}`] = text(
        formData,
        `${field}:${id}`,
        field.endsWith("erials") ? 40_000 : 40,
      );
    }
  }
  const answers = previous.answers + 1;
  const stamp = fingerprint([
    bound.transferId,
    values.locationId ?? "",
    ...lineIds.map(
      (id) => `${id}=${values[`qty:${id}`]}/${values[`damaged:${id}`]}`,
    ),
  ]);
  let result;
  try {
    result = await receiveFacilityTransfer(who, {
      transferId: idPath(bound.transferId),
      locationId: values.locationId ?? "",
      note: values.note,
      idempotencyKey: text(formData, "idempotencyKey", 64),
      lines: lineIds.map((id) => ({
        lineId: id,
        quantity: values[`qty:${id}`],
        serials: values[`serials:${id}`],
        damaged: values[`damaged:${id}`],
        damagedSerials: values[`damagedSerials:${id}`],
      })),
      // Only the button of the warning about these values carries it.
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
      },
      values,
      answers,
    };
  }
  if (!result.ok) return failed(result, values, answers);
  refreshTransfer(bound.transferId);
  return { saved: result.summary, values: {}, answers };
}

/** «Se perdió» / «Regresó al origen» for what of a line did not arrive. */
export async function resolveTransferAction(
  bound: { transferId: string; lineId: string },
  previous: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const who = await actor();
  const values = {
    outcome: text(formData, "outcome", 20),
    quantity: text(formData, "quantity", 40),
    reason: text(formData, "reason", 600),
    serials: text(formData, "serials", 40_000),
  };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await resolveFacilityTransfer(who, {
      transferId: idPath(bound.transferId),
      lineId: idPath(bound.lineId),
      ...values,
      idempotencyKey: text(formData, "idempotencyKey", 64),
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok) return failed(result, values, answers);
  refreshTransfer(bound.transferId);
  return { saved: result.summary, values: {}, answers };
}

/**
 * After a lost answer (INV-22): whether that send, receipt or resolution
 * was registered (its movement carries the key).
 */
export async function checkTransferMovementAction(
  idempotencyKey: string,
): Promise<{ done: boolean }> {
  const who = await actor();
  const found = await findConfirmation(
    who,
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { done: found !== null };
}
