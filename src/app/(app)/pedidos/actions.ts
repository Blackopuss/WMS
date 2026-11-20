"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  askProductionAgain,
  cancelOutboundOrder,
  createOutboundOrder,
  finishPacking,
  packScan,
  reopenPackage,
  reportPackShortage,
  sealPackage,
  startPacking,
  unpackFromPackage,
  type PackField,
  type PackResult,
  releaseOutboundOrder,
  removeOutboundLine,
  reserveWhatThereIs,
  setOutboundLine,
  stopWaitingForProduction,
  type OutboundField,
  type OutboundResult,
  type OutboundShortage,
} from "@/modules/inventory";
import { makeToOrder } from "@/modules/registry";
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

/** How many matching products are offered to pick from. */
const LINE_CHOICES = 6;

export type LineFormState = {
  error?: string;
  fieldErrors?: Partial<Record<"code" | "quantity", string>>;
  saved?: string;
  /** Several products match what was typed: the person picks one. */
  choices?: { sku: string; name: string }[];
  values: { code: string; quantity: string };
  answers: number;
};

/**
 * Adds a product to a draft, or changes the quantity of the one already
 * there. What is typed is its code (SKU or barcode, typed or scanned) or
 * part of its name: with one match it is added; with several, the person
 * picks among them (`pick` carries the chosen SKU).
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
  const picked = text(formData, "pick", 100).trim();
  const answers = previous.answers + 1;
  if (!values.code && !picked) {
    return {
      fieldErrors: { code: "Escribe el nombre o la clave del producto." },
      values,
      answers,
    };
  }
  try {
    const found = await listProducts(who, {
      search: picked || values.code,
      pageSize: LINE_CHOICES,
    });
    const product =
      found.exact ?? (found.total === 1 ? (found.items[0] ?? null) : null);
    if (!product) {
      return found.total === 0
        ? {
            fieldErrors: {
              code: "No encontramos ese producto. Prueba con otra palabra o con su clave.",
            },
            values,
            answers,
          }
        : {
            choices: found.items.map(({ sku, name }) => ({ sku, name })),
            fieldErrors: {
              code:
                found.total > found.items.length
                  ? `Hay ${found.total} productos parecidos: elige uno o escribe algo más.`
                  : "Hay varios productos parecidos: elige uno.",
            },
            values,
            answers,
          };
    }
    const result = await setOutboundLine(who, idOf(orderId), {
      productId: product.id,
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
  ) => Promise<
    | OutboundResult
    | {
        ok: false;
        fieldErrors?: Partial<Record<string, string>>;
        formError?: string;
        shortages?: undefined;
      }
  >,
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
      // WMS-79 (ADR 0094): what production can make is asked to it when
      // the company turned it on.
      makeToOrder,
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

/** WMS-79: «Dejar de esperar» — the order stops waiting for production. */
export async function stopWaitingAction(
  orderId: string,
  reason: string,
): Promise<OutboundStepState> {
  return step(orderId, (who, id) =>
    stopWaitingForProduction(who, id, String(reason ?? "").slice(0, 400), {
      makeToOrder,
    }),
  );
}

/** WMS-79: «Apartar lo que ya hay» for what a released order lacks. */
export async function reserveWhatThereIsAction(
  orderId: string,
): Promise<OutboundStepState> {
  return step(orderId, (who, id) => reserveWhatThereIs(who, id));
}

/** WMS-79: «Pedir producción de nuevo» for what the order still waits. */
export async function askProductionAgainAction(
  orderId: string,
): Promise<OutboundStepState> {
  return step(orderId, (who, id) =>
    askProductionAgain(who, id, { makeToOrder }),
  );
}

// ── Packing (WMS-15) ─────────────────────────────────────────────────────

export type PackStepState =
  | { ok: true; summary: string; repeated?: boolean }
  | {
      ok: false;
      error: string;
      fieldErrors?: Partial<Record<PackField, string>>;
    };

async function packStep(
  orderId: string,
  work: (
    who: { organizationId: string; userId: string },
    id: string,
  ) => Promise<PackResult>,
): Promise<PackStepState> {
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
          "No se pudo cambiar el empaque.",
        fieldErrors: result.fieldErrors,
      };
    }
    revalidatePath("/pedidos");
    revalidatePath(`/pedidos/${id}`);
    revalidatePath(`/pedidos/${id}/empaque`);
    return { ok: true, summary: result.summary, repeated: result.repeated };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/** «Empacar»: a picked order starts being packed. */
export async function startPackingAction(
  orderId: string,
): Promise<PackStepState> {
  return packStep(orderId, (who, id) => startPacking(who, id));
}

/** One scan (and how many) into the order's open package. */
export async function packScanAction(
  orderId: string,
  code: string,
  quantity: string,
): Promise<PackStepState> {
  return packStep(orderId, (who, id) =>
    packScan(who, id, {
      code: String(code ?? "").slice(0, 100),
      quantity: String(quantity ?? "").slice(0, 40),
    }),
  );
}

export async function unpackPackageAction(
  orderId: string,
  input: {
    packageId: string;
    itemId: string;
    quantity: string;
    serials?: string;
  },
): Promise<PackStepState> {
  return packStep(orderId, (who, id) =>
    unpackFromPackage(who, id, {
      packageId: idOf(input?.packageId),
      itemId: idOf(input?.itemId),
      quantity: String(input?.quantity ?? "").slice(0, 40),
      serials: String(input?.serials ?? "").slice(0, 40_000),
    }),
  );
}

export async function sealPackageAction(
  orderId: string,
  input: { packageId: string; kind: string; weight: string },
): Promise<PackStepState> {
  return packStep(orderId, (who, id) =>
    sealPackage(who, id, {
      packageId: idOf(input?.packageId),
      kind: String(input?.kind ?? "").slice(0, 200),
      weight: String(input?.weight ?? "").slice(0, 40),
    }),
  );
}

export async function reopenPackageAction(
  orderId: string,
  packageId: string,
): Promise<PackStepState> {
  return packStep(orderId, (who, id) =>
    reopenPackage(who, id, idOf(packageId)),
  );
}

export async function reportPackShortageAction(
  orderId: string,
  lineId: string,
  reason: string,
): Promise<PackStepState> {
  return packStep(orderId, (who, id) =>
    reportPackShortage(who, id, {
      lineId: idOf(lineId),
      reason: String(reason ?? "").slice(0, 400),
    }),
  );
}

export async function finishPackingAction(
  orderId: string,
): Promise<PackStepState> {
  return packStep(orderId, (who, id) => finishPacking(who, id));
}
