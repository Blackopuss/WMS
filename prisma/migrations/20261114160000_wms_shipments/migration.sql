-- WMS-16 (ADR 0045): despacho y embarques. Un embarque agrupa pedidos de un
-- almacén; confirmar su salida escribe un movimiento SHIPMENT (clave
-- `ship:<id>`), vacía los bultos, consume lo apartado en preparación y
-- cierra los pedidos. Lo que salió queda en `shipment_line` (inmutable).
-- Solo expansión: valores nuevos de dos enumeraciones, tres tablas nuevas,
-- sus reglas y el disparador de transiciones del pedido reemplazado con la
-- tabla nueva (se agrega PICKED → SHIPPED y SHIPPED exige un embarque).
-- AlterTable
ALTER TABLE `container_event` MODIFY `kind` ENUM('CREATED', 'PACKED', 'UNPACKED', 'MOVED', 'CLOSED', 'SEALED', 'REOPENED', 'SHIPPED') NOT NULL;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN', 'STATUS_CHANGE', 'SHIPMENT') NOT NULL;

-- CreateTable
CREATE TABLE `shipment` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'SHIPPED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `facilityId` CHAR(36) NOT NULL,
    `carrier` VARCHAR(120) NULL,
    `trackingNumber` VARCHAR(120) NULL,
    `vehiclePlate` VARCHAR(20) NULL,
    `driverName` VARCHAR(160) NULL,
    `note` VARCHAR(500) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `shippedAt` DATETIME(3) NULL,
    `shippedByUserId` CHAR(36) NULL,
    `movementId` CHAR(36) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `cancelReason` VARCHAR(300) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `shipment_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    INDEX `shipment_organizationId_status_shippedAt_idx`(`organizationId`, `status`, `shippedAt`),
    UNIQUE INDEX `shipment_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `shipment_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `shipment_organizationId_movementId_key`(`organizationId`, `movementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_order` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `shipmentId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `openOrderId` CHAR(36) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `shipment_order_organizationId_orderId_idx`(`organizationId`, `orderId`),
    UNIQUE INDEX `shipment_order_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `shipment_order_organizationId_shipmentId_orderId_key`(`organizationId`, `shipmentId`, `orderId`),
    UNIQUE INDEX `shipment_order_organizationId_openOrderId_key`(`organizationId`, `openOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `shipmentId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `orderLineId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `lotId` CHAR(36) NULL,
    `containerId` CHAR(36) NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `serials` TEXT NULL,
    `movementLineId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `shipment_line_organizationId_shipmentId_id_idx`(`organizationId`, `shipmentId`, `id`),
    INDEX `shipment_line_organizationId_orderId_idx`(`organizationId`, `orderId`),
    INDEX `shipment_line_organizationId_orderLineId_idx`(`organizationId`, `orderLineId`),
    INDEX `shipment_line_organizationId_lotId_idx`(`organizationId`, `lotId`),
    INDEX `shipment_line_organizationId_containerId_idx`(`organizationId`, `containerId`),
    UNIQUE INDEX `shipment_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `shipment_line_organizationId_movementLineId_key`(`organizationId`, `movementLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `shipment` ADD CONSTRAINT `shipment_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipment` ADD CONSTRAINT `shipment_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment` ADD CONSTRAINT `shipment_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_order` ADD CONSTRAINT `shipment_order_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipment_order` ADD CONSTRAINT `shipment_order_organizationId_shipmentId_fkey` FOREIGN KEY (`organizationId`, `shipmentId`) REFERENCES `shipment`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_order` ADD CONSTRAINT `shipment_order_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_shipmentId_fkey` FOREIGN KEY (`organizationId`, `shipmentId`) REFERENCES `shipment`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_orderLineId_fkey` FOREIGN KEY (`organizationId`, `orderLineId`) REFERENCES `outbound_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_containerId_fkey` FOREIGN KEY (`organizationId`, `containerId`) REFERENCES `container`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_line` ADD CONSTRAINT `shipment_line_organizationId_movementLineId_fkey` FOREIGN KEY (`organizationId`, `movementLineId`) REFERENCES `stock_movement_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Reglas de los datos.
ALTER TABLE `shipment`
    ADD CONSTRAINT `shipment_number` CHECK (`number` > 0),
    ADD CONSTRAINT `shipment_shipped` CHECK ((`status` = 'SHIPPED') = (`shippedAt` IS NOT NULL AND `shippedByUserId` IS NOT NULL)),
    ADD CONSTRAINT `shipment_cancelled` CHECK ((`status` = 'CANCELLED') = (`cancelledAt` IS NOT NULL AND `cancelledByUserId` IS NOT NULL AND `cancelReason` IS NOT NULL)),
    ADD CONSTRAINT `shipment_movement` CHECK (`movementId` IS NULL OR `status` = 'SHIPPED');

ALTER TABLE `shipment_order`
    ADD CONSTRAINT `shipment_order_open` CHECK (`openOrderId` IS NULL OR `openOrderId` = `orderId`);

ALTER TABLE `shipment_line`
    ADD CONSTRAINT `shipment_line_quantity` CHECK (`quantity` > 0);

-- Estados del embarque (SHIPMENT_TRANSITIONS de shipment-states.ts):
-- borrador → despachado o cancelado. Despachado o cancelado no cambia.
CREATE TRIGGER `shipment_transition` BEFORE UPDATE ON `shipment` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`facilityId` <=> OLD.`facilityId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment identity is immutable';
  END IF;
  IF OLD.`status` <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment is closed';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (NEW.`status` IN ('SHIPPED', 'CANCELLED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment transition not allowed';
  END IF;
  IF NEW.`status` = 'SHIPPED' THEN
    IF NOT EXISTS (SELECT 1 FROM `shipment_order`
        WHERE `organizationId` = NEW.`organizationId` AND `shipmentId` = NEW.`id`
          AND `openOrderId` IS NOT NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a shipment leaves with its orders';
    END IF;
    IF EXISTS (SELECT 1 FROM `shipment_order` so
        JOIN `outbound_order` o ON o.`organizationId` = so.`organizationId` AND o.`id` = so.`orderId`
        WHERE so.`organizationId` = NEW.`organizationId` AND so.`shipmentId` = NEW.`id`
          AND so.`openOrderId` IS NOT NULL AND o.`status` <> 'SHIPPED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'every order of a shipment ships with it';
    END IF;
    IF NEW.`movementId` IS NOT NULL AND (SELECT `type` FROM `stock_movement`
        WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`movementId`) <> 'SHIPMENT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the exit of a shipment is a SHIPMENT movement';
    END IF;
  END IF;
END;

CREATE TRIGGER `shipment_no_delete` BEFORE DELETE ON `shipment` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipments are never deleted';
END;

-- Un pedido entra o sale de un embarque solo mientras es borrador, y solo
-- un pedido de su mismo almacén.
CREATE TRIGGER `shipment_order_insert_rule` BEFORE INSERT ON `shipment_order` FOR EACH ROW
BEGIN
  IF (SELECT `status` FROM `shipment` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`shipmentId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'orders join a shipment only while a draft';
  END IF;
  IF NOT ((SELECT `facilityId` FROM `outbound_order` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`orderId`)
      <=> (SELECT `facilityId` FROM `shipment` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`shipmentId`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an order ships from its own warehouse';
  END IF;
END;

-- Al cancelar el embarque, sus pedidos se sueltan (openOrderId vacío); nada
-- más cambia.
CREATE TRIGGER `shipment_order_update_rule` BEFORE UPDATE ON `shipment_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`shipmentId` <=> OLD.`shipmentId`
      AND NEW.`orderId` <=> OLD.`orderId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`)
     OR NEW.`openOrderId` IS NOT NULL
     OR (SELECT `status` FROM `shipment` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`shipmentId`) <> 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment_order only lets go of its order when the shipment is cancelled';
  END IF;
END;

CREATE TRIGGER `shipment_order_delete_rule` BEFORE DELETE ON `shipment_order` FOR EACH ROW
BEGIN
  IF (SELECT `status` FROM `shipment` WHERE `organizationId` = OLD.`organizationId` AND `id` = OLD.`shipmentId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'orders leave a shipment only while a draft';
  END IF;
END;

-- Lo que salió no cambia ni se borra, y su línea es de un despacho.
CREATE TRIGGER `shipment_line_insert_rule` BEFORE INSERT ON `shipment_line` FOR EACH ROW
BEGIN
  IF (SELECT m.`type` FROM `stock_movement_line` l
      JOIN `stock_movement` m ON m.`organizationId` = l.`organizationId` AND m.`id` = l.`movementId`
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`movementLineId`) <> 'SHIPMENT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a shipment line is a line of a SHIPMENT movement';
  END IF;
END;

CREATE TRIGGER `shipment_line_immutable` BEFORE UPDATE ON `shipment_line` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment_line is immutable';
END;

CREATE TRIGGER `shipment_line_no_delete` BEFORE DELETE ON `shipment_line` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment_line is never deleted';
END;

-- Transiciones del pedido (OUTBOUND_ORDER_TRANSITIONS de outbound-states.ts):
-- con el empaque apagado se despacha desde surtido (PICKED → SHIPPED), y un
-- pedido solo pasa a despachado dentro de un embarque.
DROP TRIGGER `outbound_order_transition`;
CREATE TRIGGER `outbound_order_transition` BEFORE UPDATE ON `outbound_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`
      AND NEW.`importId` <=> OLD.`importId`
      AND NEW.`sourceKey` <=> OLD.`sourceKey`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order identity is immutable';
  END IF;
  IF OLD.`status` <> 'DRAFT' AND NOT (NEW.`recipient` <=> OLD.`recipient`
      AND NEW.`address` <=> OLD.`address`
      AND NEW.`reference` <=> OLD.`reference`
      AND NEW.`dueOn` <=> OLD.`dueOn`
      AND NEW.`priority` <=> OLD.`priority`
      AND NEW.`note` <=> OLD.`note`
      AND NEW.`facilityId` <=> OLD.`facilityId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order header only changes in draft';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (
       (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('RELEASED', 'CANCELLED'))
    OR (OLD.`status` = 'RELEASED' AND NEW.`status` IN ('PICKING', 'CANCELLED'))
    OR (OLD.`status` = 'PICKING' AND NEW.`status` = 'PICKED')
    OR (OLD.`status` = 'PICKED' AND NEW.`status` IN ('PACKING', 'SHIPPED'))
    OR (OLD.`status` = 'PACKING' AND NEW.`status` = 'PACKED')
    OR (OLD.`status` = 'PACKED' AND NEW.`status` = 'SHIPPED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order transition not allowed';
  END IF;
  IF OLD.`status` IN ('SHIPPED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order is closed';
  END IF;
  IF NEW.`status` = 'SHIPPED' AND NOT EXISTS (SELECT 1 FROM `shipment_order`
      WHERE `organizationId` = NEW.`organizationId` AND `openOrderId` = NEW.`id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an order ships only within a shipment';
  END IF;
END;
