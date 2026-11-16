import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import {
  ROLE_LABELS,
  getAccess,
  listMemberSessions,
  listTeamMembers,
} from "@/platform/authorization";

import { MemberSessionsPanel } from "./member-sessions-panel";

export const metadata: Metadata = { title: "Persona del equipo" };

function BackLink() {
  return (
    <Link
      href="/configuracion/equipo"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Equipo
    </Link>
  );
}

/**
 * One person of the team (WMS-40): who they are and the sessions they have
 * open in this company, with «Cerrar esta sesión» and «Cerrar todas sus
 * sesiones» when the rules allow it. Sessions in another company do not
 * exist here.
 */
export default async function PersonaPage({
  params,
}: PageProps<"/configuracion/equipo/[id]">) {
  const access = await getAccess();
  if (
    !access.can("platform.team.read") ||
    !access.can("platform.session.read")
  ) {
    return (
      <PageContainer>
        <BackLink />
        <NoAccessState
          title="No tienes acceso a las sesiones del equipo"
          description="Solo el titular, los administradores y Gerencia ven las sesiones de las personas del equipo."
        />
      </PageContainer>
    );
  }

  const { id } = await params;
  const organizationId = access.organization.id;
  const [members, view] = await Promise.all([
    listTeamMembers(organizationId),
    listMemberSessions(organizationId, access.user.id, id, access.sessionId),
  ]);
  const member = members.find((each) => each.userId === id);
  if (!member || !view) notFound();
  const tz = access.organization.timeZone;

  return (
    <PageContainer>
      <BackLink />
      <PageHeader title={member.name} />
      <div className="-mt-2 space-y-2">
        <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
          {member.email}
        </p>
        <p className="flex flex-wrap gap-1.5">
          {member.isOwner && <Badge>Titular</Badge>}
          {member.roles.map((role) => (
            <Badge key={role} variant="secondary">
              {ROLE_LABELS[role]}
            </Badge>
          ))}
          {member.status === "DISABLED" && (
            <Badge variant="secondary">Desactivado</Badge>
          )}
        </p>
        <p>
          <Link
            href={`/configuracion/equipo/${encodeURIComponent(member.userId)}/accesos`}
            className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Historial de accesos
          </Link>
        </p>
      </div>

      <MemberSessionsPanel
        userId={member.userId}
        name={member.name}
        canRevoke={view.canRevoke}
        revokeBlocked={view.revokeBlocked}
        sessions={view.sessions.map((session) => ({
          id: session.id,
          device: session.device,
          deviceLabel: session.deviceLabel,
          label: session.label,
          ipAddress: session.ipAddress,
          createdText: formatDateTime(session.createdAt, tz),
          lastActiveText: formatDateTime(session.lastActiveAt, tz),
          lastActiveAt: session.lastActiveAt.toISOString(),
          current: session.current,
          terminalName: session.terminalName,
        }))}
      />
    </PageContainer>
  );
}
