"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import {
  addPlanPoint,
  discardPlanDraft,
  publishPlanDraft,
  removePlanPoint,
  startPlanDraft,
  updatePlanDraft,
  type PlanField,
  type PlanResult,
} from "@/modules/quality";
import { requireOrganizationContext } from "@/platform/tenancy";

/** What a form of the inspection plan gets back. */
export type PlanFormState = {
  ok?: true;
  message?: string;
  error?: string;
  field?: PlanField;
  /** What was typed, so a refused form keeps it. */
  values?: Record<string, string>;
  /** Counts answers: remounts the inputs with what was sent. */
  answers: number;
};

/**
 * Runs a change with the person and the company of the session (never
 * from the form); the service checks the permission, the module and that
 * the plan and the product are the company's.
 */
async function change(
  productId: string,
  prev: PlanFormState,
  run: (actor: {
    organizationId: string;
    userId: string;
  }) => Promise<PlanResult>,
  values?: Record<string, string>,
): Promise<PlanFormState> {
  const { user, organization } = await requireOrganizationContext();
  const answers = prev.answers + 1;
  try {
    const result = await run({
      organizationId: organization.id,
      userId: user.id,
    });
    if (!result.ok) {
      return { error: result.error, field: result.field, values, answers };
    }
    revalidatePath(`/inventario/${encodeURIComponent(productId)}`, "layout");
    return { ok: true, message: result.message, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
}

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/** Opens the draft of the next version of the plan of a product. */
export async function startDraftAction(
  productId: string,
  prev: PlanFormState,
): Promise<PlanFormState> {
  return change(productId, prev, (actor) =>
    startPlanDraft(actor, String(productId)),
  );
}

/** How the quality is checked and what the draft applies to. */
export async function updateDraftAction(
  productId: string,
  versionId: string,
  prev: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const values = {
    sampling: text(formData, "sampling", 20),
    sampleRule: text(formData, "sampleRule", 20),
    sampleQuantity: text(formData, "sampleQuantity", 40),
    samplePercent: text(formData, "samplePercent", 10),
    sampleMin: text(formData, "sampleMin", 40),
    sampleMax: text(formData, "sampleMax", 40),
    forProduced: formData.get("forProduced") === "1" ? "1" : "",
    forReceived: formData.get("forReceived") === "1" ? "1" : "",
    forReturned: formData.get("forReturned") === "1" ? "1" : "",
  };
  return change(
    productId,
    prev,
    (actor) =>
      updatePlanDraft(actor, String(versionId), {
        ...values,
        forProduced: values.forProduced === "1",
        forReceived: values.forReceived === "1",
        forReturned: values.forReturned === "1",
      }),
    values,
  );
}

/** Adds a check point to the draft. */
export async function addPointAction(
  productId: string,
  versionId: string,
  prev: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const values = {
    label: text(formData, "label", 200),
    kind: text(formData, "kind", 20),
    required: formData.get("required") === "1" ? "1" : "",
    photo: formData.get("photo") === "1" ? "1" : "",
    minValue: text(formData, "minValue", 40),
    maxValue: text(formData, "maxValue", 40),
    unitLabel: text(formData, "unitLabel", 60),
    passOptions: text(formData, "passOptions", 3_000),
    failOptions: text(formData, "failOptions", 3_000),
  };
  return change(
    productId,
    prev,
    (actor) =>
      addPlanPoint(actor, String(versionId), {
        ...values,
        required: values.required === "1",
        photo: values.photo === "1",
      }),
    values,
  );
}

/** Takes a point out of the draft. */
export async function removePointAction(
  productId: string,
  pointId: string,
  prev: PlanFormState,
): Promise<PlanFormState> {
  return change(productId, prev, (actor) =>
    removePlanPoint(actor, String(pointId)),
  );
}

/** Publishes the draft as the plan in force. */
export async function publishDraftAction(
  productId: string,
  versionId: string,
  prev: PlanFormState,
): Promise<PlanFormState> {
  return change(productId, prev, (actor) =>
    publishPlanDraft(actor, String(versionId)),
  );
}

/** Drops the draft (it stays as discarded). */
export async function discardDraftAction(
  productId: string,
  versionId: string,
  prev: PlanFormState,
): Promise<PlanFormState> {
  return change(productId, prev, (actor) =>
    discardPlanDraft(actor, String(versionId)),
  );
}
