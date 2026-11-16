"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fingerprint, isAppError } from "@/lib";
import {
  addOrderLine,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  findReceiptConfirmation,
  findReturnConfirmation,
  receivePurchaseOrder,
  removeOrderLine,
  requestOrderDelivery,
  returnToSupplier,
  submitPurchaseOrder,
  updateOrderLine,
  updatePurchaseOrder,
  type OrderField,
  type ReceiveField,
  type ReceiveLineField,
} from "@/modules/purchasing";
import { requireOrganizationContext } from "@/platform/tenancy";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

export type OrderFormState = {
  fieldErrors: Partial<Record<OrderField, string>>;
  formError?: string;
  /** What the person had written, to show it again after a refusal. */
  values: {
    supplierId: string;
    facilityId?: string;
    expectedOn: string;
    notes: string;
  };
  /** Changes with every answer, so selects show what was chosen. */
  answers: number;
};

const header = (formData: FormData) => ({
  supplierId: String(formData.get("supplierId") ?? "").slice(0, 36),
  facilityId: String(formData.get("facilityId") ?? "").slice(0, 36),
  expectedOn: String(formData.get("expectedOn") ?? "").slice(0, 10),
  notes: String(formData.get("notes") ?? "").slice(0, 2000),
});

/** Starts a purchase order. Person and company come from the session. */
export async function createPurchaseOrderAction(
  prev: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = header(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await createPurchaseOrder(
      { organizationId: organization.id, userId: user.id },
      values,
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values, answers };
    }
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
  revalidatePath("/compras");
  redirect(`/compras/ordenes/${result.orderId}`);
}

/**
 * Saves the expected day and the notes of a draft. The order is looked
 * for only inside the company of the session.
 */
export async function updatePurchaseOrderAction(
  orderId: string,
  prev: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = header(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await updatePurchaseOrder(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
      { expectedOn: values.expectedOn, notes: values.notes },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values, answers };
    }
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
  revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
  redirect(`/compras/ordenes/${idPath(orderId)}`);
}

export type LineFormState = {
  fieldErrors: Partial<Record<OrderField, string>>;
  formError?: string;
  values: { capture: string; quantity: string; unitCost: string };
  answers: number;
};

/**
 * What the form of a line sent. The cost travels only when the form had
 * its field — the page shows it only to who may record costs — so a
 * person without that permission never erases a cost by saving.
 */
const lineOf = (formData: FormData) => {
  const values = {
    capture: String(formData.get("capture") ?? "base").slice(0, 40),
    quantity: String(formData.get("quantity") ?? "").slice(0, 40),
    unitCost: String(formData.get("unitCost") ?? "").slice(0, 40),
  };
  return {
    values,
    input: {
      capture: values.capture,
      quantity: values.quantity,
      ...(formData.has("unitCost") ? { unitCost: values.unitCost } : {}),
    },
  };
};

/**
 * Adds a product to a draft. Order and product are bound by the page; the
 * service looks for both only inside the company of the session.
 */
export async function addOrderLineAction(
  orderId: string,
  productId: string,
  prev: LineFormState,
  formData: FormData,
): Promise<LineFormState> {
  const { user, organization } = await requireOrganizationContext();
  const { values, input } = lineOf(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await addOrderLine(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
      { productId: String(productId), ...input },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError ?? result.fieldErrors.productId,
      values,
      answers,
    };
  }
  revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
  redirect(`/compras/ordenes/${idPath(orderId)}`);
}

/** Changes a line of a draft; looked for only inside the company of the session. */
export async function updateOrderLineAction(
  orderId: string,
  lineId: string,
  prev: LineFormState,
  formData: FormData,
): Promise<LineFormState> {
  const { user, organization } = await requireOrganizationContext();
  const { values, input } = lineOf(formData);
  const answers = prev.answers + 1;
  let result;
  try {
    result = await updateOrderLine(
      { organizationId: organization.id, userId: user.id },
      String(lineId),
      input,
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values, answers };
    }
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
  revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
  redirect(`/compras/ordenes/${idPath(orderId)}`);
}

export type RemoveLineState = { ok: true } | { ok: false; error: string };

/** Takes a line out of a draft; looked for only inside the company of the session. */
export async function removeOrderLineAction(
  orderId: string,
  lineId: string,
): Promise<RemoveLineState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await removeOrderLine(
      { organizationId: organization.id, userId: user.id },
      String(lineId),
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.formError ?? "No se pudo quitar la línea.",
      };
    }
    revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
    return { ok: true };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export type OrderStateActionResult =
  { ok: true; message: string } | { ok: false; error: string };

