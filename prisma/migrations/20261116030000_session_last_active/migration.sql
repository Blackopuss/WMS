-- WMS-40 (ADR 0059): last activity of a session, written at most every few minutes.
ALTER TABLE `session` ADD COLUMN `lastActiveAt` DATETIME(3) NULL;
