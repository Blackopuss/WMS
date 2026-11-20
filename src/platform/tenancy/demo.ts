import "server-only";

import { db } from "@/server";

/**
 * Demonstration companies (WMS-44, ADR 0089). The mark is
 * `organization.isDemo`: written when the company is created and never
 * changed (trigger), so reading it outside the operation's transaction is
 * enough.
 *
 * The mark never opens a shortcut: permissions do not read it. A few
 * operations refuse in a demonstration (payments, mail to suppliers, API
 * keys, webhooks); each one asks here.
 */
export async function isDemoCompany(organizationId: string): Promise<boolean> {
  const company = await db.organization.findUnique({
    where: { id: organizationId },
    select: { isDemo: true },
  });
  return company?.isDemo === true;
}

/** What those operations answer in a demonstration. */
export const DEMO_REFUSED_MESSAGE =
  "En una empresa de demostración no se puede hacer esto.";
