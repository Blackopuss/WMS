-- WMS-14 (especificación 5.2): surtido. Al liberar un pedido se generan tareas
-- de surtido (kind = PICK) ligadas a su línea, desde las ubicaciones con
-- existencias hacia la ubicación de preparación (location.isStaging).

-- AlterTable
ALTER TABLE `location` ADD COLUMN `isStaging` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `warehouse_task` ADD COLUMN `kind` ENUM('TRANSFER', 'PICK') NOT NULL DEFAULT 'TRANSFER',
    ADD COLUMN `outboundLineId` CHAR(36) NULL,
    ADD COLUMN `pickedQuantity` DECIMAL(12, 3) NULL,
    ADD COLUMN `shortReason` VARCHAR(300) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `location_organizationId_facilityId_isStaging_key` ON `location`(`organizationId`, `facilityId`, `isStaging`);

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_outboundLineId_idx` ON `warehouse_task`(`organizationId`, `outboundLineId`);

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_outboundLineId_fkey` FOREIGN KEY (`organizationId`, `outboundLineId`) REFERENCES `outbound_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Preparación: true o NULL (nunca false), nunca la ubicación General.
ALTER TABLE `location`
  ADD CONSTRAINT `location_staging` CHECK (`isStaging` IS NULL OR (`isStaging` = 1 AND `kind` <> 'GENERAL'));

-- Una tarea de surtido siempre es de una línea de pedido y solo ella; lo
-- surtido es más que cero y no pasa de lo pedido; el motivo del faltante
-- solo existe cuando se surtió de menos.
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_pick_line` CHECK ((`kind` = 'PICK') = (`outboundLineId` IS NOT NULL)),
  ADD CONSTRAINT `warehouse_task_picked` CHECK (
    `pickedQuantity` IS NULL OR (`kind` = 'PICK' AND `pickedQuantity` > 0 AND `pickedQuantity` <= `quantity`)),
  ADD CONSTRAINT `warehouse_task_short` CHECK (
    `shortReason` IS NULL OR (`pickedQuantity` IS NOT NULL AND `pickedQuantity` < `quantity`)),
  ADD CONSTRAINT `warehouse_task_pick_delivered` CHECK (
    `kind` <> 'PICK' OR `status` <> 'DELIVERED' OR `pickedQuantity` IS NOT NULL);

-- Lo que mueve no cambia (ahora también su tipo y su línea), y solo avanza
-- por WAREHOUSE_TASK_TRANSITIONS (task-states.ts): cambiar una exige
-- cambiar la otra. Lo surtido se escribe al recoger y no cambia después de
-- entregar.
DROP TRIGGER `warehouse_task_transition`;
CREATE TRIGGER `warehouse_task_transition` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`kind` <=> OLD.`kind`
      AND NEW.`outboundLineId` <=> OLD.`outboundLineId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`fromLocationId` <=> OLD.`fromLocationId`
      AND NEW.`toLocationId` <=> OLD.`toLocationId`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`unitCode` <=> OLD.`unitCode`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task contents are immutable';
  END IF;
  IF OLD.`movementId` IS NOT NULL AND NOT (NEW.`movementId` <=> OLD.`movementId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task movement is immutable';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (
       (OLD.`status` = 'PENDING' AND NEW.`status` IN ('ASSIGNED', 'ACCEPTED', 'CANCELLED'))
    OR (OLD.`status` = 'ASSIGNED' AND NEW.`status` IN ('ACCEPTED', 'PENDING', 'CANCELLED'))
    OR (OLD.`status` = 'ACCEPTED' AND NEW.`status` IN ('PICKED_UP', 'BLOCKED', 'CANCELLED'))
    OR (OLD.`status` = 'PICKED_UP' AND NEW.`status` IN ('DELIVERED', 'BLOCKED'))
    OR (OLD.`status` = 'BLOCKED' AND NEW.`status` IN ('PENDING', 'CANCELLED'))
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task transition not allowed';
  END IF;
  IF OLD.`status` IN ('DELIVERED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task is closed';
  END IF;
END;

-- Una tarea de surtido nace de un pedido liberado.
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
      WHERE l.`id` = NEW.`outboundLineId`) <> 'RELEASED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a pick task comes from a released order';
  END IF;
END;
