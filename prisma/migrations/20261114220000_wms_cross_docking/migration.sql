-- WMS-54 (ADR 0052): lo que llega dañado de un proveedor y cross-docking.
-- Solo expansión: una columna con valor por omisión, una columna opcional,
-- su llave e índice, y disparadores.

-- La parte dañada de una recepción es su propia línea, en «Dañado».
ALTER TABLE `purchase_receipt_line` ADD COLUMN `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED') NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE `purchase_receipt_line`
  ADD CONSTRAINT `purchase_receipt_line_status` CHECK (`status` IN ('AVAILABLE', 'DAMAGED'));

-- La línea de recepción y su línea del movimiento (mismo número) tienen el
-- mismo producto y el mismo estado.
CREATE TRIGGER `purchase_receipt_line_status` BEFORE INSERT ON `purchase_receipt_line` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `stock_movement_line` AS ml
        JOIN `purchase_receipt` AS r ON r.`organizationId` = NEW.`organizationId` AND r.`id` = NEW.`receiptId`
        WHERE ml.`organizationId` = NEW.`organizationId`
            AND ml.`movementId` = r.`movementId`
            AND ml.`lineNumber` = NEW.`lineNumber`
            AND ml.`productId` = NEW.`productId`
            AND ml.`status` = NEW.`status`
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_receipt_line: another product or state than its movement line';
    END IF;
END;

-- Una tarea de surtido puede llevar directo a su pedido lo que trajo una
-- entrada (cross-docking).
ALTER TABLE `warehouse_task` ADD COLUMN `crossDockMovementId` CHAR(36) NULL;
CREATE INDEX `warehouse_task_organizationId_crossDockMovementId_idx` ON `warehouse_task`(`organizationId`, `crossDockMovementId`);
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_crossDockMovementId_fkey` FOREIGN KEY (`organizationId`, `crossDockMovementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_cross_dock_pick` CHECK (`crossDockMovementId` IS NULL OR `kind` = 'PICK');

CREATE TRIGGER `warehouse_task_cross_dock_fixed` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`crossDockMovementId` <=> OLD.`crossDockMovementId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: crossDockMovementId never changes';
  END IF;
END;

-- Una tarea de surtido nace de un pedido liberado o en surtido (antes solo
-- liberado: lo que llega para un pedido que ya se surte también le toca), y
-- la entrada que la origina es una recepción o una entrada.
DROP TRIGGER `warehouse_task_insert_rules`;
CREATE TRIGGER `warehouse_task_insert_rules` BEFORE INSERT ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT ((NEW.`status` = 'PENDING' AND NEW.`assignedToUserId` IS NULL)
       OR (NEW.`status` = 'ASSIGNED' AND NEW.`assignedToUserId` IS NOT NULL)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task starts pending or assigned';
  END IF;
  IF NEW.`movementId` IS NOT NULL OR NEW.`pickedQuantity` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task starts without a movement';
  END IF;
  IF NEW.`kind` = 'PICK' AND (SELECT o.`status` FROM `outbound_order_line` l
      JOIN `outbound_order` o ON o.`id` = l.`orderId`
      WHERE l.`id` = NEW.`outboundLineId`) NOT IN ('RELEASED', 'PICKING') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a pick task comes from a released order';
  END IF;
  IF NEW.`crossDockMovementId` IS NOT NULL AND (SELECT `type` FROM `stock_movement`
      WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`crossDockMovementId`) NOT IN ('RECEIPT', 'ENTRY') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: cross-docking comes from a receipt or an entry';
  END IF;
END;
