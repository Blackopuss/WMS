-- WMS-42 (ADR 0065): equipos del almacén (tipos, equipos, mantenimientos),
-- el tipo de equipo que pide una tarea y el equipo con que se hace, y el
-- equipo de una incidencia. Solo expansión: tablas y columnas nuevas.
-- AlterTable
ALTER TABLE `incident` ADD COLUMN `equipmentId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `warehouse_task` ADD COLUMN `equipmentId` CHAR(36) NULL,
    ADD COLUMN `equipmentTypeId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `equipment_type` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `equipment_type_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `equipment_type_organizationId_name_key`(`organizationId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `equipment` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `typeId` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `status` ENUM('IN_SERVICE', 'OUT_OF_SERVICE') NOT NULL DEFAULT 'IN_SERVICE',
    `outOfServiceReason` VARCHAR(300) NULL,
    `outOfServiceAt` DATETIME(3) NULL,
    `outOfServiceByUserId` CHAR(36) NULL,
    `maintenanceDueOn` DATE NULL,
    `retiredAt` DATETIME(3) NULL,
    `retiredReason` VARCHAR(300) NULL,
    `retiredByUserId` CHAR(36) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `equipment_organizationId_facilityId_retiredAt_code_idx`(`organizationId`, `facilityId`, `retiredAt`, `code`),
    INDEX `equipment_organizationId_typeId_idx`(`organizationId`, `typeId`),
    INDEX `equipment_organizationId_maintenanceDueOn_idx`(`organizationId`, `maintenanceDueOn`),
    UNIQUE INDEX `equipment_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `equipment_organizationId_code_key`(`organizationId`, `code`),
    UNIQUE INDEX `equipment_organizationId_facilityId_id_key`(`organizationId`, `facilityId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `equipment_maintenance` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `equipmentId` CHAR(36) NOT NULL,
    `performedOn` DATE NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `performedBy` VARCHAR(120) NULL,
    `nextDueOn` DATE NULL,
    `recordedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `equipment_maintenance_organizationId_equipmentId_performedOn_idx`(`organizationId`, `equipmentId`, `performedOn`, `id`),
    UNIQUE INDEX `equipment_maintenance_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `incident_organizationId_equipmentId_number_idx` ON `incident`(`organizationId`, `equipmentId`, `number`);

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_equipmentId_status_idx` ON `warehouse_task`(`organizationId`, `equipmentId`, `status`);

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_equipmentTypeId_idx` ON `warehouse_task`(`organizationId`, `equipmentTypeId`);

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_equipmentTypeId_fkey` FOREIGN KEY (`organizationId`, `equipmentTypeId`) REFERENCES `equipment_type`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_equipmentId_fkey` FOREIGN KEY (`organizationId`, `equipmentId`) REFERENCES `equipment`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_facilityId_equipmentId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `equipmentId`) REFERENCES `equipment`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `equipment_type` ADD CONSTRAINT `equipment_type_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `equipment` ADD CONSTRAINT `equipment_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `equipment` ADD CONSTRAINT `equipment_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `equipment` ADD CONSTRAINT `equipment_organizationId_typeId_fkey` FOREIGN KEY (`organizationId`, `typeId`) REFERENCES `equipment_type`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `equipment_maintenance` ADD CONSTRAINT `equipment_maintenance_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `equipment_maintenance` ADD CONSTRAINT `equipment_maintenance_organizationId_equipmentId_fkey` FOREIGN KEY (`organizationId`, `equipmentId`) REFERENCES `equipment`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Reglas que la base cuida además del servicio.
ALTER TABLE `equipment` ADD CONSTRAINT `equipment_code_check` CHECK (CHAR_LENGTH(`code`) >= 1);
ALTER TABLE `equipment` ADD CONSTRAINT `equipment_status_check` CHECK (
  (`status` = 'IN_SERVICE' AND `outOfServiceReason` IS NULL)
  OR (`status` = 'OUT_OF_SERVICE' AND `outOfServiceReason` IS NOT NULL));
ALTER TABLE `equipment` ADD CONSTRAINT `equipment_retired_check` CHECK (
  (`retiredAt` IS NULL AND `retiredReason` IS NULL)
  OR (`retiredAt` IS NOT NULL AND `retiredReason` IS NOT NULL));
ALTER TABLE `equipment_type` ADD CONSTRAINT `equipment_type_name_check` CHECK (CHAR_LENGTH(`name`) >= 2);
ALTER TABLE `equipment_maintenance` ADD CONSTRAINT `equipment_maintenance_description_check` CHECK (CHAR_LENGTH(`description`) >= 3);

-- Nada de equipos se borra; un equipo no cambia de almacén ni vuelve de una
-- baja; un mantenimiento registrado no cambia.
CREATE TRIGGER `equipment_type_no_delete` BEFORE DELETE ON `equipment_type` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment_type is archived, never deleted';
END;

CREATE TRIGGER `equipment_no_delete` BEFORE DELETE ON `equipment` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment is retired, never deleted';
END;

CREATE TRIGGER `equipment_fixed` BEFORE UPDATE ON `equipment` FOR EACH ROW
BEGIN
  IF OLD.`retiredAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment: a retired equipment does not change';
  END IF;
  IF NOT (NEW.`facilityId` <=> OLD.`facilityId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment: facilityId never changes';
  END IF;
END;

CREATE TRIGGER `equipment_maintenance_no_update` BEFORE UPDATE ON `equipment_maintenance` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment_maintenance never changes';
END;

CREATE TRIGGER `equipment_maintenance_no_delete` BEFORE DELETE ON `equipment_maintenance` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment_maintenance is never deleted';
END;

-- Una tarea nace sin equipo. El tipo que pide no cambia; el equipo solo se
-- pone al tomarla (o se cambia mientras sigue tomada) y se quita al volver
-- a estar disponible; es del tipo pedido y del almacén de su origen. Una
-- tarea que pide equipo y ya se tomó, recogió o entregó tiene uno.
CREATE TRIGGER `warehouse_task_equipment_insert` BEFORE INSERT ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NEW.`equipmentId` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task starts without equipment';
  END IF;
END;

CREATE TRIGGER `warehouse_task_equipment` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`equipmentTypeId` <=> OLD.`equipmentTypeId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: equipmentTypeId never changes';
  END IF;
  IF NOT (NEW.`equipmentId` <=> OLD.`equipmentId`) THEN
    IF NOT ((NEW.`status` = 'ACCEPTED' AND NEW.`equipmentId` IS NOT NULL)
         OR (NEW.`status` = 'PENDING' AND NEW.`equipmentId` IS NULL)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: the equipment changes only when taken or released';
    END IF;
    IF NEW.`equipmentId` IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM `equipment` e
        JOIN `location` l ON l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`fromLocationId`
        WHERE e.`organizationId` = NEW.`organizationId` AND e.`id` = NEW.`equipmentId`
          AND e.`typeId` = NEW.`equipmentTypeId` AND e.`facilityId` = l.`facilityId`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: the equipment is of the type asked and of its warehouse';
    END IF;
  END IF;
  IF NEW.`equipmentTypeId` IS NOT NULL AND NEW.`equipmentId` IS NULL
      AND NEW.`status` IN ('ACCEPTED', 'PICKED_UP', 'DELIVERED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: a task that asks for equipment is done with one';
  END IF;
END;
