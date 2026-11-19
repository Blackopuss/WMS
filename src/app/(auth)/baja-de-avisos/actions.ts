"use server";

import { headers } from "next/headers";

import { unsubscribeFromNoticeEmails } from "@/platform/notifications";

export type UnsubscribeFormState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "error"; message: string };

/**
 * Stops every notice by mail of the person of the link (WMS-88, ADR
 * 0084). No session: the link is the only thing that says who; the
 * service limits attempts per IP before checking it.
 */
export async function unsubscribeAction(
  _prev: UnsubscribeFormState,
  formData: FormData,
): Promise<UnsubscribeFormState> {
  const result = await unsubscribeFromNoticeEmails(
    String(formData.get("token") ?? ""),
    await headers(),
  );
  return result.ok
    ? { status: "done" }
    : { status: "error", message: result.message };
}
