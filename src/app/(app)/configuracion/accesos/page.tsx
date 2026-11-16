import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import { listMyAccessHistory } from "@/platform/auth";
import { getAccess } from "@/platform/authorization";

import { AccessHistoryList } from "../access-history-list";

export const metadata: Metadata = { title: "Historial de accesos" };

/**
 * The person's own access history (WMS-68, ADR 0064): entries, failed
 * tries, locks, closed sessions and the alerts that went out. Not on a
 * shared terminal (account security is not touched there).
 */
export default async function AccesosPage({
  searchParams,
}: PageProps<"/configuracion/accesos">) {
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
          title="Tu historial no se ve en una terminal compartida"
          description="Revísalo desde tu propio dispositivo, entrando con tu contraseña."
        />
      </PageContainer>
    );
  }
  const { pagina } = await searchParams;
  const history = await listMyAccessHistory(
    access.user.id,
    Number(typeof pagina === "string" ? pagina : 1),
  );
  return (
    <PageContainer>
      {back}
      <PageHeader title="Historial de accesos" />
      <AccessHistoryList
        history={history}
        timeZone={access.organization.timeZone}
        basePath="/configuracion/accesos"
        emptyText="Aquí aparecerán tus entradas, los intentos fallidos y las sesiones que se cierren."
      />
    </PageContainer>
  );
}
