"use server";

import { redirect } from "next/navigation";

import { DEMO_DATASET_KEYS, moduleRegistry } from "@/modules/registry";
import {
  createDemoCompany,
  previewDemoAccount,
  requirePlatformStaff,
  type DemoField,
} from "@/platform/billing";

export type DemoState = {
  fieldErrors: Partial<Record<DemoField, string>>;
  formError?: string;
  /** What was typed, so a refused form keeps it (React resets forms). */
  values?: { email: string; name: string };
  /**
   * The account found for the email (first step): the form asks to
   * confirm with its name before anything is created.
   */
  confirm?: { name: string; email: string };
};

/**
 * Creates a demonstration company (WMS-44), in two steps: the first submit
 * shows the account found for the email, the second creates it. The staff member comes from
 * the session and the service checks again that they are platform staff;
 * the account is looked up by the email typed, and the data set must be
 * one of the known ones.
 */
export async function createDemoAction(
  _prev: DemoState,
  formData: FormData,
): Promise<DemoState> {
  const staff = await requirePlatformStaff();
  const values = {
    email: String(formData.get("email") ?? ""),
    name: String(formData.get("name") ?? ""),
  };
  // Step one: show whose account this is. Only a second submit with the
  // same email (as the server normalizes it) creates the company; the
  // service checks the account again under its lock either way.
  const typed = values.email.trim().toLowerCase();
  const confirmed = String(formData.get("confirmedEmail") ?? "");
  if (formData.get("confirm") !== "1" || confirmed !== typed) {
    const preview = await previewDemoAccount(staff.userId, {
      email: values.email,
    });
    if (!preview.ok) return { fieldErrors: preview.fieldErrors, values };
    return {
      fieldErrors: {},
      values,
      confirm: { name: preview.name, email: preview.email },
    };
  }
  const result = await createDemoCompany(
    moduleRegistry,
    staff.userId,
    { ...values, dataset: String(formData.get("dataset") ?? "generic") },
    { datasets: DEMO_DATASET_KEYS },
  );
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      values,
    };
  }
  redirect(`/interno/demostraciones/${result.organizationId}`);
}
