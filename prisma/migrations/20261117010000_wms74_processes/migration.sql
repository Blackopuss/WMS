-- AlterTable
ALTER TABLE `evidence_photo` ADD COLUMN `processStepId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `process_definition` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `documentKey` VARCHAR(80) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `process_definition_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `process_definition_organizationId_documentKey_key`(`organizationId`, `documentKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_version` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `definitionId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `draftKey` CHAR(36) NULL,
    `currentKey` CHAR(36) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `publishedByUserId` CHAR(36) NULL,
    `publishedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,

    UNIQUE INDEX `process_version_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `process_version_organizationId_definitionId_number_key`(`organizationId`, `definitionId`, `number`),
    UNIQUE INDEX `process_version_organizationId_draftKey_key`(`organizationId`, `draftKey`),
    UNIQUE INDEX `process_version_organizationId_currentKey_key`(`organizationId`, `currentKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_stage` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
    `parentStageId` CHAR(36) NULL,
    `position` INTEGER NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `kind` ENUM('MANUAL', 'OPERATION') NOT NULL,
    `operationKey` VARCHAR(80) NULL,
    `milestoneKey` VARCHAR(40) NOT NULL,
    `childOrder` ENUM('IN_ORDER', 'ANY') NOT NULL DEFAULT 'IN_ORDER',
    `noteEvidence` ENUM('NONE', 'OPTIONAL', 'REQUIRED') NOT NULL DEFAULT 'NONE',
    `photoEvidence` ENUM('NONE', 'OPTIONAL', 'REQUIRED') NOT NULL DEFAULT 'NONE',
    `quantityEvidence` ENUM('NONE', 'OPTIONAL', 'REQUIRED') NOT NULL DEFAULT 'NONE',
    `allowSkip` BOOLEAN NOT NULL DEFAULT false,
    `allowBack` BOOLEAN NOT NULL DEFAULT false,
    `zoneOnly` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `process_stage_organizationId_versionId_position_idx`(`organizationId`, `versionId`, `position`),
    UNIQUE INDEX `process_stage_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_stage_role` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `stageId` CHAR(36) NOT NULL,
    `role` VARCHAR(40) NOT NULL,

    UNIQUE INDEX `process_stage_role_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `process_stage_role_organizationId_stageId_role_key`(`organizationId`, `stageId`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_progress` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `documentKey` VARCHAR(80) NOT NULL,
    `documentId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NULL,
    `milestoneKey` VARCHAR(40) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `status` ENUM('ACTIVE', 'DONE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,

    INDEX `process_progress_organizationId_status_facilityId_idx`(`organizationId`, `status`, `facilityId`),
    UNIQUE INDEX `process_progress_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `process_progress_organizationId_documentKey_documentId_key`(`organizationId`, `documentKey`, `documentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_stage_state` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `progressId` CHAR(36) NOT NULL,
    `stageId` CHAR(36) NOT NULL,
    `kind` ENUM('MANUAL', 'OPERATION') NOT NULL,
    `status` ENUM('WAITING', 'READY', 'DONE', 'SKIPPED') NOT NULL DEFAULT 'WAITING',
    `takenByUserId` CHAR(36) NULL,
    `takenAt` DATETIME(3) NULL,
    `assignedByUserId` CHAR(36) NULL,
    `readyAt` DATETIME(3) NULL,
    `doneAt` DATETIME(3) NULL,
    `doneByUserId` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `process_stage_state_organizationId_status_kind_takenByUserId_idx`(`organizationId`, `status`, `kind`, `takenByUserId`, `readyAt`, `id`),
    UNIQUE INDEX `process_stage_state_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `process_stage_state_organizationId_progressId_stageId_key`(`organizationId`, `progressId`, `stageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_step` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `progressId` CHAR(36) NOT NULL,
    `stageId` CHAR(36) NOT NULL,
    `action` ENUM('COMPLETED', 'OPERATION', 'SKIPPED', 'BACK', 'TAKEN', 'RELEASED', 'ASSIGNED') NOT NULL,
    `actorUserId` CHAR(36) NULL,
    `assigneeUserId` CHAR(36) NULL,
    `note` VARCHAR(500) NULL,
    `quantity` DECIMAL(18, 3) NULL,
    `device` VARCHAR(120) NULL,
    `idempotencyKey` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `process_step_organizationId_progressId_createdAt_id_idx`(`organizationId`, `progressId`, `createdAt`, `id`),
    UNIQUE INDEX `process_step_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `process_step_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `evidence_photo_organizationId_processStepId_position_idx` ON `evidence_photo`(`organizationId`, `processStepId`, `position`);

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_processStepId_fkey` FOREIGN KEY (`organizationId`, `processStepId`) REFERENCES `process_step`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_definition` ADD CONSTRAINT `process_definition_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_version` ADD CONSTRAINT `process_version_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_version` ADD CONSTRAINT `process_version_organizationId_definitionId_fkey` FOREIGN KEY (`organizationId`, `definitionId`) REFERENCES `process_definition`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_stage` ADD CONSTRAINT `process_stage_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_stage` ADD CONSTRAINT `process_stage_organizationId_versionId_fkey` FOREIGN KEY (`organizationId`, `versionId`) REFERENCES `process_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_stage` ADD CONSTRAINT `process_stage_organizationId_parentStageId_fkey` FOREIGN KEY (`organizationId`, `parentStageId`) REFERENCES `process_stage`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_stage_role` ADD CONSTRAINT `process_stage_role_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_stage_role` ADD CONSTRAINT `process_stage_role_organizationId_stageId_fkey` FOREIGN KEY (`organizationId`, `stageId`) REFERENCES `process_stage`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_progress` ADD CONSTRAINT `process_progress_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_progress` ADD CONSTRAINT `process_progress_organizationId_versionId_fkey` FOREIGN KEY (`organizationId`, `versionId`) REFERENCES `process_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_progress` ADD CONSTRAINT `process_progress_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_progress` ADD CONSTRAINT `process_progress_organizationId_facilityId_locationId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `locationId`) REFERENCES `location`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_stage_state` ADD CONSTRAINT `process_stage_state_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_stage_state` ADD CONSTRAINT `process_stage_state_organizationId_progressId_fkey` FOREIGN KEY (`organizationId`, `progressId`) REFERENCES `process_progress`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_stage_state` ADD CONSTRAINT `process_stage_state_organizationId_stageId_fkey` FOREIGN KEY (`organizationId`, `stageId`) REFERENCES `process_stage`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_step` ADD CONSTRAINT `process_step_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `process_step` ADD CONSTRAINT `process_step_organizationId_progressId_fkey` FOREIGN KEY (`organizationId`, `progressId`) REFERENCES `process_progress`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `process_step` ADD CONSTRAINT `process_step_organizationId_stageId_fkey` FOREIGN KEY (`organizationId`, `stageId`) REFERENCES `process_stage`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- WMS-74 (ADR 0069): a photo of evidence has exactly one owner; a step of a
-- process is the second kind. Its purpose is its own.
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_one_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_one_owner`
    CHECK ((`incidentId` IS NOT NULL) + (`processStepId` IS NOT NULL) = 1);
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_purpose_of_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_purpose_of_owner`
    CHECK ((`incidentId` IS NULL OR `purpose` = 'incident_photo')
       AND (`processStepId` IS NULL OR `purpose` = 'process_step_photo'));

-- One draft and one version in force per definition, named by its keys.
ALTER TABLE `process_version` ADD CONSTRAINT `process_version_keys` CHECK (
    (`status` = 'DRAFT') = (`draftKey` IS NOT NULL)
    AND (`status` = 'PUBLISHED') = (`currentKey` IS NOT NULL)
    AND (`draftKey` IS NULL OR `draftKey` = `definitionId`)
    AND (`currentKey` IS NULL OR `currentKey` = `definitionId`)
    AND `number` >= 1
);
ALTER TABLE `process_stage` ADD CONSTRAINT `process_stage_shape` CHECK (
    (`kind` = 'OPERATION') = (`operationKey` IS NOT NULL)
    AND `position` >= 0
    AND CHAR_LENGTH(TRIM(`name`)) > 0
    AND (`parentStageId` IS NULL OR `parentStageId` <> `id`)
    AND (`kind` = 'MANUAL' OR (`noteEvidence` = 'NONE' AND `photoEvidence` = 'NONE'
         AND `quantityEvidence` = 'NONE' AND `allowSkip` = FALSE AND `allowBack` = FALSE))
);
ALTER TABLE `process_stage_state` ADD CONSTRAINT `process_stage_state_taken` CHECK (
    `takenByUserId` IS NULL OR (`status` = 'READY' AND `kind` = 'MANUAL')
);
ALTER TABLE `process_step` ADD CONSTRAINT `process_step_values` CHECK (
    (`quantity` IS NULL OR `quantity` > 0)
    AND (`assigneeUserId` IS NULL OR `action` = 'ASSIGNED')
);

-- The states of a version: DRAFT → PUBLISHED → RETIRED
-- (PROCESS_VERSION_TRANSITIONS of src/platform/processes/states.ts; change
-- both together). What a version is never changes.
CREATE TRIGGER `process_version_transition` BEFORE UPDATE ON `process_version` FOR EACH ROW
BEGIN
    IF NEW.`definitionId` <> OLD.`definitionId` OR NEW.`number` <> OLD.`number`
       OR NEW.`createdByUserId` <> OLD.`createdByUserId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_version: a version does not change of process';
    END IF;
    IF OLD.`status` <> NEW.`status` AND NOT (
        (OLD.`status` = 'DRAFT' AND NEW.`status` = 'PUBLISHED')
        OR (OLD.`status` = 'PUBLISHED' AND NEW.`status` = 'RETIRED')
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_version: transition not allowed';
    END IF;
    IF OLD.`status` = 'RETIRED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_version: a retired version never changes';
    END IF;
END;

CREATE TRIGGER `process_version_no_delete` BEFORE DELETE ON `process_version` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_version: versions are never deleted';
END;

CREATE TRIGGER `process_definition_keep` BEFORE UPDATE ON `process_definition` FOR EACH ROW
BEGIN
    IF NEW.`documentKey` <> OLD.`documentKey` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_definition: the document never changes';
    END IF;
END;

CREATE TRIGGER `process_definition_no_delete` BEFORE DELETE ON `process_definition` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_definition: never deleted';
END;

-- Stages and their roles change only while their version is a draft.
CREATE TRIGGER `process_stage_insert_draft` BEFORE INSERT ON `process_stage` FOR EACH ROW
BEGIN
    DECLARE version_status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE parent_version CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE parent_parent CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    SELECT `status` INTO version_status FROM `process_version`
     WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`versionId`;
    IF version_status IS NULL OR version_status <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage: only a draft changes';
    END IF;
    IF NEW.`parentStageId` IS NOT NULL THEN
        SELECT `versionId`, `parentStageId` INTO parent_version, parent_parent FROM `process_stage`
         WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`parentStageId`;
        IF parent_version IS NULL OR parent_version <> NEW.`versionId` OR parent_parent IS NOT NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage: a sub-stage goes in a stage of the same version, two levels';
        END IF;
    END IF;
END;

CREATE TRIGGER `process_stage_update_draft` BEFORE UPDATE ON `process_stage` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_version`
                    WHERE `organizationId` = OLD.`organizationId` AND `id` = OLD.`versionId`
                      AND `status` = 'DRAFT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage: only a draft changes';
    END IF;
    IF NEW.`versionId` <> OLD.`versionId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage: a stage does not change of version';
    END IF;
END;

CREATE TRIGGER `process_stage_delete_draft` BEFORE DELETE ON `process_stage` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_version`
                    WHERE `organizationId` = OLD.`organizationId` AND `id` = OLD.`versionId`
                      AND `status` = 'DRAFT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage: only a draft changes';
    END IF;
END;

CREATE TRIGGER `process_stage_role_insert_draft` BEFORE INSERT ON `process_stage_role` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_stage` s JOIN `process_version` v
                      ON v.`organizationId` = s.`organizationId` AND v.`id` = s.`versionId`
                    WHERE s.`organizationId` = NEW.`organizationId` AND s.`id` = NEW.`stageId`
                      AND v.`status` = 'DRAFT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage_role: only a draft changes';
    END IF;
END;

CREATE TRIGGER `process_stage_role_no_update` BEFORE UPDATE ON `process_stage_role` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage_role: replaced, never changed';
END;

CREATE TRIGGER `process_stage_role_delete_draft` BEFORE DELETE ON `process_stage_role` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_stage` s JOIN `process_version` v
                      ON v.`organizationId` = s.`organizationId` AND v.`id` = s.`versionId`
                    WHERE s.`organizationId` = OLD.`organizationId` AND s.`id` = OLD.`stageId`
                      AND v.`status` = 'DRAFT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage_role: only a draft changes';
    END IF;
END;

-- A document starts its process only on a published version, and keeps
-- its document and version for ever (P11).
CREATE TRIGGER `process_progress_insert_rules` BEFORE INSERT ON `process_progress` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_version`
                    WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`versionId`
                      AND `status` = 'PUBLISHED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_progress: only a published version starts';
    END IF;
END;

CREATE TRIGGER `process_progress_keep` BEFORE UPDATE ON `process_progress` FOR EACH ROW
BEGIN
    IF NEW.`documentKey` <> OLD.`documentKey` OR NEW.`documentId` <> OLD.`documentId`
       OR NEW.`versionId` <> OLD.`versionId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_progress: document and version never change';
    END IF;
END;

CREATE TRIGGER `process_progress_no_delete` BEFORE DELETE ON `process_progress` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_progress: never deleted';
END;

CREATE TRIGGER `process_stage_state_insert_rules` BEFORE INSERT ON `process_stage_state` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_stage` s JOIN `process_progress` p
                      ON p.`organizationId` = s.`organizationId` AND p.`versionId` = s.`versionId`
                    WHERE s.`organizationId` = NEW.`organizationId` AND s.`id` = NEW.`stageId`
                      AND p.`id` = NEW.`progressId` AND s.`kind` = NEW.`kind`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage_state: a stage of the version of its process';
    END IF;
END;

CREATE TRIGGER `process_stage_state_keep` BEFORE UPDATE ON `process_stage_state` FOR EACH ROW
BEGIN
    IF NEW.`progressId` <> OLD.`progressId` OR NEW.`stageId` <> OLD.`stageId` OR NEW.`kind` <> OLD.`kind` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage_state: its stage never changes';
    END IF;
END;

CREATE TRIGGER `process_stage_state_no_delete` BEFORE DELETE ON `process_stage_state` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_stage_state: never deleted';
END;

-- The trail never changes nor goes away, and its stage is of its version.
CREATE TRIGGER `process_step_insert_rules` BEFORE INSERT ON `process_step` FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM `process_stage` s JOIN `process_progress` p
                      ON p.`organizationId` = s.`organizationId` AND p.`versionId` = s.`versionId`
                    WHERE s.`organizationId` = NEW.`organizationId` AND s.`id` = NEW.`stageId`
                      AND p.`id` = NEW.`progressId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_step: a stage of the version of its process';
    END IF;
END;

CREATE TRIGGER `process_step_no_update` BEFORE UPDATE ON `process_step` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_step: the trail never changes';
END;

CREATE TRIGGER `process_step_no_delete` BEFORE DELETE ON `process_step` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'process_step: the trail is never deleted';
END;
