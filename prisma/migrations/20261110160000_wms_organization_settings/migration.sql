-- WMS-49: parámetros de operación por empresa. La clave y su validación viven en
-- el código (@/platform/settings); sin fila, rige el valor por omisión.

-- CreateTable
CREATE TABLE `organization_setting` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `key` VARCHAR(80) NOT NULL,
    `value` VARCHAR(500) NOT NULL,
    `updatedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organization_setting_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `organization_setting_organizationId_key_key`(`organizationId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organization_setting` ADD CONSTRAINT `organization_setting_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE `organization_setting`
  ADD CONSTRAINT `organization_setting_key` CHECK (CHAR_LENGTH(`key`) BETWEEN 3 AND 80);
