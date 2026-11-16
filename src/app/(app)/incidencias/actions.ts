"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  addIncidentNote,
  dismissIncident,
  reportIncident,
  resolveIncident,
  startIncident,
  type IncidentField,
  type IncidentResult,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Incidents (WMS-39, ADR 0057). Person and company always come from the
 * session; the services find the incident, its location and its product
 * only in that company and within the person's scope, and check the
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

export type ReportValues = {
  kind: string;
  description: string;
  location: string;
  product: string;
  /** WMS-42: the code of a piece of equipment, when the warehouse has any. */
  equipment: string;
};

export type ReportState = {
  error?: string;
  fieldErrors?: Partial<Record<IncidentField, string>>;
  values: ReportValues;
  answers: number;
};

/**
 * «Reportar un problema». The task and the order it is about (if any) are
 * bound by the page; the confirmation key comes painted by the server.
 */
export async function reportIncidentAction(
  bound: { taskId: string | null; orderId: string | null },
  previous: ReportState,
  formData: FormData,
): Promise<ReportState> {
  const values: ReportValues = {
    kind: text(formData, "kind", 40),
    description: text(formData, "description", 2000),
    location: text(formData, "location", 200),
    product: text(formData, "product", 80),
    equipment: text(formData, "equipment", 60),
  };
  let result: IncidentResult;
  try {
    result = await reportIncident(await actor(), {
      ...values,
      taskId: bound.taskId ? idPath(bound.taskId) : null,
      orderId: bound.orderId ? idPath(bound.orderId) : null,
      idempotencyKey: text(formData, "idempotencyKey", 64),
    });
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values, answers: previous.answers + 1 };
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers: previous.answers + 1,
    };
  }
  revalidatePath("/incidencias");
  redirect(`/incidencias/${idPath(result.incidentId)}?reportada=1`);
}

export type StepState = {
  ok?: true;
  message?: string;
  error?: string;
  /** What was typed, kept when it is refused. */
  text?: string;
  answers: number;
};

type Step = "start" | "resolve" | "dismiss" | "note";

/**
 * The next step of an incident: attend it, resolve it, dismiss it or add a
 * note. The incident id is bound by the page.
 */
export async function incidentStepAction(
  bound: { incidentId: string; step: Step },
  previous: StepState,
  formData: FormData,
): Promise<StepState> {
  const id = idPath(bound.incidentId);
  const typed = text(formData, "text", 2000);
  const who = await actor();
  let result: IncidentResult;
  try {
    result =
      bound.step === "start"
        ? await startIncident(who, id)
        : bound.step === "resolve"
          ? await resolveIncident(who, id, { resolution: typed })
          : bound.step === "dismiss"
            ? await dismissIncident(who, id, { reason: typed })
            : await addIncidentNote(who, id, { text: typed });
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, text: typed, answers: previous.answers + 1 };
  }
  revalidatePath("/incidencias");
  revalidatePath(`/incidencias/${id}`);
  if (!result.ok) {
    return {
      error:
        result.fieldErrors?.resolution ??
        result.fieldErrors?.note ??
        result.formError ??
        "No se pudo. Inténtalo de nuevo.",
      text: typed,
      answers: previous.answers + 1,
    };
  }
  return { ok: true, message: result.summary, answers: previous.answers + 1 };
}
