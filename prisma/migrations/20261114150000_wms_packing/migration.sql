-- WMS-15 (ADR 0044): verificación y empaque. Un bulto es un contenedor
-- (WMS-53) con propósito PACKING ligado a su pedido; empacar no mueve
-- existencias. Lo que faltó al empacar queda en `outbound_pack_shortage`.
-- Solo expansión: valores nuevos de tres enumeraciones, columnas opcionales,
-- una tabla nueva, disparadores nuevos y el de transiciones del pedido
-- reemplazado con la tabla nueva (PICKED → PACKING → PACKED; ninguna
-- versión anterior usó PICKED → PACKED).
-- AlterTable
ALTER TABLE `container` ADD COLUMN `outboundOrderId` CHAR(36) NULL,
    ADD COLUMN `sealedAt` DATETIME(3) NULL,
    ADD COLUMN `sealedByUserId` CHAR(36) NULL,
    ADD COLUMN `weightKg` DECIMAL(12, 3) NULL,
    MODIFY `purpose` ENUM('STORAGE', 'PACKING') NOT NULL DEFAULT 'STORAGE';

-- AlterTable
ALTER TABLE `container_event` MODIFY `kind` ENUM('CREATED', 'PACKED', 'UNPACKED', 'MOVED', 'CLOSED', 'SEALED', 'REOPENED') NOT NULL;

-- AlterTable
ALTER TABLE `outbound_order` MODIFY `status` ENUM('DRAFT', 'RELEASED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'SHIPPED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE `outbound_pack_shortage` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `lineId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `lotId` CHAR(36) NULL,
    `locationId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `serials` TEXT NULL,
    `reason` VARCHAR(300) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `outbound_pack_shortage_organizationId_orderId_id_idx`(`organizationId`, `orderId`, `id`),
    INDEX `outbound_pack_shortage_organizationId_lineId_idx`(`organizationId`, `lineId`),
    UNIQUE INDEX `outbound_pack_shortage_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `container_organizationId_outboundOrderId_idx` ON `container`(`organizationId`, `outboundOrderId`);

-- AddForeignKey
ALTER TABLE `container` ADD CONSTRAINT `container_organizationId_outboundOrderId_fkey` FOREIGN KEY (`organizationId`, `outboundOrderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_pack_shortage` ADD CONSTRAINT `outbound_pack_shortage_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outbound_pack_shortage` ADD CONSTRAINT `outbound_pack_shortage_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_pack_shortage` ADD CONSTRAINT `outbound_pack_shortage_organizationId_lineId_fkey` FOREIGN KEY (`organizationId`, `lineId`) REFERENCES `outbound_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_pack_shortage` ADD CONSTRAINT `outbound_pack_shortage_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_pack_shortage` ADD CONSTRAINT `outbound_pack_shortage_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `outbound_pack_shortage` ADD CONSTRAINT `outbound_pack_shortage_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Un bulto (PACKING) tiene su pedido y solo él lo tiene; el peso, si se
-- escribe, es mayor que cero; solo un bulto se cierra para salir.
ALTER TABLE `container`
    ADD CONSTRAINT `container_packing_order` CHECK ((`purpose` = 'PACKING') = (`outboundOrderId` IS NOT NULL)),
    ADD CONSTRAINT `container_weight_positive` CHECK (`weightKg` IS NULL OR `weightKg` > 0),
    ADD CONSTRAINT `container_sealed_packing` CHECK ((`sealedAt` IS NULL AND `sealedByUserId` IS NULL) OR (`purpose` = 'PACKING' AND `sealedAt` IS NOT NULL AND `sealedByUserId` IS NOT NULL));

ALTER TABLE `outbound_pack_shortage`
    ADD CONSTRAINT `outbound_pack_shortage_quantity` CHECK (`quantity` > 0),
    ADD CONSTRAINT `outbound_pack_shortage_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3);

-- El pedido de un bulto no cambia.
CREATE TRIGGER `container_packing_identity` BEFORE UPDATE ON `container` FOR EACH ROW
BEGIN
  IF NOT (NEW.`outboundOrderId` <=> OLD.`outboundOrderId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container order is immutable';
  END IF;
END;

-- Un bulto cerrado no recibe nada más (se vuelve a abrir antes).
CREATE TRIGGER `container_item_sealed_insert` BEFORE INSERT ON `container_item` FOR EACH ROW
BEGIN
  IF (SELECT `sealedAt` FROM `container` WHERE `id` = NEW.`containerId`) IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a sealed package takes nothing more';
  END IF;
END;

CREATE TRIGGER `container_item_sealed_update` BEFORE UPDATE ON `container_item` FOR EACH ROW
BEGIN
  IF NEW.`quantity` > OLD.`quantity`
     AND (SELECT `sealedAt` FROM `container` WHERE `id` = NEW.`containerId`) IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a sealed package takes nothing more';
  END IF;
END;

-- Lo que faltó al empacar no cambia ni se borra.
CREATE TRIGGER `outbound_pack_shortage_immutable` BEFORE UPDATE ON `outbound_pack_shortage` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_pack_shortage is immutable';
END;

CREATE TRIGGER `outbound_pack_shortage_no_delete` BEFORE DELETE ON `outbound_pack_shortage` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_pack_shortage is never deleted';
END;

-- Transiciones del pedido (OUTBOUND_ORDER_TRANSITIONS de outbound-states.ts):
-- surtido → empacando → empacado → despachado.
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
    OR (OLD.`status` = 'PICKED' AND NEW.`status` = 'PACKING')
    OR (OLD.`status` = 'PACKING' AND NEW.`status` = 'PACKED')
    OR (OLD.`status` = 'PACKED' AND NEW.`status` = 'SHIPPED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order transition not allowed';
  END IF;
  IF OLD.`status` IN ('SHIPPED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order is closed';
  END IF;
END;
