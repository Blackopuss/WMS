-- WMS-40 (ADR 0059): sessions created before this moment never work in the company again.
ALTER TABLE `membership` ADD COLUMN `sessionsRevokedAt` DATETIME(3) NULL;
