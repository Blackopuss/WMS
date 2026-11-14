import "server-only";

import { cache } from "react";

import { db } from "@/server";

/**
 * Who must use MFA (PLT-08B, USR-01): the titular of any company and every
 * administrator with an active membership, and platform staff (MOD-09).
 * One rule for one person or for many at once (shared terminals, WMS-38).
 */
export async function usersWhoMustUseMfa(
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds.map(String))];
  if (ids.length === 0) return new Set();
  const [owners, administrators, staff] = await Promise.all([
    db.organization.findMany({
      where: { ownerUserId: { in: ids } },
      select: { ownerUserId: true },
    }),
    db.membershipRole.findMany({
      where: {
        role: "administrator",
        membership: { userId: { in: ids }, status: "ACTIVE" },
      },
      select: { membership: { select: { userId: true } } },
    }),
    db.platformStaff.findMany({
      where: { userId: { in: ids }, disabledAt: null },
      select: { userId: true },
    }),
  ]);
  return new Set([
    ...owners.map((o) => o.ownerUserId),
    ...administrators.map((a) => a.membership.userId),
    ...staff.map((s) => s.userId),
  ]);
}

export const isMfaRequired = cache(async (userId: string) =>
  (await usersWhoMustUseMfa([userId])).has(userId),
);
