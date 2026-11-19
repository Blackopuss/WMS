"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { isAppError } from "@/lib";
import {
  discardReportPhoto,
  findProductionReportByKey,
  reportMaterialScrap,
  reportProduction,
  reverseProductionReport,
  saveLotNumbering,
  uploadReportPhoto,
  warnMaterialShortage,
  type LotNumberingInput,
  type ProductionReportField,
  type ProductionShortageLine,
  type ScrapField,
} from "@/modules/production";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Production reports, scrap and lot numbering (WMS-29, ADR 0087). Person
 * and company always come from the session; the services look for the
 * order and its lines only in that company and the person's scope, and
 * check the permission again.
 */

const idOf = (value: unknown) => String(value ?? "").slice(0, 36);
const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

/** Per line or output: the fields `prefix:<id>` of the form. */
function byId(formData: FormData, prefix: string, max: number) {
  const result: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(prefix)) continue;
    const id = idOf(name.slice(prefix.length));
    if (id) result[id] = String(value).slice(0, max);
  }
  return result;
}

export type ReportFormValues = {
  good: string;
  bad: string;
  badReason: string;
  materialSerials: Record<string, string>;
  outputSerials: Record<string, string>;
  outputExpiry: Record<string, string>;
};

export type ReportFormState = {
  ok?: boolean;
  summary?: string;
  reportId?: string;
  error?: string;
  fieldErrors?: Partial<Record<ProductionReportField, string>>;
  shortages?: ProductionShortageLine[];
  fitsText?: string;
  values: ReportFormValues;
  answers: number;
};

/** «Guardar reporte»: the key of the confirmation is fixed by the page. */
export async function reportProductionAction(
  target: { orderId: string; idempotencyKey: string },
  previous: ReportFormState,
  formData: FormData,
): Promise<ReportFormState> {
  const who = await actor();
  const values: ReportFormValues = {
    good: text(formData, "good", 20),
    bad: text(formData, "bad", 20),
    badReason: text(formData, "badReason", 400),
    materialSerials: byId(formData, "material:", 20000),
    outputSerials: byId(formData, "output:", 20000),
    outputExpiry: byId(formData, "expiry:", 20),
  };
  const photoIds = formData
    .getAll("photoIds")
    .slice(0, 5)
    .map((value) => idOf(value));
  const answers = previous.answers + 1;
  try {
    const result = await reportProduction(who, idOf(target.orderId), {
      ...values,
      idempotencyKey: String(target.idempotencyKey ?? "").slice(0, 64),
      photoIds,
    });
    if (!result.ok) {
      return {
        error:
          result.formError ??
          (result.fieldErrors ? "Revisa lo que falta." : undefined),
        fieldErrors: result.fieldErrors,
        shortages: result.shortages,
        fitsText: result.fitsText,
        values,
        answers,
      };
    }
    revalidatePath(`/produccion/${idOf(target.orderId)}`);
    return {
      ok: true,
      summary: result.summary,
      reportId: result.reportId,
      values,
      answers,
    };
  } catch (error) {
    unstable_rethrow(error);
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
}

/** Whether a report reached the server although its answer was lost. */
export async function checkReportAction(
  idempotencyKey: string,
): Promise<{ reportId: string } | null> {
  const who = await actor();
  try {
    return await findProductionReportByKey(
      who,
      String(idempotencyKey ?? "").slice(0, 64),
    );
  } catch (error) {
    if (forbidden(error)) return null;
    throw error;
  }
}

export async function uploadReportPhotoAction(
  formData: FormData,
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const who = await actor();
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No llegó la foto. Tómala otra vez." };
  }
  try {
    return await uploadReportPhoto(who, {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

export async function discardReportPhotoAction(
  fileId: string,
): Promise<{ ok: boolean }> {
  const who = await actor();
  try {
    return await discardReportPhoto(who, idOf(fileId));
  } catch (error) {
    if (forbidden(error)) return { ok: false };
    throw error;
  }
}

export type StepAnswer =
  { ok: true; summary: string } | { ok: false; error: string };

/** «Revertir reporte», with its reason. */
export async function reverseReportAction(
  reportId: string,
  reason: string,
): Promise<StepAnswer> {
  const who = await actor();
  try {
    const result = await reverseProductionReport(
      who,
      idOf(reportId),
      String(reason ?? "").slice(0, 400),
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo revertir.",
      };
    }
    revalidatePath(`/produccion/reportes/${idOf(reportId)}`);
    return { ok: true, summary: result.summary };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

/** «Avisar que falta material». */
export async function warnShortageAction(orderId: string): Promise<StepAnswer> {
  const who = await actor();
  try {
    const result = await warnMaterialShortage(who, idOf(orderId));
    return result.ok ? result : { ok: false, error: result.formError };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

export type ScrapFormState = {
  ok?: boolean;
  summary?: string;
  pending?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<ScrapField, string>>;
  values: {
    orderLineId: string;
    quantity: string;
    reason: string;
    serials: string;
  };
  answers: number;
};

/** «Reportar merma de material»: the key is fixed by the page. */
export async function reportScrapAction(
  target: { orderId: string; idempotencyKey: string },
  previous: ScrapFormState,
  formData: FormData,
): Promise<ScrapFormState> {
  const who = await actor();
  const values = {
    orderLineId: idOf(formData.get("orderLineId")),
    quantity: text(formData, "quantity", 20),
    reason: text(formData, "reason", 600),
    serials: text(formData, "serials", 20000),
  };
  const answers = previous.answers + 1;
  try {
    const result = await reportMaterialScrap(who, idOf(target.orderId), {
      ...values,
      serials: values.serials || undefined,
      idempotencyKey: String(target.idempotencyKey ?? "").slice(0, 64),
    });
    if (result.ok) {
      revalidatePath(`/produccion/${idOf(target.orderId)}`);
      return { ok: true, summary: result.summary, values, answers };
    }
    if (result.reason === "pending_approval") {
      return { pending: true, summary: result.formError, values, answers };
    }
    return {
      error:
        result.formError ??
        (result.fieldErrors ? "Revisa lo que falta." : undefined),
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
}

export type LotNumberingFormState = {
  ok?: boolean;
  summary?: string;
  error?: string;
  fieldErrors?: Partial<Record<keyof LotNumberingInput, string>>;
  values: LotNumberingInput;
  answers: number;
};

/** Configuración › «Lotes de lo producido». */
export async function saveLotNumberingAction(
  previous: LotNumberingFormState,
  formData: FormData,
): Promise<LotNumberingFormState> {
  const who = await actor();
  const values = {
    prefix: text(formData, "prefix", 20),
    dateFormat: text(
      formData,
      "dateFormat",
      10,
    ) as LotNumberingInput["dateFormat"],
    digits: text(formData, "digits", 2),
    resetEvery: text(
      formData,
      "resetEvery",
      10,
    ) as LotNumberingInput["resetEvery"],
    sequenceScope: text(
      formData,
      "sequenceScope",
      10,
    ) as LotNumberingInput["sequenceScope"],
  };
  const answers = previous.answers + 1;
  try {
    const result = await saveLotNumbering(who, values);
    if (!result.ok) {
      return {
        error: result.formError ?? "Revisa lo que falta.",
        fieldErrors: result.fieldErrors,
        values,
        answers,
      };
    }
    revalidatePath("/configuracion/lotes-de-produccion");
    return { ok: true, summary: result.summary, values, answers };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
}
