-- WMS-57 (ADR 0055): solicitudes de compra, y el almacén de la orden de compra.
-- Solo expansión: dos columnas que admiten NULL en purchase_order (las órdenes
-- que ya existen quedan «de toda la empresa») y dos tablas nuevas.
-- AlterTable
ALTER TABLE `purchase_order` ADD COLUMN `facilityId` CHAR(36) NULL,
    ADD COLUMN `purchaseRequestId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `purchase_request` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `neededOn` DATE NULL,
    `notes` VARCHAR(500) NULL,
    `requestedByUserId` CHAR(36) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedByUserId` CHAR(36) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectedByUserId` CHAR(36) NULL,
    `rejectReason` VARCHAR(500) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `convertedAt` DATETIME(3) NULL,
    `convertedByUserId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `purchase_request_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    INDEX `purchase_request_organizationId_requestedByUserId_number_idx`(`organizationId`, `requestedByUserId`, `number`),
    UNIQUE INDEX `purchase_request_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `purchase_request_organizationId_number_key`(`organizationId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_request_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `capturedQuantity` DECIMAL(12, 3) NOT NULL,
    `presentationId` CHAR(36) NULL,
    `presentationVersionId` CHAR(36) NULL,
    `factor` DECIMAL(18, 6) NOT NULL,
    `baseQuantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `purchase_request_line_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `purchase_request_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `purchase_request_line_organizationId_requestId_lineNumber_key`(`organizationId`, `requestId`, `lineNumber`),
    UNIQUE INDEX `purchase_request_line_organizationId_requestId_productId_key`(`organizationId`, `requestId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `purchase_order_organizationId_facilityId_number_idx` ON `purchase_order`(`organizationId`, `facilityId`, `number`);

-- CreateIndex
CREATE INDEX `purchase_order_organizationId_purchaseRequestId_idx` ON `purchase_order`(`organizationId`, `purchaseRequestId`);

-- AddForeignKey
ALTER TABLE `purchase_order` ADD CONSTRAINT `purchase_order_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `purchase_order` ADD CONSTRAINT `purchase_order_organizationId_purchaseRequestId_fkey` FOREIGN KEY (`organizationId`, `purchaseRequestId`) REFERENCES `purchase_request`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `purchase_request` ADD CONSTRAINT `purchase_request_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request` ADD CONSTRAINT `purchase_request_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_organizationId_requestId_fkey` FOREIGN KEY (`organizationId`, `requestId`) REFERENCES `purchase_request`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_organizationId_productId_presentation_fkey` FOREIGN KEY (`organizationId`, `productId`, `presentationId`) REFERENCES `product_presentation`(`organizationId`, `productId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_organizationId_presentationId_present_fkey` FOREIGN KEY (`organizationId`, `presentationId`, `presentationVersionId`) REFERENCES `presentation_version`(`organizationId`, `presentationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Números desde 1; cantidades positivas y la equivalencia exacta, como en la orden.
ALTER TABLE `purchase_request` ADD CONSTRAINT `purchase_request_number_check` CHECK (`number` >= 1);
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_quantities_check` CHECK (
    `capturedQuantity` > 0 AND `factor` > 0 AND `baseQuantity` > 0
    AND `baseQuantity` = `capturedQuantity` * `factor`
    AND `lineNumber` >= 1
);
ALTER TABLE `purchase_request_line` ADD CONSTRAINT `purchase_request_line_capture_check` CHECK (
    (`presentationId` IS NULL AND `presentationVersionId` IS NULL AND `factor` = 1)
    OR (`presentationId` IS NOT NULL AND `presentationVersionId` IS NOT NULL)
);

-- Cada estado con sus datos.
ALTER TABLE `purchase_request` ADD CONSTRAINT `purchase_request_state_check` CHECK (
    (`status` = 'DRAFT' AND `submittedAt` IS NULL AND `approvedAt` IS NULL AND `rejectedAt` IS NULL AND `cancelledAt` IS NULL AND `convertedAt` IS NULL)
    OR (`status` = 'SUBMITTED' AND `submittedAt` IS NOT NULL AND `approvedAt` IS NULL AND `rejectedAt` IS NULL AND `cancelledAt` IS NULL AND `convertedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `submittedAt` IS NOT NULL AND `approvedAt` IS NOT NULL AND `rejectedAt` IS NULL AND `cancelledAt` IS NULL AND `convertedAt` IS NULL)
    OR (`status` = 'REJECTED' AND `submittedAt` IS NOT NULL AND `rejectedAt` IS NOT NULL AND `rejectedByUserId` IS NOT NULL AND CHAR_LENGTH(TRIM(COALESCE(`rejectReason`, ''))) > 0 AND `cancelledAt` IS NULL AND `convertedAt` IS NULL)
    OR (`status` = 'CONVERTED' AND `approvedAt` IS NOT NULL AND `convertedAt` IS NOT NULL AND `convertedByUserId` IS NOT NULL AND `rejectedAt` IS NULL AND `cancelledAt` IS NULL)
    OR (`status` = 'CANCELLED' AND `cancelledAt` IS NOT NULL AND `approvedAt` IS NULL AND `rejectedAt` IS NULL AND `convertedAt` IS NULL)
);

-- Las transiciones de PURCHASE_REQUEST_TRANSITIONS (request-states.ts): cambiar
-- una exige cambiar la otra. Número, almacén y quién la pidió no cambian.
CREATE TRIGGER `purchase_request_transition` BEFORE UPDATE ON `purchase_request` FOR EACH ROW
BEGIN
    IF NEW.`status` <> OLD.`status` AND NOT (
        (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('SUBMITTED', 'APPROVED', 'CANCELLED'))
        OR (OLD.`status` = 'SUBMITTED' AND NEW.`status` IN ('APPROVED', 'REJECTED', 'CANCELLED'))
        OR (OLD.`status` = 'APPROVED' AND NEW.`status` IN ('CONVERTED', 'REJECTED'))
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request: invalid state transition';
    END IF;
    IF NEW.`number` <> OLD.`number` OR NEW.`facilityId` <> OLD.`facilityId`
        OR NEW.`requestedByUserId` <> OLD.`requestedByUserId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request: number, warehouse and requester cannot change';
    END IF;
END;

-- Una solicitud no se borra.
CREATE TRIGGER `purchase_request_no_delete` BEFORE DELETE ON `purchase_request` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request: requests are never deleted';
END;

-- Las líneas solo cambian mientras su solicitud es un borrador.
CREATE TRIGGER `purchase_request_line_draft_insert` BEFORE INSERT ON `purchase_request_line` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `purchase_request` WHERE `id` = NEW.`requestId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request_line: the request is not a draft';
    END IF;
END;

CREATE TRIGGER `purchase_request_line_draft_update` BEFORE UPDATE ON `purchase_request_line` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `purchase_request` WHERE `id` = OLD.`requestId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request_line: the request is not a draft';
    END IF;
END;

CREATE TRIGGER `purchase_request_line_draft_delete` BEFORE DELETE ON `purchase_request_line` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `purchase_request` WHERE `id` = OLD.`requestId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request_line: the request is not a draft';
    END IF;
END;

-- El almacén de una orden y la solicitud de la que viene no cambian.
CREATE TRIGGER `purchase_order_origin` BEFORE UPDATE ON `purchase_order` FOR EACH ROW
BEGIN
    IF NOT (NEW.`facilityId` <=> OLD.`facilityId`)
        OR NOT (NEW.`purchaseRequestId` <=> OLD.`purchaseRequestId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_order: warehouse and request cannot change';
    END IF;
END;
