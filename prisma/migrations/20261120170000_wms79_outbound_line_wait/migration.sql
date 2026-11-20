-- WMS-79 (ADR 0094): pedido del cliente ligado a producción y embarque.
-- De expansión: tabla nueva, columna opcional nueva y el disparador de
-- transición de la solicitud recreado con la columna nueva entre lo que no
-- cambia.

-- AlterTable
ALTER TABLE `production_request` ADD COLUMN `lineWaitId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `outbound_line_wait` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `lineId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `received` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `status` ENUM('OPEN', 'DONE', 'DROPPED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `openLineId` CHAR(36) NULL,
    `openedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `closedByUserId` CHAR(36) NULL,
    `closeReason` VARCHAR(300) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `outbound_line_wait_organizationId_orderId_status_idx`(`organizationId`, `orderId`, `status`),
    INDEX `outbound_line_wait_organizationId_lineId_idx`(`organizationId`, `lineId`),
    UNIQUE INDEX `outbound_line_wait_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `outbound_line_wait_organizationId_openLineId_key`(`organizationId`, `openLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `production_request_organizationId_lineWaitId_idx` ON `production_request`(`organizationId`, `lineWaitId`);

-- AddForeignKey
ALTER TABLE `outbound_line_wait` ADD CONSTRAINT `outbound_line_wait_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outbound_line_wait` ADD CONSTRAINT `outbound_line_wait_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_line_wait` ADD CONSTRAINT `outbound_line_wait_organizationId_lineId_fkey` FOREIGN KEY (`organizationId`, `lineId`) REFERENCES `outbound_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_line_wait` ADD CONSTRAINT `outbound_line_wait_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_request` ADD CONSTRAINT `production_request_organizationId_lineWaitId_fkey` FOREIGN KEY (`organizationId`, `lineWaitId`) REFERENCES `outbound_line_wait`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Lo que espera es positivo; lo recibido no es negativo; abierta = con su
-- línea en openLineId; cerrada = con su fecha.
ALTER TABLE `outbound_line_wait`
  ADD CONSTRAINT `outbound_line_wait_quantity` CHECK (`quantity` > 0),
  ADD CONSTRAINT `outbound_line_wait_received` CHECK (`received` >= 0),
  ADD CONSTRAINT `outbound_line_wait_open_key` CHECK (
    (`status` = 'OPEN' AND `openLineId` IS NOT NULL AND `openLineId` = `lineId` AND `closedAt` IS NULL)
    OR (`status` <> 'OPEN' AND `openLineId` IS NULL AND `closedAt` IS NOT NULL)),
  ADD CONSTRAINT `outbound_line_wait_close_reason` CHECK (
    `status` NOT IN ('DROPPED', 'CANCELLED') OR `closeReason` IS NOT NULL);

-- Una espera no se borra.
CREATE TRIGGER `outbound_line_wait_no_delete` BEFORE DELETE ON `outbound_line_wait` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_line_wait cannot be deleted';

-- Nace abierta y sin nada recibido.
CREATE TRIGGER `outbound_line_wait_insert` BEFORE INSERT ON `outbound_line_wait` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'OPEN' OR NEW.`received` <> 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_line_wait starts open';
  END IF;
END;

-- Lo que espera no cambia; lo recibido solo sube mientras está abierta; los
-- estados solo por OUTBOUND_WAIT_TRANSITIONS (wait-states.ts): cambiar una
-- exige cambiar la otra.
CREATE TRIGGER `outbound_line_wait_transition` BEFORE UPDATE ON `outbound_line_wait` FOR EACH ROW
BEGIN
  IF OLD.`status` <> 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_line_wait is closed';
  END IF;
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`orderId` <=> OLD.`orderId`
      AND NEW.`lineId` <=> OLD.`lineId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`unitCode` <=> OLD.`unitCode`
      AND NEW.`openedByUserId` <=> OLD.`openedByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_line_wait is immutable';
  END IF;
  IF NEW.`received` < OLD.`received` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_line_wait received only grows';
  END IF;
  IF NEW.`status` <> OLD.`status`
     AND NOT (NEW.`status` IN ('DONE', 'DROPPED', 'CANCELLED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_line_wait transition not allowed';
  END IF;
END;

-- La solicitud: la espera a la que va ligada tampoco cambia.
DROP TRIGGER IF EXISTS `production_request_transition`;
CREATE TRIGGER `production_request_transition` BEFORE UPDATE ON `production_request` FOR EACH ROW
BEGIN
  IF OLD.`status` <> 'SUBMITTED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request is decided';
  END IF;
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`facilityId` <=> OLD.`facilityId`
      AND NEW.`areaLocationId` <=> OLD.`areaLocationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`unitCode` <=> OLD.`unitCode`
      AND NEW.`note` <=> OLD.`note`
      AND NEW.`requestedByUserId` <=> OLD.`requestedByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`
      AND NEW.`lineWaitId` <=> OLD.`lineWaitId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request is immutable';
  END IF;
  IF NEW.`status` <> OLD.`status`
     AND NOT (NEW.`status` IN ('ACCEPTED', 'REJECTED', 'CANCELLED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request transition not allowed';
  END IF;
END;
