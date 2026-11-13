-- WMS-21B (ADR 0041): números de serie. Solo expansión: un valor más en el
-- control del producto y tres tablas nuevas, con sus disparadores.

-- AlterTable
ALTER TABLE `product` MODIFY `tracking` ENUM('NONE', 'LOT', 'SERIAL') NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE `serial_unit` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `serial` VARCHAR(64) NOT NULL,
    `locationId` CHAR(36) NULL,
    `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `serial_unit_organizationId_productId_locationId_status_idx`(`organizationId`, `productId`, `locationId`, `status`),
    INDEX `serial_unit_organizationId_serial_idx`(`organizationId`, `serial`),
    UNIQUE INDEX `serial_unit_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `serial_unit_organizationId_productId_serial_key`(`organizationId`, `productId`, `serial`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `serial_move` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `serialUnitId` CHAR(36) NOT NULL,
    `movementLineId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL,
    `direction` ENUM('IN', 'OUT') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `serial_move_organizationId_serialUnitId_id_idx`(`organizationId`, `serialUnitId`, `id`),
    UNIQUE INDEX `serial_move_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `serial_move_organizationId_movementLineId_serialUnitId_key`(`organizationId`, `movementLineId`, `serialUnitId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `warehouse_task_serial` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `serialUnitId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `warehouse_task_serial_organizationId_serialUnitId_idx`(`organizationId`, `serialUnitId`),
    UNIQUE INDEX `warehouse_task_serial_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `warehouse_task_serial_organizationId_taskId_serialUnitId_key`(`organizationId`, `taskId`, `serialUnitId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `serial_unit` ADD CONSTRAINT `serial_unit_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serial_unit` ADD CONSTRAINT `serial_unit_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `serial_unit` ADD CONSTRAINT `serial_unit_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `serial_move` ADD CONSTRAINT `serial_move_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serial_move` ADD CONSTRAINT `serial_move_organizationId_serialUnitId_fkey` FOREIGN KEY (`organizationId`, `serialUnitId`) REFERENCES `serial_unit`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `serial_move` ADD CONSTRAINT `serial_move_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task_serial` ADD CONSTRAINT `warehouse_task_serial_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_task_serial` ADD CONSTRAINT `warehouse_task_serial_organizationId_taskId_fkey` FOREIGN KEY (`organizationId`, `taskId`) REFERENCES `warehouse_task`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task_serial` ADD CONSTRAINT `warehouse_task_serial_organizationId_serialUnitId_fkey` FOREIGN KEY (`organizationId`, `serialUnitId`) REFERENCES `serial_unit`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Una unidad está dentro (ubicación y estado) o fuera (ninguno de los dos).
ALTER TABLE `serial_unit`
  ADD CONSTRAINT `serial_unit_place` CHECK ((`locationId` IS NULL) = (`status` IS NULL));

-- Una unidad por serie solo es de un producto por serie y nace fuera: entra
-- al almacén con el movimiento que la trae (`serial_move`).
CREATE TRIGGER `serial_unit_rule` BEFORE INSERT ON `serial_unit` FOR EACH ROW
BEGIN
  IF NOT ((SELECT `tracking` FROM `product` WHERE `id` = NEW.`productId`) <=> 'SERIAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only a product by serial has serial units';
  END IF;
  IF NEW.`locationId` IS NOT NULL OR NEW.`status` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a serial unit comes in with a move';
  END IF;
END;

-- Producto y serie identifican la unidad: no cambian. Una unidad no se borra.
CREATE TRIGGER `serial_unit_identity` BEFORE UPDATE ON `serial_unit` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`serial` <=> OLD.`serial`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'serial unit product and serial are immutable';
  END IF;
END;

CREATE TRIGGER `serial_unit_no_delete` BEFORE DELETE ON `serial_unit` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'serial units are never deleted';
END;

-- Cada renglón mueve su unidad: lo que sale debe estar justo ahí (ubicación
-- y estado) y queda fuera; lo que entra debe estar fuera y queda ahí. Así la
-- unidad siempre dice dónde la dejó su último movimiento.
CREATE TRIGGER `serial_move_apply` BEFORE INSERT ON `serial_move` FOR EACH ROW
BEGIN
  DECLARE unitProduct CHAR(36);
  DECLARE unitLocation CHAR(36);
  DECLARE unitStatus VARCHAR(16);
  SELECT `productId`, `locationId`, `status` INTO unitProduct, unitLocation, unitStatus
    FROM `serial_unit` WHERE `id` = NEW.`serialUnitId` FOR UPDATE;
  IF NOT (unitProduct <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit belongs to another product';
  END IF;
  IF NEW.`direction` = 'OUT' THEN
    IF NOT (unitLocation <=> NEW.`locationId` AND unitStatus <=> NEW.`status`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit is not there';
    END IF;
    UPDATE `serial_unit` SET `locationId` = NULL, `status` = NULL WHERE `id` = NEW.`serialUnitId`;
  ELSE
    IF unitLocation IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit is already inside';
    END IF;
    UPDATE `serial_unit` SET `locationId` = NEW.`locationId`, `status` = NEW.`status` WHERE `id` = NEW.`serialUnitId`;
  END IF;
END;

CREATE TRIGGER `serial_move_immutable` BEFORE UPDATE ON `serial_move` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'serial moves are immutable';
END;

CREATE TRIGGER `serial_move_no_delete` BEFORE DELETE ON `serial_move` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'serial moves are never deleted';
END;

-- Una línea de un producto por serie lleva un renglón por unidad que mueve,
-- todos con su producto, ubicación, estado y sentido; una línea de otro
-- producto no lleva ninguno. Los renglones se escriben antes que la línea,
-- en la misma transacción: ningún servicio puede mover unidades sin decir
-- cuáles.
CREATE TRIGGER `stock_movement_line_serial_rule` BEFORE INSERT ON `stock_movement_line` FOR EACH ROW
BEGIN
  DECLARE tracked VARCHAR(8);
  DECLARE moves INT;
  SELECT `tracking` INTO tracked FROM `product` WHERE `id` = NEW.`productId`;
  SELECT COUNT(*) INTO moves FROM `serial_move`
    WHERE `organizationId` = NEW.`organizationId` AND `movementLineId` = NEW.`id`;
  IF tracked = 'SERIAL' THEN
    IF moves <> NEW.`baseQuantity` THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product by serial moves one serial per unit';
    END IF;
    IF EXISTS (SELECT 1 FROM `serial_move`
        WHERE `organizationId` = NEW.`organizationId` AND `movementLineId` = NEW.`id`
          AND NOT (`productId` <=> NEW.`productId` AND `locationId` <=> NEW.`locationId`
               AND `status` <=> NEW.`status` AND `direction` <=> NEW.`direction`)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial moves do not match their line';
    END IF;
  ELSEIF moves > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product without serials moves no serial';
  END IF;
END;

-- Lo que tomó una tarea es de su producto; se suelta (se borra) solo
-- mientras la tarea no se ha entregado: lo entregado es historia.
CREATE TRIGGER `warehouse_task_serial_rule` BEFORE INSERT ON `warehouse_task_serial` FOR EACH ROW
BEGIN
  IF NOT ((SELECT `productId` FROM `serial_unit` WHERE `id` = NEW.`serialUnitId`)
       <=> (SELECT `productId` FROM `warehouse_task` WHERE `id` = NEW.`taskId`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit belongs to another product';
  END IF;
END;

CREATE TRIGGER `warehouse_task_serial_immutable` BEFORE UPDATE ON `warehouse_task_serial` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task_serial is immutable';
END;

CREATE TRIGGER `warehouse_task_serial_release` BEFORE DELETE ON `warehouse_task_serial` FOR EACH ROW
BEGIN
  IF (SELECT `status` FROM `warehouse_task` WHERE `id` = OLD.`taskId`) = 'DELIVERED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'what a delivered task moved stays';
  END IF;
END;
