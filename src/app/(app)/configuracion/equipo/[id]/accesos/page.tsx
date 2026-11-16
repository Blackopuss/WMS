import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import {
  getAccess,
  listMemberAccessHistory,
  listTeamMembers,
} from "@/platform/authorization";

import { AccessHistoryList } from "../../../access-history-list";

export const metadata: Metadata = { title: "Historial de accesos" };

/**
 * Access history of a team member (WMS-68, ADR 0064), with the rules of
 * the team's sessions: what happened in another company does not exist.
 */
export default async function AccesosPersonaPage({
  params,
  searchParams,
}: PageProps<"/configuracion/equipo/[id]/accesos">) {
  const access = await getAccess();
  const { id } = await params;
  if (
    !access.can("platform.team.read") ||
    !access.can("platform.session.read")
  ) {
    return (
      <PageContainer>
        <NoAccessState
          title="No tienes acceso al historial de accesos del equipo"
          description="Solo el titular, los administradores y Gerencia ven los accesos de las personas del equipo."
        />
      </PageContainer>
    );
  }
  const organizationId = access.organization.id;
  const { pagina } = await searchParams;
  const [members, history] = await Promise.all([
    listTeamMembers(organizationId),
    listMemberAccessHistory(
      organizationId,
      access.user.id,
      id,
      Number(typeof pagina === "string" ? pagina : 1),
    ),
  ]);
  const member = members.find((each) => each.userId === id);
  if (!member || !history) notFound();
  const basePath = `/configuracion/equipo/${encodeURIComponent(member.userId)}`;

  return (
    <PageContainer>
      <Link
        href={basePath}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        {member.name}
      </Link>
      <PageHeader title="Historial de accesos" />
      <AccessHistoryList
        history={history}
        timeZone={access.organization.timeZone}
        basePath={`${basePath}/accesos`}
        emptyText="Aquí aparecerán sus entradas, los intentos fallidos y las sesiones que se cierren en tu empresa."
      />
    </PageContainer>
  );
}
