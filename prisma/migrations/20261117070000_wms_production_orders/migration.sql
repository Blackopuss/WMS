-- WMS-28 (ADR 0073): órdenes de producción. Solo expansión: tablas nuevas,
-- un valor más al final de dos ENUM (uso de ubicación «Producción» y tarea
-- «Surtir a producción») y dos columnas opcionales. Ninguna fila existente
-- tiene los valores nuevos.
-- AlterTable
ALTER TABLE `location` MODIFY `type` ENUM('STORAGE', 'PICKING', 'RECEIVING', 'STAGING', 'QUARANTINE', 'DOCK', 'REPAIR', 'PRODUCTION') NOT NULL DEFAULT 'STORAGE';

-- AlterTable
ALTER TABLE `recipe` ADD COLUMN `areaLocationId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `warehouse_task` ADD COLUMN `productionOrderLineId` CHAR(36) NULL,
    MODIFY `kind` ENUM('TRANSFER', 'PICK', 'PUTAWAY', 'REPLENISH', 'ISSUE') NOT NULL DEFAULT 'TRANSFER';

-- CreateTable
CREATE TABLE `production_order` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `areaLocationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `recipeVersionId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `dueOn` DATE NULL,
    `priority` ENUM('NORMAL', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `note` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'RELEASED', 'IN_PROGRESS', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,
    `releasedByUserId` CHAR(36) NULL,
    `startedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `closedByUserId` CHAR(36) NULL,
    `closeReason` VARCHAR(300) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `cancelReason` VARCHAR(300) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `production_order_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    INDEX `production_order_organizationId_status_number_idx`(`organizationId`, `status`, `number`),
    INDEX `production_order_organizationId_productId_idx`(`organizationId`, `productId`),
    INDEX `production_order_organizationId_areaLocationId_idx`(`organizationId`, `areaLocationId`),
    INDEX `production_order_organizationId_recipeVersionId_idx`(`organizationId`, `recipeVersionId`),
    UNIQUE INDEX `production_order_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_order_organizationId_number_key`(`organizationId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_order_line` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `recipeQuantity` DECIMAL(12, 3) NOT NULL,
    `scrapPercent` DECIMAL(5, 2) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `production_order_line_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `production_order_line_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_order_line_organizationId_orderId_lineNumber_key`(`organizationId`, `orderId`, `lineNumber`),
    UNIQUE INDEX `production_order_line_organizationId_orderId_productId_key`(`organizationId`, `orderId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_order_output` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `costShare` DECIMAL(5, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `production_order_output_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `production_order_output_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_order_output_organizationId_orderId_lineNumber_key`(`organizationId`, `orderId`, `lineNumber`),
    UNIQUE INDEX `production_order_output_organizationId_orderId_productId_key`(`organizationId`, `orderId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_order_assignee` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `production_order_assignee_organizationId_userId_idx`(`organizationId`, `userId`),
    UNIQUE INDEX `production_order_assignee_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_order_assignee_organizationId_orderId_userId_key`(`organizationId`, `orderId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_productionOrderLineId_idx` ON `warehouse_task`(`organizationId`, `productionOrderLineId`);

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_productionOrderLineId_fkey` FOREIGN KEY (`organizationId`, `productionOrderLineId`) REFERENCES `production_order_line`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `recipe` ADD CONSTRAINT `recipe_organizationId_areaLocationId_fkey` FOREIGN KEY (`organizationId`, `areaLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order` ADD CONSTRAINT `production_order_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_order` ADD CONSTRAINT `production_order_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order` ADD CONSTRAINT `production_order_organizationId_areaLocationId_fkey` FOREIGN KEY (`organizationId`, `areaLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order` ADD CONSTRAINT `production_order_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order` ADD CONSTRAINT `production_order_organizationId_recipeVersionId_fkey` FOREIGN KEY (`organizationId`, `recipeVersionId`) REFERENCES `recipe_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order_line` ADD CONSTRAINT `production_order_line_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_order_line` ADD CONSTRAINT `production_order_line_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `production_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order_line` ADD CONSTRAINT `production_order_line_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order_output` ADD CONSTRAINT `production_order_output_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_order_output` ADD CONSTRAINT `production_order_output_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `production_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order_output` ADD CONSTRAINT `production_order_output_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_order_assignee` ADD CONSTRAINT `production_order_assignee_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_order_assignee` ADD CONSTRAINT `production_order_assignee_organizationId_orderId_fkey` FOREIGN KEY (`organizationId`, `orderId`) REFERENCES `production_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Orden de producción ─────────────────────────────────────────────────

ALTER TABLE `production_order`
  ADD CONSTRAINT `production_order_number` CHECK (`number` > 0),
  ADD CONSTRAINT `production_order_quantity` CHECK (`quantity` > 0),
  ADD CONSTRAINT `production_order_released` CHECK (
    `status` NOT IN ('RELEASED', 'IN_PROGRESS', 'CLOSED')
    OR (`releasedAt` IS NOT NULL AND `releasedByUserId` IS NOT NULL)),
  ADD CONSTRAINT `production_order_cancelled` CHECK (
    (`status` = 'CANCELLED') = (`cancelledAt` IS NOT NULL)
    AND (`status` <> 'CANCELLED' OR (`cancelReason` IS NOT NULL AND `cancelledByUserId` IS NOT NULL))),
  ADD CONSTRAINT `production_order_closed` CHECK (
    (`status` = 'CLOSED') = (`closedAt` IS NOT NULL)
    AND (`status` <> 'CLOSED' OR `closedByUserId` IS NOT NULL)),
  -- WMS-29 starts it (first report) and WMS-31 closes it: in progress and
  -- closed always say when it started; a cancelled one never started.
  ADD CONSTRAINT `production_order_started` CHECK (
    `status` NOT IN ('IN_PROGRESS', 'CLOSED') OR `startedAt` IS NOT NULL),
  ADD CONSTRAINT `production_order_not_started` CHECK (
    `status` NOT IN ('DRAFT', 'RELEASED', 'CANCELLED') OR `startedAt` IS NULL);

-- Una orden no se borra: se cancela o se cierra.
CREATE TRIGGER `production_order_no_delete` BEFORE DELETE ON `production_order` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order cannot be deleted';

-- Nace en borrador, con un área de uso «Producción» de su almacén.
CREATE TRIGGER `production_order_insert_rules` BEFORE INSERT ON `production_order` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order starts as a draft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM `location` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`areaLocationId`
        AND l.`facilityId` = NEW.`facilityId` AND l.`type` = 'PRODUCTION') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order area is a production location of its warehouse';
  END IF;
END;

-- Número, almacén, producto y autor nunca cambian; lo demás de la orden solo
-- en borrador; los estados solo por PRODUCTION_ORDER_TRANSITIONS
-- (order-states.ts): cambiar una exige cambiar la otra.
CREATE TRIGGER `production_order_transition` BEFORE UPDATE ON `production_order` FOR EACH ROW
BEGIN
  IF OLD.`status` IN ('CLOSED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order is closed';
  END IF;
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`facilityId` <=> OLD.`facilityId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order identity is immutable';
  END IF;
  IF NOT (NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`unitCode` <=> OLD.`unitCode`
      AND NEW.`recipeVersionId` <=> OLD.`recipeVersionId`
      AND NEW.`areaLocationId` <=> OLD.`areaLocationId`
      AND NEW.`dueOn` <=> OLD.`dueOn`
      AND NEW.`priority` <=> OLD.`priority`
      AND NEW.`note` <=> OLD.`note`)
     AND NOT (OLD.`status` = 'DRAFT' AND NEW.`status` = 'DRAFT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order only changes as a draft';
  END IF;
  IF NOT (NEW.`areaLocationId` <=> OLD.`areaLocationId`) AND NOT EXISTS (
      SELECT 1 FROM `location` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`areaLocationId`
        AND l.`facilityId` = NEW.`facilityId` AND l.`type` = 'PRODUCTION') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order area is a production location of its warehouse';
  END IF;
  IF (OLD.`releasedAt` IS NOT NULL AND NOT (NEW.`releasedAt` <=> OLD.`releasedAt`))
     OR (OLD.`releasedByUserId` IS NOT NULL AND NOT (NEW.`releasedByUserId` <=> OLD.`releasedByUserId`))
     OR (OLD.`startedAt` IS NOT NULL AND NOT (NEW.`startedAt` <=> OLD.`startedAt`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order history is immutable';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (
       (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('RELEASED', 'CANCELLED'))
    OR (OLD.`status` = 'RELEASED' AND NEW.`status` IN ('IN_PROGRESS', 'CANCELLED'))
    OR (OLD.`status` = 'IN_PROGRESS' AND NEW.`status` = 'CLOSED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order transition not allowed';
  END IF;
END;

-- ── Materiales y lo que sale: solo en borrador, sin cambios ─────────────

ALTER TABLE `production_order_line`
  ADD CONSTRAINT `production_order_line_quantity` CHECK (`quantity` > 0 AND `recipeQuantity` > 0),
  ADD CONSTRAINT `production_order_line_scrap` CHECK (`scrapPercent` IS NULL OR (`scrapPercent` >= 0 AND `scrapPercent` < 100)),
  ADD CONSTRAINT `production_order_line_number` CHECK (`lineNumber` > 0);

ALTER TABLE `production_order_output`
  ADD CONSTRAINT `production_order_output_quantity` CHECK (`quantity` >= 0),
  ADD CONSTRAINT `production_order_output_share` CHECK (`costShare` >= 0 AND `costShare` <= 100),
  ADD CONSTRAINT `production_order_output_number` CHECK (`lineNumber` > 0);

CREATE TRIGGER `production_order_line_insert` BEFORE INSERT ON `production_order_line` FOR EACH ROW
BEGIN
  IF (SELECT o.`status` FROM `production_order` o
      WHERE o.`organizationId` = NEW.`organizationId` AND o.`id` = NEW.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_line only changes in a draft';
  END IF;
END;

CREATE TRIGGER `production_order_line_update` BEFORE UPDATE ON `production_order_line` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_line is immutable';

CREATE TRIGGER `production_order_line_delete` BEFORE DELETE ON `production_order_line` FOR EACH ROW
BEGIN
  IF (SELECT o.`status` FROM `production_order` o
      WHERE o.`organizationId` = OLD.`organizationId` AND o.`id` = OLD.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_line only changes in a draft';
  END IF;
END;

CREATE TRIGGER `production_order_output_insert` BEFORE INSERT ON `production_order_output` FOR EACH ROW
BEGIN
  IF (SELECT o.`status` FROM `production_order` o
      WHERE o.`organizationId` = NEW.`organizationId` AND o.`id` = NEW.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_output only changes in a draft';
  END IF;
END;

CREATE TRIGGER `production_order_output_update` BEFORE UPDATE ON `production_order_output` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_output is immutable';

CREATE TRIGGER `production_order_output_delete` BEFORE DELETE ON `production_order_output` FOR EACH ROW
BEGIN
  IF (SELECT o.`status` FROM `production_order` o
      WHERE o.`organizationId` = OLD.`organizationId` AND o.`id` = OLD.`orderId`) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_output only changes in a draft';
  END IF;
END;

-- ── Personas asignadas: hasta que la orden se cierra o se cancela ───────

CREATE TRIGGER `production_order_assignee_insert` BEFORE INSERT ON `production_order_assignee` FOR EACH ROW
BEGIN
  IF (SELECT o.`status` FROM `production_order` o
      WHERE o.`organizationId` = NEW.`organizationId` AND o.`id` = NEW.`orderId`) IN ('CLOSED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_assignee: the order is closed';
  END IF;
END;

CREATE TRIGGER `production_order_assignee_update` BEFORE UPDATE ON `production_order_assignee` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_assignee is immutable';

CREATE TRIGGER `production_order_assignee_delete` BEFORE DELETE ON `production_order_assignee` FOR EACH ROW
BEGIN
  IF (SELECT o.`status` FROM `production_order` o
      WHERE o.`organizationId` = OLD.`organizationId` AND o.`id` = OLD.`orderId`) IN ('CLOSED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order_assignee: the order is closed';
  END IF;
END;

-- ── Tarea «Surtir a producción» ─────────────────────────────────────────

-- Exactamente las tareas ISSUE llevan su línea de orden.
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_issue_line` CHECK ((`kind` = 'ISSUE') = (`productionOrderLineId` IS NOT NULL));

-- Una tarea de surtir a producción nace de una orden liberada o en curso,
-- con el producto de su línea y hacia el área de la orden.
CREATE TRIGGER `warehouse_task_issue_insert` BEFORE INSERT ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NEW.`kind` = 'ISSUE' AND NOT EXISTS (SELECT 1 FROM `production_order_line` l
      JOIN `production_order` o ON o.`organizationId` = l.`organizationId` AND o.`id` = l.`orderId`
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`productionOrderLineId`
        AND o.`status` IN ('RELEASED', 'IN_PROGRESS')
        AND l.`productId` = NEW.`productId`
        AND o.`areaLocationId` = NEW.`toLocationId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an issue task comes from a released production order to its area';
  END IF;
END;

-- La línea que surte no cambia.
CREATE TRIGGER `warehouse_task_production_line_fixed` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`productionOrderLineId` <=> OLD.`productionOrderLineId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task production line is immutable';
  END IF;
END;
