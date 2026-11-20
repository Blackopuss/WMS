import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { formatDateTime } from "@/lib";
import { getAccess } from "@/platform/authorization";
import { getMyPinStatus } from "@/platform/terminals";

import { PinForm } from "./pin-form";

export const metadata: Metadata = { title: "Mi PIN" };

/**
 * The person's PIN for the shared terminals of this company (WMS-38,
 * ADR 0061 §3). Never from a terminal; only for who may sign in with a PIN.
 */
export default async function MiPinPage() {
  const access = await getAccess();
  const back = (
    <Link
      href="/configuracion"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
  if (access.terminal) {
    return (
      <PageContainer>
        {back}
        <NoAccessState
          title="Tu PIN no se cambia desde una terminal"
          description="Entra con tu correo y contraseña en tu propio dispositivo."
        />
      </PageContainer>
    );
  }
  const status = await getMyPinStatus({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  if (!status.available) {
    return (
      <PageContainer>
        {back}
        <NoAccessState
          title="No puedes entrar con PIN en esta empresa"
          description="Tu rol no lo permite o usas verificación en dos pasos. Entra siempre con tu correo y contraseña."
        />
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      {back}
      <PageHeader title="Mi PIN" />
      <section className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <p className="text-sm text-muted-foreground">
          {status.hasPin && status.setAt
            ? `Tienes PIN desde el ${formatDateTime(status.setAt, access.organization.timeZone)}. Sirve solo en las terminales compartidas de ${access.organization.name}.`
            : `Con tu PIN entras rápido en las terminales compartidas de ${access.organization.name}. No lo compartas con nadie.`}
        </p>
        <PinForm hasPin={status.hasPin} length={status.length} />
      </section>
    </PageContainer>
  );
}
