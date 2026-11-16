"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import {
  createDefect,
  setDefectArchived,
  updateDefect,
  type DefectResult,
} from "@/modules/quality";
import { requireOrganizationContext } from "@/platform/tenancy";

/** What a form of the defects screen gets back. */
export type DefectFormState = {
  ok?: true;
  message?: string;
  error?: string;
  field?: "name" | "severity";
  /** What was typed, so a refused form keeps it. */
  values?: { name: string; severity: string };
  /** Counts answers: remounts the inputs with what was sent. */
  answers: number;
};

const PATH = "/configuracion/defectos";

/**
 * Runs a change with the person and the company of the session (never
 * from the form); the service checks the permission, the module and that
 * the defect is the company's.
 */
async function change(
  prev: DefectFormState,
  run: (actor: {
    organizationId: string;
    userId: string;
  }) => Promise<DefectResult>,
  values?: DefectFormState["values"],
): Promise<DefectFormState> {
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
    revalidatePath(PATH);
    return { ok: true, message: result.message, answers };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
}

const valuesOf = (formData: FormData) => ({
  name: String(formData.get("name") ?? "").slice(0, 200),
  severity: String(formData.get("severity") ?? "").slice(0, 20),
});

/** Adds a defect to the list of the company. */
export async function createDefectAction(
  prev: DefectFormState,
  formData: FormData,
): Promise<DefectFormState> {
  const values = valuesOf(formData);
  return change(prev, (actor) => createDefect(actor, values), values);
}

/** Renames a defect or changes its severity. */
export async function updateDefectAction(
  defectId: string,
  prev: DefectFormState,
  formData: FormData,
): Promise<DefectFormState> {
  const values = valuesOf(formData);
  return change(
    prev,
    (actor) => updateDefect(actor, String(defectId), values),
    values,
  );
}

/** Archives a defect or brings it back. */
export async function setDefectArchivedAction(
  defectId: string,
  archived: boolean,
  prev: DefectFormState,
): Promise<DefectFormState> {
  return change(prev, (actor) =>
    setDefectArchived(actor, String(defectId), archived === true),
  );
}
