-- WMS-12: reservas de existencias (ADR 0033). Restan de lo disponible sin
-- mover el saldo.

-- CreateTable
CREATE TABLE `stock_reservation` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NULL,
    `lotId` CHAR(36) NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `remaining` DECIMAL(12, 3) NOT NULL,
    `state` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `sourceType` VARCHAR(40) NOT NULL,
    `sourceId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,

    INDEX `stock_reservation_organizationId_productId_state_idx`(`organizationId`, `productId`, `state`),
    INDEX `stock_reservation_organizationId_sourceType_sourceId_idx`(`organizationId`, `sourceType`, `sourceId`),
    UNIQUE INDEX `stock_reservation_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_reservation` ADD CONSTRAINT `stock_reservation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_reservation` ADD CONSTRAINT `stock_reservation_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_reservation` ADD CONSTRAINT `stock_reservation_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_reservation` ADD CONSTRAINT `stock_reservation_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE `stock_reservation`
  ADD CONSTRAINT `stock_reservation_amounts` CHECK (`quantity` > 0 AND `remaining` >= 0 AND `remaining` <= `quantity`),
  ADD CONSTRAINT `stock_reservation_closed` CHECK ((`state` = 'CLOSED') = (`remaining` = 0)),
  ADD CONSTRAINT `stock_reservation_closed_at` CHECK ((`state` = 'CLOSED') = (`closedAt` IS NOT NULL));

-- Nace activa con todo lo reservado.
CREATE TRIGGER `stock_reservation_insert_rules` BEFORE INSERT ON `stock_reservation` FOR EACH ROW
BEGIN
  IF NEW.`state` <> 'ACTIVE' OR NEW.`remaining` <> NEW.`quantity` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_reservation starts active and whole';
  END IF;
END;

-- Lo reservado y su documento no cambian; lo que queda solo baja; una
-- reserva cerrada no se reabre. No se borra.
CREATE TRIGGER `stock_reservation_update_rules` BEFORE UPDATE ON `stock_reservation` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`locationId` <=> OLD.`locationId`
      AND NEW.`lotId` <=> OLD.`lotId`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`sourceType` <=> OLD.`sourceType`
      AND NEW.`sourceId` <=> OLD.`sourceId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_reservation is immutable but its remaining';
  END IF;
  IF NEW.`remaining` > OLD.`remaining` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_reservation remaining only goes down';
  END IF;
  IF OLD.`state` = 'CLOSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_reservation is closed';
  END IF;
END;

CREATE TRIGGER `stock_reservation_no_delete` BEFORE DELETE ON `stock_reservation` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_reservation cannot be deleted';
