"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAccess } from "@/platform/authorization";
import {
  previewCode,
  previewQuote,
  startCheckout,
  type CheckoutField,
} from "@/platform/billing";

import { quoteTable, showQuote, type ShownQuote } from "./quotes";

export type CheckoutValues = {
  tier: string;
  months: string;
  /** Add-ons chosen on top of Inventario. */
  modules: string[];
  /** People added on top of the tier's, as typed (BIL-11). */
  extraUsers: string;
  code: string;
};

export type CheckoutState = {
  fieldErrors: Partial<Record<CheckoutField, string>>;
  formError?: string;
  /** What was chosen, so a rejected form keeps it (React resets forms). */
  values?: CheckoutValues;
  /** A code that applies: its discount priced for every combination. */
  applied?: {
    code: string;
    percentOff: number;
    quotes: Record<string, ShownQuote>;
    /** Signed by the server: prices other choices with this code. */
    token: string;
  };
  /** Counts answers: remounts the choices with the values above. */
  answers: number;
};

/**
 * «Aplicar» a code (`intent=apply`) or pay (any other submit). The actor
 * and the email for the receipt come from the session; the service checks
 * the titular and prices everything again.
 */
export async function checkoutAction(
  prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const access = await getAccess();
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const values: CheckoutValues = {
    tier: String(formData.get("tier") ?? ""),
    months: String(formData.get("months") ?? ""),
    modules: formData
      .getAll("modules")
      .slice(0, 10)
      .map((value) => String(value).slice(0, 20)),
    extraUsers: String(formData.get("extraUsers") ?? "").slice(0, 10),
    code: String(formData.get("code") ?? ""),
  };
  const answers = prev.answers + 1;

  if (formData.get("intent") === "apply") {
    const result = await previewCode(actor, values, await headers());
    if (!result.ok) {
      return {
        fieldErrors: result.fieldErrors,
        formError: result.formError,
        values,
        answers,
      };
    }
    return {
      fieldErrors: {},
      values: { ...values, code: result.code },
      applied: {
        code: result.code,
        percentOff: result.percentOff,
        quotes: quoteTable(result.percentOff, result.carry),
        token: result.codeToken,
      },
      answers,
    };
  }

  const result = await startCheckout(
    actor,
    { ...values, provider: String(formData.get("provider") ?? "") },
    await headers(),
    access.user.email,
  );
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      values,
      // The code was not the problem: keep showing its discount.
      applied: result.fieldErrors.code ? undefined : prev.applied,
      answers,
    };
  }
  redirect(result.next);
}

/**
 * The price of a choice with people added (BIL-11), asked while choosing.
 * The discount of a code only through the token the server signed when it
 * was applied. Null when the choice is not valid (the form says why).
 */
export async function quoteAction(
  values: CheckoutValues,
  codeToken: string,
): Promise<ShownQuote | null> {
  const access = await getAccess();
  const result = await previewQuote(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      tier: String(values.tier ?? ""),
      months: String(values.months ?? ""),
      modules: Array.isArray(values.modules)
        ? values.modules.slice(0, 10).map((value) => String(value).slice(0, 20))
        : [],
      extraUsers: String(values.extraUsers ?? "").slice(0, 10),
      code: String(values.code ?? "").slice(0, 60),
    },
    String(codeToken ?? "").slice(0, 200),
  );
  return result.ok ? showQuote(result.quote) : null;
}
