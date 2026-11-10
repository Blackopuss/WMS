-- WMS-13B: importar pedidos de salida desde Excel/CSV. Confirmar un archivo
-- crea todos sus borradores en una transacción, o ninguno; el «Pedido» del
-- archivo (sourceKey) es único en la empresa, así que un pedido no se crea dos veces.

-- AlterTable
ALTER TABLE `outbound_order` ADD COLUMN `importId` CHAR(36) NULL,
    ADD COLUMN `sourceKey` VARCHAR(80) NULL;

-- CreateTable
CREATE TABLE `outbound_import` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `fileId` CHAR(36) NOT NULL,
    `status` ENUM('READY', 'CONFIRMED', 'CANCELLED') NOT NULL DEFAULT 'READY',
    `decimalSeparator` CHAR(1) NOT NULL,
    `dataRows` INTEGER NOT NULL,
    `ordersCreated` INTEGER NOT NULL DEFAULT 0,
    `confirmedAt` DATETIME(3) NULL,
    `confirmedByUserId` CHAR(36) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `outbound_import_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `outbound_import_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `outbound_order_organizationId_sourceKey_key` ON `outbound_order`(`organizationId`, `sourceKey`);

-- AddForeignKey
ALTER TABLE `outbound_order` ADD CONSTRAINT `outbound_order_organizationId_importId_fkey` FOREIGN KEY (`organizationId`, `importId`) REFERENCES `outbound_import`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_import` ADD CONSTRAINT `outbound_import_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outbound_import` ADD CONSTRAINT `outbound_import_organizationId_fileId_fkey` FOREIGN KEY (`organizationId`, `fileId`) REFERENCES `stored_file`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE `outbound_import`
  ADD CONSTRAINT `outbound_import_separator` CHECK (`decimalSeparator` IN ('.', ',')),
  ADD CONSTRAINT `outbound_import_rows` CHECK (`dataRows` > 0 AND `ordersCreated` >= 0),
  ADD CONSTRAINT `outbound_import_confirmed` CHECK ((`status` = 'CONFIRMED') = (`confirmedAt` IS NOT NULL AND `confirmedByUserId` IS NOT NULL));
ALTER TABLE `outbound_order`
  ADD CONSTRAINT `outbound_order_source` CHECK ((`importId` IS NULL) = (`sourceKey` IS NULL));

-- Nace lista para revisar; solo pasa a confirmada o cancelada, una vez; no se borra.
CREATE TRIGGER `outbound_import_insert_rules` BEFORE INSERT ON `outbound_import` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'READY' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_import starts ready';
  END IF;
END;

CREATE TRIGGER `outbound_import_update_rules` BEFORE UPDATE ON `outbound_import` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`fileId` <=> OLD.`fileId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_import identity is immutable';
  END IF;
  IF OLD.`status` <> 'READY' AND NOT (NEW.`status` <=> OLD.`status`
      AND NEW.`ordersCreated` <=> OLD.`ordersCreated`
      AND NEW.`confirmedAt` <=> OLD.`confirmedAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_import is closed';
  END IF;
END;

CREATE TRIGGER `outbound_import_no_delete` BEFORE DELETE ON `outbound_import` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_import cannot be deleted';

-- El origen de un pedido importado no cambia (se suma a lo que ya no cambiaba).
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
      AND NEW.`note` <=> OLD.`note`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order header only changes in draft';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (
       (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('RELEASED', 'CANCELLED'))
    OR (OLD.`status` = 'RELEASED' AND NEW.`status` IN ('PICKING', 'CANCELLED'))
    OR (OLD.`status` = 'PICKING' AND NEW.`status` = 'PICKED')
    OR (OLD.`status` = 'PICKED' AND NEW.`status` = 'PACKED')
    OR (OLD.`status` = 'PACKED' AND NEW.`status` = 'SHIPPED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order transition not allowed';
  END IF;
  IF OLD.`status` IN ('SHIPPED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order is closed';
  END IF;
END;
