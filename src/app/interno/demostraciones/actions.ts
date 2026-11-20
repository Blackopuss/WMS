"use server";

import { redirect } from "next/navigation";

import { DEMO_DATASET_KEYS, moduleRegistry } from "@/modules/registry";
import {
  createDemoCompany,
  requirePlatformStaff,
  type DemoField,
} from "@/platform/billing";

export type DemoState = {
  fieldErrors: Partial<Record<DemoField, string>>;
  formError?: string;
  /** What was typed, so a refused form keeps it (React resets forms). */
  values?: { email: string; name: string };
};

/**
 * Creates a demonstration company (WMS-44). The staff member comes from
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
