import {
  runCycleCountRound,
  runDailyDigestRound,
  runEquipmentMaintenanceRound,
  runReplenishmentRound,
} from "@/modules/inventory";
import { allOrganizations, type ScheduledRound } from "@/platform/jobs";
import {
  organizationsWithWebhookHistory,
  purgeWebhookHistory,
} from "@/platform/api";
import { processStorageCleanup, purgeOrphanPhotos } from "@/platform/files";
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
  // WMS-37 (ADR 0063): photos taken and never linked to a record, a day
  // after, for every company that has any (whatever its modules or plan).
  {
    name: "platform.photo_orphans_cleanup",
    organizations: allOrganizations,
    run: async (organizationId) => ({
      photos: await purgeOrphanPhotos(organizationId),
    }),
  },
  // WMS-67 (ADR 0070): bytes left without a live file (an upload that did
  // not end, a removal whose bytes could not go), for every company
  // (one indexed read when it has nothing waiting).
  {
    name: "platform.storage_cleanup",
    organizations: allOrganizations,
    run: (organizationId) => processStorageCleanup(organizationId),
  },
  // WMS-39B (ADR 0060): the daily summary by mail of who asked for it.
  {
    name: "inventory.daily_digest",
    module: "inventory",
    run: (organizationId) => runDailyDigestRound(organizationId),
  },
  // WMS-42 (ADR 0065): the notice of equipment maintenance near or due.
  {
    name: "inventory.equipment_maintenance",
    module: "inventory",
    run: (organizationId) => runEquipmentMaintenanceRound(organizationId),
  },
  // WMS-60 (ADR 0058): webhook events and deliveries older than 30 days,
  // for every company that has any (whatever its modules).
  {
    name: "platform.webhooks_cleanup",
    organizations: organizationsWithWebhookHistory,
    run: (organizationId) => purgeWebhookHistory(organizationId),
  },
];
