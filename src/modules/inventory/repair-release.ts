import "server-only";

import { readSetting } from "@/platform/settings";
import type { TenantDb } from "@/server";

import { REPAIR_RELEASE } from "./settings";
import type { StockStatus } from "./stock-status";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** What leaves «En restauración» through inspection (ADR 0072, R2). */
export const REPAIR_THROUGH_INSPECTION =
  "La empresa pide que lo restaurado pase por inspección: cámbialo a «En inspección» y libéralo desde ahí.";

/**
 * WMS-75 (ADR 0072, R2): whether stock going from `from` to `to` breaks
 * the company's rule for what was restored (`inventory.repair.release`).
 * Read inside the transaction that decides, after its locks: a change of
 * state (`writeStatusChange`) and the reversal of one. `null` when it may
 * go.
 */
export async function repairReleaseProblem(
  tx: Tx,
  from: StockStatus,
  to: StockStatus,
): Promise<string | null> {
  if (from !== "REPAIR" || to !== "AVAILABLE") return null;
  const rule = await readSetting(tx, REPAIR_RELEASE);
  return rule === "inspection" ? REPAIR_THROUGH_INSPECTION : null;
}
