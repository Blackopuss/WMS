-- WMS-79 (ADR 0094): lo que una verificación aprueba de un lote hecho para
-- un pedido se manda directo al pedido con su tarea de surtido; la tarea
-- guarda el cambio de estado que lo dejó disponible (como el cross-docking
-- guarda la entrada o la recepción). Solo se agrega 'STATUS_CHANGE' a la
-- lista; lo demás del disparador queda igual.
DROP TRIGGER IF EXISTS `warehouse_task_insert_rules`;
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
      WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`crossDockMovementId`) NOT IN ('RECEIPT', 'ENTRY', 'STATUS_CHANGE') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: cross-docking comes from a receipt, an entry or a verification';
  END IF;
END;
