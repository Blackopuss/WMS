-- WMS-84 (ADR 0079): what is rejected at the door when receiving. It never
-- enters the stock: a receipt may now have no movement (everything was
-- rejected). Expansion only: nothing that exists changes.

-- AlterTable
ALTER TABLE `evidence_photo` ADD COLUMN `purchaseReceiptId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `purchase_receipt` MODIFY `movementId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `purchase_receipt_rejection` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `receiptId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `orderLineId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `lotCode` VARCHAR(80) NULL,
    `serials` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `purchase_receipt_rejection_organizationId_orderLineId_idx`(`organizationId`, `orderLineId`),
    INDEX `purchase_receipt_rejection_organizationId_productId_createdA_idx`(`organizationId`, `productId`, `createdAt`),
    INDEX `purchase_receipt_rejection_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `purchase_receipt_rejection_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `purchase_receipt_rejection_organizationId_receiptId_lineNumb_key`(`organizationId`, `receiptId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `evidence_photo_organizationId_purchaseReceiptId_position_idx` ON `evidence_photo`(`organizationId`, `purchaseReceiptId`, `position`);

-- AddForeignKey
ALTER TABLE `purchase_receipt_rejection` ADD CONSTRAINT `purchase_receipt_rejection_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_receipt_rejection` ADD CONSTRAINT `purchase_receipt_rejection_organizationId_receiptId_fkey` FOREIGN KEY (`organizationId`, `receiptId`) REFERENCES `purchase_receipt`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_receipt_rejection` ADD CONSTRAINT `purchase_receipt_rejection_organizationId_orderLineId_fkey` FOREIGN KEY (`organizationId`, `orderLineId`) REFERENCES `purchase_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_receipt_rejection` ADD CONSTRAINT `purchase_receipt_rejection_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_organizationId_purchaseReceiptId_fkey` FOREIGN KEY (`organizationId`, `purchaseReceiptId`) REFERENCES `purchase_receipt`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- A rejection says why, and rejects something of one line.
ALTER TABLE `purchase_receipt_rejection` ADD CONSTRAINT `purchase_receipt_rejection_check` CHECK (
    `quantity` > 0 AND `lineNumber` >= 1 AND CHAR_LENGTH(TRIM(`reason`)) >= 3
);

-- History: never edited nor deleted.
CREATE TRIGGER `purchase_receipt_rejection_no_update` BEFORE UPDATE ON `purchase_receipt_rejection` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_receipt_rejection is immutable';
CREATE TRIGGER `purchase_receipt_rejection_no_delete` BEFORE DELETE ON `purchase_receipt_rejection` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_receipt_rejection is immutable';

-- It rejects a line of the same order, of the same product. Reads the
-- order line (immutable once sent) and its own receipt (written in the same
-- transaction): no lock another operation waits for.
CREATE TRIGGER `purchase_receipt_rejection_matches_order` BEFORE INSERT ON `purchase_receipt_rejection` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `purchase_order_line` AS ol
        JOIN `purchase_receipt` AS r ON r.`organizationId` = NEW.`organizationId` AND r.`id` = NEW.`receiptId`
        WHERE ol.`organizationId` = NEW.`organizationId`
            AND ol.`id` = NEW.`orderLineId`
            AND ol.`orderId` = r.`orderId`
            AND ol.`productId` = NEW.`productId`
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_receipt_rejection: not a line of the order, or another product';
    END IF;
END;

-- A receipt without movement is one that only rejected; with one, it is a
-- receipt movement (as before).
DROP TRIGGER `purchase_receipt_order_state`;
CREATE TRIGGER `purchase_receipt_order_state` BEFORE INSERT ON `purchase_receipt` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `purchase_order` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`orderId`) NOT IN ('SENT', 'PARTIAL') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_receipt: the order is not waiting to be received';
    END IF;
    IF NEW.`movementId` IS NOT NULL
       AND (SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) <> 'RECEIPT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_receipt: the movement is not a receipt';
    END IF;
END;

-- A photo has exactly one owner, each with its own purpose.
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_one_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_one_owner`
    CHECK ((`incidentId` IS NOT NULL) + (`processStepId` IS NOT NULL)
           + (`warehouseTaskId` IS NOT NULL) + (`purchaseReceiptId` IS NOT NULL) = 1);
ALTER TABLE `evidence_photo` DROP CHECK `evidence_photo_purpose_of_owner`;
ALTER TABLE `evidence_photo` ADD CONSTRAINT `evidence_photo_purpose_of_owner`
    CHECK ((`incidentId` IS NULL OR `purpose` = 'incident_photo')
       AND (`processStepId` IS NULL OR `purpose` = 'process_step_photo')
       AND (`warehouseTaskId` IS NULL OR `purpose` = 'task_photo')
       AND (`purchaseReceiptId` IS NULL OR `purpose` = 'receipt_rejection_photo'));
