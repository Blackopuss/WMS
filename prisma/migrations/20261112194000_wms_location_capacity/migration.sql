-- WMS-22B (ADR 0039): capacity and restrictions of locations.
-- * product.unitWeight (kg) and product.unitVolume (liters) of one unit of
--   the product; NULL = unknown, it does not count in that measure.
-- * location_capacity: what a location (with everything inside it) may hold
--   at most; a row exists only while some limit is set, and it is the row
--   an arrival locks to be decided after the previous one.
-- * location_restriction: the products or categories a location is limited
--   to; no rows = anything.
-- Expansion only: nothing existing changes.
-- AlterTable
ALTER TABLE `product` ADD COLUMN `unitVolume` DECIMAL(14, 6) NULL,
    ADD COLUMN `unitWeight` DECIMAL(14, 6) NULL;

-- CreateTable
CREATE TABLE `location_capacity` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `maxUnits` DECIMAL(18, 3) NULL,
    `maxWeight` DECIMAL(18, 3) NULL,
    `maxVolume` DECIMAL(18, 3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `location_capacity_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `location_capacity_organizationId_locationId_key`(`organizationId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `location_restriction` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NULL,
    `categoryId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `location_restriction_organizationId_productId_idx`(`organizationId`, `productId`),
    INDEX `location_restriction_organizationId_categoryId_idx`(`organizationId`, `categoryId`),
    UNIQUE INDEX `location_restriction_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `location_restriction_organizationId_locationId_productId_key`(`organizationId`, `locationId`, `productId`),
    UNIQUE INDEX `location_restriction_organizationId_locationId_categoryId_key`(`organizationId`, `locationId`, `categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `location_capacity` ADD CONSTRAINT `location_capacity_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `location_capacity` ADD CONSTRAINT `location_capacity_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `location_restriction` ADD CONSTRAINT `location_restriction_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `location_restriction` ADD CONSTRAINT `location_restriction_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `location_restriction` ADD CONSTRAINT `location_restriction_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `location_restriction` ADD CONSTRAINT `location_restriction_organizationId_categoryId_fkey` FOREIGN KEY (`organizationId`, `categoryId`) REFERENCES `product_category`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- A weight or a volume is a positive amount, or unknown.
ALTER TABLE `product` ADD CONSTRAINT `product_unit_weight` CHECK (`unitWeight` IS NULL OR `unitWeight` > 0);
ALTER TABLE `product` ADD CONSTRAINT `product_unit_volume` CHECK (`unitVolume` IS NULL OR `unitVolume` > 0);

-- A capacity row carries at least one limit, and every limit is positive.
ALTER TABLE `location_capacity` ADD CONSTRAINT `location_capacity_some` CHECK (`maxUnits` IS NOT NULL OR `maxWeight` IS NOT NULL OR `maxVolume` IS NOT NULL);
ALTER TABLE `location_capacity` ADD CONSTRAINT `location_capacity_units` CHECK (`maxUnits` IS NULL OR `maxUnits` > 0);
ALTER TABLE `location_capacity` ADD CONSTRAINT `location_capacity_weight` CHECK (`maxWeight` IS NULL OR `maxWeight` > 0);
ALTER TABLE `location_capacity` ADD CONSTRAINT `location_capacity_volume` CHECK (`maxVolume` IS NULL OR `maxVolume` > 0);

-- A restriction names a product or a category, never both nor neither.
ALTER TABLE `location_restriction` ADD CONSTRAINT `location_restriction_one` CHECK ((`productId` IS NULL) <> (`categoryId` IS NULL));
