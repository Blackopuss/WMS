-- WMS-30-0 (ADR 0068): inspeccionar al recibir, desechar lo dañado o
-- rechazado y retención genérica de existencias no disponibles.
-- Solo expansión: una columna con valor por omisión, un valor más de un
-- ENUM, un CHECK más amplio, dos tablas nuevas y disparadores.

-- AlterTable
ALTER TABLE `product` ADD COLUMN `inspectOnReceipt` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN', 'STATUS_CHANGE', 'SHIPMENT', 'CUSTOMER_RETURN', 'FACILITY_TRANSFER', 'DISPOSAL') NOT NULL;

-- CreateTable
CREATE TABLE `stock_hold` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL,
    `lotId` CHAR(36) NULL,
    `lotKey` CHAR(36) NOT NULL DEFAULT '',
    `quantity` DECIMAL(12, 3) NOT NULL,
    `remaining` DECIMAL(12, 3) NOT NULL,
    `state` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `sourceType` VARCHAR(40) NOT NULL,
    `sourceId` CHAR(36) NOT NULL,
    `sourceText` VARCHAR(40) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,

    INDEX `stock_hold_organizationId_productId_locationId_state_idx`(`organizationId`, `productId`, `locationId`, `state`),
    INDEX `stock_hold_organizationId_sourceType_sourceId_idx`(`organizationId`, `sourceType`, `sourceId`),
    UNIQUE INDEX `stock_hold_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_hold_unit` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `holdId` CHAR(36) NOT NULL,
    `serialUnitId` CHAR(36) NOT NULL,
    `releasedAt` DATETIME(3) NULL,

    INDEX `stock_hold_unit_organizationId_serialUnitId_idx`(`organizationId`, `serialUnitId`),
    UNIQUE INDEX `stock_hold_unit_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `stock_hold_unit_organizationId_holdId_serialUnitId_key`(`organizationId`, `holdId`, `serialUnitId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_hold` ADD CONSTRAINT `stock_hold_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_hold` ADD CONSTRAINT `stock_hold_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_hold` ADD CONSTRAINT `stock_hold_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_hold` ADD CONSTRAINT `stock_hold_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_hold_unit` ADD CONSTRAINT `stock_hold_unit_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_hold_unit` ADD CONSTRAINT `stock_hold_unit_organizationId_holdId_fkey` FOREIGN KEY (`organizationId`, `holdId`) REFERENCES `stock_hold`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_hold_unit` ADD CONSTRAINT `stock_hold_unit_organizationId_serialUnitId_fkey` FOREIGN KEY (`organizationId`, `serialUnitId`) REFERENCES `serial_unit`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Lo sano de un producto que se inspecciona al recibir entra en inspección.
ALTER TABLE `purchase_receipt_line` DROP CHECK `purchase_receipt_line_status`;
ALTER TABLE `purchase_receipt_line`
  ADD CONSTRAINT `purchase_receipt_line_status` CHECK (`status` IN ('AVAILABLE', 'DAMAGED', 'INSPECTION'));

-- Desechar siempre lleva motivo.
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_disposal_reason_check` CHECK (
    `type` <> 'DISPOSAL' OR (`reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reason`)) >= 3)
);

-- Una retención es de existencias no disponibles, con su lote, entera al
-- nacer y nunca por debajo de cero.
ALTER TABLE `stock_hold`
  ADD CONSTRAINT `stock_hold_not_available` CHECK (`status` <> 'AVAILABLE'),
  ADD CONSTRAINT `stock_hold_lot_key` CHECK (`lotKey` = COALESCE(`lotId`, '')),
  ADD CONSTRAINT `stock_hold_quantity` CHECK (`quantity` > 0 AND `remaining` >= 0 AND `remaining` <= `quantity`),
  ADD CONSTRAINT `stock_hold_closed` CHECK ((`state` = 'CLOSED') = (`remaining` = 0)),
  ADD CONSTRAINT `stock_hold_source_text` CHECK (CHAR_LENGTH(TRIM(`sourceText`)) >= 1);

CREATE TRIGGER `stock_hold_insert_rules` BEFORE INSERT ON `stock_hold` FOR EACH ROW
BEGIN
  IF NEW.`state` <> 'ACTIVE' OR NEW.`remaining` <> NEW.`quantity` OR NEW.`closedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold starts active and whole';
  END IF;
END;

-- Lo retenido y su documento no cambian; lo que queda solo baja; una
-- retención cerrada no se reabre. No se borra.
CREATE TRIGGER `stock_hold_update_rules` BEFORE UPDATE ON `stock_hold` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`locationId` <=> OLD.`locationId`
      AND NEW.`status` <=> OLD.`status`
      AND NEW.`lotId` <=> OLD.`lotId`
      AND NEW.`lotKey` <=> OLD.`lotKey`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`sourceType` <=> OLD.`sourceType`
      AND NEW.`sourceId` <=> OLD.`sourceId`
      AND NEW.`sourceText` <=> OLD.`sourceText`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold is immutable but its remaining';
  END IF;
  IF NEW.`remaining` > OLD.`remaining` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold remaining only goes down';
  END IF;
  IF OLD.`state` = 'CLOSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold is closed';
  END IF;
END;

CREATE TRIGGER `stock_hold_no_delete` BEFORE DELETE ON `stock_hold` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold cannot be deleted';

-- Una unidad retenida nace sin soltar y se suelta una sola vez.
CREATE TRIGGER `stock_hold_unit_insert_rules` BEFORE INSERT ON `stock_hold_unit` FOR EACH ROW
BEGIN
  IF NEW.`releasedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold_unit starts held';
  END IF;
END;

CREATE TRIGGER `stock_hold_unit_update_rules` BEFORE UPDATE ON `stock_hold_unit` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`holdId` <=> OLD.`holdId`
      AND NEW.`serialUnitId` <=> OLD.`serialUnitId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold_unit is immutable but its release';
  END IF;
  IF OLD.`releasedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold_unit is already released';
  END IF;
END;

CREATE TRIGGER `stock_hold_unit_no_delete` BEFORE DELETE ON `stock_hold_unit` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_hold_unit cannot be deleted';
