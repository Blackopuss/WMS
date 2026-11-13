import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  isRole,
  type Role,
} from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { getEntitlements } from "@/platform/entitlements";
import { forOrganization } from "@/server";

import type { ApprovalTx, ApprovalType } from "./definitions";

/**
 * What each company asks to authorize (WMS-56, ADR 0053). Without a row a
 * type asks for nothing; who decides is one or more roles of the matrix
 * (the titular always may), and who asked does not decide unless the rule
 * allows it. Changing a rule is for who edits the business configuration
 * (`platform.organization.update`) and leaves an audit event.
 */

type Actor = { organizationId: string; userId: string };
type Reader = Pick<ApprovalTx, "approvalRule">;

export type ApprovalRuleValue = {
  enabled: boolean;
  roles: Role[];
  allowSelfApproval: boolean;
};

const OFF: ApprovalRuleValue = {
  enabled: false,
  roles: [],
  allowSelfApproval: false,
};

const PERMISSION = "platform.organization.update" as const;

/** Stored roles, known ones only, without repeats, in catalog order. */
export function parseRoles(raw: string): Role[] {
  const listed = new Set(raw.split(",").map((each) => each.trim()));
  return ROLES.filter((role) => listed.has(role));
}

/** Roles that could decide a type: they hold what deciding takes. */
export function rolesThatMayDecide(
  type: Pick<ApprovalType, "decidePermissions">,
): Role[] {
  return ROLES.filter((role) =>
    type.decidePermissions.every((permission) =>
      ROLE_PERMISSIONS[role].includes(permission),
    ),
  );
}

/** The rule of a type for the company of `client`; read it where it decides. */
export async function readApprovalRule(
  client: Reader,
  typeKey: string,
): Promise<ApprovalRuleValue> {
  const row = await client.approvalRule.findFirst({
    where: { typeKey },
    select: { enabled: true, approverRoles: true, allowSelfApproval: true },
  });
  if (!row) return OFF;
  return {
    enabled: row.enabled,
    roles: parseRoles(row.approverRoles),
    allowSelfApproval: row.allowSelfApproval,
  };
}

/**
 * True when the company asks to authorize this type. Call it inside the
 * transaction that would otherwise apply the operation, after its locks.
 */
export async function approvalRequired(
  client: Reader,
  typeKey: string,
): Promise<boolean> {
  return (await readApprovalRule(client, typeKey)).enabled;
}

export type ApprovalRuleView = ApprovalRuleValue & {
  key: string;
  label: string;
  description: string;
  /** Roles that can be chosen: the ones that may do the operation. */
  roleOptions: { role: Role; label: string }[];
  /** Keys of the settings that say when it applies. */
  settingKeys: string[];
};

/** The types the company can use now (its modules), with their rules. */
export async function getApprovalRules(
  actor: Actor,
  types: readonly ApprovalType[],
): Promise<ApprovalRuleView[]> {
  await assertModulePermission(actor.organizationId, actor.userId, PERMISSION);
  const entitlements = await getEntitlements(actor.organizationId);
  const client = forOrganization(actor.organizationId);
  const visible = types.filter(
    (type) => type.module === null || entitlements.hasModule(type.module),
  );
  return Promise.all(
    visible.map(async (type) => ({
      key: type.key,
      label: type.label,
      description: type.description,
      ...(await readApprovalRule(client, type.key)),
      roleOptions: rolesThatMayDecide(type).map((role) => ({
        role,
        label: ROLE_LABELS[role],
      })),
      settingKeys: (type.settings ?? []).map((setting) => setting.key),
    })),
  );
}

export type UpdateApprovalRuleResult =
  { ok: true; summary: string; repeated?: true } | { ok: false; error: string };

const yes = (value: unknown) =>
  value === true || value === "1" || value === "on" || value === "true";

const describe = (rule: ApprovalRuleValue) =>
  !rule.enabled
    ? "no pide autorización"
    : `pide autorización; autoriza ${
        rule.roles.length === 0
          ? "solo el titular"
          : `el titular o ${rule.roles.map((role) => ROLE_LABELS[role]).join(", ")}`
      }; ${rule.allowSelfApproval ? "quien lo pide puede autorizarlo" : "quien lo pide no lo autoriza"}`;

/** Changes the rule of one type. */
export async function updateApprovalRule(
  actor: Actor,
  types: readonly ApprovalType[],
  key: string,
  input: { enabled: unknown; roles: unknown; allowSelfApproval: unknown },
): Promise<UpdateApprovalRuleResult> {
  await assertModulePermission(actor.organizationId, actor.userId, PERMISSION);
  const type = types.find((each) => each.key === String(key));
  if (!type) return { ok: false, error: "Ese tipo de aprobación no existe." };
  if (type.module) {
    const entitlements = await getEntitlements(actor.organizationId);
    if (!entitlements.hasModule(type.module)) {
      return {
        ok: false,
        error: "Es de un módulo que tu empresa no tiene activo.",
      };
    }
  }
  const listed = Array.isArray(input.roles)
    ? input.roles.map(String).slice(0, ROLES.length + 2)
    : [];
  if (listed.some((role) => !isRole(role))) {
    return { ok: false, error: "Elige roles de la lista." };
  }
  const allowed = new Set(rolesThatMayDecide(type));
  const cannot = listed.filter((role) => !allowed.has(role as Role));
  if (cannot.length > 0) {
    return {
      ok: false,
      error: `${ROLE_LABELS[cannot[0] as Role]} no puede hacer esta operación, así que tampoco puede autorizarla.`,
    };
  }
  const wanted: ApprovalRuleValue = {
    enabled: yes(input.enabled),
    roles: parseRoles(listed.join(",")),
    allowSelfApproval: yes(input.allowSelfApproval),
  };

  return forOrganization(actor.organizationId).$transaction(async (tx) => {
    const before = await readApprovalRule(tx, type.key);
    const same =
      before.enabled === wanted.enabled &&
      before.allowSelfApproval === wanted.allowSelfApproval &&
      before.roles.join(",") === wanted.roles.join(",");
    if (same) {
      return {
        ok: true as const,
        repeated: true as const,
        summary: `«${type.label}» ya estaba así: ${describe(wanted)}.`,
      };
    }
    const data = {
      enabled: wanted.enabled,
      approverRoles: wanted.roles.join(","),
      allowSelfApproval: wanted.allowSelfApproval,
      updatedByUserId: actor.userId,
    };
    const existing = await tx.approvalRule.findFirst({
      where: { typeKey: type.key },
      select: { id: true },
    });
    if (existing) {
      await tx.approvalRule.update({ where: { id: existing.id }, data });
    } else {
      await tx.approvalRule.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          typeKey: type.key,
          ...data,
        },
      });
    }
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "approval.rule_changed",
      target: { type: "approval_rule", id: type.key },
      metadata: {
        tipo: type.label,
        reglaAntes: describe(before),
        reglaAhora: describe(wanted),
      },
    });
    return {
      ok: true as const,
      summary: `«${type.label}» ${describe(wanted)}.`,
    };
  });
}
