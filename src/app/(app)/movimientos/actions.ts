"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fingerprint, isAppError } from "@/lib";
import {
  findConfirmation,
  registerAdjustment,
  registerEntry,
  registerExit,
  registerInitialBalance,
  registerTransfer,
  reverseMovement,
  type EntryField,
} from "@/modules/inventory";
import { previewConversion, type Capture } from "@/platform/catalog";
import { requireOrganizationContext } from "@/platform/tenancy";

export type EntryFormState = {
  fieldErrors: Partial<Record<EntryField | "toLocationId", string>>;
  formError?: string;
  /**
   * The same entry was registered a moment ago (WMS-71): nothing was saved
   * and the form offers «Registrar de todos modos».
   */
  repeatWarning?: string;
  /**
   * What was sent would leave a location above its capacity and the
   * company only warns (WMS-22B): nothing was saved. `stamp` marks the
   * values the warning is about; the button that accepts it sends it back,
   * so the acceptance never applies to something else.
   */
  capacityWarning?: { message: string; stamp: string };
  /** The capacity warning of these values was already accepted (its stamp). */
  capacityAccepted?: string;
  values: {
    locationId: string;
    quantity: string;
    /** "base", "p:<presentation id>" or "u:<unit code>". */
    capture: string;
    reference: string;
    reason: string;
    /** Cost of one captured unit, as typed (VAL-03); only some forms have it. */
    unitCost?: string;
    /** Destination of a relocation (INV-23). */
    toLocationId?: string;
    /** WMS-21: lot and expiry typed for what comes in; lot chosen to adjust. */
    lotCode?: string;
    lotExpiresOn?: string;
    lotId?: string;
  };
};

/**
 * WMS-21: for a product by lot, «de dónde sale» chooses location and lot
 * at once, as `<location id>|<lot id>`. Only ids travel; the service
 * checks that the lot is of the product and is there.
 */
function placeAndLot(value: string): { locationId: string; lotId: string } {
  const [locationId = "", lotId = ""] = value.split("|");
  return { locationId, lotId };
}

/**
 * How the quantity is captured, as the form sends it. Only an id or a code
 * travels; the content of a presentation is always read in the server.
 */
function captureFields(capture: string): {
  presentationId?: string;
  unitCode?: string;
} {
  if (capture.startsWith("p:")) return { presentationId: capture.slice(2) };
  if (capture.startsWith("u:")) return { unitCode: capture.slice(2) };
  return {};
}

/**
 * Registers an entry. The product id is bound by the page and looked for
 * only inside the company of the session; person and company come from
 * the session, never from the form.
 */
export async function registerEntryAction(
  productId: string,
  prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  return receive("entry", productId, prev, formData);
}

/**
 * What the form sends with «Registrar de todos modos» (WMS-71). Only that
 * button carries it, so it is a decision of the person on that warning.
 */
const acceptsRepeat = (formData: FormData) =>
  formData.get("acceptRepeat") === "1";

/**
 * Whether the form accepts the capacity warning of exactly these values
 * (WMS-22B): the button of the warning, or the acceptance kept while
 * another warning is answered, carries their stamp.
 */
const acceptsCapacity = (formData: FormData, stamp: string) =>
  formData.getAll("acceptCapacity").includes(stamp);

/** Registers an exit; the service refuses more than the location holds (INV-19). */
export async function registerExitAction(
  productId: string,
  prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  return receive("exit", productId, prev, formData);
}

/** Registers the initial balance of a product in a location (INV-18). */
export async function registerInitialBalanceAction(
  productId: string,
  prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  return receive("initial", productId, prev, formData);
}

/** Corrects stock to what was counted, with a mandatory reason (INV-24). */
export async function registerAdjustmentAction(
  productId: string,
  prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  return receive("adjustment", productId, prev, formData);
}

/** The choice of an adjustment for a lot the system does not know (WMS-21). */
const NEW_LOT = "new";

const SERVICES = {
  adjustment: registerAdjustment,
  entry: registerEntry,
  exit: registerExit,
  initial: registerInitialBalance,
} as const;

