-- WMS-17 (ADR 0046): devoluciones de clientes. Lo que un cliente regresa
-- entra con un movimiento propio (CUSTOMER_RETURN), siempre en inspección;
-- cada decisión (disponible, dañado o rechazado) es un cambio de estado
-- ligado a la devolución. Solo expansión: un valor nuevo del tipo de
-- movimiento, tres tablas nuevas y sus reglas.

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN', 'STATUS_CHANGE', 'SHIPMENT', 'CUSTOMER_RETURN') NOT NULL;

-- CreateTable
CREATE TABLE `customer_return` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('RECEIVED', 'RESOLVED') NOT NULL DEFAULT 'RECEIVED',
    `facilityId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NULL,
    `returnedBy` VARCHAR(160) NOT NULL,
    `reason` VARCHAR(300) NOT NULL,
    `note` VARCHAR(500) NULL,
    `movementId` CHAR(36) NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,

    INDEX `customer_return_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    INDEX `customer_return_organizationId_orderId_idx`(`organizationId`, `orderId`),
    UNIQUE INDEX `customer_return_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `customer_return_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `customer_return_organizationId_movementId_key`(`organizationId`, `movementId`),
    UNIQUE INDEX `customer_return_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_return_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `returnId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `lotId` CHAR(36) NULL,
    `orderLineId` CHAR(36) NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `serials` TEXT NULL,
    `movementLineId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `customer_return_line_organizationId_orderLineId_idx`(`organizationId`, `orderLineId`),
    INDEX `customer_return_line_organizationId_productId_idx`(`organizationId`, `productId`),
    INDEX `customer_return_line_organizationId_lotId_idx`(`organizationId`, `lotId`),
    UNIQUE INDEX `customer_return_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `customer_return_line_organizationId_returnId_lineNumber_key`(`organizationId`, `returnId`, `lineNumber`),
    UNIQUE INDEX `customer_return_line_organizationId_movementLineId_key`(`organizationId`, `movementLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_return_decision` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `returnId` CHAR(36) NOT NULL,
    `lineId` CHAR(36) NOT NULL,
    `outcome` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `movementId` CHAR(36) NOT NULL,
    `decidedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `customer_return_decision_organizationId_returnId_id_idx`(`organizationId`, `returnId`, `id`),
    INDEX `customer_return_decision_organizationId_lineId_idx`(`organizationId`, `lineId`),
    UNIQUE INDEX `customer_return_decision_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `customer_return_decision_organizationId_movementId_key`(`organizationId`, `movementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `customer_return` ADD CONSTRAINT `customer_return_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_return` ADD CONSTRAINT `customer_return_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return` ADD CONSTRAINT `customer_return_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return` ADD CONSTRAINT `customer_return_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return` ADD CONSTRAINT `customer_return_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_line` ADD CONSTRAINT `customer_return_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_return_line` ADD CONSTRAINT `customer_return_line_organizationId_returnId_fkey` FOREIGN KEY (`organizationId`, `returnId`) REFERENCES `customer_return`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_line` ADD CONSTRAINT `customer_return_line_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_line` ADD CONSTRAINT `customer_return_line_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_line` ADD CONSTRAINT `customer_return_line_organizationId_orderLineId_fkey` FOREIGN KEY (`organizationId`, `orderLineId`) REFERENCES `outbound_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_line` ADD CONSTRAINT `customer_return_line_organizationId_movementLineId_fkey` FOREIGN KEY (`organizationId`, `movementLineId`) REFERENCES `stock_movement_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_decision` ADD CONSTRAINT `customer_return_decision_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_return_decision` ADD CONSTRAINT `customer_return_decision_organizationId_returnId_fkey` FOREIGN KEY (`organizationId`, `returnId`) REFERENCES `customer_return`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_decision` ADD CONSTRAINT `customer_return_decision_organizationId_lineId_fkey` FOREIGN KEY (`organizationId`, `lineId`) REFERENCES `customer_return_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_decision` ADD CONSTRAINT `customer_return_decision_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_return_decision` ADD CONSTRAINT `customer_return_decision_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Reglas de los datos.
ALTER TABLE `customer_return`
    ADD CONSTRAINT `customer_return_number` CHECK (`number` > 0),
    ADD CONSTRAINT `customer_return_resolved` CHECK ((`status` = 'RESOLVED') = (`resolvedAt` IS NOT NULL)),
    ADD CONSTRAINT `customer_return_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3),
    ADD CONSTRAINT `customer_return_returned_by` CHECK (CHAR_LENGTH(TRIM(`returnedBy`)) >= 1);

ALTER TABLE `customer_return_line`
    ADD CONSTRAINT `customer_return_line_quantity` CHECK (`quantity` > 0);

ALTER TABLE `customer_return_decision`
    ADD CONSTRAINT `customer_return_decision_outcome` CHECK (`outcome` IN ('AVAILABLE', 'DAMAGED', 'REJECTED')),
    ADD CONSTRAINT `customer_return_decision_quantity` CHECK (`quantity` > 0),
    ADD CONSTRAINT `customer_return_decision_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3);

-- Lo que entra con una devolución de cliente entra siempre en inspección.
CREATE TRIGGER `stock_movement_line_customer_return_rule` BEFORE INSERT ON `stock_movement_line` FOR EACH ROW
BEGIN
  IF (SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) = 'CUSTOMER_RETURN'
     AND NOT (NEW.`direction` = 'IN' AND NEW.`status` = 'INSPECTION') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a customer return enters into inspection';
  END IF;
END;

-- Una devolución se escribe con su entrada (CUSTOMER_RETURN).
CREATE TRIGGER `customer_return_insert_rule` BEFORE INSERT ON `customer_return` FOR EACH ROW
BEGIN
  IF NOT ((SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) <=> 'CUSTOMER_RETURN') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the entry of a customer return is a CUSTOMER_RETURN movement';
  END IF;
  IF NEW.`status` <> 'RECEIVED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a customer return is born received';
  END IF;
END;

-- Estados de la devolución (CUSTOMER_RETURN_TRANSITIONS de
-- customer-return-states.ts): recibida → resuelta; nada más cambia.
CREATE TRIGGER `customer_return_transition` BEFORE UPDATE ON `customer_return` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`facilityId` <=> OLD.`facilityId`
      AND NEW.`locationId` <=> OLD.`locationId`
      AND NEW.`orderId` <=> OLD.`orderId`
      AND NEW.`returnedBy` <=> OLD.`returnedBy`
      AND NEW.`reason` <=> OLD.`reason`
      AND NEW.`note` <=> OLD.`note`
      AND NEW.`movementId` <=> OLD.`movementId`
      AND NEW.`idempotencyKey` <=> OLD.`idempotencyKey`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return is immutable';
  END IF;
  IF OLD.`status` <> 'RECEIVED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return is resolved';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NEW.`status` <> 'RESOLVED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return transition not allowed';
  END IF;
  IF NEW.`status` = 'RESOLVED' AND EXISTS (SELECT 1 FROM `customer_return_line` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`returnId` = NEW.`id`
        AND l.`quantity` > COALESCE((SELECT SUM(d.`quantity`) FROM `customer_return_decision` d
          WHERE d.`organizationId` = l.`organizationId` AND d.`lineId` = l.`id`), 0)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a customer return is resolved when every line is decided';
  END IF;
END;

CREATE TRIGGER `customer_return_no_delete` BEFORE DELETE ON `customer_return` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer returns are never deleted';
END;

-- Una línea es una línea de su entrada (mismo producto, lote y cantidad,
-- en inspección) y, con pedido, de una línea de ese pedido.
CREATE TRIGGER `customer_return_line_insert_rule` BEFORE INSERT ON `customer_return_line` FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM `stock_movement_line` l
      JOIN `customer_return` r ON r.`organizationId` = l.`organizationId` AND r.`movementId` = l.`movementId`
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`movementLineId`
        AND r.`id` = NEW.`returnId` AND l.`direction` = 'IN' AND l.`status` = 'INSPECTION'
        AND l.`productId` = NEW.`productId` AND l.`lotId` <=> NEW.`lotId`
        AND l.`baseQuantity` = NEW.`quantity`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a customer return line is a line of its entry';
  END IF;
  IF NEW.`orderLineId` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `outbound_order_line` ol
      JOIN `customer_return` r ON r.`organizationId` = ol.`organizationId` AND r.`orderId` = ol.`orderId`
      WHERE ol.`organizationId` = NEW.`organizationId` AND ol.`id` = NEW.`orderLineId`
        AND r.`id` = NEW.`returnId` AND ol.`productId` = NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a customer return line comes from a line of its order';
  END IF;
END;

CREATE TRIGGER `customer_return_line_immutable` BEFORE UPDATE ON `customer_return_line` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return_line is immutable';
END;

CREATE TRIGGER `customer_return_line_no_delete` BEFORE DELETE ON `customer_return_line` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return_line is never deleted';
END;

-- Una decisión es un cambio de estado desde inspección de una línea de una
-- devolución abierta, y nunca decide más de lo que entró.
CREATE TRIGGER `customer_return_decision_insert_rule` BEFORE INSERT ON `customer_return_decision` FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM `customer_return_line` l
      JOIN `customer_return` r ON r.`organizationId` = l.`organizationId` AND r.`id` = l.`returnId`
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`lineId`
        AND r.`id` = NEW.`returnId` AND r.`status` = 'RECEIVED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a decision is of a line of an open customer return';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM `stock_movement_line` ml
      JOIN `stock_movement` m ON m.`organizationId` = ml.`organizationId` AND m.`id` = ml.`movementId`
      JOIN `customer_return_line` l ON l.`organizationId` = ml.`organizationId` AND l.`id` = NEW.`lineId`
      WHERE ml.`organizationId` = NEW.`organizationId` AND ml.`movementId` = NEW.`movementId`
        AND m.`type` = 'STATUS_CHANGE' AND ml.`direction` = 'OUT' AND ml.`status` = 'INSPECTION'
        AND ml.`productId` = l.`productId` AND ml.`lotId` <=> l.`lotId`
        AND ml.`baseQuantity` = NEW.`quantity`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a decision is a change of state out of inspection';
  END IF;
  IF (SELECT l.`quantity` FROM `customer_return_line` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`lineId`)
     < COALESCE((SELECT SUM(d.`quantity`) FROM `customer_return_decision` d
        WHERE d.`organizationId` = NEW.`organizationId` AND d.`lineId` = NEW.`lineId`), 0) + NEW.`quantity` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a decision never decides more than what came back';
  END IF;
END;

CREATE TRIGGER `customer_return_decision_immutable` BEFORE UPDATE ON `customer_return_decision` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return_decision is immutable';
END;

CREATE TRIGGER `customer_return_decision_no_delete` BEFORE DELETE ON `customer_return_decision` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return_decision is never deleted';
END;
