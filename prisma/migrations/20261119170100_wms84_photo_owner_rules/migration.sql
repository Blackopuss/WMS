-- WMS-84 (ADR 0079), review: the rule that a photo taken for a record is
-- linked only to that record (WMS-37B) also names the receipt as an owner.
-- Same trigger, one more owner in its COALESCE.

DROP TRIGGER `evidence_photo_owner_rules`;
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
       AND file_owner <> COALESCE(NEW.`warehouseTaskId`, NEW.`incidentId`, NEW.`processStepId`, NEW.`purchaseReceiptId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the photo was taken for another record';
    END IF;
END;
