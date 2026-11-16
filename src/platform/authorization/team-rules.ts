/**
 * Who may change whom in the team (USR-03B, matrix rule 4 and founder's
 * answer 6). Pure: callers load the people and pass them in.
 *
 * - Nobody disables the titular or changes their roles; the titular only
 *   stops being one through the ownership transfer.
 * - Only the titular names, changes or removes administrators.
 * - An administrator manages Almacén, Comprador and Consulta of other
 *   people, never their own roles.
 * - The same holds for limiting a person to warehouses or zones (WMS-20):
 *   never the titular, never oneself, administrators only by the titular.
 * - And for closing someone's sessions from the team screen (WMS-40): never
 *   the titular's, never one's own (that is «Sesiones activas» and «Cerrar
 *   sesión»), an administrator's only by the titular.
 * - A role tied to a module (WMS-59, ADR 0062) is not handed out while the
 *   company lacks that module (`actor.modules`); one the person already has
 *   may stay when other roles change.
 */
import {
  ROLES,
  ROLE_MODULE,
  isRole,
  type Permission,
  type Role,
} from "./catalog";
import { can, type Subject } from "./policy";

export type TeamPerson = Subject & { userId: string };

export type TeamChange =
  | { kind: "assign_roles"; roles: readonly string[] }
  | { kind: "disable" }
  /** Limiting a person to warehouses or zones (WMS-20). */
  | { kind: "set_scope" }
  /** Closing one or all of a person's sessions in the company (WMS-40). */
  | { kind: "revoke_sessions" };

export type TeamRuleReason =
  | "forbidden"
  | "owner_protected"
  | "self"
  | "administrator_reserved"
  | "invalid_roles"
  | "module_missing";

export type TeamRuleResult =
  { ok: true } | { ok: false; reason: TeamRuleReason };

export const TEAM_RULE_MESSAGES: Record<TeamRuleReason, string> = {
  forbidden: "No tienes permiso para hacer esto.",
  owner_protected:
    "El titular no se puede desactivar ni cambiar de rol. Para cambiar de titular se transfiere la empresa.",
  self: "No puedes cambiar tu propio acceso.",
  administrator_reserved:
    "Solo el titular puede nombrar, cambiar o quitar administradores.",
  invalid_roles: "Elige al menos un rol válido.",
  module_missing:
    "Ese rol necesita un módulo que tu empresa no tiene contratado.",
};

const PERMISSION_OF: Record<TeamChange["kind"], Permission> = {
  assign_roles: "platform.team.assign_roles",
  disable: "platform.team.disable",
  // Where a person may work is part of what they may do: same permission.
  set_scope: "platform.team.assign_roles",
  revoke_sessions: "platform.session.revoke",
};

const deny = (reason: TeamRuleReason): TeamRuleResult => ({
  ok: false,
  reason,
});

/** True when the company has the module a role needs (or it needs none). */
function moduleOfRoleIsThere(actor: Subject, role: string): boolean {
  const needs = isRole(role) ? ROLE_MODULE[role] : undefined;
  return needs === undefined || actor.modules?.has(needs) === true;
}

/**
 * Roles a person may hand out: the titular all, an administrator all but
 * administrator; neither a role whose module the company lacks (WMS-59).
 */
export function assignableRoles(actor: Subject): Role[] {
  if (!can(actor, "platform.team.assign_roles")) return [];
  return ROLES.filter(
    (role) =>
      (actor.isOwner === true || role !== "administrator") &&
      moduleOfRoleIsThere(actor, role),
  );
}

export function checkTeamChange(
  actor: TeamPerson,
  target: TeamPerson,
  change: TeamChange,
): TeamRuleResult {
  if (!can(actor, PERMISSION_OF[change.kind])) return deny("forbidden");
  if (target.isOwner === true) return deny("owner_protected");
  if (actor.userId === target.userId) return deny("self");

  if (change.kind === "assign_roles") {
    const roles = change.roles;
    if (
      roles.length === 0 ||
      !roles.every(isRole) ||
      new Set(roles).size !== roles.length
    ) {
      return deny("invalid_roles");
    }
  }

  if (actor.isOwner !== true) {
    if (target.roles.includes("administrator")) {
      return deny("administrator_reserved");
    }
    if (
      change.kind === "assign_roles" &&
      change.roles.includes("administrator")
    ) {
      return deny("administrator_reserved");
    }
  }
  if (change.kind === "assign_roles") {
    const added = change.roles.filter((role) => !target.roles.includes(role));
    if (!added.every((role) => moduleOfRoleIsThere(actor, role))) {
      return deny("module_missing");
    }
  }
  return { ok: true };
}

/** Roles that can be offered in an invitation by this person (USR-04). */
export function checkInvitationRoles(
  actor: Subject,
  roles: readonly string[],
): TeamRuleResult {
  if (!can(actor, "platform.team.invite")) return deny("forbidden");
  if (
    roles.length === 0 ||
    !roles.every(isRole) ||
    new Set(roles).size !== roles.length
  ) {
    return deny("invalid_roles");
  }
  if (actor.isOwner !== true && roles.includes("administrator")) {
    return deny("administrator_reserved");
  }
  if (!roles.every((role) => moduleOfRoleIsThere(actor, role))) {
    return deny("module_missing");
  }
  return { ok: true };
}
