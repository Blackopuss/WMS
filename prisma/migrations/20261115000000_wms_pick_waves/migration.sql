-- WMS-25 (ADR 0054): surtido por olas. Una ola agrupa pedidos de salida de un
-- almacén para surtirlos juntos; sus tareas de surtido siguen siendo de una
-- línea de un pedido. Solo expansión: dos tablas nuevas, sus reglas y sus
-- disparadores; ninguna tabla existente cambia.
-- CreateTable
CREATE TABLE `pick_wave` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('OPEN', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `facilityId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `doneAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `cancelReason` VARCHAR(300) NULL,

    INDEX `pick_wave_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    UNIQUE INDEX `pick_wave_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `pick_wave_organizationId_number_key`(`organizationId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pick_wave_order` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `waveId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `openOrderId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `pick_wave_order_organizationId_orderId_idx`(`organizationId`, `orderId`),
    UNIQUE INDEX `pick_wave_order_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `pick_wave_order_organizationId_waveId_orderId_key`(`organizationId`, `waveId`, `orderId`),
    UNIQUE INDEX `pick_wave_order_organizationId_openOrderId_key`(`organizationId`, `openOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `pick_wave` ADD CONSTRAINT `pick_wave_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pick_wave` ADD CONSTRAINT `pick_wave_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `pick_wave_order` ADD CONSTRAINT `pick_wave_order_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pick_wave_order` ADD CONSTRAINT `pick_wave_order_organizationId_waveId_fkey` FOREIGN KEY (`organizationId`, `waveId`) REFERENCES `pick_wave`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `pick_wave_order` ADD CONSTRAINT `pick_wave_order_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE `pick_wave_order`
    ADD CONSTRAINT `pick_wave_order_open` CHECK (`openOrderId` IS NULL OR `openOrderId` = `orderId`);

-- Estados de la ola (PICK_WAVE_TRANSITIONS de wave-states.ts): abierta →
-- terminada o cancelada. Terminada o cancelada no cambia, y no se cierra
-- mientras algún renglón no haya soltado su pedido.
CREATE TRIGGER `pick_wave_transition` BEFORE UPDATE ON `pick_wave` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`facilityId` <=> OLD.`facilityId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick_wave identity is immutable';
  END IF;
  IF OLD.`status` <> 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick_wave is closed';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (NEW.`status` IN ('DONE', 'CANCELLED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick_wave transition not allowed';
  END IF;
  IF NEW.`status` <> 'OPEN' AND EXISTS (SELECT 1 FROM `pick_wave_order`
      WHERE `organizationId` = NEW.`organizationId` AND `waveId` = NEW.`id`
        AND `openOrderId` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a closed pick_wave lets go of its orders first';
  END IF;
END;

CREATE TRIGGER `pick_wave_no_delete` BEFORE DELETE ON `pick_wave` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick waves are never deleted';
END;

-- Un pedido entra a una ola solo mientras está abierta, solo abierto
-- (openOrderId = el pedido) y solo si es de su mismo almacén.
CREATE TRIGGER `pick_wave_order_insert_rule` BEFORE INSERT ON `pick_wave_order` FOR EACH ROW
BEGIN
  IF (SELECT `status` FROM `pick_wave` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`waveId`) <> 'OPEN'
     OR NEW.`openOrderId` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'orders join only an open pick_wave';
  END IF;
  IF NOT ((SELECT `facilityId` FROM `outbound_order` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`orderId`)
      <=> (SELECT `facilityId` FROM `pick_wave` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`waveId`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an order is picked in a wave of its own warehouse';
  END IF;
END;

-- Un renglón solo suelta su pedido (openOrderId vacío); nada más cambia.
CREATE TRIGGER `pick_wave_order_update_rule` BEFORE UPDATE ON `pick_wave_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`waveId` <=> OLD.`waveId`
      AND NEW.`orderId` <=> OLD.`orderId`
      AND NEW.`createdAt` <=> OLD.`createdAt`)
     OR NEW.`openOrderId` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick_wave_order only lets go of its order';
  END IF;
END;

CREATE TRIGGER `pick_wave_order_no_delete` BEFORE DELETE ON `pick_wave_order` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick_wave_order is never deleted';
END;
