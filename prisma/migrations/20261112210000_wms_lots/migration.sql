-- WMS-21A (ADR 0040): lotes y caducidad. Escrita a mano: la diferencia que
-- genera Prisma soltaba llaves foráneas de `stock_count_line` sin reponerlas
-- y volvía a crear las de `purchase_receipt_line`. Solo expansión, salvo el
-- índice único de las líneas de conteo, que se ensancha con el lote (el
-- nuevo se crea antes de quitar el anterior, como en WMS-10).

-- Cómo se controla cada producto: sin lote (lo que ya existe) o por lote.
ALTER TABLE `product`
    ADD COLUMN `tracking` ENUM('NONE', 'LOT') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `lotExpiry` ENUM('NONE', 'OPTIONAL', 'REQUIRED') NOT NULL DEFAULT 'NONE';

-- La lista de caducidad próxima lee los lotes por fecha.
CREATE INDEX `lot_organizationId_expiresOn_idx` ON `lot`(`organizationId`, `expiresOn`);

-- Una tarea de traslado o de surtido dice qué lote mueve.
ALTER TABLE `warehouse_task` ADD COLUMN `lotId` CHAR(36) NULL;
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- La línea de una recepción guarda el lote en que llegó: lo que se devuelve
-- al proveedor sale de ese lote.
ALTER TABLE `purchase_receipt_line` ADD COLUMN `lotId` CHAR(36) NULL;
ALTER TABLE `purchase_receipt_line` ADD CONSTRAINT `purchase_receipt_line_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Un conteo cuenta por lote: una línea por producto y lote.
ALTER TABLE `stock_count_line`
    ADD COLUMN `lotId` CHAR(36) NULL,
    ADD COLUMN `lotKey` VARCHAR(36) NOT NULL DEFAULT '';
ALTER TABLE `stock_count_line` ADD CONSTRAINT `stock_count_line_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `stock_count_line`
  ADD CONSTRAINT `stock_count_line_lot_key` CHECK (`lotKey` = COALESCE(`lotId`, ''));
CREATE UNIQUE INDEX `stock_count_line_organizationId_countId_productId_lotKey_key` ON `stock_count_line`(`organizationId`, `countId`, `productId`, `lotKey`);
DROP INDEX `stock_count_line_organizationId_countId_productId_key` ON `stock_count_line`;

-- De un lote solo se corrige la caducidad: su producto y su código son lo
-- que lo identifica.
CREATE TRIGGER `lot_identity` BEFORE UPDATE ON `lot` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`code` <=> OLD.`code`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'lot product and code are immutable';
  END IF;
END;

-- Un producto por lote nunca se mueve sin lote, uno sin lote nunca lleva
-- lote, y el lote es de ese producto. Se pregunta al escribir cada línea de
-- movimiento y cada saldo nuevo: ningún servicio puede mezclar lotes.
CREATE TRIGGER `stock_movement_line_lot_rule` BEFORE INSERT ON `stock_movement_line` FOR EACH ROW
BEGIN
  DECLARE tracked VARCHAR(8);
  SELECT `tracking` INTO tracked FROM `product` WHERE `id` = NEW.`productId`;
  IF tracked = 'LOT' AND NEW.`lotId` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product by lot moves with its lot';
  END IF;
  IF tracked <> 'LOT' AND NEW.`lotId` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product without lots takes no lot';
  END IF;
  IF NEW.`lotId` IS NOT NULL AND NOT ((SELECT `productId` FROM `lot` WHERE `id` = NEW.`lotId`) <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the lot belongs to another product';
  END IF;
END;

CREATE TRIGGER `stock_balance_lot_rule` BEFORE INSERT ON `stock_balance` FOR EACH ROW
BEGIN
  DECLARE tracked VARCHAR(8);
  SELECT `tracking` INTO tracked FROM `product` WHERE `id` = NEW.`productId`;
  IF tracked = 'LOT' AND NEW.`lotId` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product by lot is held by lot';
  END IF;
  IF tracked <> 'LOT' AND NEW.`lotId` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product without lots takes no lot';
  END IF;
  IF NEW.`lotId` IS NOT NULL AND NOT ((SELECT `productId` FROM `lot` WHERE `id` = NEW.`lotId`) <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the lot belongs to another product';
  END IF;
END;

-- Lo que se aparta y lo que una tarea mueve, si nombra un lote, es un lote
-- de su producto.
CREATE TRIGGER `stock_reservation_lot_rule` BEFORE INSERT ON `stock_reservation` FOR EACH ROW
BEGIN
  IF NEW.`lotId` IS NOT NULL AND NOT ((SELECT `productId` FROM `lot` WHERE `id` = NEW.`lotId`) <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the lot belongs to another product';
  END IF;
END;

CREATE TRIGGER `warehouse_task_lot_rule` BEFORE INSERT ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NEW.`lotId` IS NOT NULL AND NOT ((SELECT `productId` FROM `lot` WHERE `id` = NEW.`lotId`) <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the lot belongs to another product';
  END IF;
END;

-- El lote de una tarea no cambia (lo demás ya lo cuida `warehouse_task_transition`).
CREATE TRIGGER `warehouse_task_lot_immutable` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`lotId` <=> OLD.`lotId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task lot is immutable';
  END IF;
END;

-- El control de un producto solo cambia mientras no tiene existencias (en
-- ningún estado) ni nada apartado.
CREATE TRIGGER `product_tracking_change` BEFORE UPDATE ON `product` FOR EACH ROW
BEGIN
  IF NEW.`tracking` <> OLD.`tracking` AND (
       EXISTS (SELECT 1 FROM `stock_balance` WHERE `productId` = OLD.`id` AND `quantity` > 0)
    OR EXISTS (SELECT 1 FROM `stock_reservation` WHERE `productId` = OLD.`id` AND `state` = 'ACTIVE')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'product tracking changes only without stock';
  END IF;
END;
