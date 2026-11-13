-- WMS-21A (ADR 0040), pendientes: el lote de una salida importada.
-- Solo de expansión: una columna que admite NULL y su llave foránea.

-- AlterTable
ALTER TABLE `exit_import_row` ADD COLUMN `lotId` CHAR(36) NULL;

-- AddForeignKey
ALTER TABLE `exit_import_row` ADD CONSTRAINT `exit_import_row_organizationId_lotId_fkey` FOREIGN KEY (`organizationId`, `lotId`) REFERENCES `lot`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- El lote de una fila es de su producto, como en reservas y tareas.
CREATE TRIGGER `exit_import_row_lot_rule` BEFORE INSERT ON `exit_import_row` FOR EACH ROW
BEGIN
  IF NEW.`lotId` IS NOT NULL AND NOT ((SELECT `productId` FROM `lot` WHERE `id` = NEW.`lotId`) <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the lot belongs to another product';
  END IF;
END;
