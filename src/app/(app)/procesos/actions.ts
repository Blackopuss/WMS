"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { isAppError, isInternalHref } from "@/lib";
import { processDocuments } from "@/modules/registry";
import {
  assignStage,
  backStage,
  completeStage,
  discardProcessPhoto,
  releaseStage,
  skipStage,
  takeStage,
  uploadProcessPhoto,
  type ProcessPhotoResult,
  type StageActionResult,
} from "@/platform/processes";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Actions on the stages of a process (WMS-74, ADR 0069). The person and the
 * company come from the session; the form only says which stage, what it
 * wants to do and what was typed. The engine checks the area, the scope,
 * the module and the lock between stages under the lock of the process.
 */

const idPath = (value: unknown) =>
  String(value ?? "")
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

export type StageFormState = {
  ok?: true;
  message?: string;
  error?: string;
  field?: "note" | "quantity" | "photos" | "reason" | "assignee";
  /** What was typed, so a refused form keeps it. */
  values?: { note: string; quantity: string; reason: string };
  /** Counts answers: remounts the inputs with what was sent. */
  answers: number;
};

const INTENTS = [
  "complete",
  "take",
  "release",
  "skip",
  "back",
  "assign",
] as const;
type Intent = (typeof INTENTS)[number];

/** One form for every action on a stage: `intent` says which. */
export async function stageAction(
  prev: StageFormState,
  formData: FormData,
): Promise<StageFormState> {
  const who = await actor();
  const answers = prev.answers + 1;
  const intent = text(formData, "intent", 20) as Intent;
  const progressId = idPath(formData.get("progressId"));
  const values = {
    note: text(formData, "note", 600),
    quantity: text(formData, "quantity", 30),
    reason: text(formData, "reason", 600),
  };
  if (!INTENTS.includes(intent)) {
    return { error: "No se pudo. Vuelve a abrir la pantalla.", answers };
  }
  const base = {
    stateId: idPath(formData.get("stateId")),
    idempotencyKey: idPath(formData.get("idempotencyKey")) || null,
    userAgent: (await headers()).get("user-agent"),
    installed: formData.get("installed") === "1",
  };
  let result: StageActionResult;
  try {
    switch (intent) {
      case "complete":
        result = await completeStage(who, processDocuments, {
          ...base,
          note: values.note,
          quantity: values.quantity,
          photoIds: formData.getAll("photoIds").map(idPath).filter(Boolean),
        });
        break;
      case "take":
        result = await takeStage(who, processDocuments, base);
        break;
      case "release":
        result = await releaseStage(who, processDocuments, base);
        break;
      case "skip":
        result = await skipStage(who, processDocuments, {
          ...base,
          reason: values.reason,
        });
        break;
      case "back":
        result = await backStage(who, processDocuments, {
          ...base,
          reason: values.reason,
        });
        break;
      case "assign":
        result = await assignStage(who, processDocuments, {
          ...base,
          assigneeUserId: idPath(formData.get("assigneeUserId")),
        });
        break;
    }
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok) {
    return { error: result.error, field: result.field, values, answers };
  }
  revalidatePath(`/procesos/${progressId}`);
  revalidatePath("/tareas");
  // WMS-74B: the panel also lives in the screen of its document; the
  // engine says which (never the form).
  if (result.documentHref && isInternalHref(result.documentHref)) {
    revalidatePath(result.documentHref.split("?")[0]!);
  }
  return { ok: true, message: result.message, answers };
}

/**
 * A photo taken to complete a stage (WMS-37): checked and kept unlinked,
 * for the person only, until the stage is completed. Only for a stage the
 * person may do now (the engine checks it).
 */
export async function uploadProcessPhotoAction(
  stateId: string,
  formData: FormData,
): Promise<ProcessPhotoResult> {
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No llegó la foto. Tómala otra vez." };
  }
  try {
    return await uploadProcessPhoto(await actor(), processDocuments, {
      stateId: idPath(stateId),
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** «Quitar» a photo taken and not used: only the person's, unlinked. */
export async function discardProcessPhotoAction(
  fileId: string,
): Promise<{ ok: boolean }> {
  return discardProcessPhoto(await actor(), idPath(fileId));
}
