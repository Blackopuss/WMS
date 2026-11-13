-- WMS-52 (ADR 0042): acomodo con recomendación. Tareas `kind = PUTAWAY`
-- desde un lugar «de paso» («General» o una ubicación de recepción): su
-- destino (`toLocationId`) es el lugar recomendado, o el propio origen
-- cuando no hubo ninguno; dónde quedó de verdad lo dice `placedLocationId`,
-- escrito una sola vez al entregar. Solo expansión.

-- AlterTable
ALTER TABLE `warehouse_task` ADD COLUMN `placedLocationId` CHAR(36) NULL,
    MODIFY `kind` ENUM('TRANSFER', 'PICK', 'PUTAWAY') NOT NULL DEFAULT 'TRANSFER';

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_placedLocationId_idx` ON `warehouse_task`(`organizationId`, `placedLocationId`);

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_placedLocationId_fkey` FOREIGN KEY (`organizationId`, `placedLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Origen y destino distintos, salvo en un acomodo sin lugar recomendado
-- (su destino es el propio origen hasta que alguien elija dónde dejarlo).
ALTER TABLE `warehouse_task` DROP CHECK `warehouse_task_places`;
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_places` CHECK (`fromLocationId` <> `toLocationId` OR `kind` = 'PUTAWAY');

-- Dónde quedó solo existe en un acomodo entregado, y todo acomodo entregado
-- lo dice. Nunca es el lugar de donde salió.
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_placed` CHECK (
    `placedLocationId` IS NULL OR (`kind` = 'PUTAWAY' AND `status` = 'DELIVERED' AND `placedLocationId` <> `fromLocationId`)),
  ADD CONSTRAINT `warehouse_task_putaway_delivered` CHECK (
    `kind` <> 'PUTAWAY' OR `status` <> 'DELIVERED' OR `placedLocationId` IS NOT NULL);

-- Lo que mueve no cambia, y solo avanza por WAREHOUSE_TASK_TRANSITIONS
-- (task-states.ts, sin cambios en este paso): cambiar una exige cambiar la
-- otra. Nuevo: dónde quedó un acomodo no cambia una vez escrito.
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
  IF OLD.`placedLocationId` IS NOT NULL AND NOT (NEW.`placedLocationId` <=> OLD.`placedLocationId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task placed location is immutable';
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
