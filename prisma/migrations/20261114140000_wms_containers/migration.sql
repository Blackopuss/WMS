-- WMS-53 (ADR 0043): tarimas y contenedores (LPN). Un contenedor agrupa
-- parte del saldo de su ubicación sin entrar en la llave del saldo: lo que
-- dicen sus renglones nunca pasa del saldo (disparadores en ambos lados y
-- reconciliación). Moverlo es un movimiento TRANSFER con su contenido.
-- Solo expansión: tablas nuevas, columnas opcionales, columnas de
-- `warehouse_task` que dejan de ser obligatorias (la versión anterior
-- siempre las escribe) y disparadores nuevos; ninguno existente se toca.

-- AlterTable
ALTER TABLE `serial_unit` ADD COLUMN `containerId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `stock_movement` ADD COLUMN `containerId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `warehouse_task` ADD COLUMN `containerId` CHAR(36) NULL,
    MODIFY `productId` CHAR(36) NULL,
    MODIFY `quantity` DECIMAL(12, 3) NULL,
    MODIFY `unitCode` VARCHAR(12) NULL;

-- CreateTable
CREATE TABLE `container` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `purpose` ENUM('STORAGE') NOT NULL DEFAULT 'STORAGE',
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `locationId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `closedByUserId` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `container_organizationId_locationId_status_idx`(`organizationId`, `locationId`, `status`),
    INDEX `container_organizationId_status_number_idx`(`organizationId`, `status`, `number`),
    UNIQUE INDEX `container_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `container_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `container_organizationId_code_key`(`organizationId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `container_item` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `containerId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL DEFAULT 'AVAILABLE',
    `lotId` CHAR(36) NULL,
    `lotKey` VARCHAR(36) NOT NULL DEFAULT '',
    `quantity` DECIMAL(18, 3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `container_item_organizationId_productId_locationId_status_lo_idx`(`organizationId`, `productId`, `locationId`, `status`, `lotKey`),
    INDEX `container_item_organizationId_locationId_idx`(`organizationId`, `locationId`),
    UNIQUE INDEX `container_item_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `container_item_organizationId_containerId_productId_status_l_key`(`organizationId`, `containerId`, `productId`, `status`, `lotKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `container_event` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `containerId` CHAR(36) NOT NULL,
    `kind` ENUM('CREATED', 'PACKED', 'UNPACKED', 'MOVED', 'CLOSED') NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `fromLocationId` CHAR(36) NULL,
    `productId` CHAR(36) NULL,
    `lotId` CHAR(36) NULL,
    `quantity` DECIMAL(18, 3) NULL,
    `serials` TEXT NULL,
    `movementId` CHAR(36) NULL,
    `taskId` CHAR(36) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `container_event_organizationId_containerId_id_idx`(`organizationId`, `containerId`, `id`),
    UNIQUE INDEX `container_event_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `serial_unit_organizationId_containerId_idx` ON `serial_unit`(`organizationId`, `containerId`);

-- CreateIndex
CREATE INDEX `stock_movement_organizationId_containerId_idx` ON `stock_movement`(`organizationId`, `containerId`);

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_containerId_idx` ON `warehouse_task`(`organizationId`, `containerId`);

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_organizationId_containerId_fkey` FOREIGN KEY (`organizationId`, `containerId`) REFERENCES `container`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_containerId_fkey` FOREIGN KEY (`organizationId`, `containerId`) REFERENCES `container`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `serial_unit` ADD CONSTRAINT `serial_unit_organizationId_containerId_fkey` FOREIGN KEY (`organizationId`, `containerId`) REFERENCES `container`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container` ADD CONSTRAINT `container_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container` ADD CONSTRAINT `container_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_item` ADD CONSTRAINT `container_item_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_item` ADD CONSTRAINT `container_item_organizationId_containerId_fkey` FOREIGN KEY (`organizationId`, `containerId`) REFERENCES `container`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_item` ADD CONSTRAINT `container_item_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_item` ADD CONSTRAINT `container_item_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_item` ADD CONSTRAINT `container_item_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_containerId_fkey` FOREIGN KEY (`organizationId`, `containerId`) REFERENCES `container`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_fromLocationId_fkey` FOREIGN KEY (`organizationId`, `fromLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `container_event` ADD CONSTRAINT `container_event_organizationId_taskId_fkey` FOREIGN KEY (`organizationId`, `taskId`) REFERENCES `warehouse_task`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Reglas de la base ──────────────────────────────────────────────────

ALTER TABLE `container`
  ADD CONSTRAINT `container_number` CHECK (`number` > 0),
  ADD CONSTRAINT `container_closed` CHECK ((`status` = 'CLOSED') = (`closedAt` IS NOT NULL));

ALTER TABLE `container_item`
  ADD CONSTRAINT `container_item_quantity` CHECK (`quantity` > 0),
  ADD CONSTRAINT `container_item_lot_key` CHECK (`lotKey` = COALESCE(`lotId`, ''));

-- Una tarea mueve un producto (con su cantidad y unidad) o un contenedor
-- entero (sin cantidad, lote ni pedido; solo traslado o acomodo).
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_what` CHECK (
    (`productId` IS NOT NULL AND `containerId` IS NULL AND `quantity` IS NOT NULL AND `unitCode` IS NOT NULL)
    OR (`productId` IS NULL AND `containerId` IS NOT NULL AND `quantity` IS NULL AND `unitCode` IS NULL
        AND `lotId` IS NULL AND `outboundLineId` IS NULL AND `kind` IN ('TRANSFER', 'PUTAWAY')));

-- Un contenedor no se borra; su número, código, propósito y creación no
-- cambian, y cerrado (desarmado) ya no cambia.
CREATE TRIGGER `container_no_delete` BEFORE DELETE ON `container` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'containers are never deleted';
END;

CREATE TRIGGER `container_identity` BEFORE UPDATE ON `container` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`code` <=> OLD.`code`
      AND NEW.`purpose` <=> OLD.`purpose`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container identity is immutable';
  END IF;
  IF OLD.`status` = 'CLOSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a closed container does not change';
  END IF;
  IF NEW.`status` = 'CLOSED' AND EXISTS (SELECT 1 FROM `container_item` WHERE `containerId` = OLD.`id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a container closes empty';
  END IF;
END;

-- Lo que trae un contenedor está donde está el contenedor, abierto, en un
-- lote de su producto, y nunca pasa del saldo de su llave (producto,
-- ubicación, estado y lote) sumado con lo de los demás contenedores.
CREATE TRIGGER `container_item_insert_rule` BEFORE INSERT ON `container_item` FOR EACH ROW
BEGIN
  DECLARE boxLocation CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE boxStatus VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE held DECIMAL(18, 3);
  DECLARE balance DECIMAL(18, 3);
  SELECT `locationId`, `status` INTO boxLocation, boxStatus FROM `container` WHERE `id` = NEW.`containerId`;
  IF NOT (boxLocation <=> NEW.`locationId`) OR boxStatus <> 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container items live in their open container';
  END IF;
  IF NEW.`lotId` IS NOT NULL AND NOT ((SELECT `productId` FROM `lot` WHERE `id` = NEW.`lotId`) <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the lot belongs to another product';
  END IF;
  SELECT COALESCE(SUM(`quantity`), 0) INTO held FROM `container_item`
    WHERE `organizationId` = NEW.`organizationId` AND `productId` = NEW.`productId`
      AND `locationId` = NEW.`locationId` AND `status` = NEW.`status` AND `lotKey` = NEW.`lotKey`;
  SELECT COALESCE(SUM(`quantity`), 0) INTO balance FROM `stock_balance`
    WHERE `organizationId` = NEW.`organizationId` AND `productId` = NEW.`productId`
      AND `locationId` = NEW.`locationId` AND `status` = NEW.`status` AND `lotKey` = NEW.`lotKey`;
  IF held + NEW.`quantity` > balance THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'containers cannot hold more than the balance';
  END IF;
END;

CREATE TRIGGER `container_item_update_rule` BEFORE UPDATE ON `container_item` FOR EACH ROW
BEGIN
  DECLARE boxLocation CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE boxStatus VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE held DECIMAL(18, 3);
  DECLARE balance DECIMAL(18, 3);
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`containerId` <=> OLD.`containerId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`status` <=> OLD.`status`
      AND NEW.`lotId` <=> OLD.`lotId`
      AND NEW.`lotKey` <=> OLD.`lotKey`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a container item only changes quantity or place';
  END IF;
  SELECT `locationId`, `status` INTO boxLocation, boxStatus FROM `container` WHERE `id` = NEW.`containerId`;
  IF NOT (boxLocation <=> NEW.`locationId`) OR boxStatus <> 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container items live in their open container';
  END IF;
  IF NEW.`quantity` > OLD.`quantity` OR NOT (NEW.`locationId` <=> OLD.`locationId`) THEN
    SELECT COALESCE(SUM(`quantity`), 0) INTO held FROM `container_item`
      WHERE `organizationId` = NEW.`organizationId` AND `productId` = NEW.`productId`
        AND `locationId` = NEW.`locationId` AND `status` = NEW.`status` AND `lotKey` = NEW.`lotKey`
        AND `id` <> NEW.`id`;
    SELECT COALESCE(SUM(`quantity`), 0) INTO balance FROM `stock_balance`
      WHERE `organizationId` = NEW.`organizationId` AND `productId` = NEW.`productId`
        AND `locationId` = NEW.`locationId` AND `status` = NEW.`status` AND `lotKey` = NEW.`lotKey`;
    IF held + NEW.`quantity` > balance THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'containers cannot hold more than the balance';
    END IF;
  END IF;
END;

-- El saldo nunca queda por debajo de lo que dicen los contenedores de su
-- llave: ninguna operación, presente o futura, toma lo que está dentro de
-- un contenedor sin sacarlo antes.
CREATE TRIGGER `stock_balance_container_floor` BEFORE UPDATE ON `stock_balance` FOR EACH ROW
BEGIN
  DECLARE held DECIMAL(18, 3);
  IF NEW.`quantity` < OLD.`quantity` THEN
    SELECT COALESCE(SUM(`quantity`), 0) INTO held FROM `container_item`
      WHERE `organizationId` = OLD.`organizationId` AND `productId` = OLD.`productId`
        AND `locationId` = OLD.`locationId` AND `status` = OLD.`status` AND `lotKey` = OLD.`lotKey`;
    IF held > 0 AND NEW.`quantity` < held THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the stock in containers cannot leave loose';
    END IF;
  END IF;
END;

-- Una unidad por serie entra a un contenedor solo donde está el contenedor
-- y disponible.
CREATE TRIGGER `serial_unit_container_rule` BEFORE UPDATE ON `serial_unit` FOR EACH ROW
BEGIN
  DECLARE boxLocation CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE boxStatus VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  IF NEW.`containerId` IS NOT NULL AND NOT (NEW.`containerId` <=> OLD.`containerId`) THEN
    SELECT `locationId`, `status` INTO boxLocation, boxStatus FROM `container` WHERE `id` = NEW.`containerId`;
    IF NOT (boxLocation <=> NEW.`locationId`) OR boxStatus <> 'OPEN' OR NOT (NEW.`status` <=> 'AVAILABLE') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a serial unit enters a container where it is';
    END IF;
  END IF;
END;

-- La historia de un contenedor no cambia ni se borra.
CREATE TRIGGER `container_event_immutable` BEFORE UPDATE ON `container_event` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container events are immutable';
END;

CREATE TRIGGER `container_event_no_delete` BEFORE DELETE ON `container_event` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container events are never deleted';
END;

-- El contenedor que mueve una tarea no cambia.
CREATE TRIGGER `warehouse_task_container_immutable` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`containerId` <=> OLD.`containerId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task container is immutable';
  END IF;
END;
