"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  TERMINAL_PASSWORD_PATH,
  safeRedirectPath,
  verifySignInCode,
} from "@/platform/auth";

export type CodeFormState = { error?: string; restart?: boolean };

export async function verifyCodeAction(
  _prev: CodeFormState,
  formData: FormData,
): Promise<CodeFormState> {
  const next = safeRedirectPath(formData.get("siguiente"));
  const result = await verifySignInCode(
    {
      code: String(formData.get("code") ?? ""),
      method: formData.get("method") === "backup" ? "backup" : "totp",
    },
    await headers(),
  );
  if (result.ok) redirect(next);
  if (result.reason === "terminal") redirect(TERMINAL_PASSWORD_PATH);
  return { error: result.error, restart: result.reason === "restart" };
}
