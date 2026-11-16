-- WMS-30A (ADR 0067): inspection plans of a product, versioned, and the
-- defects of the company. Expansion only.

-- CreateTable
CREATE TABLE `quality_plan` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `quality_plan_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_plan_organizationId_productId_key`(`organizationId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_plan_version` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `planId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'RETIRED', 'DISCARDED') NOT NULL DEFAULT 'DRAFT',
    `draftPlanId` CHAR(36) NULL,
    `activePlanId` CHAR(36) NULL,
    `sampling` ENUM('DEFAULT', 'FULL', 'SAMPLE') NOT NULL DEFAULT 'DEFAULT',
    `sampleRule` ENUM('FIXED', 'PERCENT') NULL,
    `sampleQuantity` DECIMAL(15, 3) NULL,
    `samplePercent` INTEGER NULL,
    `sampleMin` DECIMAL(15, 3) NULL,
    `sampleMax` DECIMAL(15, 3) NULL,
    `forProduced` BOOLEAN NOT NULL DEFAULT true,
    `forReceived` BOOLEAN NOT NULL DEFAULT true,
    `forReturned` BOOLEAN NOT NULL DEFAULT true,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedByUserId` CHAR(36) NULL,
    `publishedAt` DATETIME(3) NULL,
    `closedByUserId` CHAR(36) NULL,
    `closedAt` DATETIME(3) NULL,

    UNIQUE INDEX `quality_plan_version_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_plan_version_organizationId_planId_number_key`(`organizationId`, `planId`, `number`),
    UNIQUE INDEX `quality_plan_version_organizationId_draftPlanId_key`(`organizationId`, `draftPlanId`),
    UNIQUE INDEX `quality_plan_version_organizationId_activePlanId_key`(`organizationId`, `activePlanId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_plan_point` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `kind` ENUM('CHECK', 'NUMBER', 'CHOICE', 'TEXT') NOT NULL,
    `required` BOOLEAN NOT NULL DEFAULT true,
    `photo` BOOLEAN NOT NULL DEFAULT false,
    `minValue` DECIMAL(19, 4) NULL,
    `maxValue` DECIMAL(19, 4) NULL,
    `unitLabel` VARCHAR(20) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `quality_plan_point_organizationId_versionId_position_idx`(`organizationId`, `versionId`, `position`),
    UNIQUE INDEX `quality_plan_point_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_plan_point_organizationId_versionId_label_key`(`organizationId`, `versionId`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_plan_point_option` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `pointId` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `acceptable` BOOLEAN NOT NULL,

    UNIQUE INDEX `quality_plan_point_option_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_plan_point_option_organizationId_pointId_label_key`(`organizationId`, `pointId`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_defect` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `severity` ENUM('MINOR', 'MAJOR', 'CRITICAL') NOT NULL DEFAULT 'MAJOR',
    `archivedAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `quality_defect_organizationId_archivedAt_name_idx`(`organizationId`, `archivedAt`, `name`),
    UNIQUE INDEX `quality_defect_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_defect_organizationId_name_key`(`organizationId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_defect_catalog` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `quality_defect_catalog_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `quality_defect_catalog_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `quality_defect_catalog` ADD CONSTRAINT `quality_defect_catalog_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_plan` ADD CONSTRAINT `quality_plan_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_plan` ADD CONSTRAINT `quality_plan_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_plan_version` ADD CONSTRAINT `quality_plan_version_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_plan_version` ADD CONSTRAINT `quality_plan_version_organizationId_planId_fkey` FOREIGN KEY (`organizationId`, `planId`) REFERENCES `quality_plan`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_plan_point` ADD CONSTRAINT `quality_plan_point_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_plan_point` ADD CONSTRAINT `quality_plan_point_organizationId_versionId_fkey` FOREIGN KEY (`organizationId`, `versionId`) REFERENCES `quality_plan_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_plan_point_option` ADD CONSTRAINT `quality_plan_point_option_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quality_plan_point_option` ADD CONSTRAINT `quality_plan_point_option_organizationId_pointId_fkey` FOREIGN KEY (`organizationId`, `pointId`) REFERENCES `quality_plan_point`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_defect` ADD CONSTRAINT `quality_defect_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- A sample rule says how much, and only when the quality is sampled.
ALTER TABLE `quality_plan_version` ADD CONSTRAINT `quality_plan_version_sample` CHECK (
    ((`sampling` = 'SAMPLE' AND `sampleRule` IS NOT NULL) OR (`sampling` <> 'SAMPLE' AND `sampleRule` IS NULL))
    AND (
        (`sampleRule` IS NULL AND `sampleQuantity` IS NULL AND `samplePercent` IS NULL
            AND `sampleMin` IS NULL AND `sampleMax` IS NULL)
        OR (`sampleRule` IS NOT NULL AND `sampleRule` = 'FIXED'
            AND `sampleQuantity` IS NOT NULL AND `sampleQuantity` > 0
            AND `samplePercent` IS NULL AND `sampleMin` IS NULL AND `sampleMax` IS NULL)
        OR (`sampleRule` IS NOT NULL AND `sampleRule` = 'PERCENT' AND `sampleQuantity` IS NULL
            AND `samplePercent` IS NOT NULL AND `samplePercent` BETWEEN 1 AND 100
            AND `sampleMin` IS NOT NULL AND `sampleMin` > 0
            AND (`sampleMax` IS NULL OR `sampleMax` >= `sampleMin`))
    )
);

-- A plan applies to something, and versions count from 1.
ALTER TABLE `quality_plan_version` ADD CONSTRAINT `quality_plan_version_applies` CHECK (
    (`forProduced` OR `forReceived` OR `forReturned`) AND `number` >= 1
);

-- Who published and who closed it go with the state: a draft has neither,
-- a version in force was published, a retired one was published and
-- closed, a discarded one was closed without being published.
ALTER TABLE `quality_plan_version` ADD CONSTRAINT `quality_plan_version_stamps` CHECK (
    (`status` = 'DRAFT' AND `publishedAt` IS NULL AND `publishedByUserId` IS NULL
        AND `closedAt` IS NULL AND `closedByUserId` IS NULL)
    OR (`status` = 'ACTIVE' AND `publishedAt` IS NOT NULL AND `publishedByUserId` IS NOT NULL
        AND `closedAt` IS NULL AND `closedByUserId` IS NULL)
    OR (`status` = 'RETIRED' AND `publishedAt` IS NOT NULL AND `publishedByUserId` IS NOT NULL
        AND `closedAt` IS NOT NULL AND `closedByUserId` IS NOT NULL)
    OR (`status` = 'DISCARDED' AND `publishedAt` IS NULL AND `publishedByUserId` IS NULL
        AND `closedAt` IS NOT NULL AND `closedByUserId` IS NOT NULL)
);

-- Only a number has a range and a unit; a number has at least one end.
ALTER TABLE `quality_plan_point` ADD CONSTRAINT `quality_plan_point_range` CHECK (
    (`kind` = 'NUMBER' AND (`minValue` IS NOT NULL OR `maxValue` IS NOT NULL)
        AND (`minValue` IS NULL OR `maxValue` IS NULL OR `minValue` <= `maxValue`))
    OR (`kind` <> 'NUMBER' AND `minValue` IS NULL AND `maxValue` IS NULL AND `unitLabel` IS NULL)
);

-- The product of a plan never changes; plans are never deleted.
CREATE TRIGGER `quality_plan_fixed` BEFORE UPDATE ON `quality_plan` FOR EACH ROW
BEGIN
    IF NEW.`productId` <> OLD.`productId` OR NEW.`createdByUserId` <> OLD.`createdByUserId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan: the product of a plan cannot change';
    END IF;
END;

CREATE TRIGGER `quality_plan_no_delete` BEFORE DELETE ON `quality_plan` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan: a plan is never deleted';
END;

-- A version is born a draft; draftPlanId and activePlanId follow its state.
CREATE TRIGGER `quality_plan_version_insert` BEFORE INSERT ON `quality_plan_version` FOR EACH ROW
BEGIN
    IF NEW.`status` <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_version: a version starts as a draft';
    END IF;
    SET NEW.`draftPlanId` = NEW.`planId`;
    SET NEW.`activePlanId` = NULL;
END;

-- DRAFT -> ACTIVE -> RETIRED and DRAFT -> DISCARDED. Outside a draft only
-- the state (and when and who closed it) changes, once.
CREATE TRIGGER `quality_plan_version_update` BEFORE UPDATE ON `quality_plan_version` FOR EACH ROW
BEGIN
    IF NEW.`planId` <> OLD.`planId` OR NEW.`number` <> OLD.`number`
        OR NEW.`createdByUserId` <> OLD.`createdByUserId` OR NEW.`createdAt` <> OLD.`createdAt` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_version: plan, number and author cannot change';
    END IF;
    IF NOT (
        (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('DRAFT', 'ACTIVE', 'DISCARDED'))
        OR (OLD.`status` = 'ACTIVE' AND NEW.`status` = 'RETIRED')
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_version: a published version does not change';
    END IF;
    IF OLD.`status` <> 'DRAFT' AND NOT (
        NEW.`sampling` <=> OLD.`sampling` AND NEW.`sampleRule` <=> OLD.`sampleRule`
        AND NEW.`sampleQuantity` <=> OLD.`sampleQuantity` AND NEW.`samplePercent` <=> OLD.`samplePercent`
        AND NEW.`sampleMin` <=> OLD.`sampleMin` AND NEW.`sampleMax` <=> OLD.`sampleMax`
        AND NEW.`forProduced` <=> OLD.`forProduced` AND NEW.`forReceived` <=> OLD.`forReceived`
        AND NEW.`forReturned` <=> OLD.`forReturned`
        AND NEW.`publishedByUserId` <=> OLD.`publishedByUserId` AND NEW.`publishedAt` <=> OLD.`publishedAt`
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_version: a published version does not change';
    END IF;
    SET NEW.`draftPlanId` = IF(NEW.`status` = 'DRAFT', NEW.`planId`, NULL);
    SET NEW.`activePlanId` = IF(NEW.`status` = 'ACTIVE', NEW.`planId`, NULL);
END;

CREATE TRIGGER `quality_plan_version_no_delete` BEFORE DELETE ON `quality_plan_version` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_version: a version is never deleted';
END;

-- Points and options change only while their version is a draft.
CREATE TRIGGER `quality_plan_point_insert` BEFORE INSERT ON `quality_plan_point` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `quality_plan_version` v
        WHERE v.`organizationId` = NEW.`organizationId` AND v.`id` = NEW.`versionId` AND v.`status` = 'DRAFT'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_point: only a draft changes';
    END IF;
END;

CREATE TRIGGER `quality_plan_point_update` BEFORE UPDATE ON `quality_plan_point` FOR EACH ROW
BEGIN
    IF NEW.`versionId` <> OLD.`versionId` OR NOT EXISTS (
        SELECT 1 FROM `quality_plan_version` v
        WHERE v.`organizationId` = OLD.`organizationId` AND v.`id` = OLD.`versionId` AND v.`status` = 'DRAFT'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_point: only a draft changes';
    END IF;
END;

CREATE TRIGGER `quality_plan_point_delete` BEFORE DELETE ON `quality_plan_point` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `quality_plan_version` v
        WHERE v.`organizationId` = OLD.`organizationId` AND v.`id` = OLD.`versionId` AND v.`status` = 'DRAFT'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_point: only a draft changes';
    END IF;
END;

CREATE TRIGGER `quality_plan_point_option_insert` BEFORE INSERT ON `quality_plan_point_option` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `quality_plan_point` p
        JOIN `quality_plan_version` v ON v.`organizationId` = p.`organizationId` AND v.`id` = p.`versionId`
        WHERE p.`organizationId` = NEW.`organizationId` AND p.`id` = NEW.`pointId`
          AND p.`kind` = 'CHOICE' AND v.`status` = 'DRAFT'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_point_option: only a list point of a draft has options';
    END IF;
END;

CREATE TRIGGER `quality_plan_point_option_update` BEFORE UPDATE ON `quality_plan_point_option` FOR EACH ROW
BEGIN
    IF NEW.`pointId` <> OLD.`pointId` OR NOT EXISTS (
        SELECT 1 FROM `quality_plan_point` p
        JOIN `quality_plan_version` v ON v.`organizationId` = p.`organizationId` AND v.`id` = p.`versionId`
        WHERE p.`organizationId` = OLD.`organizationId` AND p.`id` = OLD.`pointId` AND v.`status` = 'DRAFT'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_point_option: only a draft changes';
    END IF;
END;

CREATE TRIGGER `quality_plan_point_option_delete` BEFORE DELETE ON `quality_plan_point_option` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `quality_plan_point` p
        JOIN `quality_plan_version` v ON v.`organizationId` = p.`organizationId` AND v.`id` = p.`versionId`
        WHERE p.`organizationId` = OLD.`organizationId` AND p.`id` = OLD.`pointId` AND v.`status` = 'DRAFT'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_plan_point_option: only a draft changes';
    END IF;
END;

-- A defect is archived, never deleted.
CREATE TRIGGER `quality_defect_no_delete` BEFORE DELETE ON `quality_defect` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_defect: a defect is never deleted';
END;

CREATE TRIGGER `quality_defect_catalog_no_delete` BEFORE DELETE ON `quality_defect_catalog` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quality_defect_catalog: never deleted';
END;
