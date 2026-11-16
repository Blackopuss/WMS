-- WMS-42 (revisión): la clave de confirmación de un mantenimiento, para que
-- un doble envío no registre dos. Solo expansión: columna nueva.
-- AlterTable
ALTER TABLE `equipment_maintenance` ADD COLUMN `idempotencyKey` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `equipment_maintenance_organizationId_idempotencyKey_key` ON `equipment_maintenance`(`organizationId`, `idempotencyKey`);

