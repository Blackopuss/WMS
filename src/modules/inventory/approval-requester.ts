import "server-only";

import {
  companyModules,
  permissionsOf,
  type Permission,
} from "@/platform/authorization";
import { readModuleStates } from "@/platform/entitlements";
import type { ApprovalTx } from "@/platform/approvals";

/**
 * Before an authorized operation is redone in the name of who asked for it
 * (WMS-97, NEG-20): that person still works in the company and still holds
 * the permissions of the operation, with their roles and the company's
 * modules as they are now, read with the transaction of the decision.
 * Returns why it no longer applies, or null. The same check the effect of
 * a write-off already makes (ADR 0078).
 */
export async function requesterNoLongerMay(
  tx: ApprovalTx,
  organizationId: string,
  userId: string,
  permissions: readonly Permission[],
  what: string,
): Promise<string | null> {
  const member = await tx.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    select: {
      roles: { select: { role: true } },
      organization: { select: { ownerUserId: true } },
    },
  });
  if (!member) {
    return `Quien pidió ${what} ya no trabaja en la empresa: que lo pida alguien que sí.`;
  }
  const subject = {
    isOwner: member.organization.ownerUserId === userId,
    roles: member.roles.map((each) => each.role),
    modules: companyModules(await readModuleStates(tx, organizationId)),
  };
  const held = permissionsOf(subject);
  if (permissions.some((permission) => !held.has(permission))) {
    return `Quien pidió ${what} ya no tiene permiso para hacerlo: que lo pida alguien que sí.`;
  }
  return null;
}
