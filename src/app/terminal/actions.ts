"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { DEFAULT_AFTER_SIGN_IN } from "@/platform/auth";
import { pinSignIn } from "@/platform/terminals";

export type PinSignInState = {
  error?: string;
  /** This browser is not (or no longer) a terminal. */
  notTerminal?: boolean;
  /** Changes with every answer so the keypad starts empty again. */
  answers: number;
};

/**
 * Signs a person in with their PIN on this shared terminal (WMS-38). The
 * terminal comes from this browser's cookie, never from the form; the form
 * only names who is typing and what they typed.
 */
export async function pinSignInAction(
  prev: PinSignInState,
  formData: FormData,
): Promise<PinSignInState> {
  const result = await pinSignIn(
    {
      userId: String(formData.get("userId") ?? ""),
      pin: String(formData.get("pin") ?? ""),
    },
    await headers(),
  );
  if (result.ok) redirect(DEFAULT_AFTER_SIGN_IN);
  if (result.reason === "not_terminal") {
    return { notTerminal: true, answers: prev.answers + 1 };
  }
  return { error: result.message, answers: prev.answers + 1 };
}
