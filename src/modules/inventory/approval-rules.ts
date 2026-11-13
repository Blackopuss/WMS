import type { Decimal } from "@/lib";

/**
 * WMS-41 (ADR 0053): whether a correction passes the company's threshold
 * (`ADJUSTMENT_APPROVAL_THRESHOLD`). Pure. `any` = every correction; a
 * percent compares what changes with what the system has there; when the
 * system has nothing, anything found is a big difference.
 */
export function exceedsThreshold(
  threshold: string,
  before: Decimal,
  changed: Decimal,
): boolean {
  if (changed.isZero()) return false;
  if (threshold === "any" || before.lessThanOrEqualTo(0)) return true;
  const percent = Number(threshold);
  if (!Number.isFinite(percent) || percent <= 0) return true;
  return changed.abs().times(100).greaterThan(before.times(percent));
}
