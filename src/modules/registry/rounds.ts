import { runCycleCountRound } from "@/modules/inventory";
import type { ScheduledRound } from "@/platform/jobs";

/**
 * Work each module does on a schedule, company by company (PAG-07). The
 * worker runs these once an hour; a module adds its rounds here.
 */
export const scheduledRounds: readonly ScheduledRound[] = [
  // WMS-55 (ADR 0050): the counts of the day of each cycle count program.
  {
    name: "inventory.cycle_counts",
    module: "inventory",
    run: (organizationId) => runCycleCountRound(organizationId),
  },
];
