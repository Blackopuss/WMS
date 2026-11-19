import "server-only";

import { db } from "@/server";

/**
 * Work the worker does on a schedule for each company that holds a module
 * (PAG-07: reminders of overdue payments). The platform never imports
 * modules: the worker receives the rounds from the registry. A round works
 * with one company at a time, only through `forOrganization`, checks by
 * itself whether the company may use it now, and must be safe to run again.
 */
export type ScheduledRound = {
  /** «sales.overdue_reminders». */
  name: string;
  /** Runs for the companies that hold this module… */
  module?: string;
  /**
   * …or for the companies this says (a round of the platform that does not
   * depend on a module, WMS-60).
   */
  organizations?: () => Promise<string[]>;
  run(organizationId: string): Promise<unknown>;
};

/** Companies with the module granted now (the round checks the rest). */
export async function organizationsWithModule(
  moduleId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db.entitlement.findMany({
    where: {
      kind: "MODULE",
      key: moduleId,
      validFrom: { lte: now },
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    },
    select: { organizationId: true },
    orderBy: { organizationId: "asc" },
  });
  return rows.map((row) => row.organizationId);
}

/**
 * Every company, whatever its modules or plan: for a round of the platform
 * that must keep running after a plan ends (WMS-37: photos never linked).
 */
export async function allOrganizations(): Promise<string[]> {
  const rows = await db.organization.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

/**
 * Work of the platform that belongs to no company (WMS-88, ADR 0084: the
 * retention of the per-person access history). The worker runs these in
 * the same hourly turn as the company rounds.
 */
export type AccountRound = {
  name: string;
  run(): Promise<unknown>;
};

/** Runs every account round once; one that fails does not stop the rest. */
export async function runAccountRounds(
  rounds: readonly AccountRound[],
  onError: (round: string, error: unknown) => void,
): Promise<void> {
  for (const round of rounds) {
    try {
      await round.run();
    } catch (error) {
      onError(round.name, error);
    }
  }
}

/**
 * Runs every round once for each company. One company that fails does not
 * stop the others; `onError` hears about it.
 */
export async function runScheduledRounds(
  rounds: readonly ScheduledRound[],
  onError: (round: string, organizationId: string, error: unknown) => void,
): Promise<void> {
  for (const round of rounds) {
    const companies = round.organizations
      ? await round.organizations()
      : round.module
        ? await organizationsWithModule(round.module)
        : [];
    for (const organizationId of companies) {
      try {
        await round.run(organizationId);
      } catch (error) {
        onError(round.name, organizationId, error);
      }
    }
  }
}
