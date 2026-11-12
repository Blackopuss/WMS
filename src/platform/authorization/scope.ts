import "server-only";

import type { TenantDb } from "@/server";

import { buildScope, type Scope } from "./policy";

/**
 * Where a member may work (WMS-20, ADR 0038), read from `membership_scope`
 * on every request. No rows = no limit, and the titular is never limited,
 * whatever rows there are (the services that write them refuse the titular
 * and handing the company over removes them). One read through the
 * company client, so it can run inside any company transaction.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
export type ScopeReader = Pick<Tx, "membership">;

/** The scope of that person in the company of the client; null = no limit. */
export async function loadScope(
  client: ScopeReader,
  userId: string,
): Promise<Scope | null> {
  const membership = await client.membership.findFirst({
    where: { userId: String(userId) },
    select: {
      organization: { select: { ownerUserId: true } },
      scopes: { select: { facilityId: true, locationId: true } },
    },
  });
  if (!membership || membership.organization.ownerUserId === userId) {
    return null;
  }
  return buildScope(membership.scopes);
}

/**
 * True when nothing limits that person to warehouses or zones. Figures of
 * the whole company (low stock against its minimum, what the inventory is
 * worth, what to buy) are only for them: someone limited would read there
 * numbers of places outside their scope (WMS-20).
 */
export async function seesWholeCompany(
  client: ScopeReader,
  userId: string,
): Promise<boolean> {
  return (await loadScope(client, userId)) === null;
}
