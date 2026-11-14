import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  getCurrentSession,
  refuseOnTerminal,
  safeRedirectPath,
} from "@/platform/auth";

import { CodeForm } from "./code-form";

export const metadata: Metadata = { title: "Código de verificación" };

/** Second sign-in step for accounts with MFA (PLT-08B). */
export default async function VerificarCodigoPage({
  searchParams,
}: PageProps<"/verificar-codigo">) {
  // A shared terminal is entered with a PIN only (WMS-38).
  await refuseOnTerminal();
  const { siguiente } = await searchParams;
  const next = safeRedirectPath(siguiente);
  if (await getCurrentSession()) redirect(next);
  return <CodeForm next={next} />;
}
