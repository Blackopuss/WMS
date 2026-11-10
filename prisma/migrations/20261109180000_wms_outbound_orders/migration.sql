-- WMS-13 (especificación 5.2): pedidos de salida. Documento de almacén, sin
-- precios ni cobro (ADR 0032).

-- CreateTable
CREATE TABLE `outbound_order` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'RELEASED', 'PICKING', 'PICKED', 'PACKED', 'SHIPPED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `priority` ENUM('NORMAL', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `recipient` VARCHAR(160) NOT NULL,
    `address` VARCHAR(300) NULL,
    `reference` VARCHAR(120) NULL,
    `dueOn` DATE NULL,
    `note` VARCHAR(500) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,
    `releasedByUserId` CHAR(36) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `cancelReason` VARCHAR(300) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `outbound_order_organizationId_status_number_idx`(`organizationId`, `status`, `number`),
    UNIQUE INDEX `outbound_order_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `outbound_order_organizationId_number_key`(`organizationId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outbound_order_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `outbound_order_line_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `outbound_order_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `outbound_order_line_organizationId_orderId_lineNumber_key`(`organizationId`, `orderId`, `lineNumber`),
    UNIQUE INDEX `outbound_order_line_organizationId_orderId_productId_key`(`organizationId`, `orderId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `outbound_order` ADD CONSTRAINT `outbound_order_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outbound_order_line` ADD CONSTRAINT `outbound_order_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outbound_order_line` ADD CONSTRAINT `outbound_order_line_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_order_line` ADD CONSTRAINT `outbound_order_line_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE `outbound_order`
  ADD CONSTRAINT `outbound_order_number` CHECK (`number` > 0),
  ADD CONSTRAINT `outbound_order_recipient` CHECK (CHAR_LENGTH(TRIM(`recipient`)) >= 1),
  ADD CONSTRAINT `outbound_order_released` CHECK (`status` = 'DRAFT' OR `status` = 'CANCELLED' OR `releasedAt` IS NOT NULL),
  ADD CONSTRAINT `outbound_order_cancelled` CHECK ((`status` = 'CANCELLED') = (`cancelledAt` IS NOT NULL AND `cancelReason` IS NOT NULL));
ALTER TABLE `outbound_order_line`
  ADD CONSTRAINT `outbound_order_line_quantity` CHECK (`quantity` > 0 AND `lineNumber` > 0);

-- Nace borrador; no se borra.
CREATE TRIGGER `outbound_order_insert_rules` BEFORE INSERT ON `outbound_order` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order starts as a draft';
  END IF;
END;

CREATE TRIGGER `outbound_order_no_delete` BEFORE DELETE ON `outbound_order` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order cannot be deleted';

-- Número y autor no cambian; el encabezado solo cambia en borrador; solo
-- avanza por OUTBOUND_ORDER_TRANSITIONS (outbound-states.ts): cambiar una
-- exige cambiar la otra.
CREATE TRIGGER `outbound_order_transition` BEFORE UPDATE ON `outbound_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order identity is immutable';
  END IF;
  IF OLD.`status` <> 'DRAFT' AND NOT (NEW.`recipient` <=> OLD.`recipient`
      AND NEW.`address` <=> OLD.`address`
      AND NEW.`reference` <=> OLD.`reference`
      AND NEW.`dueOn` <=> OLD.`dueOn`
      AND NEW.`priority` <=> OLD.`priority`
      AND NEW.`note` <=> OLD.`note`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order header only changes in draft';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (
       (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('RELEASED', 'CANCELLED'))
    OR (OLD.`status` = 'RELEASED' AND NEW.`status` IN ('PICKING', 'CANCELLED'))
    OR (OLD.`status` = 'PICKING' AND NEW.`status` = 'PICKED')
    OR (OLD.`status` = 'PICKED' AND NEW.`status` = 'PACKED')
    OR (OLD.`status` = 'PACKED' AND NEW.`status` = 'SHIPPED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order transition not allowed';
  END IF;
  IF OLD.`status` IN ('SHIPPED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order is closed';
  END IF;
END;

-- Las líneas solo se escriben mientras el pedido es borrador.
CREATE TRIGGER `outbound_order_line_insert_draft` BEFORE INSERT ON `outbound_order_line` FOR EACH ROW
BEGIN
  IF (SELECT `status` FROM `outbound_order` WHERE `id` = NEW.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order_line only changes in draft';
  END IF;
END;

CREATE TRIGGER `outbound_order_line_update_draft` BEFORE UPDATE ON `outbound_order_line` FOR EACH ROW
BEGIN
  IF NOT (NEW.`orderId` <=> OLD.`orderId` AND NEW.`organizationId` <=> OLD.`organizationId`)
     OR (SELECT `status` FROM `outbound_order` WHERE `id` = OLD.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order_line only changes in draft';
  END IF;
END;

CREATE TRIGGER `outbound_order_line_delete_draft` BEFORE DELETE ON `outbound_order_line` FOR EACH ROW
BEGIN
  IF (SELECT `status` FROM `outbound_order` WHERE `id` = OLD.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order_line only changes in draft';
  END IF;
END;
