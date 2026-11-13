"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  removeReplenishmentRule,
  replenishNow,
  saveReplenishmentRule,
  type ReplenishmentField,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Replenishment of picking locations (WMS-23/24). Person, company,
 * warehouse and zones come from the session; the rule, product and
 * location are looked for only inside that company by the service, which
 * checks the permission again.
 */

export type RuleFormState = {
  error?: string;
  fieldErrors?: Partial<Record<ReplenishmentField, string>>;
  values: {
    productCode: string;
    locationId: string;
    minQuantity: string;
    maxQuantity: string;
    multiple: string;
  };
  /** Bumped on every answer, so the select shows what was sent. */
  answers: number;
};

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/**
 * Creates a rule (`ruleId` empty) or changes the quantities of one (bound
 * by the page).
 */
export async function saveRuleAction(
  ruleId: string | null,
  previous: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    productCode: text(formData, "productCode", 80),
    locationId: text(formData, "locationId", 36),
    minQuantity: text(formData, "minQuantity", 40),
    maxQuantity: text(formData, "maxQuantity", 40),
    multiple: text(formData, "multiple", 40),
  };
  let result;
  try {
    result = await saveReplenishmentRule(
      { organizationId: organization.id, userId: user.id },
      {
        ...values,
        ruleId: ruleId ? String(ruleId).slice(0, 36) : undefined,
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers: previous.answers + 1 };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers: previous.answers + 1,
    };
  }
  revalidatePath("/inventario/reposicion");
  redirect("/inventario/reposicion?guardada=1");
}

export type RuleActionState =
  { ok: true; summary: string } | { ok: false; error: string } | null;

/** Removes a rule (bound by the page); its open tasks stay. */
export async function removeRuleAction(
  ruleId: string,
): Promise<RuleActionState> {
  const { user, organization } = await requireOrganizationContext();
  let result;
  try {
    result = await removeReplenishmentRule(
      { organizationId: organization.id, userId: user.id },
      String(ruleId ?? "").slice(0, 36),
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  if (!result.ok) {
    return { ok: false, error: result.formError ?? "No se pudo quitar." };
  }
  revalidatePath("/inventario/reposicion");
  redirect("/inventario/reposicion?quitada=1");
}

/**
 * «Reponer ahora» (WMS-24): receives nothing. The same as the round, for
 * the warehouse and zones of the session's person.
 */
export async function replenishNowAction(): Promise<RuleActionState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await replenishNow({
      organizationId: organization.id,
      userId: user.id,
    });
    if (!result.ok) return { ok: false, error: result.formError };
    revalidatePath("/inventario/reposicion");
    revalidatePath("/tareas");
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
