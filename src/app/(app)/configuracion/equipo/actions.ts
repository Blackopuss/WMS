"use server";

import { revalidatePath } from "next/cache";

import {
  assignRoles,
  cancelInvitation,
  createInvitation,
  disableMember,
  reactivateMember,
  resendInvitation,
  revokeAllMemberSessions,
  revokeMemberSession,
  setMemberScope,
  type InvitationField,
} from "@/platform/authorization";
import { requireOrganizationContext } from "@/platform/tenancy";

const TEAM_PATH = "/configuracion/equipo";

export type TeamActionState = { ok: boolean; message: string };

export type InviteState = {
  fieldErrors: Partial<Record<InvitationField, string>>;
  formError?: string;
  /** Email of the invitation just sent (the dialog closes and says so). */
  sentTo?: string;
  values: { email: string; roles: string[] };
};

/** The person and the company always come from the session, never the form. */
async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { userId: user.id, organizationId: organization.id };
}

/**
 * What the warehouse fields of a form say (`ScopeFields`): every warehouse,
 * or the chosen ones with their zones. Only ids; the service checks them.
 */
function scopeFrom(formData: FormData):
  | {
      ok: true;
      everywhere: boolean;
      facilities: { facilityId: string; zoneIds: string[] }[];
    }
  | { ok: false; error: string } {
  const everywhere = formData.get("mode") !== "some";
  const chosen = everywhere
    ? []
    : [
        ...new Set(formData.getAll("facility").map((value) => String(value))),
      ].slice(0, 200);
  if (!everywhere && chosen.length === 0) {
    return { ok: false, error: "Elige al menos un almacén." };
  }
  const facilities = chosen.map((facilityId) => ({
    facilityId,
    zoneIds:
      formData.get(`zoneMode:${facilityId}`) === "zones"
        ? formData
            .getAll(`zones:${facilityId}`)
            .map((value) => String(value))
            .slice(0, 500)
        : [],
    zoned: formData.get(`zoneMode:${facilityId}`) === "zones",
  }));
  if (facilities.some((each) => each.zoned && each.zoneIds.length === 0)) {
    return {
      ok: false,
      error:
        "Elige al menos una zona en cada almacén que limitaste, o marca «Todo el almacén».",
    };
  }
  return {
    ok: true,
    everywhere,
    facilities: facilities.map(({ facilityId, zoneIds }) => ({
      facilityId,
      zoneIds,
    })),
  };
}

const rolesFrom = (formData: FormData) =>
  formData.getAll("roles").map((value) => String(value));

export async function inviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const { userId, organizationId } = await actor();
  const values = {
    email: String(formData.get("email") ?? ""),
    roles: rolesFrom(formData),
  };
  // The warehouse fields are only in the form when there is something to
  // choose; without them the service decides (no limit, or the inviter's).
  const scope = formData.has("mode")
    ? scopeFrom(formData)
    : ({ ok: true, everywhere: true, facilities: [] } as const);
  if (!scope.ok) {
    return { fieldErrors: { scope: scope.error }, values };
  }
  const result = await createInvitation(organizationId, userId, {
    ...values,
    facilities: scope.facilities,
  });
  if (!result.ok) {
    return {
      fieldErrors: result.fieldErrors,
      formError: result.formError,
      values,
    };
  }
  revalidatePath(TEAM_PATH);
  return {
    fieldErrors: {},
    sentTo: values.email.trim().toLowerCase(),
    values: { email: "", roles: [] },
  };
}

export async function resendInvitationAction(
  invitationId: string,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const result = await resendInvitation(
    organizationId,
    userId,
    String(invitationId),
  );
  revalidatePath(TEAM_PATH);
  return result.ok
    ? {
        ok: true,
        message: "Enviamos un enlace nuevo. El anterior ya no sirve.",
      }
    : { ok: false, message: result.error };
}

export async function cancelInvitationAction(
  invitationId: string,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const result = await cancelInvitation(
    organizationId,
    userId,
    String(invitationId),
  );
  revalidatePath(TEAM_PATH);
  return result.ok
    ? { ok: true, message: "Invitación cancelada. Su enlace ya no sirve." }
    : { ok: false, message: result.error };
}

export async function assignRolesAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const result = await assignRoles(organizationId, userId, {
    userId: String(formData.get("userId") ?? ""),
    roles: rolesFrom(formData),
  });
  revalidatePath(TEAM_PATH);
  return result.ok
    ? { ok: true, message: "Roles actualizados." }
    : { ok: false, message: result.error };
}

export async function disableMemberAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const result = await disableMember(organizationId, userId, {
    userId: String(formData.get("userId") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  });
  revalidatePath(TEAM_PATH);
  return result.ok
    ? {
        ok: true,
        message: "Persona desactivada. Cerramos sus sesiones abiertas.",
      }
    : { ok: false, message: result.error };
}

export async function reactivateMemberAction(
  memberUserId: string,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const result = await reactivateMember(organizationId, userId, {
    userId: String(memberUserId),
  });
  revalidatePath(TEAM_PATH);
  return result.ok
    ? { ok: true, message: "Persona reactivada con los roles que tenía." }
    : { ok: false, message: result.error };
}

/**
 * Limits a person to certain warehouses and zones, or removes the limit
 * (WMS-20). The form only names ids: the service checks each one in the
 * company of the session and that who asks may hand it out.
 */
export async function setMemberScopeAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const scope = scopeFrom(formData);
  if (!scope.ok) return { ok: false, message: scope.error };
  const { everywhere, facilities } = scope;
  const result = await setMemberScope(organizationId, userId, {
    userId: String(formData.get("userId") ?? ""),
    facilities,
  });
  revalidatePath(TEAM_PATH);
  return result.ok
    ? {
        ok: true,
        message: everywhere
          ? "Ahora puede trabajar en todos los almacenes."
          : "Almacenes actualizados.",
      }
    : { ok: false, message: result.error };
}

/**
 * Closes one session of a member (`sessionId`) or all their sessions in
 * this company (no `sessionId`), WMS-40. Identity from the session; the
 * service checks the rules and that the session is open in this company.
 */
export async function revokeMemberSessionsAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const { userId, organizationId } = await actor();
  const memberUserId = String(formData.get("userId") ?? "");
  const sessionId = String(formData.get("sessionId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const result = sessionId
    ? await revokeMemberSession(organizationId, userId, {
        userId: memberUserId,
        sessionId,
        reason,
      })
    : await revokeAllMemberSessions(organizationId, userId, {
        userId: memberUserId,
        reason,
      });
  revalidatePath(`${TEAM_PATH}/${encodeURIComponent(memberUserId)}`);
  if (!result.ok) return { ok: false, message: result.error };
  if (sessionId) {
    return { ok: true, message: "Sesión cerrada en ese dispositivo." };
  }
  return {
    ok: true,
    message:
      result.closed === 0
        ? "No tenía sesiones abiertas en tu empresa."
        : result.closed === 1
          ? "Se cerró 1 sesión."
          : `Se cerraron ${result.closed} sesiones.`,
  };
}
