-- WMS-37B (ADR 0076), review: a photo taken for a record (a task) is linked
-- only to that record. Expansion only.

-- AlterTable
ALTER TABLE `stored_file` ADD COLUMN `pendingOwnerId` CHAR(36) NULL;

-- The record a photo was taken for, and who took it, must match its link.
CREATE TRIGGER `evidence_photo_owner_rules` BEFORE INSERT ON `evidence_photo` FOR EACH ROW
FOLLOWS `evidence_photo_task_rules`
BEGIN
    DECLARE file_owner CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE file_person CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    SELECT `pendingOwnerId`, `createdByUserId` INTO file_owner, file_person
      FROM `stored_file`
     WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`fileId`;
    IF file_person IS NULL OR file_person <> NEW.`createdByUserId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the file is of another person';
    END IF;
    IF NEW.`purpose` = 'task_photo' AND (file_owner IS NULL OR file_owner <> NEW.`warehouseTaskId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the photo was taken for another record';
    END IF;
    IF file_owner IS NOT NULL
       AND file_owner <> COALESCE(NEW.`warehouseTaskId`, NEW.`incidentId`, NEW.`processStepId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the photo was taken for another record';
    END IF;
END;

-- What a photo was taken for never changes.
CREATE TRIGGER `stored_file_pending_owner_keep` BEFORE UPDATE ON `stored_file` FOR EACH ROW
BEGIN
    IF NOT (OLD.`pendingOwnerId` <=> NEW.`pendingOwnerId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stored_file: what a photo was taken for never changes';
    END IF;
END;
