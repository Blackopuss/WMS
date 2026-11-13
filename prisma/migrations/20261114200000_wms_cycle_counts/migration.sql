-- WMS-55 (ADR 0050): programas de conteo cíclico y los conteos que generan.
-- Solo de expansión: una tabla nueva y dos columnas que admiten NULL.

-- AlterTable
ALTER TABLE `stock_count` ADD COLUMN `programDay` DATE NULL,
    ADD COLUMN `programId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `count_program` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `rootLocationId` CHAR(36) NULL,
    `basis` ENUM('EVEN', 'ABC') NOT NULL DEFAULT 'EVEN',
    `everyDays` INTEGER NOT NULL,
    `everyDaysB` INTEGER NULL,
    `everyDaysC` INTEGER NULL,
    `locationsPerDay` INTEGER NOT NULL,
    `pausedAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `count_program_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `count_program_organizationId_facilityId_name_key`(`organizationId`, `facilityId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `stock_count_organizationId_programDay_idx` ON `stock_count`(`organizationId`, `programDay`);

-- CreateIndex
CREATE UNIQUE INDEX `stock_count_organizationId_programId_programDay_locationId_key` ON `stock_count`(`organizationId`, `programId`, `programDay`, `locationId`);

-- AddForeignKey
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_organizationId_programId_fkey` FOREIGN KEY (`organizationId`, `programId`) REFERENCES `count_program`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `count_program` ADD CONSTRAINT `count_program_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_program` ADD CONSTRAINT `count_program_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `count_program` ADD CONSTRAINT `count_program_organizationId_facilityId_rootLocationId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `rootLocationId`) REFERENCES `location`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Un programa cuenta cada ubicación entre 1 y 365 días, y de 1 a 500 por día;
-- con ABC lleva la frecuencia de B y de C, y sin ABC no lleva ninguna.
ALTER TABLE `count_program`
    ADD CONSTRAINT `count_program_every_days` CHECK (`everyDays` BETWEEN 1 AND 365),
    ADD CONSTRAINT `count_program_per_day` CHECK (`locationsPerDay` BETWEEN 1 AND 500),
    ADD CONSTRAINT `count_program_abc` CHECK (
      (`basis` = 'ABC' AND `everyDaysB` IS NOT NULL AND `everyDaysC` IS NOT NULL
        AND `everyDaysB` BETWEEN 1 AND 365 AND `everyDaysC` BETWEEN 1 AND 365)
      OR (`basis` = 'EVEN' AND `everyDaysB` IS NULL AND `everyDaysC` IS NULL)
    );

-- Un conteo generado lleva su programa y su día, o ninguno de los dos.
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_program_day` CHECK (
  (`programId` IS NULL AND `programDay` IS NULL)
  OR (`programId` IS NOT NULL AND `programDay` IS NOT NULL)
);

-- Un programa no cambia de almacén, y un conteo no cambia de programa ni de
-- día: eso es lo que impide generarlo dos veces.
CREATE TRIGGER `count_program_facility_fixed` BEFORE UPDATE ON `count_program` FOR EACH ROW
BEGIN
  IF NOT (NEW.`facilityId` <=> OLD.`facilityId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a count program stays in its warehouse';
  END IF;
END;

CREATE TRIGGER `stock_count_program_fixed` BEFORE UPDATE ON `stock_count` FOR EACH ROW
BEGIN
  IF NOT (NEW.`programId` <=> OLD.`programId`) OR NOT (NEW.`programDay` <=> OLD.`programDay`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a generated count keeps its program and day';
  END IF;
END;

-- Nunca se borra un programa: se pausa.
CREATE TRIGGER `count_program_no_delete` BEFORE DELETE ON `count_program` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a count program is paused, never deleted';
END;
