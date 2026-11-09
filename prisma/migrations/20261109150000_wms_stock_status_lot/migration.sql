-- WMS-10 (ADR 0033): estado y lote en saldos y líneas de movimiento. Lo que
-- ya existe queda disponible y sin lote. Escrita a mano: la diferencia que
-- genera Prisma soltaba las llaves foráneas del saldo sin reponerlas.

-- Columnas nuevas (los registros actuales quedan AVAILABLE y sin lote).
ALTER TABLE `stock_balance`
    ADD COLUMN `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL DEFAULT 'AVAILABLE',
    ADD COLUMN `lotId` CHAR(36) NULL,
    ADD COLUMN `lotKey` VARCHAR(36) NOT NULL DEFAULT '';

ALTER TABLE `stock_movement_line`
    ADD COLUMN `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL DEFAULT 'AVAILABLE',
    ADD COLUMN `lotId` CHAR(36) NULL,
    ADD COLUMN `lotKey` VARCHAR(36) NOT NULL DEFAULT '';

-- Lotes (WMS-21 los llena).
CREATE TABLE `lot` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `expiresOn` DATE NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `lot_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `lot_organizationId_productId_code_key`(`organizationId`, `productId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `lot` ADD CONSTRAINT `lot_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `lot` ADD CONSTRAINT `lot_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Llave nueva del saldo. Se crea antes de quitar la vieja: también sirve de
-- índice a las llaves foráneas (organizationId, productId) que ya existen.
CREATE UNIQUE INDEX `stock_balance_organizationId_productId_locationId_status_lot_key` ON `stock_balance`(`organizationId`, `productId`, `locationId`, `status`, `lotKey`);
CREATE INDEX `stock_balance_organizationId_productId_status_idx` ON `stock_balance`(`organizationId`, `productId`, `status`);
DROP INDEX `stock_balance_organizationId_productId_locationId_key` ON `stock_balance`;

ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `stock_movement_line` ADD CONSTRAINT `stock_movement_line_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- La llave compara el lote con lotKey (MySQL no compara NULL en un índice
-- único): siempre igual a COALESCE(lotId, '').
ALTER TABLE `stock_balance`
  ADD CONSTRAINT `stock_balance_lot_key` CHECK (`lotKey` = COALESCE(`lotId`, ''));
ALTER TABLE `stock_movement_line`
  ADD CONSTRAINT `stock_movement_line_lot_key` CHECK (`lotKey` = COALESCE(`lotId`, ''));

-- De un saldo solo cambia la cantidad: producto, ubicación, estado y lote son
-- su llave.
CREATE TRIGGER `stock_balance_dimensions` BEFORE UPDATE ON `stock_balance` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`locationId` <=> OLD.`locationId`
      AND NEW.`status` <=> OLD.`status`
      AND NEW.`lotId` <=> OLD.`lotId`
      AND NEW.`lotKey` <=> OLD.`lotKey`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_balance dimensions are immutable';
  END IF;
END;

-- Un lote no se borra.
CREATE TRIGGER `lot_no_delete` BEFORE DELETE ON `lot` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'lot cannot be deleted';