async function receive(
  kind: keyof typeof SERVICES,
  productId: string,
  _prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  const { user, organization } = await requireOrganizationContext();
  const text = (name: string) => String(formData.get(name) ?? "");
  const values = {
    locationId: text("locationId"),
    quantity: text("quantity"),
    capture: text("capture") || "base",
    reference: text("reference"),
    reason: text("reason"),
    unitCost: text("unitCost"),
    lotCode: text("lotCode"),
    lotExpiresOn: text("lotExpiresOn"),
    lotId: text("lotId"),
  };
  const from = placeAndLot(values.locationId);
  // What a capacity warning would be about: product, place and quantity.
  const stamp = fingerprint([
    kind,
    String(productId),
    values.locationId,
    values.quantity,
    values.capture,
    values.lotCode,
  ]);
  const acceptCapacity = acceptsCapacity(formData, stamp);
  let result;
  try {
    result = await SERVICES[kind](
      { organizationId: organization.id, userId: user.id },
      {
        productId: String(productId),
        locationId: from.locationId,
        quantity: values.quantity,
        reference: values.reference,
        reason: values.reason,
        // WMS-21: only the forms of a product by lot send them. An
        // adjustment names a lot of the list, or a new one («new») by code.
        ...(kind !== "adjustment" || values.lotId === NEW_LOT
          ? { lotCode: values.lotCode, lotExpiresOn: values.lotExpiresOn }
          : {}),
        lotId: from.lotId || (values.lotId === NEW_LOT ? "" : values.lotId),
        // Only the forms that show the field send it (VAL-03).
        unitCost: values.unitCost,
        // Created with the form and resent on every retry (INV-21).
        idempotencyKey: text("idempotencyKey"),
        ...captureFields(values.capture),
        // Only entries look at it (WMS-71).
        ...(kind === "entry" ? { acceptRepeat: acceptsRepeat(formData) } : {}),
        // Only what brings stock in looks at it (WMS-22B).
        ...(kind === "entry" || kind === "initial" ? { acceptCapacity } : {}),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values };
    }
    throw error;
  }
  if (!result.ok && result.reason === "repeated_recently") {
    return {
      fieldErrors: {},
      repeatWarning: result.formError,
      // Asked after the capacity: keep that answer for the same values.
      capacityAccepted: acceptCapacity ? stamp : undefined,
      values,
    };
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      fieldErrors: {},
      capacityWarning: { message: result.formError, stamp },
      values,
    };
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      // A problem with the product itself has no field in this form.
      formError: result.formError ?? result.fieldErrors.productId,
      values,
    };
  }
  revalidatePath("/movimientos");
  revalidatePath("/inventario");
  redirect(
    kind === "initial"
      ? `/movimientos/saldo-inicial?guardado=${result.movementId}`
      : `/movimientos?registrado=${result.movementId}`,
  );
}

export type EntryPreview =
  { ok: true; preview: string } | { ok: false; error: string };

/**
 * «3 cajas × 100 = 300 piezas», computed in the server with the current
 * content of the presentation, to show before confirming. Writes nothing.
 */
export async function previewEntryAction(
  productId: string,
  capture: string,
  quantity: string,
): Promise<EntryPreview> {
  const { user, organization } = await requireOrganizationContext();
  const fields = captureFields(String(capture));
  const typed = String(quantity).slice(0, 40);
  const request: Capture = fields.presentationId
    ? {
        kind: "presentation",
        quantity: typed,
        presentationId: fields.presentationId,
      }
    : fields.unitCode
      ? { kind: "unit", quantity: typed, unitCode: fields.unitCode }
      : { kind: "base", quantity: typed };
  try {
    const result = await previewConversion(
      { organizationId: organization.id, userId: user.id },
      String(productId),
      request,
    );
    return result.ok
      ? { ok: true, preview: result.preview }
      : { ok: false, error: result.error };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export type ConfirmationCheck = { registered: boolean; movementId?: string };

/**
 * Tells the form whether a confirmation whose answer never arrived was
 * registered (INV-22). It only reads; the key identifies a confirmation of
 * the person of the session.
 */
export async function checkConfirmationAction(
  idempotencyKey: string,
): Promise<ConfirmationCheck> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const found = await findConfirmation(
      { organizationId: organization.id, userId: user.id },
      String(idempotencyKey),
    );
    return found
      ? { registered: true, movementId: found.movementId }
      : { registered: false };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { registered: false };
    }
    throw error;
  }
}

/** Moves stock of a product between two locations (INV-23). */
export async function registerTransferAction(
  productId: string,
  _prev: EntryFormState,
  formData: FormData,
): Promise<EntryFormState> {
  const { user, organization } = await requireOrganizationContext();
  const text = (name: string) => String(formData.get(name) ?? "");
  const values = {
    locationId: text("locationId"),
    toLocationId: text("toLocationId"),
    quantity: text("quantity"),
    capture: text("capture") || "base",
    reference: "",
    reason: text("reason"),
  };
  const from = placeAndLot(values.locationId);
  const stamp = fingerprint([
    "transfer",
    String(productId),
    values.locationId,
    values.toLocationId,
    values.quantity,
    values.capture,
  ]);
  let result;
  try {
    result = await registerTransfer(
      { organizationId: organization.id, userId: user.id },
      {
        productId: String(productId),
        locationId: from.locationId,
        lotId: from.lotId,
        toLocationId: values.toLocationId,
        quantity: values.quantity,
        reason: values.reason,
        idempotencyKey: text("idempotencyKey"),
        ...captureFields(values.capture),
        acceptCapacity: acceptsCapacity(formData, stamp),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { fieldErrors: {}, formError: error.message, values };
    }
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      fieldErrors: {},
      capacityWarning: { message: result.formError, stamp },
      values,
    };
  }
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError ?? result.fieldErrors.productId,
      values,
    };
  }
  revalidatePath("/movimientos");
  revalidatePath("/inventario");
  redirect(`/movimientos?registrado=${result.movementId}`);
}

export type ReverseState =
  { ok: true; summary: string } | { ok: false; error: string };

/**
 * Reverses a movement with a mandatory reason (INV-25). The movement is
 * looked for only inside the company of the session.
 */
export async function reverseMovementAction(
  movementId: string,
  idempotencyKey: string,
  reason: string,
): Promise<ReverseState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await reverseMovement(
      { organizationId: organization.id, userId: user.id },
      {
        movementId: String(movementId),
        reason: String(reason ?? ""),
        idempotencyKey: String(idempotencyKey ?? ""),
      },
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/movimientos");
    revalidatePath("/inventario");
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
