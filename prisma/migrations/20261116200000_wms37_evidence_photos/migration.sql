-- AlterTable
ALTER TABLE `stored_file` ADD COLUMN `height` INTEGER NULL,
    ADD COLUMN `width` INTEGER NULL;

-- CreateTable
CREATE TABLE `evidence_photo` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `fileId` CHAR(36) NOT NULL,
    `purpose` VARCHAR(40) NOT NULL,
    `incidentId` CHAR(36) NULL,
    `incidentNoteId` CHAR(36) NULL,
    `position` INTEGER NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `evidence_photo_organizationId_incidentId_position_idx`(`organizationId`, `incidentId`, `position`),
    INDEX `evidence_photo_organizationId_incidentNoteId_idx`(`organizationId`, `incidentNoteId`),
    UNIQUE INDEX `evidence_photo_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `evidence_photo_organizationId_fileId_key`(`organizationId`, `fileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `stored_file_organizationId_createdByUserId_purpose_createdAt_idx` ON `stored_file`(`organizationId`, `createdByUserId`, `purpose`, `createdAt`);

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_fileId_fkey` FOREIGN KEY (`organizationId`, `fileId`) REFERENCES `stored_file`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_incidentId_fkey` FOREIGN KEY (`organizationId`, `incidentId`) REFERENCES `incident`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_incidentNoteId_fkey` FOREIGN KEY (`organizationId`, `incidentNoteId`) REFERENCES `incident_note`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- WMS-37 (ADR 0063): exactly one owner. A step that adds a kind of record
-- adds its column and rebuilds this CHECK adding it to the sum.
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_one_owner`
    CHECK ((`incidentId` IS NOT NULL) = 1);
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_note_of_incident`
    CHECK (`incidentNoteId` IS NULL OR `incidentId` IS NOT NULL);
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_position`
    CHECK (`position` >= 0);
ALTER TABLE `stored_file` ADD CONSTRAINT `stored_file_image_size`
    CHECK ((`width` IS NULL AND `height` IS NULL) OR (`width` > 0 AND `height` > 0));

-- The file must exist, not removed, with the same purpose; a note must be
-- of the same incident.
CREATE TRIGGER `evidence_photo_insert_rules` BEFORE INSERT ON `evidence_photo` FOR EACH ROW
BEGIN
    DECLARE file_purpose VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE file_removed DATETIME(3);
    DECLARE note_incident CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    SELECT `purpose`, `deletedAt` INTO file_purpose, file_removed
      FROM `stored_file`
     WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`fileId`;
    IF file_purpose IS NULL OR file_removed IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the file does not exist';
    END IF;
    IF file_purpose <> NEW.`purpose` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the file is of another purpose';
    END IF;
    IF NEW.`incidentNoteId` IS NOT NULL THEN
        SELECT `incidentId` INTO note_incident
          FROM `incident_note`
         WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`incidentNoteId`;
        IF note_incident IS NULL OR note_incident <> NEW.`incidentId` THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the note is of another incident';
        END IF;
    END IF;
END;

CREATE TRIGGER `evidence_photo_no_update` BEFORE UPDATE ON `evidence_photo` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: evidence never changes';
END;

CREATE TRIGGER `evidence_photo_no_delete` BEFORE DELETE ON `evidence_photo` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: evidence is never deleted';
END;

-- A file linked as evidence is never removed nor changed.
CREATE TRIGGER `stored_file_evidence_keep` BEFORE UPDATE ON `stored_file` FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM `evidence_photo`
                WHERE `organizationId` = OLD.`organizationId` AND `fileId` = OLD.`id`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stored_file: a file linked as evidence never changes';
    END IF;
END;
