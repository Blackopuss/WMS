"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import { automationCatalog } from "@/modules/registry";
import {
  archiveAutomationRule,
  createAutomationRule,
  setAutomationRuleOn,
  updateAutomationRule,
  type DefinitionErrors,
} from "@/platform/automations";
import { requireOrganizationContext } from "@/platform/tenancy";

export type AutomationFormState = {
  error?: string;
  errors?: DefinitionErrors;
  /** Counts answers: remounts the form with what was sent. */
  answers: number;
  /** What was sent, kept when it is refused. */
  definition?: string;
};

/** The definition the form sends, read as plain data (never more than 20 KB). */
function definitionOf(formData: FormData): {
  raw: string;
  input: Record<string, unknown>;
} {
  const raw = String(formData.get("definition") ?? "").slice(0, 20_000);
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const input =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { raw, input: { ...input, name: formData.get("name") ?? "" } };
}

const idPath = (value: unknown) =>
  String(value ?? "")
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

function refused(error: unknown, answers: number, definition: string) {
  if (isAppError(error) && error.kind === "forbidden") {
    return { error: error.message, answers, definition };
  }
  throw error;
}

/**
 * Creates or changes a rule (WMS-64, ADR 0092). Person and company come
 * from the session; the service checks the permission, that the person
 * sees the whole company and every choice against the catalog.
 */
export async function saveAutomationAction(
  prev: AutomationFormState,
  formData: FormData,
): Promise<AutomationFormState> {
  const { user, organization } = await requireOrganizationContext();
  const actor = { organizationId: organization.id, userId: user.id };
  const answers = prev.answers + 1;
  const { raw, input } = definitionOf(formData);
  const ruleId = idPath(formData.get("ruleId"));
  let id: string;
  try {
    const result = ruleId
      ? await updateAutomationRule(actor, ruleId, input, automationCatalog)
      : await createAutomationRule(actor, input, automationCatalog);
    if (!result.ok) {
      return {
        error:
          result.error ??
          (result.reason === "not_found"
            ? "Esta automatización ya no existe."
            : undefined),
        errors: result.errors,
        answers,
        definition: raw,
      };
    }
    id = result.id;
  } catch (error) {
    return refused(error, answers, raw);
  }
  revalidatePath("/configuracion/automatizaciones");
  redirect(`/configuracion/automatizaciones/${idPath(id)}`);
}

export type RuleStateForm = { error?: string; answers: number };

/** Turns a rule on or off, or archives it. */
export async function changeAutomationAction(
  prev: RuleStateForm,
  formData: FormData,
): Promise<RuleStateForm> {
  const { user, organization } = await requireOrganizationContext();
  const actor = { organizationId: organization.id, userId: user.id };
  const answers = prev.answers + 1;
  const ruleId = idPath(formData.get("ruleId"));
  const change = String(formData.get("change") ?? "");
  try {
    const result =
      change === "archive"
        ? await archiveAutomationRule(actor, ruleId)
        : await setAutomationRuleOn(
            actor,
            ruleId,
            change === "on",
            automationCatalog,
          );
    if (!result.ok) {
      return {
        error:
          result.error ??
          (result.reason === "not_found"
            ? "Esta automatización ya no existe."
            : "No se pudo cambiar."),
        answers,
      };
    }
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, answers };
    }
    throw error;
  }
  revalidatePath("/configuracion/automatizaciones");
  revalidatePath(`/configuracion/automatizaciones/${ruleId}`);
  return { answers };
}
