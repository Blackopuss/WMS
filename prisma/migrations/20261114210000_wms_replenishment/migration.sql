-- WMS-23/24 (ADR 0051): reposición de ubicaciones de surtido. Reglas por
-- producto y ubicación de surtido (mínimo, máximo y múltiplo) y tareas
-- `kind = REPLENISH` que traen mercancía desde almacenamiento. Solo
-- expansión: un valor más del enumerado y una tabla nueva.
-- AlterTable
ALTER TABLE `warehouse_task` MODIFY `kind` ENUM('TRANSFER', 'PICK', 'PUTAWAY', 'REPLENISH') NOT NULL DEFAULT 'TRANSFER';

-- CreateTable
CREATE TABLE `replenishment_rule` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `minQuantity` DECIMAL(12, 3) NOT NULL,
    `maxQuantity` DECIMAL(12, 3) NOT NULL,
    `multiple` DECIMAL(12, 3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `updatedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `replenishment_rule_organizationId_locationId_idx`(`organizationId`, `locationId`),
    UNIQUE INDEX `replenishment_rule_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `replenishment_rule_organizationId_productId_locationId_key`(`organizationId`, `productId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `replenishment_rule` ADD CONSTRAINT `replenishment_rule_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `replenishment_rule` ADD CONSTRAINT `replenishment_rule_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `replenishment_rule` ADD CONSTRAINT `replenishment_rule_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Reglas de la base ──────────────────────────────────────────────────

-- Mínimo mayor que cero, máximo mayor que el mínimo, y el múltiplo cabe
-- al menos una vez entre los dos (así siempre se puede reponer algo).
ALTER TABLE `replenishment_rule`
  ADD CONSTRAINT `replenishment_rule_min` CHECK (`minQuantity` > 0),
  ADD CONSTRAINT `replenishment_rule_max` CHECK (`maxQuantity` > `minQuantity`),
  ADD CONSTRAINT `replenishment_rule_multiple` CHECK (
    `multiple` IS NULL OR (`multiple` > 0 AND `multiple` <= `maxQuantity` - `minQuantity`));

-- Producto, ubicación, empresa y creación no cambian: otra ubicación es
-- otra regla.
CREATE TRIGGER `replenishment_rule_identity` BEFORE UPDATE ON `replenishment_rule` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`locationId` <=> OLD.`locationId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'replenishment_rule product and location are immutable';
  END IF;
END;
