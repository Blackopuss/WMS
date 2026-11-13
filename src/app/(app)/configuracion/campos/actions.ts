"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { customFieldReservedLabels } from "@/modules/registry";
import {
  addCustomFieldOption,
  createCustomField,
  isCustomFieldEntity,
  moveCustomField,
  setCustomFieldArchived,
  updateCustomField,
  updateCustomFieldOption,
  type CustomFieldResult,
} from "@/platform/custom-fields";
import { requireOrganizationContext } from "@/platform/tenancy";

/** What a form of the setup screen gets back. */
export type FieldFormState = {
  ok?: true;
  message?: string;
  error?: string;
  /** Field of the form the problem is about. */
  field?: "label" | "type" | "options" | "required";
  /** What was typed, so a refused form keeps it. */
  values?: { label: string; type: string; required: boolean; options: string };
  /** Counts answers: remounts the inputs with what was sent. */
  answers: number;
};

const PATH = "/configuracion/campos";

/**
 * Runs a change with the person and the company of the session (never
 * from the form); the service checks the permission, the module and that
 * the field is the company's.
 */
async function change(
  prev: FieldFormState,
  run: (actor: {
    organizationId: string;
    userId: string;
  }) => Promise<CustomFieldResult>,
  values?: FieldFormState["values"],
): Promise<FieldFormState> {
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

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/** Adds a field to the entity chosen on the screen. */
export async function createFieldAction(
  prev: FieldFormState,
  formData: FormData,
): Promise<FieldFormState> {
  const entity = text(formData, "entity", 20);
  const values = {
    label: text(formData, "label", 200),
    type: text(formData, "type", 20),
    required: formData.get("required") === "1",
    options: text(formData, "options", 5_000),
  };
  if (!isCustomFieldEntity(entity)) {
    return {
      error: "Elige a qué le agregas el campo.",
      answers: prev.answers + 1,
    };
  }
  return change(
    prev,
    (actor) =>
      createCustomField(actor, entity, values, {
        reservedLabels: customFieldReservedLabels,
      }),
    values,
  );
}

/** Renames a field or changes whether it is required. Id bound by the page. */
export async function updateFieldAction(
  fieldId: string,
  prev: FieldFormState,
  formData: FormData,
): Promise<FieldFormState> {
  const values = {
    label: text(formData, "label", 200),
    type: "",
    required: formData.get("required") === "1",
    options: "",
  };
  return change(
    prev,
    (actor) =>
      updateCustomField(
        actor,
        String(fieldId),
        { label: values.label, required: values.required },
        { reservedLabels: customFieldReservedLabels },
      ),
    values,
  );
}

/** Archives a field or brings it back. Id and choice bound by the page. */
export async function fieldStatusAction(
  fieldId: string,
  archived: boolean,
  prev: FieldFormState,
): Promise<FieldFormState> {
  return change(prev, (actor) =>
    setCustomFieldArchived(actor, String(fieldId), archived === true),
  );
}

/** Moves a field up or down. Id and direction bound by the page. */
export async function moveFieldAction(
  fieldId: string,
  direction: "up" | "down",
  prev: FieldFormState,
): Promise<FieldFormState> {
  return change(prev, (actor) =>
    moveCustomField(actor, String(fieldId), direction === "up" ? "up" : "down"),
  );
}

/** Adds an option to a list field. Id bound by the page. */
export async function addOptionAction(
  fieldId: string,
  prev: FieldFormState,
  formData: FormData,
): Promise<FieldFormState> {
  const label = text(formData, "label", 200);
  return change(
    prev,
    (actor) => addCustomFieldOption(actor, String(fieldId), label),
    { label, type: "", required: false, options: "" },
  );
}

/** Renames an option. Id bound by the page. */
export async function renameOptionAction(
  optionId: string,
  prev: FieldFormState,
  formData: FormData,
): Promise<FieldFormState> {
  const label = text(formData, "label", 200);
  return change(
    prev,
    (actor) => updateCustomFieldOption(actor, String(optionId), { label }),
    { label, type: "", required: false, options: "" },
  );
}

/** Archives an option or brings it back. Id and choice bound by the page. */
export async function optionStatusAction(
  optionId: string,
  archived: boolean,
  prev: FieldFormState,
): Promise<FieldFormState> {
  return change(prev, (actor) =>
    updateCustomFieldOption(actor, String(optionId), {
      archived: archived === true,
    }),
  );
}
