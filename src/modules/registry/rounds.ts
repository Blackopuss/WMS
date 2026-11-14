import {
  runCycleCountRound,
  runDailyDigestRound,
  runReplenishmentRound,
} from "@/modules/inventory";
import type { ScheduledRound } from "@/platform/jobs";
import {
  purgeFinishedNoticeEmails,
  purgeReadNotifications,
} from "@/platform/notifications";

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
  // WMS-39B (ADR 0060): and the mails of notices that ended that long ago.
  {
    name: "platform.notifications_cleanup",
    module: "inventory",
    run: async (organizationId) => ({
      notices: await purgeReadNotifications(organizationId),
      mails: await purgeFinishedNoticeEmails(organizationId),
    }),
  },
  // WMS-39B (ADR 0060): the daily summary by mail of who asked for it.
  {
    name: "inventory.daily_digest",
    module: "inventory",
    run: (organizationId) => runDailyDigestRound(organizationId),
  },
];
