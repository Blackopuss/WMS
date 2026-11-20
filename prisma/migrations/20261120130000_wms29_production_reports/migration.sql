-- AlterTable
ALTER TABLE `evidence_photo` ADD COLUMN `productionReportId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN', 'STATUS_CHANGE', 'SHIPMENT', 'CUSTOMER_RETURN', 'FACILITY_TRANSFER', 'DISPOSAL', 'PRODUCTION') NOT NULL;

-- CreateTable
CREATE TABLE `production_report` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `movementId` CHAR(36) NOT NULL,
    `goodQuantity` DECIMAL(12, 3) NOT NULL,
    `badQuantity` DECIMAL(12, 3) NOT NULL,
    `badReason` VARCHAR(300) NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `lotCode` VARCHAR(60) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reversedAt` DATETIME(3) NULL,
    `reversedByUserId` CHAR(36) NULL,
    `reverseReason` VARCHAR(300) NULL,
    `reversalMovementId` CHAR(36) NULL,

    INDEX `production_report_organizationId_createdByUserId_createdAt_idx`(`organizationId`, `createdByUserId`, `createdAt`),
    INDEX `production_report_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `production_report_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_report_organizationId_orderId_number_key`(`organizationId`, `orderId`, `number`),
    UNIQUE INDEX `production_report_organizationId_movementId_key`(`organizationId`, `movementId`),
    UNIQUE INDEX `production_report_organizationId_reversalMovementId_key`(`organizationId`, `reversalMovementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_report_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `reportId` CHAR(36) NOT NULL,
    `kind` ENUM('INPUT', 'OUTPUT') NOT NULL,
    `orderLineId` CHAR(36) NULL,
    `orderOutputId` CHAR(36) NULL,
    `movementLineId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `reservedQuantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `production_report_line_organizationId_reportId_idx`(`organizationId`, `reportId`),
    INDEX `production_report_line_organizationId_orderLineId_idx`(`organizationId`, `orderLineId`),
    INDEX `production_report_line_organizationId_orderOutputId_idx`(`organizationId`, `orderOutputId`),
    UNIQUE INDEX `production_report_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_report_line_organizationId_movementLineId_key`(`organizationId`, `movementLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_scrap` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `orderLineId` CHAR(36) NOT NULL,
    `movementId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `production_scrap_organizationId_orderId_createdAt_idx`(`organizationId`, `orderId`, `createdAt`),
    INDEX `production_scrap_organizationId_orderLineId_idx`(`organizationId`, `orderLineId`),
    UNIQUE INDEX `production_scrap_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_scrap_organizationId_movementId_key`(`organizationId`, `movementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_lot_numbering` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `prefix` VARCHAR(12) NOT NULL DEFAULT '',
    `dateFormat` VARCHAR(8) NOT NULL DEFAULT 'NONE',
    `digits` INTEGER NOT NULL DEFAULT 4,
    `resetEvery` VARCHAR(8) NOT NULL DEFAULT 'NEVER',
    `sequenceScope` VARCHAR(8) NOT NULL DEFAULT 'PRODUCT',
    `updatedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `production_lot_numbering_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_lot_numbering_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_lot_sequence` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `scopeKey` VARCHAR(36) NOT NULL,
    `period` VARCHAR(6) NOT NULL,
    `lastNumber` INTEGER NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `production_lot_sequence_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_lot_sequence_organizationId_scopeKey_period_key`(`organizationId`, `scopeKey`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `evidence_photo_organizationId_productionReportId_position_idx` ON `evidence_photo`(`organizationId`, `productionReportId`, `position`);

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_productionReportId_fkey` FOREIGN KEY (`organizationId`, `productionReportId`) REFERENCES `production_report`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report` ADD CONSTRAINT `production_report_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_report` ADD CONSTRAINT `production_report_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `production_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report` ADD CONSTRAINT `production_report_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report` ADD CONSTRAINT `production_report_organizationId_reversalMovementId_fkey` FOREIGN KEY (`organizationId`, `reversalMovementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report_line` ADD CONSTRAINT `production_report_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_report_line` ADD CONSTRAINT `production_report_line_organizationId_reportId_fkey` FOREIGN KEY (`organizationId`, `reportId`) REFERENCES `production_report`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report_line` ADD CONSTRAINT `production_report_line_organizationId_orderLineId_fkey` FOREIGN KEY (`organizationId`, `orderLineId`) REFERENCES `production_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report_line` ADD CONSTRAINT `production_report_line_organizationId_orderOutputId_fkey` FOREIGN KEY (`organizationId`, `orderOutputId`) REFERENCES `production_order_output`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_report_line` ADD CONSTRAINT `production_report_line_organizationId_movementLineId_fkey` FOREIGN KEY (`organizationId`, `movementLineId`) REFERENCES `stock_movement_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_scrap` ADD CONSTRAINT `production_scrap_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_scrap` ADD CONSTRAINT `production_scrap_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `production_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_scrap` ADD CONSTRAINT `production_scrap_organizationId_orderLineId_fkey` FOREIGN KEY (`organizationId`, `orderLineId`) REFERENCES `production_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_scrap` ADD CONSTRAINT `production_scrap_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_lot_numbering` ADD CONSTRAINT `production_lot_numbering_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_lot_sequence` ADD CONSTRAINT `production_lot_sequence_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── WMS-29 (ADR 0087): reglas en la base ────────────────────────────────

-- Un reporte de producción: materiales salen disponibles; lo producido
-- entra siempre en inspección (PC-5).
CREATE TRIGGER `stock_movement_line_production_rule` BEFORE INSERT ON `stock_movement_line` FOR EACH ROW
BEGIN
  IF (SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) = 'PRODUCTION'
     AND NOT ((NEW.`direction` = 'OUT' AND NEW.`status` = 'AVAILABLE')
              OR (NEW.`direction` = 'IN' AND NEW.`status` = 'INSPECTION')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a production report takes available materials and makes stock in inspection';
  END IF;
END;

ALTER TABLE `production_report`
    ADD CONSTRAINT `production_report_number` CHECK (`number` > 0),
    ADD CONSTRAINT `production_report_quantities` CHECK (`goodQuantity` >= 0 AND `badQuantity` >= 0 AND `goodQuantity` + `badQuantity` > 0),
    ADD CONSTRAINT `production_report_bad_reason` CHECK (`badQuantity` = 0 OR (`badReason` IS NOT NULL AND CHAR_LENGTH(TRIM(`badReason`)) >= 3)),
    ADD CONSTRAINT `production_report_reversed` CHECK ((`reversedAt` IS NULL) = (`reversedByUserId` IS NULL)
        AND (`reversedAt` IS NULL) = (`reversalMovementId` IS NULL)
        AND (`reversedAt` IS NULL) = (`reverseReason` IS NULL)),
    ADD CONSTRAINT `production_report_reverse_reason` CHECK (`reverseReason` IS NULL OR CHAR_LENGTH(TRIM(`reverseReason`)) >= 3);

CREATE TRIGGER `production_report_insert_rule` BEFORE INSERT ON `production_report` FOR EACH ROW
BEGIN
  IF NOT ((SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) <=> 'PRODUCTION') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: its movement is a PRODUCTION movement';
  END IF;
  IF NEW.`reversedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: a report is born not reversed';
  END IF;
END;

-- Solo se marca una vez como revertido; nada más cambia.
CREATE TRIGGER `production_report_update_rule` BEFORE UPDATE ON `production_report` FOR EACH ROW
BEGIN
  IF NOT (NEW.`orderId` <=> OLD.`orderId` AND NEW.`number` <=> OLD.`number`
          AND NEW.`movementId` <=> OLD.`movementId` AND NEW.`goodQuantity` <=> OLD.`goodQuantity`
          AND NEW.`badQuantity` <=> OLD.`badQuantity` AND NEW.`badReason` <=> OLD.`badReason`
          AND NEW.`unitCode` <=> OLD.`unitCode` AND NEW.`lotCode` <=> OLD.`lotCode`
          AND NEW.`createdByUserId` <=> OLD.`createdByUserId` AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: a report does not change';
  END IF;
  IF OLD.`reversedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: a report is reversed once';
  END IF;
  IF NEW.`reversalMovementId` IS NOT NULL
     AND NOT ((SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`reversalMovementId`) <=> 'REVERSAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: its reversal is a REVERSAL movement';
  END IF;
END;

CREATE TRIGGER `production_report_no_delete` BEFORE DELETE ON `production_report` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: never deleted';

ALTER TABLE `production_report_line`
    ADD CONSTRAINT `production_report_line_owner` CHECK ((`kind` = 'INPUT' AND `orderLineId` IS NOT NULL AND `orderOutputId` IS NULL)
        OR (`kind` = 'OUTPUT' AND `orderOutputId` IS NOT NULL AND `orderLineId` IS NULL AND `reservedQuantity` = 0)),
    ADD CONSTRAINT `production_report_line_quantity` CHECK (`quantity` > 0 AND `reservedQuantity` >= 0 AND `reservedQuantity` <= `quantity`);

CREATE TRIGGER `production_report_line_no_update` BEFORE UPDATE ON `production_report_line` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report_line: never changes';
CREATE TRIGGER `production_report_line_no_delete` BEFORE DELETE ON `production_report_line` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report_line: never deleted';

ALTER TABLE `production_scrap`
    ADD CONSTRAINT `production_scrap_quantity` CHECK (`quantity` > 0),
    ADD CONSTRAINT `production_scrap_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3);

CREATE TRIGGER `production_scrap_insert_rule` BEFORE INSERT ON `production_scrap` FOR EACH ROW
BEGIN
  IF NOT ((SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) <=> 'DISPOSAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_scrap: its movement is a DISPOSAL movement';
  END IF;
END;
CREATE TRIGGER `production_scrap_no_update` BEFORE UPDATE ON `production_scrap` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_scrap: never changes';
CREATE TRIGGER `production_scrap_no_delete` BEFORE DELETE ON `production_scrap` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_scrap: never deleted';

ALTER TABLE `production_lot_numbering`
    ADD CONSTRAINT `production_lot_numbering_prefix` CHECK (REGEXP_LIKE(`prefix`, '^[A-Za-z0-9-]{0,12}$', 'c')),
    ADD CONSTRAINT `production_lot_numbering_date` CHECK (`dateFormat` IN ('NONE', 'YYYY', 'YYMM', 'YYMMDD')),
    ADD CONSTRAINT `production_lot_numbering_digits` CHECK (`digits` BETWEEN 3 AND 6),
    ADD CONSTRAINT `production_lot_numbering_reset` CHECK (`resetEvery` IN ('NEVER', 'YEAR', 'MONTH')),
    ADD CONSTRAINT `production_lot_numbering_scope` CHECK (`sequenceScope` IN ('PRODUCT', 'COMPANY'));
CREATE TRIGGER `production_lot_numbering_no_delete` BEFORE DELETE ON `production_lot_numbering` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_numbering: never deleted';

ALTER TABLE `production_lot_sequence`
    ADD CONSTRAINT `production_lot_sequence_number` CHECK (`lastNumber` > 0);
CREATE TRIGGER `production_lot_sequence_up` BEFORE UPDATE ON `production_lot_sequence` FOR EACH ROW
BEGIN
  IF NOT (NEW.`scopeKey` <=> OLD.`scopeKey` AND NEW.`period` <=> OLD.`period`) OR NEW.`lastNumber` <= OLD.`lastNumber` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_sequence: a consecutive only goes up';
  END IF;
END;
CREATE TRIGGER `production_lot_sequence_no_delete` BEFORE DELETE ON `production_lot_sequence` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_sequence: never deleted';

-- Una foto tiene un solo dueño, cada uno con su propósito.
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_one_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_one_owner`
    CHECK ((`incidentId` IS NOT NULL) + (`processStepId` IS NOT NULL)
           + (`warehouseTaskId` IS NOT NULL) + (`purchaseReceiptId` IS NOT NULL)
           + (`productionReportId` IS NOT NULL) = 1);
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_purpose_of_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_purpose_of_owner`
    CHECK ((`incidentId` IS NULL OR `purpose` = 'incident_photo')
       AND (`processStepId` IS NULL OR `purpose` = 'process_step_photo')
       AND (`warehouseTaskId` IS NULL OR `purpose` = 'task_photo')
       AND (`purchaseReceiptId` IS NULL OR `purpose` = 'receipt_rejection_photo')
       AND (`productionReportId` IS NULL OR `purpose` = 'production_report_photo'));

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
       AND file_owner <> COALESCE(NEW.`warehouseTaskId`, NEW.`incidentId`, NEW.`processStepId`, NEW.`purchaseReceiptId`, NEW.`productionReportId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence_photo: the photo was taken for another record';
    END IF;
END;
