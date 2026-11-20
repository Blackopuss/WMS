"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import {
  INSPECTION_OUTCOMES,
  MISSING_CAUSES,
  cancelInspection,
  decideInspection,
  discardInspectionPhoto,
  findInspectionDecision,
  startInspection,
  uploadInspectionPhoto,
} from "@/modules/quality";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Verifications (WMS-30B, ADR 0091). Person and company always come from
 * the session; the services look for the stock and the verification only
 * in that company and the person's scope, and check the permission again.
 */

const idOf = (value: unknown) =>
  String(value ?? "")
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);
const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

export type StartInspectionState = {
  ok?: boolean;
  inspectionId?: string;
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values: { origin: string; quantity: string };
  answers: number;
};

/** «Iniciar verificación»: the key is fixed by the page. */
export async function startInspectionAction(
  fixed: {
    productId: string;
    locationId: string;
    lotId: string | null;
    status: string;
    idempotencyKey: string;
  },
  previous: StartInspectionState,
  formData: FormData,
): Promise<StartInspectionState> {
  const who = await actor();
  const chosen = text(formData, "origin", 80);
  const [origin, lineId] = chosen.split("|");
  const values = { origin: chosen, quantity: text(formData, "quantity", 20) };
  try {
    const result = await startInspection(who, {
      productId: idOf(fixed.productId),
      locationId: idOf(fixed.locationId),
      lotId: fixed.lotId ? idOf(fixed.lotId) : null,
      status: String(fixed.status).slice(0, 12),
      origin: String(origin ?? "").slice(0, 20),
      lineId: idOf(lineId),
      quantity: values.quantity,
      idempotencyKey: String(fixed.idempotencyKey ?? "").slice(0, 64),
    });
    if (!result.ok) {
      return {
        values,
        error: result.formError,
        fieldErrors: result.fieldErrors,
        answers: previous.answers + 1,
      };
    }
    revalidatePath("/inventario/por-inspeccionar");
    return {
      ok: true,
      inspectionId: result.inspectionId,
      values,
      answers: previous.answers + 1,
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) {
      return { values, error: message, answers: previous.answers + 1 };
    }
    throw error;
  }
}

export type DecideInspectionState = {
  ok?: boolean;
  summary?: string;
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  overCapacity?: boolean;
  values: Record<string, string>;
  answers: number;
};

