-- CreateTable
CREATE TABLE `automation_scan` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `ruleId` CHAR(36) NOT NULL,
    `placeKey` VARCHAR(36) NOT NULL,
    `nextPage` INTEGER NOT NULL DEFAULT 1,
    `unfinished` BOOLEAN NOT NULL DEFAULT false,
    `reviewed` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `automation_scan_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `automation_scan_organizationId_ruleId_placeKey_key`(`organizationId`, `ruleId`, `placeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `automation_scan` ADD CONSTRAINT `automation_scan_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_scan` ADD CONSTRAINT `automation_scan_organizationId_ruleId_fkey` FOREIGN KEY (`organizationId`, `ruleId`) REFERENCES `automation_rule`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- WMS-64 (segunda revisión): dónde dejó la ronda la revisión de cada regla
-- y almacén; las páginas no son negativas.
ALTER TABLE `automation_scan` ADD CONSTRAINT `automation_scan_counters` CHECK (`nextPage` >= 1 AND `reviewed` >= 0);
