-- WMS-06 (especificación WMS v5, 5.3): tareas de traslado de almacén.

-- CreateTable
CREATE TABLE `warehouse_task` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'BLOCKED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `priority` ENUM('NORMAL', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `productId` CHAR(36) NOT NULL,
    `fromLocationId` CHAR(36) NOT NULL,
    `toLocationId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `note` VARCHAR(300) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `assignedToUserId` CHAR(36) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `pickedUpAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `blockedAt` DATETIME(3) NULL,
    `blockedReason` VARCHAR(300) NULL,
    `closedByUserId` CHAR(36) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(300) NULL,
    `movementId` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `warehouse_task_organizationId_status_number_idx`(`organizationId`, `status`, `number`),
    INDEX `warehouse_task_organizationId_assignedToUserId_status_idx`(`organizationId`, `assignedToUserId`, `status`),
    INDEX `warehouse_task_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `warehouse_task_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `warehouse_task_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `warehouse_task_organizationId_movementId_key`(`organizationId`, `movementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_fromLocationId_fkey` FOREIGN KEY (`organizationId`, `fromLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_toLocationId_fkey` FOREIGN KEY (`organizationId`, `toLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_movementId_fkey` FOREIGN KEY (`organizationId`, `movementId`) REFERENCES `stock_movement`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Lo que mueve una tarea tiene sentido.
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_quantity` CHECK (`quantity` > 0),
  ADD CONSTRAINT `warehouse_task_places` CHECK (`fromLocationId` <> `toLocationId`),
  ADD CONSTRAINT `warehouse_task_number` CHECK (`number` > 0),
  ADD CONSTRAINT `warehouse_task_delivered` CHECK (`status` <> 'DELIVERED' OR `movementId` IS NOT NULL),
  ADD CONSTRAINT `warehouse_task_has_person` CHECK (`status` NOT IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED') OR `assignedToUserId` IS NOT NULL),
  ADD CONSTRAINT `warehouse_task_cancel_reason` CHECK (`status` <> 'CANCELLED' OR `cancelReason` IS NOT NULL),
  ADD CONSTRAINT `warehouse_task_block_reason` CHECK (`status` <> 'BLOCKED' OR `blockedReason` IS NOT NULL);

-- Una tarea no se borra: se cancela.
CREATE TRIGGER `warehouse_task_no_delete` BEFORE DELETE ON `warehouse_task` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task cannot be deleted';

-- Nace disponible, o asignada a alguien.
CREATE TRIGGER `warehouse_task_insert_rules` BEFORE INSERT ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT ((NEW.`status` = 'PENDING' AND NEW.`assignedToUserId` IS NULL)
       OR (NEW.`status` = 'ASSIGNED' AND NEW.`assignedToUserId` IS NOT NULL)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task starts pending or assigned';
  END IF;
  IF NEW.`movementId` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task starts without a movement';
  END IF;
END;

-- Lo que mueve no cambia, y solo avanza por WAREHOUSE_TASK_TRANSITIONS
-- (task-states.ts): cambiar una exige cambiar la otra.
CREATE TRIGGER `warehouse_task_transition` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
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