/** «Confirmar»: every destination and cause of a verification at once. */
export async function decideInspectionAction(
  fixed: { inspectionId: string; idempotencyKey: string },
  previous: DecideInspectionState,
  formData: FormData,
): Promise<DecideInspectionState> {
  const who = await actor();
  const values: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string" && name.length <= 80) {
      values[name] = value.slice(0, 2000);
    }
  }
  const outcomes = INSPECTION_OUTCOMES.map((status) => ({
    status,
    quantity: text(formData, `q:${status}`, 20),
    reason: text(formData, `r:${status}`, 300),
    toLocationId: idOf(formData.get(`l:${status}`)),
    serials: text(formData, `s:${status}`, 20000),
  })).filter(
    (each) => each.quantity.trim() !== "" && each.quantity.trim() !== "0",
  );
  const missing = MISSING_CAUSES.map((cause) => ({
    cause,
    quantity: text(formData, `mq:${cause}`, 20),
    reason: text(formData, `mr:${cause}`, 300),
    serials: text(formData, `ms:${cause}`, 20000),
  })).filter(
    (each) => each.quantity.trim() !== "" && each.quantity.trim() !== "0",
  );
  const answers: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("a:") && typeof value === "string") {
      const id = idOf(name.slice(2));
      if (id) answers[id] = value.slice(0, 500);
    }
  }
  const defects: { defectId: string; quantity: string }[] = [];
  for (let index = 0; index < 3; index++) {
    const defectId = idOf(formData.get(`d:${index}`));
    const quantity = text(formData, `dq:${index}`, 20);
    if (defectId && quantity.trim() !== "")
      defects.push({ defectId, quantity });
  }
  const photoIds = formData
    .getAll("photos")
    .map((value) => idOf(value))
    .filter(Boolean)
    .slice(0, 10);
  try {
    const result = await decideInspection(who, {
      inspectionId: idOf(fixed.inspectionId),
      idempotencyKey: String(fixed.idempotencyKey ?? "").slice(0, 64),
      outcomes: outcomes.map((each) => ({
        ...each,
        toLocationId: each.toLocationId || null,
      })),
      missing,
      checked: text(formData, "checked", 20),
      answers,
      defects,
      photoIds,
      acceptCapacity: formData.get("acceptCapacity") === "1",
    });
    if (!result.ok) {
      // The service names the lines by position among the filled ones;
      // the form, by state or cause.
      const fieldErrors: Record<string, string> = {};
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        if (!message) continue;
        const outcome = /^outcome\.(\d+)\.(\w+)$/.exec(field);
        const lost = /^missing\.(\d+)\.(\w+)$/.exec(field);
        if (outcome) {
          const row = outcomes[Number(outcome[1])];
          fieldErrors[
            `${outcome[2] === "reason" ? "r" : outcome[2] === "serials" ? "s" : outcome[2] === "toLocationId" ? "l" : "q"}:${row?.status ?? ""}`
          ] = message;
        } else if (lost) {
          const row = missing[Number(lost[1])];
          fieldErrors[
            `${lost[2] === "reason" ? "mr" : lost[2] === "serials" ? "ms" : "mq"}:${row?.cause ?? ""}`
          ] = message;
        } else if (field.startsWith("answer.")) {
          fieldErrors[`a:${field.slice(7)}`] = message;
        } else {
          fieldErrors[field] = message;
        }
      }
      return {
        values,
        error: result.formError,
        fieldErrors,
        overCapacity: result.reason === "over_capacity",
        answers: previous.answers + 1,
      };
    }
    revalidatePath(`/calidad/verificaciones/${idOf(fixed.inspectionId)}`);
    revalidatePath("/inventario/por-inspeccionar");
    return {
      ok: true,
      summary: result.summary,
      values: {},
      answers: previous.answers + 1,
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) {
      return { values, error: message, answers: previous.answers + 1 };
    }
    throw error;
  }
}

/** For a lost answer (INV-22): whether the decision was registered. */
export async function checkInspectionDecisionAction(
  idempotencyKey: string,
): Promise<{ inspectionId: string } | null> {
  const who = await actor();
  try {
    return await findInspectionDecision(
      who,
      String(idempotencyKey ?? "").slice(0, 64),
    );
  } catch (error) {
    if (forbidden(error)) return null;
    throw error;
  }
}

export type CancelInspectionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  answers: number;
};

/** «Cancelar verificación», with its reason. */
export async function cancelInspectionAction(
  inspectionId: string,
  previous: CancelInspectionState,
  formData: FormData,
): Promise<CancelInspectionState> {
  const who = await actor();
  try {
    const result = await cancelInspection(who, {
      inspectionId: idOf(inspectionId),
      reason: text(formData, "reason", 300),
    });
    if (!result.ok) {
      return {
        error: result.formError,
        fieldErrors: result.fieldErrors,
        answers: previous.answers + 1,
      };
    }
    revalidatePath(`/calidad/verificaciones/${idOf(inspectionId)}`);
    revalidatePath("/inventario/por-inspeccionar");
    return { ok: true, answers: previous.answers + 1 };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, answers: previous.answers + 1 };
    throw error;
  }
}

export async function uploadInspectionPhotoAction(
  inspectionId: string,
  formData: FormData,
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const who = await actor();
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No llegó la foto. Tómala otra vez." };
  }
  try {
    return await uploadInspectionPhoto(who, idOf(inspectionId), {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

export async function discardInspectionPhotoAction(
  fileId: string,
): Promise<{ ok: boolean }> {
  const who = await actor();
  try {
    return await discardInspectionPhoto(who, idOf(fileId));
  } catch (error) {
    if (forbidden(error)) return { ok: false };
    throw error;
  }
}
