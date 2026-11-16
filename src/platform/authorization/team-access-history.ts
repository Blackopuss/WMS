import "server-only";

import {
  ACCESS_ACTIONS,
  readAccessHistory,
  type AccessHistoryPage,
} from "@/platform/auth";
import { db, forOrganization } from "@/server";

import { assertAllowed } from "./access";

/**
 * Access history of a member, seen by the company (WMS-68, ADR 0064), with
 * the rules of the team's sessions (WMS-40): `platform.session.read`, and
 * what belongs to another company does not exist here.
 *
 * - Events of this company (`eventOrganizationId`): always.
 * - Account events (no company: password, codes, recovery): only while the
 *   person belongs to no other company, and only since they joined this
 *   one. With two companies there is no knowing for which one they signed
 *   in, so each company sees only what happened inside it.
 * - Events of another company: never.
 *
 * Null when the person is not in the company.
 */
export async function listMemberAccessHistory(
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  page = 1,
): Promise<AccessHistoryPage | null> {
  await assertAllowed(organizationId, actorUserId, "platform.session.read");
  const userId = String(targetUserId).slice(0, 36);
  const membership = await forOrganization(organizationId).membership.findFirst(
    { where: { userId }, select: { createdAt: true } },
  );
  if (!membership) return null;
  const otherCompanies = await db.membership.count({
    where: { userId, organizationId: { not: organizationId } },
  });
  return readAccessHistory(
    {
      userId,
      action: { in: ACCESS_ACTIONS },
      OR: [
        { eventOrganizationId: organizationId },
        ...(otherCompanies === 0
          ? [
              {
                eventOrganizationId: null,
                createdAt: { gte: membership.createdAt },
              },
            ]
          : []),
      ],
    },
    page,
  );
}
