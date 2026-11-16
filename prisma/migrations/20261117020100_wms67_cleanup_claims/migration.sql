-- WMS-67 (ADR 0070), review: the round claims a note before removing bytes, and waits longer after each failure.
-- AlterTable
ALTER TABLE `storage_cleanup` ADD COLUMN `claimedAt` DATETIME(3) NULL,
    ADD COLUMN `nextAttemptAt` DATETIME(3) NULL;


-- Every company has its storage counter from now (IMP-S13): the ones
-- without files start at 0, so no upload creates it inside its
-- transaction. Ids with UUID(), as earlier seeding migrations did.
INSERT INTO `quota_usage` (`id`, `organizationId`, `key`, `taken`, `reserved`, `updatedAt`)
SELECT UUID(), o.`id`, 'file_storage_kib', 0, 0, CURRENT_TIMESTAMP(3)
FROM `organization` o
WHERE NOT EXISTS (
  SELECT 1 FROM `quota_usage` q
  WHERE q.`organizationId` = o.`id` AND q.`key` = 'file_storage_kib'
);
