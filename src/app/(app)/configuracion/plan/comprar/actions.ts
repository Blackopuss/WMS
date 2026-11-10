"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAccess } from "@/platform/authorization";
import {
  previewCode,
  priceChoice,
  startCheckout,
  type CheckoutField,
} from "@/platform/billing";

import { quoteTable, showQuote, type ShownQuote } from "./quotes";

export type CheckoutValues = {
  tier: string;
  months: string;
  /** Add-ons chosen on top of Inventario. */
  modules: string[];
  /** Additional users, as typed (BIL-11). */
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
 * The price of the choice with additional users (BIL-11), asked while the
 * titular types: the table the page carries only has the plans without
 * them. The service checks the titular and prices on the server; the
 * discount is the one `previewCode` gave the page and only changes what is
 * shown (paying checks the code again).
 */
export async function priceChoiceAction(
  values: Omit<CheckoutValues, "code">,
  percentOff: number,
): Promise<{ quote: ShownQuote } | { error: string }> {
  const access = await getAccess();
  const result = await priceChoice(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      tier: String(values.tier ?? "").slice(0, 20),
      months: String(values.months ?? "").slice(0, 5),
      modules: (Array.isArray(values.modules) ? values.modules : [])
        .slice(0, 10)
        .map((value) => String(value).slice(0, 20)),
      extraUsers: String(values.extraUsers ?? "").slice(0, 10),
    },
    Number(percentOff),
  );
  if (!result.ok) {
    return {
      error:
        result.fieldErrors.extraUsers ??
        result.fieldErrors.months ??
        result.formError ??
        "No pudimos calcular el precio. Revisa lo que elegiste.",
    };
  }
  return { quote: showQuote(result.quote) };
}
