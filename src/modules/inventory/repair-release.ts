import "server-only";

import { readSetting } from "@/platform/settings";
import { forOrganization, type TenantDb } from "@/server";

import { REPAIR_RELEASE } from "./settings";
import type { StockStatus } from "./stock-status";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** What leaves «En restauración» through inspection (ADR 0072, R2). */
export const REPAIR_THROUGH_INSPECTION =
  "La empresa pide que lo restaurado pase por inspección: de «En restauración» solo pasa a «En inspección», o a «Dañado» o «Rechazado» si no se pudo restaurar.";

/**
 * Where stock in restoration may go when the company asks that what was
 * restored goes through inspection: inspection, or damaged or rejected to
 * dispose of it or return it. Never available, quarantine or blocked,
 * which would be a way around inspection.
 */
export const REPAIR_EXITS_THROUGH_INSPECTION: readonly StockStatus[] = [
  "INSPECTION",
  "DAMAGED",
  "REJECTED",
];

/** Whether a change of state breaks the rule, once the rule is known. */
export function breaksRepairRule(
  rule: string,
  from: StockStatus,
  to: StockStatus,
): boolean {
  return (
    rule === "inspection" &&
    from === "REPAIR" &&
    !REPAIR_EXITS_THROUGH_INSPECTION.includes(to)
  );
}

/**
 * WMS-75 (ADR 0072, R2): whether stock going from `from` to `to` breaks
 * the company's rule for what was restored (`inventory.repair.release`):
 * with `inspection`, restoration only leaves for the states of
 * `REPAIR_EXITS_THROUGH_INSPECTION`.
 * Read inside the transaction that decides, after its locks: a change of
 * state (`writeStatusChange`) and the reversal of one. `null` when it may
 * go.
 */
export async function repairReleaseProblem(
  tx: Tx,
  from: StockStatus,
  to: StockStatus,
): Promise<string | null> {
  if (from !== "REPAIR" || REPAIR_EXITS_THROUGH_INSPECTION.includes(to)) {
    return null;
  }
  const rule = await readSetting(tx, REPAIR_RELEASE);
  return breaksRepairRule(rule, from, to) ? REPAIR_THROUGH_INSPECTION : null;
}

/**
 * For a screen (BAJO de la revisión): which states stock in restoration
 * may go to in this company, so «Cambiar estado» never offers what the
 * service would refuse. The service decides again under its locks.
 */
export async function repairExitsOf(
  organizationId: string,
  targets: readonly StockStatus[],
): Promise<StockStatus[]> {
  const rule = await readSetting(
    forOrganization(organizationId),
    REPAIR_RELEASE,
  );
  return targets.filter((to) => !breaksRepairRule(rule, "REPAIR", to));
}
