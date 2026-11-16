-- WMS-67 (ADR 0070): keys of the storage whose bytes may be left without a live file.
-- CreateTable
CREATE TABLE `storage_cleanup` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `storageKey` VARCHAR(100) NOT NULL,
    `reason` ENUM('UPLOAD', 'DELETE') NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` VARCHAR(200) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `storage_cleanup_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `storage_cleanup_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `storage_cleanup` ADD CONSTRAINT `storage_cleanup_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- WMS-67 (ADR 0070): the storage quota of each company starts with what it
-- already keeps (files not removed), in KiB rounded up per file, so the
-- counter tells the truth from the first upload. Companies without files
-- get their counter when they first upload.
INSERT INTO `quota_usage` (`id`, `organizationId`, `key`, `taken`, `reserved`, `updatedAt`)
SELECT UUID(), `organizationId`, 'file_storage_kib', SUM(CEIL(`size` / 1024)), 0, CURRENT_TIMESTAMP(3)
FROM `stored_file`
WHERE `deletedAt` IS NULL
GROUP BY `organizationId`;