/**
 * Confirms a draft as sent (CMP-05). The order is looked for only inside
 * the company of the session; sending it twice confirms once.
 */
export async function submitPurchaseOrderAction(
  orderId: string,
): Promise<OrderStateActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await submitPurchaseOrder(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.formError ?? "No se pudo confirmar la orden.",
      };
    }
    revalidatePath("/compras");
    revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
    return { ok: true, message: "Orden confirmada como enviada." };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Cancels an order with its reason (CMP-05). Looked for only inside the
 * company of the session; cancelling twice cancels once.
 */
export async function cancelPurchaseOrderAction(
  orderId: string,
  reason: string,
): Promise<OrderStateActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await cancelPurchaseOrder(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
      { reason: String(reason ?? "").slice(0, 1000) },
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.fieldErrors.reason ??
          result.formError ??
          "No se pudo cancelar la orden.",
      };
    }
    revalidatePath("/compras");
    revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
    return { ok: true, message: "Orden cancelada." };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Closes an order received in part with its shortage (CMP-11). The order
 * is looked for only inside the company of the session.
 */
export async function closePurchaseOrderAction(
  orderId: string,
  reason: string,
): Promise<OrderStateActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await closePurchaseOrder(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
      { reason: String(reason ?? "").slice(0, 1000) },
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.fieldErrors.reason ??
          result.formError ??
          "No se pudo cerrar la orden.",
      };
    }
    revalidatePath("/compras");
    revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
    return {
      ok: true,
      message: result.repeated
        ? "La orden ya estaba cerrada."
        : `Orden cerrada. Faltante: ${result.shortageText}.`,
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Asks to send an order to its supplier by mail, or to try again after a
 * failure (CMP-06B). The order is looked for only inside the company of
 * the session and the address is the supplier's, never one sent by the
 * browser. The worker sends it.
 */
export async function sendPurchaseOrderAction(
  orderId: string,
): Promise<OrderStateActionResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await requestOrderDelivery(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
    );
    if (!result.ok) return { ok: false, error: result.message };
    revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
    return {
      ok: true,
      message: result.repeated
        ? `Ya hay un envío en camino a ${result.recipient}.`
        : `La orden va en camino a ${result.recipient}.`,
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export type ReceiveFormState = {
  fieldErrors: Partial<Record<ReceiveField, string>>;
  formError?: string;
  /** Problem of each line, by the id of the order line. */
  lineErrors?: Record<string, string>;
  /**
   * WMS-21: the problem of that line is its lot or its expiry date; WMS-54:
   * or what came damaged.
   */
  lineFields?: Record<string, ReceiveLineField>;
  /**
   * A location would be left above its capacity and the company only warns
   * (WMS-22B): nothing was received. `stamp` marks what the warning is
   * about; the button that accepts it sends it back.
   */
  capacityWarning?: { message: string; stamp: string };
  values: {
    locationId: string;
    reference: string;
    /** What was typed for each line, by the id of the order line. */
    quantities: Record<string, string>;
    /** Location chosen for a line, when not the one of the receipt. */
    places: Record<string, string>;
    /** WMS-21: lot and expiry typed for a line of a product by lot. */
    lots: Record<string, string>;
    expiries: Record<string, string>;
    /** WMS-21B: serials typed for a line of a product by serial. */
    serials: Record<string, string>;
    /** WMS-54: of what arrived, how much came damaged, and its serials. */
    damaged: Record<string, string>;
    damagedSerials: Record<string, string>;
    /** WMS-53: everything arrived on a pallet, its label and its kind. */
    onPallet?: boolean;
    containerCode?: string;
    containerKind?: string;
  };
  /** Changes with every answer, so selects show what was chosen. */
  answers: number;
  /** The receipt went through: what to tell the person. */
  done?: string;
  /** WMS-54: what went straight to outbound orders, to open them. */
  crossDock?: { orderId: string; orderNumber: string }[];
};

/** The order line of a field: `<id>` or, for another lot of it, `<id>~1`. */
const orderLineOf = (key: string) => key.split("~")[0]!.slice(0, 36);

/**
 * Receives what is pending of an order into one location (CMP-07). The
 * order and the location are looked for only inside the company of the
 * session; the key makes a repeated confirmation receive once.
 */
export async function receivePurchaseOrderAction(
  orderId: string,
  prev: ReceiveFormState,
  formData: FormData,
): Promise<ReceiveFormState> {
  const { user, organization } = await requireOrganizationContext();
  // One field per line of the order: `q:<id of the order line>`.
  // and, when it goes elsewhere than the rest, `l:<id>` (CMP-09).
  const quantities: Record<string, string> = {};
  const places: Record<string, string> = {};
  // WMS-21: `lot:<id>` and `exp:<id>`, only for products by lot.
  const lots: Record<string, string> = {};
  const expiries: Record<string, string> = {};
  // WMS-21B: `ser:<id>`, only for products by serial.
  const serials: Record<string, string> = {};
  // WMS-54: `dmg:<id>` (how much came damaged) and `dser:<id>` (which
  // serials), per part like the quantity.
  const damaged: Record<string, string> = {};
  const damagedSerials: Record<string, string> = {};
  // A product by lot may arrive in several lots: its extra parts are
  // `q:<id>~1`, `lot:<id>~1`, `exp:<id>~1`… (WMS-21); the place is the
  // line's.
  const MAX = 2_000;
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (name.startsWith("dmg:") && Object.keys(damaged).length < MAX) {
      damaged[name.slice(4, 44)] = value.slice(0, 40);
      continue;
    }
    if (name.startsWith("dser:") && Object.keys(damagedSerials).length < MAX) {
      damagedSerials[name.slice(5, 45)] = value.slice(0, 40_000);
      continue;
    }
    if (name.startsWith("lot:") && Object.keys(lots).length < MAX) {
      lots[name.slice(4, 44)] = value.slice(0, 100);
      continue;
    }
    if (name.startsWith("ser:") && Object.keys(serials).length < MAX) {
      serials[name.slice(4, 44)] = value.slice(0, 40_000);
      continue;
    }
    if (name.startsWith("exp:") && Object.keys(expiries).length < MAX) {
      expiries[name.slice(4, 44)] = value.slice(0, 20);
      continue;
    }
    if (name.startsWith("q:") && Object.keys(quantities).length < MAX) {
      quantities[name.slice(2, 42)] = value.slice(0, 40);
    } else if (
      name.startsWith("l:") &&
      value &&
      Object.keys(places).length < 200
    ) {
      places[name.slice(2, 38)] = value.slice(0, 36);
    }
  }
  const values = {
    locationId: String(formData.get("locationId") ?? "").slice(0, 36),
    reference: String(formData.get("reference") ?? "").slice(0, 200),
    quantities,
    places,
    lots,
    expiries,
    serials,
    damaged,
    damagedSerials,
    onPallet: formData.get("onPallet") === "1",
    containerCode: String(formData.get("containerCode") ?? "").slice(0, 200),
    containerKind: String(formData.get("containerKind") ?? "").slice(0, 200),
  };
  const answers = prev.answers + 1;
  // What a capacity warning would be about: what goes where.
  const stamp = fingerprint([
    String(orderId),
    values.locationId,
    ...Object.entries(quantities).flatMap(([key, quantity]) => [
      key,
      quantity,
      places[orderLineOf(key)] ?? "",
      lots[key] ?? "",
      serials[key] ?? "",
      damaged[key] ?? "",
      damagedSerials[key] ?? "",
    ]),
  ]);
  let result;
  try {
    result = await receivePurchaseOrder(
      { organizationId: organization.id, userId: user.id },
      String(orderId),
      {
        locationId: values.locationId,
        reference: values.reference,
        lines: Object.entries(quantities).map(([key, quantity]) => ({
          orderLineId: orderLineOf(key),
          quantity,
          locationId: places[orderLineOf(key)],
          lotCode: lots[key],
          lotExpiresOn: expiries[key],
          serials: serials[key],
          damaged: damaged[key],
          damagedSerials: damagedSerials[key],
        })),
        idempotencyKey: String(formData.get("idempotencyKey") ?? "").slice(
          0,
          64,
        ),
        // Only the button of the warning about these values carries it.
        acceptCapacity: formData.get("acceptCapacity") === stamp,
        // WMS-53: «Llegó en una tarima».
        container: values.onPallet
          ? { code: values.containerCode, kind: values.containerKind }
          : undefined,
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      fieldErrors: {},
      capacityWarning: {
        message: result.formError ?? "Una ubicación pasaría su capacidad.",
        stamp,
      },
      values,
      answers,
    };
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      lineErrors: result.lineErrors,
      lineFields: result.lineFields,
      values,
      answers,
    };
  }
  revalidatePath("/compras");
  revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
  if (result.crossDock) {
    revalidatePath("/pedidos");
    revalidatePath("/tareas");
  }
  return {
    fieldErrors: {},
    values,
    answers,
    done: result.summary,
    ...(result.crossDock
      ? {
          crossDock: result.crossDock.map((sent) => ({
            orderId: sent.orderId,
            orderNumber: sent.orderNumber,
          })),
        }
      : {}),
  };
}

/**
 * After a lost answer (INV-22): whether the receipt with that key was
 * registered for this person in the company of the session.
 */
export async function checkReceiptAction(
  idempotencyKey: string,
): Promise<{ received: boolean }> {
  const { user, organization } = await requireOrganizationContext();
  const found = await findReceiptConfirmation(
    { organizationId: organization.id, userId: user.id },
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { received: found !== null };
}

export type ReturnFormState = {
  fieldErrors: { reason?: string };
  formError?: string;
  /** Problem of each line, by the id of the receipt line. */
  lineErrors?: Record<string, string>;
  values: {
    reason: string;
    /** What was typed for each line, by the id of the receipt line. */
    quantities: Record<string, string>;
    /** Where a line is taken from, when not where it was received. */
    places: Record<string, string>;
    /** WMS-21B: serials of the units that go back, by receipt line. */
    serials: Record<string, string>;
    /** WMS-30-0: the state a line leaves from, when chosen. */
    states?: Record<string, string>;
  };
  /** Changes with every answer, so selects show what was chosen. */
  answers: number;
  /** The return went through: what to tell the person. */
  done?: string;
};

/**
 * Returns to the supplier what came with a receipt (CMP-12). The receipt
 * and the locations are looked for only inside the company of the
 * session; the key makes a repeated confirmation return once.
 */
export async function returnToSupplierAction(
  orderId: string,
  receiptId: string,
  prev: ReturnFormState,
  formData: FormData,
): Promise<ReturnFormState> {
  const { user, organization } = await requireOrganizationContext();
  // One field per receipt line: `q:<id>`, and `l:<id>` for where from.
  const quantities: Record<string, string> = {};
  const places: Record<string, string> = {};
  const serials: Record<string, string> = {};
  // WMS-30-0: `st:<id>`, the state it leaves from, when offered.
  const states: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (name.startsWith("ser:") && Object.keys(serials).length < 200) {
      serials[name.slice(4, 40)] = value.slice(0, 40_000);
      continue;
    }
    if (name.startsWith("st:") && Object.keys(states).length < 200) {
      states[name.slice(3, 39)] = value.slice(0, 20);
      continue;
    }
    if (name.startsWith("q:") && Object.keys(quantities).length < 200) {
      quantities[name.slice(2, 38)] = value.slice(0, 40);
    } else if (
      name.startsWith("l:") &&
      value &&
      Object.keys(places).length < 200
    ) {
      places[name.slice(2, 38)] = value.slice(0, 36);
    }
  }
  const values = {
    reason: String(formData.get("reason") ?? "").slice(0, 1000),
    quantities,
    places,
    states,
    serials,
  };
  const answers = prev.answers + 1;
  let result;
  try {
    result = await returnToSupplier(
      { organizationId: organization.id, userId: user.id },
      String(receiptId),
      {
        reason: values.reason,
        lines: Object.entries(quantities).map(([receiptLineId, quantity]) => ({
          receiptLineId,
          quantity,
          locationId: places[receiptLineId],
          serials: serials[receiptLineId],
          status: states[receiptLineId],
        })),
        idempotencyKey: String(formData.get("idempotencyKey") ?? "").slice(
          0,
          64,
        ),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      lineErrors: result.lineErrors,
      values,
      answers,
    };
  }
  revalidatePath("/compras");
  revalidatePath(`/compras/ordenes/${idPath(orderId)}`);
  revalidatePath("/movimientos");
  return { fieldErrors: {}, values, answers, done: result.summary };
}

/**
 * After a lost answer (INV-22): whether the return with that key was
 * registered for this person in the company of the session.
 */
export async function checkReturnAction(
  idempotencyKey: string,
): Promise<{ returned: boolean }> {
  const { user, organization } = await requireOrganizationContext();
  const found = await findReturnConfirmation(
    { organizationId: organization.id, userId: user.id },
    String(idempotencyKey ?? "").slice(0, 64),
  );
  return { returned: found !== null };
}
