-- AlterTable
ALTER TABLE `evidence_photo` ADD COLUMN `qualityInspectionId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `quality_inspection` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `stockStatus` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL,
    `lotId` CHAR(36) NULL,
    `origin` ENUM('PRODUCTION', 'RECEIPT', 'CUSTOMER_RETURN', 'OTHER') NOT NULL,
    `productionReportId` CHAR(36) NULL,
    `productionReportLineId` CHAR(36) NULL,
    `purchaseReceiptLineId` CHAR(36) NULL,
    `customerReturnLineId` CHAR(36) NULL,
    `openKey` CHAR(36) NULL,
    `expectedQuantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `holdId` CHAR(36) NULL,
    `byQuality` BOOLEAN NOT NULL,
    `planVersionId` CHAR(36) NULL,
    `sampling` VARCHAR(8) NULL,
    `checkedQuantity` DECIMAL(12, 3) NULL,
    `countedQuantity` DECIMAL(12, 3) NULL,
    `state` ENUM('OPEN', 'DECIDED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `startKey` VARCHAR(64) NOT NULL,
    `decideKey` VARCHAR(64) NULL,
    `note` VARCHAR(500) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedByUserId` CHAR(36) NULL,
    `decidedAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(300) NULL,

    INDEX `quality_inspection_organizationId_facilityId_state_id_idx`(`organizationId`, `facilityId`, `state`, `id`),
    INDEX `quality_inspection_organizationId_productionReportId_idx`(`organizationId`, `productionReportId`),
    INDEX `quality_inspection_organizationId_productionReportLineId_idx`(`organizationId`, `productionReportLineId`),
    INDEX `quality_inspection_organizationId_purchaseReceiptLineId_idx`(`organizationId`, `purchaseReceiptLineId`),
    INDEX `quality_inspection_organizationId_customerReturnLineId_idx`(`organizationId`, `customerReturnLineId`),
    UNIQUE INDEX `quality_inspection_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_inspection_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `quality_inspection_organizationId_openKey_key`(`organizationId`, `openKey`),
    UNIQUE INDEX `quality_inspection_organizationId_startKey_key`(`organizationId`, `startKey`),
    UNIQUE INDEX `quality_inspection_organizationId_decideKey_key`(`organizationId`, `decideKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_inspection_result` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `inspectionId` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `kind` ENUM('OUTCOME', 'MISSING') NOT NULL,
    `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NULL,
    `cause` VARCHAR(16) NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `reason` VARCHAR(300) NULL,
    `locationId` CHAR(36) NULL,
    `movementId` CHAR(36) NOT NULL,

    INDEX `quality_inspection_result_organizationId_movementId_idx`(`organizationId`, `movementId`),
    UNIQUE INDEX `quality_inspection_result_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_inspection_result_organizationId_inspectionId_positi_key`(`organizationId`, `inspectionId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_inspection_answer` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `inspectionId` CHAR(36) NOT NULL,
    `pointId` CHAR(36) NOT NULL,
    `answer` VARCHAR(500) NULL,
    `result` VARCHAR(8) NOT NULL,

    UNIQUE INDEX `quality_inspection_answer_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_inspection_answer_organizationId_inspectionId_pointI_key`(`organizationId`, `inspectionId`, `pointId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_inspection_defect` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `inspectionId` CHAR(36) NOT NULL,
    `defectId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,

    INDEX `quality_inspection_defect_organizationId_defectId_idx`(`organizationId`, `defectId`),
    UNIQUE INDEX `quality_inspection_defect_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_inspection_defect_organizationId_inspectionId_defect_key`(`organizationId`, `inspectionId`, `defectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `evidence_photo_organizationId_qualityInspectionId_position_idx` ON `evidence_photo`(`organizationId`, `qualityInspectionId`, `position`);

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_qualityInspectionId_fkey` FOREIGN KEY (`organizationId`, `qualityInspectionId`) REFERENCES `quality_inspection`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_productionReportLineId_fkey` FOREIGN KEY (`organizationId`, `productionReportLineId`) REFERENCES `production_report_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_purchaseReceiptLineId_fkey` FOREIGN KEY (`organizationId`, `purchaseReceiptLineId`) REFERENCES `purchase_receipt_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_customerReturnLineId_fkey` FOREIGN KEY (`organizationId`, `customerReturnLineId`) REFERENCES `customer_return_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection` ADD CONSTRAINT `quality_inspection_organizationId_planVersionId_fkey` FOREIGN KEY (`organizationId`, `planVersionId`) REFERENCES `quality_plan_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_result` ADD CONSTRAINT `quality_inspection_result_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_inspection_result` ADD CONSTRAINT `quality_inspection_result_organizationId_inspectionId_fkey` FOREIGN KEY (`organizationId`, `inspectionId`) REFERENCES `quality_inspection`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_result` ADD CONSTRAINT `quality_inspection_result_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_result` ADD CONSTRAINT `quality_inspection_result_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_answer` ADD CONSTRAINT `quality_inspection_answer_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_inspection_answer` ADD CONSTRAINT `quality_inspection_answer_organizationId_inspectionId_fkey` FOREIGN KEY (`organizationId`, `inspectionId`) REFERENCES `quality_inspection`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_answer` ADD CONSTRAINT `quality_inspection_answer_organizationId_pointId_fkey` FOREIGN KEY (`organizationId`, `pointId`) REFERENCES `quality_plan_point`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_defect` ADD CONSTRAINT `quality_inspection_defect_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_inspection_defect` ADD CONSTRAINT `quality_inspection_defect_organizationId_inspectionId_fkey` FOREIGN KEY (`organizationId`, `inspectionId`) REFERENCES `quality_inspection`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_inspection_defect` ADD CONSTRAINT `quality_inspection_defect_organizationId_defectId_fkey` FOREIGN KEY (`organizationId`, `defectId`) REFERENCES `quality_defect`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── WMS-30B (ADR 0091): reglas en la base ───────────────────────────────

ALTER TABLE `quality_inspection`
    ADD CONSTRAINT `quality_inspection_number` CHECK (`number` > 0),
    ADD CONSTRAINT `quality_inspection_stock_status` CHECK (`stockStatus` IN ('INSPECTION', 'QUARANTINE')),
    ADD CONSTRAINT `quality_inspection_expected` CHECK (`expectedQuantity` > 0),
    ADD CONSTRAINT `quality_inspection_origin_line` CHECK (
        (`origin` = 'PRODUCTION' AND `productionReportLineId` IS NOT NULL AND `productionReportId` IS NOT NULL
            AND `purchaseReceiptLineId` IS NULL AND `customerReturnLineId` IS NULL)
     OR (`origin` = 'RECEIPT' AND `purchaseReceiptLineId` IS NOT NULL AND `productionReportLineId` IS NULL
            AND `productionReportId` IS NULL AND `customerReturnLineId` IS NULL)
     OR (`origin` = 'CUSTOMER_RETURN' AND `customerReturnLineId` IS NOT NULL AND `productionReportLineId` IS NULL
            AND `productionReportId` IS NULL AND `purchaseReceiptLineId` IS NULL)
     OR (`origin` = 'OTHER' AND `productionReportLineId` IS NULL AND `productionReportId` IS NULL
            AND `purchaseReceiptLineId` IS NULL AND `customerReturnLineId` IS NULL)),
    ADD CONSTRAINT `quality_inspection_quarantine_other` CHECK (`stockStatus` = 'INSPECTION' OR `origin` = 'OTHER'),
    ADD CONSTRAINT `quality_inspection_without_quality` CHECK (`byQuality` OR `origin` = 'PRODUCTION'),
    ADD CONSTRAINT `quality_inspection_open_key` CHECK (`openKey` IS NULL OR `state` = 'OPEN'),
    ADD CONSTRAINT `quality_inspection_decided` CHECK (
        (`state` = 'DECIDED') = (`decidedAt` IS NOT NULL)
        AND (`decidedAt` IS NULL) = (`decidedByUserId` IS NULL)
        AND (`decidedAt` IS NULL) = (`decideKey` IS NULL)
        AND (`decidedAt` IS NULL) = (`countedQuantity` IS NULL)
        AND (`countedQuantity` IS NULL OR (`countedQuantity` >= 0 AND `countedQuantity` <= `expectedQuantity`))
        AND (`checkedQuantity` IS NULL OR (`checkedQuantity` >= 0 AND `checkedQuantity` <= `countedQuantity`))),
    ADD CONSTRAINT `quality_inspection_cancelled` CHECK (
        (`state` = 'CANCELLED') = (`cancelledAt` IS NOT NULL)
        AND (`cancelledAt` IS NULL) = (`cancelledByUserId` IS NULL)
        AND (`cancelledAt` IS NULL) = (`cancelReason` IS NULL)
        AND (`cancelReason` IS NULL OR CHAR_LENGTH(TRIM(`cancelReason`)) >= 3));

-- Nace abierta; solo cambia de OPEN a DECIDED o CANCELLED, una vez
-- (INSPECTION_TRANSITIONS de inspection-states.ts: cambian juntas).
CREATE TRIGGER `quality_inspection_insert_rule` BEFORE INSERT ON `quality_inspection` FOR EACH ROW
BEGIN
  IF NEW.`state` <> 'OPEN' OR NEW.`decidedAt` IS NOT NULL OR NEW.`cancelledAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection: a verification is born open';
  END IF;
END;

CREATE TRIGGER `quality_inspection_transition` BEFORE UPDATE ON `quality_inspection` FOR EACH ROW
BEGIN
  IF NOT (NEW.`number` <=> OLD.`number` AND NEW.`facilityId` <=> OLD.`facilityId`
          AND NEW.`productId` <=> OLD.`productId` AND NEW.`locationId` <=> OLD.`locationId`
          AND NEW.`stockStatus` <=> OLD.`stockStatus` AND NEW.`lotId` <=> OLD.`lotId`
          AND NEW.`origin` <=> OLD.`origin` AND NEW.`productionReportId` <=> OLD.`productionReportId`
          AND NEW.`productionReportLineId` <=> OLD.`productionReportLineId`
          AND NEW.`purchaseReceiptLineId` <=> OLD.`purchaseReceiptLineId`
          AND NEW.`customerReturnLineId` <=> OLD.`customerReturnLineId`
          AND NEW.`expectedQuantity` <=> OLD.`expectedQuantity` AND NEW.`unitCode` <=> OLD.`unitCode`
          AND NEW.`holdId` <=> OLD.`holdId` AND NEW.`byQuality` <=> OLD.`byQuality`
          AND NEW.`startKey` <=> OLD.`startKey`
          AND NEW.`createdByUserId` <=> OLD.`createdByUserId` AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection: what a verification covers never changes';
  END IF;
  IF OLD.`state` <> 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection: a decided or cancelled verification never changes';
  END IF;
  IF NEW.`state` NOT IN ('DECIDED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection: from open only to decided or cancelled';
  END IF;
  IF NEW.`openKey` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection: a closed verification frees its origin line';
  END IF;
END;

CREATE TRIGGER `quality_inspection_no_delete` BEFORE DELETE ON `quality_inspection` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection: never deleted';

ALTER TABLE `quality_inspection_result`
    ADD CONSTRAINT `quality_inspection_result_quantity` CHECK (`quantity` > 0),
    ADD CONSTRAINT `quality_inspection_result_kind` CHECK (
        (`kind` = 'OUTCOME' AND `status` IN ('AVAILABLE', 'REJECTED', 'DAMAGED', 'QUARANTINE', 'REPAIR') AND `cause` IS NULL)
     OR (`kind` = 'MISSING' AND `status` IS NULL AND `cause` IN ('MERMA', 'OVER_REPORTED', 'OTHER')
            AND `reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reason`)) >= 3));

-- Un resultado se escribe con la decisión, sobre una verificación abierta
-- (se decide en la misma transacción), y con el movimiento que lo hizo.
CREATE TRIGGER `quality_inspection_result_insert_rule` BEFORE INSERT ON `quality_inspection_result` FOR EACH ROW
BEGIN
  IF NOT ((SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`)
          <=> IF(NEW.`kind` = 'OUTCOME', 'STATUS_CHANGE', 'DISPOSAL')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_result: a destination is a change of state, a missing piece a disposal';
  END IF;
END;
CREATE TRIGGER `quality_inspection_result_no_update` BEFORE UPDATE ON `quality_inspection_result` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_result: never changes';
CREATE TRIGGER `quality_inspection_result_no_delete` BEFORE DELETE ON `quality_inspection_result` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_result: never deleted';

ALTER TABLE `quality_inspection_answer`
    ADD CONSTRAINT `quality_inspection_answer_result` CHECK (`result` IN ('pass', 'fail', 'noted', 'skipped'));
CREATE TRIGGER `quality_inspection_answer_no_update` BEFORE UPDATE ON `quality_inspection_answer` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_answer: never changes';
CREATE TRIGGER `quality_inspection_answer_no_delete` BEFORE DELETE ON `quality_inspection_answer` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_answer: never deleted';

ALTER TABLE `quality_inspection_defect`
    ADD CONSTRAINT `quality_inspection_defect_quantity` CHECK (`quantity` > 0);
CREATE TRIGGER `quality_inspection_defect_no_update` BEFORE UPDATE ON `quality_inspection_defect` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_defect: never changes';
CREATE TRIGGER `quality_inspection_defect_no_delete` BEFORE DELETE ON `quality_inspection_defect` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_inspection_defect: never deleted';

-- Una foto tiene un solo dueño, cada uno con su propósito (versión de
-- WMS-29 más la verificación).
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_one_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_one_owner`
    CHECK ((`incidentId` IS NOT NULL) + (`processStepId` IS NOT NULL)
           + (`warehouseTaskId` IS NOT NULL) + (`purchaseReceiptId` IS NOT NULL)
           + (`productionReportId` IS NOT NULL) + (`qualityInspectionId` IS NOT NULL) = 1);
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_purpose_of_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_purpose_of_owner`
    CHECK ((`incidentId` IS NULL OR `purpose` = 'incident_photo')
       AND (`processStepId` IS NULL OR `purpose` = 'process_step_photo')
       AND (`warehouseTaskId` IS NULL OR `purpose` = 'task_photo')
       AND (`purchaseReceiptId` IS NULL OR `purpose` = 'receipt_rejection_photo')
       AND (`productionReportId` IS NULL OR `purpose` = 'production_report_photo')
       AND (`qualityInspectionId` IS NULL OR `purpose` IN ('quality_inspection_photo', 'production_verification_photo')));

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
    IF NEW.`purpose` IN ('quality_inspection_photo', 'production_verification_photo')
       AND (file_owner IS NULL OR file_owner <> NEW.`qualityInspectionId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the photo was taken for another record';
    END IF;
    IF file_owner IS NOT NULL
       AND file_owner <> COALESCE(NEW.`warehouseTaskId`, NEW.`incidentId`, NEW.`processStepId`, NEW.`purchaseReceiptId`, NEW.`productionReportId`, NEW.`qualityInspectionId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the photo was taken for another record';
    END IF;
END;
