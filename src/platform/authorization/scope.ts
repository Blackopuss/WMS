import "server-only";

import { delegationOf, forOrganization, type TenantDb } from "@/server";

import { buildScope, intersectScopes, type Scope } from "./policy";

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
  const own =
    !membership || membership.organization.ownerUserId === userId
      ? null
      : buildScope(membership.scopes);
  // WMS-60: an API key limited to its warehouse narrows its creator's scope.
  const delegated = delegationOf(null, String(userId));
  if (delegated.kind === "key" && delegated.delegation.facilityOnly) {
    return intersectScopes(own, {
      facilities: new Map([[delegated.delegation.facilityId, null]]),
    });
  }
  return own;
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

/**
 * Configuration that applies to every warehouse of the company (operation
 * settings, approval rules, custom fields, production lot numbering) is
 * changed only by someone not limited to warehouses or zones (WMS-93): a
 * member limited on purpose by the titular must not weaken the controls of
 * the warehouses outside their scope. Same rule as processes (N6),
 * automations and webhooks.
 */
export const WHOLE_COMPANY_CONFIG_MESSAGE =
  "Esto vale para toda la empresa: lo cambia quien no está limitado a un almacén.";

/** seesWholeCompany for a page or a service that has no client at hand. */
export async function changesCompanyConfig(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return seesWholeCompany(forOrganization(organizationId), userId);
}
