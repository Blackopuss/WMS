-- WMS-19 (ADR 0048): traslados entre almacenes. El almacén de origen envía
-- (un movimiento FACILITY_TRANSFER que saca disponible del origen y lo deja
-- en tránsito en la ubicación «En tránsito» del destino), y el destino lo
-- recibe, o se resuelve lo que no llegó (se perdió o regresó al origen).
-- Solo expansión: un valor nuevo del tipo de movimiento, una columna nueva
-- en `location`, cuatro tablas nuevas y sus reglas.
-- AlterTable
ALTER TABLE `location` ADD COLUMN `isTransit` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN', 'STATUS_CHANGE', 'SHIPMENT', 'CUSTOMER_RETURN', 'FACILITY_TRANSFER') NOT NULL;

-- CreateTable
CREATE TABLE `facility_transfer` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `fromFacilityId` CHAR(36) NOT NULL,
    `toFacilityId` CHAR(36) NOT NULL,
    `transitLocationId` CHAR(36) NOT NULL,
    `note` VARCHAR(500) NULL,
    `carrier` VARCHAR(160) NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sendMovementId` CHAR(36) NULL,
    `sentByUserId` CHAR(36) NULL,
    `sentAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(300) NULL,

    INDEX `facility_transfer_organizationId_fromFacilityId_status_numbe_idx`(`organizationId`, `fromFacilityId`, `status`, `number`),
    INDEX `facility_transfer_organizationId_toFacilityId_status_number_idx`(`organizationId`, `toFacilityId`, `status`, `number`),
    UNIQUE INDEX `facility_transfer_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `facility_transfer_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `facility_transfer_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    UNIQUE INDEX `facility_transfer_organizationId_sendMovementId_key`(`organizationId`, `sendMovementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `facility_transfer_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `transferId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `fromLocationId` CHAR(36) NOT NULL,
    `lotId` CHAR(36) NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `serials` TEXT NULL,
    `transitLineId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `facility_transfer_line_organizationId_productId_idx`(`organizationId`, `productId`),
    INDEX `facility_transfer_line_organizationId_lotId_idx`(`organizationId`, `lotId`),
    UNIQUE INDEX `facility_transfer_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `facility_transfer_line_organizationId_transferId_lineNumber_key`(`organizationId`, `transferId`, `lineNumber`),
    UNIQUE INDEX `facility_transfer_line_organizationId_transitLineId_key`(`organizationId`, `transitLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `facility_transfer_receipt` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `transferId` CHAR(36) NOT NULL,
    `kind` ENUM('RECEIVED', 'LOST', 'RETURNED') NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `movementId` CHAR(36) NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `reason` VARCHAR(500) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `facility_transfer_receipt_organizationId_transferId_id_idx`(`organizationId`, `transferId`, `id`),
    UNIQUE INDEX `facility_transfer_receipt_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `facility_transfer_receipt_organizationId_movementId_key`(`organizationId`, `movementId`),
    UNIQUE INDEX `facility_transfer_receipt_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `facility_transfer_receipt_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `receiptId` CHAR(36) NOT NULL,
    `lineId` CHAR(36) NOT NULL,
    `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `movementLineId` CHAR(36) NOT NULL,
    `serials` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `facility_transfer_receipt_line_organizationId_lineId_idx`(`organizationId`, `lineId`),
    INDEX `facility_transfer_receipt_line_organizationId_receiptId_idx`(`organizationId`, `receiptId`),
    UNIQUE INDEX `facility_transfer_receipt_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `facility_transfer_receipt_line_organizationId_movementLineId_key`(`organizationId`, `movementLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `location_organizationId_facilityId_isTransit_key` ON `location`(`organizationId`, `facilityId`, `isTransit`);

-- AddForeignKey
ALTER TABLE `facility_transfer` ADD CONSTRAINT `facility_transfer_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_transfer` ADD CONSTRAINT `facility_transfer_organizationId_fromFacilityId_fkey` FOREIGN KEY (`organizationId`, `fromFacilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer` ADD CONSTRAINT `facility_transfer_organizationId_toFacilityId_fkey` FOREIGN KEY (`organizationId`, `toFacilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer` ADD CONSTRAINT `facility_transfer_organizationId_transitLocationId_fkey` FOREIGN KEY (`organizationId`, `transitLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer` ADD CONSTRAINT `facility_transfer_organizationId_sendMovementId_fkey` FOREIGN KEY (`organizationId`, `sendMovementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_line` ADD CONSTRAINT `facility_transfer_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_transfer_line` ADD CONSTRAINT `facility_transfer_line_organizationId_transferId_fkey` FOREIGN KEY (`organizationId`, `transferId`) REFERENCES `facility_transfer`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_line` ADD CONSTRAINT `facility_transfer_line_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_line` ADD CONSTRAINT `facility_transfer_line_organizationId_fromLocationId_fkey` FOREIGN KEY (`organizationId`, `fromLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_line` ADD CONSTRAINT `facility_transfer_line_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_line` ADD CONSTRAINT `facility_transfer_line_organizationId_transitLineId_fkey` FOREIGN KEY (`organizationId`, `transitLineId`) REFERENCES `stock_movement_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt` ADD CONSTRAINT `facility_transfer_receipt_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt` ADD CONSTRAINT `facility_transfer_receipt_organizationId_transferId_fkey` FOREIGN KEY (`organizationId`, `transferId`) REFERENCES `facility_transfer`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt` ADD CONSTRAINT `facility_transfer_receipt_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt` ADD CONSTRAINT `facility_transfer_receipt_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt_line` ADD CONSTRAINT `facility_transfer_receipt_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt_line` ADD CONSTRAINT `facility_transfer_receipt_line_organizationId_receiptId_fkey` FOREIGN KEY (`organizationId`, `receiptId`) REFERENCES `facility_transfer_receipt`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt_line` ADD CONSTRAINT `facility_transfer_receipt_line_organizationId_lineId_fkey` FOREIGN KEY (`organizationId`, `lineId`) REFERENCES `facility_transfer_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `facility_transfer_receipt_line` ADD CONSTRAINT `facility_transfer_receipt_line_organizationId_movementLineI_fkey` FOREIGN KEY (`organizationId`, `movementLineId`) REFERENCES `stock_movement_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Reglas de los datos.

-- La ubicación de tránsito de un almacén: en la raíz, nunca General ni
-- preparación, nunca archivada.
ALTER TABLE `location` ADD CONSTRAINT `location_transit` CHECK (
    `isTransit` IS NULL OR (`isTransit` = 1 AND `isDefault` IS NULL AND `isStaging` IS NULL AND `parentId` IS NULL AND `archivedAt` IS NULL)
);

-- Nada va dentro de una ubicación de tránsito.
CREATE TRIGGER `location_transit_insert` BEFORE INSERT ON `location` FOR EACH ROW
BEGIN
  IF NEW.`parentId` IS NOT NULL AND EXISTS (SELECT 1 FROM `location` p
      WHERE p.`organizationId` = NEW.`organizationId` AND p.`id` = NEW.`parentId` AND p.`isTransit` = 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nothing goes inside a transit location';
  END IF;
END;

-- Una ubicación no se vuelve de tránsito ni deja de serlo, y nada se mueve
-- dentro de una.
CREATE TRIGGER `location_transit_update` BEFORE UPDATE ON `location` FOR EACH ROW
BEGIN
  IF NOT (NEW.`isTransit` <=> OLD.`isTransit`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transit location stays one';
  END IF;
  IF NEW.`parentId` IS NOT NULL AND NOT (NEW.`parentId` <=> OLD.`parentId`) AND EXISTS (SELECT 1 FROM `location` p
      WHERE p.`organizationId` = NEW.`organizationId` AND p.`id` = NEW.`parentId` AND p.`isTransit` = 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nothing goes inside a transit location';
  END IF;
END;

-- En tránsito solo en la ubicación de tránsito, y ahí solo en tránsito.
CREATE TRIGGER `stock_balance_transit_rule` BEFORE INSERT ON `stock_balance` FOR EACH ROW
BEGIN
  IF (NEW.`status` = 'IN_TRANSIT') <> COALESCE((SELECT l.`isTransit` FROM `location` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`locationId`), 0) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock in transit lives only in a transit location';
  END IF;
END;

-- Solo un traslado escribe en una ubicación de tránsito, y siempre en
-- tránsito; fuera de ella, un traslado mueve disponible o dañado.
CREATE TRIGGER `stock_movement_line_transit_rule` BEFORE INSERT ON `stock_movement_line` FOR EACH ROW
BEGIN
  IF COALESCE((SELECT l.`isTransit` FROM `location` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`locationId`), 0) = 1 THEN
    IF NEW.`status` <> 'IN_TRANSIT' OR NOT ((SELECT m.`type` FROM `stock_movement` m
        WHERE m.`organizationId` = NEW.`organizationId` AND m.`id` = NEW.`movementId`) <=> 'FACILITY_TRANSFER') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only a transfer moves stock in transit';
    END IF;
  ELSE
    IF NEW.`status` = 'IN_TRANSIT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock in transit lives only in a transit location';
    END IF;
    IF (SELECT m.`type` FROM `stock_movement` m
        WHERE m.`organizationId` = NEW.`organizationId` AND m.`id` = NEW.`movementId`) = 'FACILITY_TRANSFER'
       AND NEW.`status` NOT IN ('AVAILABLE', 'DAMAGED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer moves available or damaged stock';
    END IF;
  END IF;
END;

ALTER TABLE `facility_transfer`
    ADD CONSTRAINT `facility_transfer_number` CHECK (`number` > 0),
    ADD CONSTRAINT `facility_transfer_sent` CHECK ((`status` IN ('SENT', 'RECEIVED')) = (`sentAt` IS NOT NULL AND `sentByUserId` IS NOT NULL)),
    ADD CONSTRAINT `facility_transfer_closed` CHECK ((`status` = 'RECEIVED') = (`closedAt` IS NOT NULL)),
    ADD CONSTRAINT `facility_transfer_cancelled` CHECK ((`status` = 'CANCELLED') = (`cancelledAt` IS NOT NULL AND `cancelledByUserId` IS NOT NULL AND `cancelReason` IS NOT NULL)),
    ADD CONSTRAINT `facility_transfer_cancel_reason` CHECK (`cancelReason` IS NULL OR CHAR_LENGTH(TRIM(`cancelReason`)) >= 3);

ALTER TABLE `facility_transfer_line`
    ADD CONSTRAINT `facility_transfer_line_quantity` CHECK (`quantity` > 0);

ALTER TABLE `facility_transfer_receipt`
    ADD CONSTRAINT `facility_transfer_receipt_reason` CHECK (`kind` = 'RECEIVED' OR CHAR_LENGTH(TRIM(COALESCE(`reason`, ''))) >= 3);

ALTER TABLE `facility_transfer_receipt_line`
    ADD CONSTRAINT `facility_transfer_receipt_line_quantity` CHECK (`quantity` > 0);

-- Un traslado nace en borrador, entre dos almacenes distintos, y espera en
-- la ubicación de tránsito de su destino.
CREATE TRIGGER `facility_transfer_insert_rule` BEFORE INSERT ON `facility_transfer` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'DRAFT' OR NEW.`sendMovementId` IS NOT NULL OR NEW.`carrier` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer is born a draft';
  END IF;
  IF NEW.`fromFacilityId` = NEW.`toFacilityId` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer goes to another warehouse';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM `location` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`transitLocationId`
        AND l.`facilityId` = NEW.`toFacilityId` AND l.`isTransit` = 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer waits in the transit location of its destination';
  END IF;
END;

-- Estados del traslado (FACILITY_TRANSFER_TRANSITIONS de
-- facility-transfer-states.ts): borrador → enviado → recibido, borrador →
-- cancelado. Cada dato cambia solo en su transición.
CREATE TRIGGER `facility_transfer_transition` BEFORE UPDATE ON `facility_transfer` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`fromFacilityId` <=> OLD.`fromFacilityId`
      AND NEW.`toFacilityId` <=> OLD.`toFacilityId`
      AND NEW.`transitLocationId` <=> OLD.`transitLocationId`
      AND NEW.`note` <=> OLD.`note`
      AND NEW.`idempotencyKey` <=> OLD.`idempotencyKey`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer is immutable';
  END IF;
  IF NEW.`status` = OLD.`status` THEN
    IF NOT (NEW.`sendMovementId` <=> OLD.`sendMovementId`
        AND NEW.`carrier` <=> OLD.`carrier`
        AND NEW.`sentByUserId` <=> OLD.`sentByUserId`
        AND NEW.`sentAt` <=> OLD.`sentAt`
        AND NEW.`closedAt` <=> OLD.`closedAt`
        AND NEW.`cancelledByUserId` <=> OLD.`cancelledByUserId`
        AND NEW.`cancelledAt` <=> OLD.`cancelledAt`
        AND NEW.`cancelReason` <=> OLD.`cancelReason`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer changes only with its status';
    END IF;
  ELSEIF OLD.`status` = 'DRAFT' AND NEW.`status` = 'SENT' THEN
    IF NEW.`sendMovementId` IS NULL OR NOT ((SELECT m.`type` FROM `stock_movement` m
        WHERE m.`organizationId` = NEW.`organizationId` AND m.`id` = NEW.`sendMovementId`) <=> 'FACILITY_TRANSFER') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer is sent with its FACILITY_TRANSFER movement';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM `facility_transfer_line` t
        WHERE t.`organizationId` = NEW.`organizationId` AND t.`transferId` = NEW.`id`)
       OR EXISTS (SELECT 1 FROM `facility_transfer_line` t
        WHERE t.`organizationId` = NEW.`organizationId` AND t.`transferId` = NEW.`id` AND t.`transitLineId` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'every line of a sent transfer is in transit';
    END IF;
    IF NOT (NEW.`closedAt` IS NULL AND NEW.`cancelledAt` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer transition not allowed';
    END IF;
  ELSEIF OLD.`status` = 'DRAFT' AND NEW.`status` = 'CANCELLED' THEN
    IF NOT (NEW.`sendMovementId` IS NULL AND NEW.`sentAt` IS NULL AND NEW.`carrier` IS NULL AND NEW.`closedAt` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer transition not allowed';
    END IF;
  ELSEIF OLD.`status` = 'SENT' AND NEW.`status` = 'RECEIVED' THEN
    IF NOT (NEW.`sendMovementId` <=> OLD.`sendMovementId`
        AND NEW.`carrier` <=> OLD.`carrier`
        AND NEW.`sentByUserId` <=> OLD.`sentByUserId`
        AND NEW.`sentAt` <=> OLD.`sentAt`
        AND NEW.`cancelledAt` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer transition not allowed';
    END IF;
    IF EXISTS (SELECT 1 FROM `facility_transfer_line` t
        WHERE t.`organizationId` = NEW.`organizationId` AND t.`transferId` = NEW.`id`
          AND t.`quantity` > COALESCE((SELECT SUM(r.`quantity`) FROM `facility_transfer_receipt_line` r
            WHERE r.`organizationId` = t.`organizationId` AND r.`lineId` = t.`id`), 0)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer is received when nothing of it is left in transit';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer transition not allowed';
  END IF;
END;

CREATE TRIGGER `facility_transfer_no_delete` BEFORE DELETE ON `facility_transfer` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility transfers are never deleted';
END;

-- Un renglón se agrega a un borrador y sale de una ubicación del origen.
CREATE TRIGGER `facility_transfer_line_insert_rule` BEFORE INSERT ON `facility_transfer_line` FOR EACH ROW
BEGIN
  IF NOT ((SELECT t.`status` FROM `facility_transfer` t
      WHERE t.`organizationId` = NEW.`organizationId` AND t.`id` = NEW.`transferId`) <=> 'DRAFT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'lines are added only to a draft transfer';
  END IF;
  IF NEW.`transitLineId` IS NOT NULL OR NOT EXISTS (SELECT 1 FROM `location` l
      JOIN `facility_transfer` t ON t.`organizationId` = l.`organizationId` AND t.`fromFacilityId` = l.`facilityId`
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`fromLocationId`
        AND t.`id` = NEW.`transferId` AND l.`isTransit` IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer line leaves from a location of its origin';
  END IF;
END;

-- Lo único que cambia de un renglón es su línea de llegada a tránsito, una
-- vez, al enviarlo: la misma cantidad, producto y lote, en tránsito.
CREATE TRIGGER `facility_transfer_line_update_rule` BEFORE UPDATE ON `facility_transfer_line` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`transferId` <=> OLD.`transferId`
      AND NEW.`lineNumber` <=> OLD.`lineNumber`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`fromLocationId` <=> OLD.`fromLocationId`
      AND NEW.`lotId` <=> OLD.`lotId`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`unitCode` <=> OLD.`unitCode`
      AND NEW.`serials` <=> OLD.`serials`
      AND NEW.`createdAt` <=> OLD.`createdAt`)
     OR OLD.`transitLineId` IS NOT NULL OR NEW.`transitLineId` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer_line is immutable';
  END IF;
  IF NOT ((SELECT t.`status` FROM `facility_transfer` t
      WHERE t.`organizationId` = NEW.`organizationId` AND t.`id` = NEW.`transferId`) <=> 'DRAFT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer line goes into transit when its transfer is sent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM `stock_movement_line` ml
      JOIN `facility_transfer` t ON t.`organizationId` = ml.`organizationId` AND t.`transitLocationId` = ml.`locationId`
      WHERE ml.`organizationId` = NEW.`organizationId` AND ml.`id` = NEW.`transitLineId`
        AND t.`id` = NEW.`transferId` AND ml.`direction` = 'IN' AND ml.`status` = 'IN_TRANSIT'
        AND ml.`productId` = NEW.`productId` AND ml.`lotId` <=> NEW.`lotId`
        AND ml.`baseQuantity` = NEW.`quantity`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer line goes into transit as itself';
  END IF;
END;

CREATE TRIGGER `facility_transfer_line_delete_rule` BEFORE DELETE ON `facility_transfer_line` FOR EACH ROW
BEGIN
  IF NOT ((SELECT t.`status` FROM `facility_transfer` t
      WHERE t.`organizationId` = OLD.`organizationId` AND t.`id` = OLD.`transferId`) <=> 'DRAFT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'lines are removed only from a draft transfer';
  END IF;
END;

-- Una recepción (o pérdida, o regreso) es de un traslado enviado y se
-- escribe con su movimiento FACILITY_TRANSFER.
CREATE TRIGGER `facility_transfer_receipt_insert_rule` BEFORE INSERT ON `facility_transfer_receipt` FOR EACH ROW
BEGIN
  IF NOT ((SELECT t.`status` FROM `facility_transfer` t
      WHERE t.`organizationId` = NEW.`organizationId` AND t.`id` = NEW.`transferId`) <=> 'SENT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only a sent transfer is received';
  END IF;
  IF NOT ((SELECT m.`type` FROM `stock_movement` m
      WHERE m.`organizationId` = NEW.`organizationId` AND m.`id` = NEW.`movementId`) <=> 'FACILITY_TRANSFER') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer receipt is a FACILITY_TRANSFER movement';
  END IF;
END;

CREATE TRIGGER `facility_transfer_receipt_immutable` BEFORE UPDATE ON `facility_transfer_receipt` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer_receipt is immutable';
END;

CREATE TRIGGER `facility_transfer_receipt_no_delete` BEFORE DELETE ON `facility_transfer_receipt` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer_receipt is never deleted';
END;

-- Un renglón de recepción es de un renglón del mismo traslado, es una línea
-- de su movimiento (llegada o, para lo perdido, salida de tránsito) y nunca
-- resuelve más de lo enviado.
CREATE TRIGGER `facility_transfer_receipt_line_insert_rule` BEFORE INSERT ON `facility_transfer_receipt_line` FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM `facility_transfer_receipt` r
      JOIN `facility_transfer_line` t ON t.`organizationId` = r.`organizationId` AND t.`transferId` = r.`transferId`
      JOIN `stock_movement_line` ml ON ml.`organizationId` = r.`organizationId` AND ml.`movementId` = r.`movementId`
      WHERE r.`organizationId` = NEW.`organizationId` AND r.`id` = NEW.`receiptId`
        AND t.`id` = NEW.`lineId` AND ml.`id` = NEW.`movementLineId`
        AND ml.`productId` = t.`productId` AND ml.`lotId` <=> t.`lotId`
        AND ml.`baseQuantity` = NEW.`quantity`
        AND ((r.`kind` = 'RECEIVED' AND NEW.`status` IN ('AVAILABLE', 'DAMAGED') AND ml.`direction` = 'IN' AND ml.`status` = NEW.`status`)
          OR (r.`kind` = 'RETURNED' AND NEW.`status` = 'AVAILABLE' AND ml.`direction` = 'IN' AND ml.`status` = 'AVAILABLE')
          OR (r.`kind` = 'LOST' AND NEW.`status` = 'IN_TRANSIT' AND ml.`direction` = 'OUT' AND ml.`status` = 'IN_TRANSIT'))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer receipt line is a line of its movement';
  END IF;
  IF (SELECT t.`quantity` FROM `facility_transfer_line` t
      WHERE t.`organizationId` = NEW.`organizationId` AND t.`id` = NEW.`lineId`)
     < COALESCE((SELECT SUM(r.`quantity`) FROM `facility_transfer_receipt_line` r
        WHERE r.`organizationId` = NEW.`organizationId` AND r.`lineId` = NEW.`lineId`), 0) + NEW.`quantity` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a transfer never receives more than what was sent';
  END IF;
END;

CREATE TRIGGER `facility_transfer_receipt_line_immutable` BEFORE UPDATE ON `facility_transfer_receipt_line` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer_receipt_line is immutable';
END;

CREATE TRIGGER `facility_transfer_receipt_line_no_delete` BEFORE DELETE ON `facility_transfer_receipt_line` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer_receipt_line is never deleted';
END;
