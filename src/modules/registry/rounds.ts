import { runCycleCountRound, runReplenishmentRound } from "@/modules/inventory";
import type { ScheduledRound } from "@/platform/jobs";
import { purgeWebhookHistory } from "@/platform/api";
import { purgeReadNotifications } from "@/platform/notifications";

/**
 * Work each module does on a schedule, company by company (PAG-07). The
 * worker runs these once an hour; a module adds its rounds here.
 */
export const scheduledRounds: readonly ScheduledRound[] = [
  // WMS-24 (ADR 0051): fills picking locations below their minimum.
  {
    name: "inventory.replenishment",
    module: "inventory",
    run: runReplenishmentRound,
  },
  // WMS-55 (ADR 0050): the counts of the day of each cycle count program.
  {
    name: "inventory.cycle_counts",
    module: "inventory",
    run: (organizationId) => runCycleCountRound(organizationId),
  },
  // WMS-39 (ADR 0057): read notices older than 90 days. A platform table,
  // run for every company of the WMS (all of them have Inventario).
  {
    name: "platform.notifications_cleanup",
    module: "inventory",
    run: (organizationId) => purgeReadNotifications(organizationId),
  },
  // WMS-60 (ADR 0058): webhook events and deliveries older than 30 days.
  {
    name: "platform.webhooks_cleanup",
    module: "inventory",
    run: (organizationId) => purgeWebhookHistory(organizationId),
  },
];
