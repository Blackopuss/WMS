import "server-only";

import {
  ACCESS_ACTIONS,
  readAccessHistory,
  type AccessHistoryPage,
} from "@/platform/auth";
import { db, forOrganization } from "@/server";

import { assertAllowed } from "./access";

type Period = { from: Date; to: Date | null };

/**
 * When the person belonged to the company: from joining, cut at each
 * deactivation and opened again at each reactivation (read from the
 * company's audit log, the only record of those changes). A disabled
 * person's last period ends when they were disabled.
 */
async function periodsInCompany(
  organizationId: string,
  userId: string,
  joinedAt: Date,
): Promise<Period[]> {
  const changes = await forOrganization(organizationId).auditEvent.findMany({
    where: {
      targetType: "user",
      targetId: userId,
      action: { in: ["team.member_disabled", "team.member_reactivated"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { action: true, createdAt: true },
  });
  const periods: Period[] = [{ from: joinedAt, to: null }];
  for (const change of changes) {
    const open = periods.at(-1)!;
    if (change.action === "team.member_disabled" && open.to === null) {
      open.to = change.createdAt;
    } else if (
      change.action === "team.member_reactivated" &&
      open.to !== null
    ) {
      periods.push({ from: change.createdAt, to: null });
    }
  }
  return periods;
}

/**
 * Access history of a member, seen by the company (WMS-68, ADR 0064), with
 * the rules of the team's sessions (WMS-40): `platform.session.read`, and
 * what belongs to another company does not exist here.
 *
 * - Events of this company (`eventOrganizationId`): always.
 * - Account events (no company: password, codes, recovery): only while the
 *   person belongs to no other company, and only while they belonged to
 *   this one: from joining, not while disabled (nor after, if they still
 *   are). With two companies there is no knowing for which one they
 *   signed in, so each company sees only what happened inside it.
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
  const periods =
    otherCompanies === 0
      ? await periodsInCompany(organizationId, userId, membership.createdAt)
      : [];
  return readAccessHistory(
    {
      userId,
      action: { in: ACCESS_ACTIONS },
      OR: [
        { eventOrganizationId: organizationId },
        ...periods.map((period) => ({
          eventOrganizationId: null,
          createdAt: {
            gte: period.from,
            ...(period.to ? { lt: period.to } : {}),
          },
        })),
      ],
    },
    page,
  );
}
