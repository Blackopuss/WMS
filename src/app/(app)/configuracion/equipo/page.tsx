import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import {
  ROLE_LABELS,
  companyModules,
  assignableRoles,
  checkTeamChange,
  getAccess,
  getSeatUsage,
  listPendingInvitations,
  listScopeOptions,
  listTeamMembers,
} from "@/platform/authorization";

import { getModuleAccess } from "@/platform/billing";

import { InviteDialog } from "./invite-dialog";
import { InvitationsPanel } from "./invitations-panel";
import { MembersPanel } from "./members-panel";

export const metadata: Metadata = { title: "Equipo" };

function BackLink() {
  return (
    <Link
      href="/configuracion"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
}

/** Team screen (USR-08): people, their roles and pending invitations. */
export default async function EquipoPage() {
  const access = await getAccess();
  if (!access.can("platform.team.read")) {
    return (
      <PageContainer>
        <BackLink />
        <NoAccessState
          title="No tienes acceso al equipo"
          description="Solo el titular y los administradores pueden ver y cambiar quién trabaja en la empresa."
        />
      </PageContainer>
    );
  }

  const organizationId = access.organization.id;
  const [members, seats, scopeOptions, invitations] = await Promise.all([
    listTeamMembers(organizationId),
    getSeatUsage(organizationId),
    // Warehouses and zones this person may hand out (WMS-20).
    listScopeOptions(organizationId, access.user.id),
    access.can("platform.team.invite")
      ? listPendingInvitations(organizationId)
      : Promise.resolve([]),
  ]);

  // Roles tied to a module only once the company has it (WMS-59): the
  // team rules decide it from the company's modules, here and on save.
  const modules = await getModuleAccess();
  const me = {
    userId: access.user.id,
    isOwner: access.organization.isOwner,
    roles: access.roles,
    modules: companyModules(modules.entitlements),
  };
  const offered = assignableRoles(me);
  const roleOptions = offered.map((role) => ({
    id: role,
    label: ROLE_LABELS[role],
  }));
  // The server decides what each row offers; the actions check it again.
  const allows = (
    target: (typeof members)[number],
    kind: "assign_roles" | "disable" | "set_scope",
  ) =>
    checkTeamChange(
      me,
      target,
      kind === "assign_roles"
        ? { kind, roles: offered.length > 0 ? [offered[0]!] : [] }
        : { kind },
    ).ok;
  // Limiting by warehouse only makes sense with something to choose from:
  // more than one warehouse, or zones in the only one.
  const scopeUseful =
    scopeOptions.options.length > 1 ||
    scopeOptions.options.some((option) => option.zones.length > 1);
  const handlesAdministrators = access.organization.isOwner;

  return (
    <PageContainer>
      <BackLink />
      <PageHeader
        title="Equipo"
        description="Quién trabaja en tu empresa y qué puede hacer cada persona."
        actions={
          access.can("platform.team.invite") && roleOptions.length > 0 ? (
            <InviteDialog
              roleOptions={roleOptions}
              scopeChoices={
                scopeUseful || scopeOptions.actorLimited
                  ? scopeOptions.options
                  : []
              }
              everywhereAllowed={!scopeOptions.actorLimited}
              scopeDefault={
                scopeOptions.actorLimited
                  ? scopeOptions.options.map((option) => ({
                      facilityId: option.id,
                      zoneIds: option.wholeAllowed
                        ? null
                        : option.zones.map((zone) => zone.id),
                    }))
                  : []
              }
            />
          ) : undefined
        }
      />

      <MembersPanel
        roleOptions={roleOptions}
        scopeChoices={scopeOptions.options}
        everywhereAllowed={!scopeOptions.actorLimited}
        seats={{
          limit: seats.limit,
          taken: seats.members + seats.pendingInvitations,
          pending: seats.pendingInvitations,
        }}
        members={members.map((member) => ({
          userId: member.userId,
          name: member.name,
          email: member.email,
          disabled: member.status === "DISABLED",
          isOwner: member.isOwner,
          isMe: member.userId === access.user.id,
          roles: member.roles.map((role) => ({
            id: role,
            label: ROLE_LABELS[role],
          })),
          canAssign:
            member.status === "ACTIVE" && allows(member, "assign_roles"),
          canDisable: allows(member, "disable"),
          scope: member.limitedTo.map((entry) => ({
            facilityId: entry.facilityId,
            zoneIds: entry.zones?.map((zone) => zone.id) ?? null,
          })),
          scopeText:
            member.limitedTo.length === 0
              ? null
              : member.limitedTo
                  .map((entry) =>
                    entry.zones
                      ? `${entry.facilityName} (${entry.zones.map((zone) => zone.name).join(", ")})`
                      : entry.facilityName,
                  )
                  .join(" · "),
          canScope:
            member.status === "ACTIVE" &&
            allows(member, "set_scope") &&
            (scopeUseful || member.limitedTo.length > 0),
          href: access.can("platform.session.read")
            ? `/configuracion/equipo/${encodeURIComponent(member.userId)}`
            : null,
        }))}
      />

      {access.can("platform.team.invite") && (
        <InvitationsPanel
          invitations={invitations.map((invitation) => {
            const manageable =
              handlesAdministrators ||
              !invitation.roles.includes("administrator");
            return {
              id: invitation.id,
              email: invitation.email,
              roles: invitation.roles.map((role) => ROLE_LABELS[role]),
              expiresAt: invitation.expiresAt.toISOString(),
              expired: invitation.expired,
              limited: invitation.limited,
              canResend: manageable && access.can("platform.invitation.resend"),
              canCancel: manageable && access.can("platform.invitation.cancel"),
            };
          })}
        />
      )}
    </PageContainer>
  );
}
