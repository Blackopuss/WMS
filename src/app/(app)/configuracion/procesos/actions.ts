"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { processDocuments } from "@/modules/registry";
import { saveProcessDraft, type DraftInput } from "@/platform/processes";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Configuring processes (WMS-74, ADR 0069). The person and the company come
 * from the session; the form sends the document and its stages as JSON,
 * which the service validates whole (Zod and the rules of the document).
 */

export type ProcessFormState = {
  ok?: true;
  message?: string;
  error?: string;
  /** Position of the stage the error is about. */
  index?: number;
  answers: number;
};

const MAX_JSON = 100_000;

function stagesOf(formData: FormData): DraftInput | null {
  const raw = String(formData.get("stages") ?? "");
  if (raw.length > MAX_JSON) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return { stages: Array.isArray(parsed) ? parsed : [] } as DraftInput;
  } catch {
    return null;
  }
}

/** Saves the draft and, with `publish`, makes it the version in force. */
export async function saveProcessAction(
  prev: ProcessFormState,
  formData: FormData,
): Promise<ProcessFormState> {
  const { user, organization } = await requireOrganizationContext();
  const actor = { organizationId: organization.id, userId: user.id };
  const answers = prev.answers + 1;
  const documentKey = String(formData.get("documentKey") ?? "").slice(0, 80);
  const draft = stagesOf(formData);
  if (!draft) {
    return {
      error: "No se pudo leer el proceso. Inténtalo de nuevo.",
      answers,
    };
  }
  const publish = formData.get("publish") === "1";
  try {
    // B4: saving and publishing are one transaction, so what is published
    // is exactly what this person saved.
    const saved = await saveProcessDraft(
      actor,
      processDocuments,
      documentKey,
      draft,
      { publish },
    );
    if (!saved.ok) {
      return { error: saved.error, index: saved.index, answers };
    }
    const message = saved.published
      ? `Versión ${saved.number} publicada: la usan los documentos nuevos; los que ya empezaron siguen con la suya.`
      : `Borrador guardado (versión ${saved.number}). Nada cambia hasta que lo publiques.`;
    revalidatePath("/configuracion/procesos");
    return { ok: true, message, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, answers };
    }
    throw error;
  }
}
