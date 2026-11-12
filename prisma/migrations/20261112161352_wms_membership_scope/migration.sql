-- WMS-20 (ADR 0038): where a member may work. No rows = every warehouse;
-- a row without location opens the whole warehouse, a row with one opens
-- that location and what it holds.
-- CreateTable
CREATE TABLE `membership_scope` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `membershipId` CHAR(36) NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `membership_scope_organizationId_membershipId_idx`(`organizationId`, `membershipId`),
    INDEX `membership_scope_organizationId_facilityId_locationId_idx`(`organizationId`, `facilityId`, `locationId`),
    UNIQUE INDEX `membership_scope_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `membership_scope_membershipId_facilityId_locationId_key`(`membershipId`, `facilityId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `membership_scope` ADD CONSTRAINT `membership_scope_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `membership_scope` ADD CONSTRAINT `membership_scope_organizationId_membershipId_fkey` FOREIGN KEY (`organizationId`, `membershipId`) REFERENCES `membership`(`organizationId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `membership_scope` ADD CONSTRAINT `membership_scope_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `membership_scope` ADD CONSTRAINT `membership_scope_organizationId_facilityId_locationId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `locationId`) REFERENCES `location`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

