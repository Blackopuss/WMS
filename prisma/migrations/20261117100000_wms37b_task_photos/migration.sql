-- WMS-37B (ADR 0076): a photo of where a warehouse task was left. A task is
-- the third kind of owner of a photo of evidence. Expansion only: nothing
-- that exists changes.

-- AlterTable
ALTER TABLE `evidence_photo` ADD COLUMN `warehouseTaskId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `evidence_photo_organizationId_warehouseTaskId_position_idx` ON `evidence_photo`(`organizationId`, `warehouseTaskId`, `position`);

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_warehouseTaskId_fkey` FOREIGN KEY (`organizationId`, `warehouseTaskId`) REFERENCES `warehouse_task`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Exactly one owner, and each owner with its own purpose.
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_one_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_one_owner`
    CHECK ((`incidentId` IS NOT NULL) + (`processStepId` IS NOT NULL)
           + (`warehouseTaskId` IS NOT NULL) = 1);
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_purpose_of_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_purpose_of_owner`
    CHECK ((`incidentId` IS NULL OR `purpose` = 'incident_photo')
       AND (`processStepId` IS NULL OR `purpose` = 'process_step_photo')
       AND (`warehouseTaskId` IS NULL OR `purpose` = 'task_photo'));

-- A photo of a task is linked only to a delivered task, by the person who
-- had it (the delivery links its photos in its own transaction, after
-- writing the task as delivered).
CREATE TRIGGER `evidence_photo_task_rules` BEFORE INSERT ON `evidence_photo` FOR EACH ROW
FOLLOWS `evidence_photo_insert_rules`
BEGIN
    DECLARE task_status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE task_person CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    IF NEW.`warehouseTaskId` IS NOT NULL THEN
        SELECT `status`, `assignedToUserId` INTO task_status, task_person
          FROM `warehouse_task`
         WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`warehouseTaskId`;
        IF task_status IS NULL OR task_status <> 'DELIVERED' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the task is not delivered';
        END IF;
        IF task_person IS NULL OR task_person <> NEW.`createdByUserId` THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the task is of another person';
        END IF;
    END IF;
END;
