-- WMS-27 (ADR 0066): receta en la ficha del producto. Solo expansión: cinco
-- tablas nuevas, sin tocar ninguna existente.
-- CreateTable
CREATE TABLE `recipe` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `recipe_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `recipe_organizationId_productId_key`(`organizationId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recipe_version` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `recipeId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'RETIRED', 'DISCARDED') NOT NULL DEFAULT 'DRAFT',
    `baseQuantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `activeRecipeId` CHAR(36) NULL,
    `draftRecipeId` CHAR(36) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `activatedAt` DATETIME(3) NULL,
    `activatedByUserId` CHAR(36) NULL,
    `retiredAt` DATETIME(3) NULL,
    `retiredByUserId` CHAR(36) NULL,
    `discardedAt` DATETIME(3) NULL,
    `discardedByUserId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `recipe_version_organizationId_status_idx`(`organizationId`, `status`),
    UNIQUE INDEX `recipe_version_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `recipe_version_organizationId_recipeId_number_key`(`organizationId`, `recipeId`, `number`),
    UNIQUE INDEX `recipe_version_organizationId_activeRecipeId_key`(`organizationId`, `activeRecipeId`),
    UNIQUE INDEX `recipe_version_organizationId_draftRecipeId_key`(`organizationId`, `draftRecipeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recipe_input` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `capturedQuantity` DECIMAL(12, 3) NOT NULL,
    `presentationId` CHAR(36) NULL,
    `presentationVersionId` CHAR(36) NULL,
    `capturedUnitCode` VARCHAR(12) NULL,
    `factor` DECIMAL(18, 6) NOT NULL,
    `baseQuantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `scrapPercent` DECIMAL(5, 2) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `recipe_input_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `recipe_input_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `recipe_input_organizationId_versionId_lineNumber_key`(`organizationId`, `versionId`, `lineNumber`),
    UNIQUE INDEX `recipe_input_organizationId_versionId_productId_key`(`organizationId`, `versionId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recipe_output` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `costShare` DECIMAL(5, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `recipe_output_organizationId_productId_idx`(`organizationId`, `productId`),
    UNIQUE INDEX `recipe_output_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `recipe_output_organizationId_versionId_lineNumber_key`(`organizationId`, `versionId`, `lineNumber`),
    UNIQUE INDEX `recipe_output_organizationId_versionId_productId_key`(`organizationId`, `versionId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recipe_lock` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `recipe_lock_organizationId_key`(`organizationId`),
    UNIQUE INDEX `recipe_lock_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `recipe` ADD CONSTRAINT `recipe_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe` ADD CONSTRAINT `recipe_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_version` ADD CONSTRAINT `recipe_version_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_version` ADD CONSTRAINT `recipe_version_organizationId_recipeId_fkey` FOREIGN KEY (`organizationId`, `recipeId`) REFERENCES `recipe`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_organizationId_versionId_fkey` FOREIGN KEY (`organizationId`, `versionId`) REFERENCES `recipe_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_organizationId_productId_presentationId_fkey` FOREIGN KEY (`organizationId`, `productId`, `presentationId`) REFERENCES `product_presentation`(`organizationId`, `productId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_organizationId_presentationId_presentationVers_fkey` FOREIGN KEY (`organizationId`, `presentationId`, `presentationVersionId`) REFERENCES `presentation_version`(`organizationId`, `presentationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `recipe_output` ADD CONSTRAINT `recipe_output_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_output` ADD CONSTRAINT `recipe_output_organizationId_versionId_fkey` FOREIGN KEY (`organizationId`, `versionId`) REFERENCES `recipe_version`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_output` ADD CONSTRAINT `recipe_output_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recipe_lock` ADD CONSTRAINT `recipe_lock_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Números desde 1; cantidades positivas; la equivalencia exacta de cada
-- material, como en una línea de movimiento (base = capturada × factor).
ALTER TABLE `recipe_version` ADD CONSTRAINT `recipe_version_number_check` CHECK (
    `number` >= 1 AND `baseQuantity` > 0
);
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_quantities_check` CHECK (
    `capturedQuantity` > 0 AND `factor` > 0 AND `baseQuantity` > 0
    AND `baseQuantity` = `capturedQuantity` * `factor`
    AND `lineNumber` >= 1
    AND (`scrapPercent` IS NULL OR (`scrapPercent` >= 0 AND `scrapPercent` < 100))
);
ALTER TABLE `recipe_input` ADD CONSTRAINT `recipe_input_capture_check` CHECK (
    (`presentationId` IS NULL AND `presentationVersionId` IS NULL AND `capturedUnitCode` IS NULL AND `factor` = 1)
    OR (`presentationId` IS NOT NULL AND `presentationVersionId` IS NOT NULL AND `capturedUnitCode` IS NULL)
    OR (`presentationId` IS NULL AND `presentationVersionId` IS NULL AND `capturedUnitCode` IS NOT NULL)
);
ALTER TABLE `recipe_output` ADD CONSTRAINT `recipe_output_quantities_check` CHECK (
    `quantity` > 0 AND `lineNumber` >= 1 AND `costShare` >= 0 AND `costShare` <= 100
);
-- Cada estado con sus datos; una sola vigente y un solo borrador por receta
-- (las columnas valen el id de la receta solo en ese estado, con índice único).
ALTER TABLE `recipe_version` ADD CONSTRAINT `recipe_version_state_check` CHECK (
    (`status` = 'DRAFT' AND `draftRecipeId` = `recipeId` AND `activeRecipeId` IS NULL
        AND `activatedAt` IS NULL AND `retiredAt` IS NULL AND `discardedAt` IS NULL)
    OR (`status` = 'ACTIVE' AND `activeRecipeId` = `recipeId` AND `draftRecipeId` IS NULL
        AND `activatedAt` IS NOT NULL AND `activatedByUserId` IS NOT NULL
        AND `retiredAt` IS NULL AND `discardedAt` IS NULL)
    OR (`status` = 'RETIRED' AND `activeRecipeId` IS NULL AND `draftRecipeId` IS NULL
        AND `activatedAt` IS NOT NULL AND `retiredAt` IS NOT NULL AND `discardedAt` IS NULL)
    OR (`status` = 'DISCARDED' AND `activeRecipeId` IS NULL AND `draftRecipeId` IS NULL
        AND `activatedAt` IS NULL AND `retiredAt` IS NULL AND `discardedAt` IS NOT NULL)
);

-- Una receta no se borra; su producto y quien la creó no cambian.
CREATE TRIGGER `recipe_fixed` BEFORE UPDATE ON `recipe` FOR EACH ROW
BEGIN
    IF NEW.`productId` <> OLD.`productId` OR NEW.`createdByUserId` <> OLD.`createdByUserId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe: the product and the author cannot change';
    END IF;
END;
CREATE TRIGGER `recipe_no_delete` BEFORE DELETE ON `recipe` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe: recipes are never deleted';
END;

-- Las transiciones de RECIPE_VERSION_TRANSITIONS (recipe-states.ts): cambiar
-- una exige cambiar la otra. Receta y número nunca cambian; para cuánto y su
-- unidad solo en borrador. Una versión no se borra.
CREATE TRIGGER `recipe_version_transition` BEFORE UPDATE ON `recipe_version` FOR EACH ROW
BEGIN
    IF NEW.`status` <> OLD.`status` AND NOT (
        (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('ACTIVE', 'DISCARDED'))
        OR (OLD.`status` = 'ACTIVE' AND NEW.`status` = 'RETIRED')
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: invalid state transition';
    END IF;
    IF NEW.`recipeId` <> OLD.`recipeId` OR NEW.`number` <> OLD.`number`
        OR NEW.`createdByUserId` <> OLD.`createdByUserId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: recipe, number and author cannot change';
    END IF;
    -- Para cuánto y su unidad solo cambian en un borrador que sigue siendo
    -- borrador: nunca en la misma sentencia que cambia el estado.
    IF (OLD.`status` <> 'DRAFT' OR NEW.`status` <> 'DRAFT') AND (NEW.`baseQuantity` <> OLD.`baseQuantity`
        OR NEW.`unitCode` <> OLD.`unitCode`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: only a draft changes';
    END IF;
    -- Quién y cuándo la activó, retiró o descartó: se escribe una vez.
    IF (OLD.`activatedAt` IS NOT NULL AND NOT (NEW.`activatedAt` <=> OLD.`activatedAt`))
        OR (OLD.`activatedByUserId` IS NOT NULL AND NOT (NEW.`activatedByUserId` <=> OLD.`activatedByUserId`))
        OR (OLD.`retiredAt` IS NOT NULL AND NOT (NEW.`retiredAt` <=> OLD.`retiredAt`))
        OR (OLD.`retiredByUserId` IS NOT NULL AND NOT (NEW.`retiredByUserId` <=> OLD.`retiredByUserId`))
        OR (OLD.`discardedAt` IS NOT NULL AND NOT (NEW.`discardedAt` <=> OLD.`discardedAt`))
        OR (OLD.`discardedByUserId` IS NOT NULL AND NOT (NEW.`discardedByUserId` <=> OLD.`discardedByUserId`)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: who and when cannot change';
    END IF;
    -- Lo que no es de su estado no se escribe fuera de él.
    IF (NEW.`status` IN ('DRAFT', 'DISCARDED') AND (NEW.`activatedByUserId` IS NOT NULL OR NEW.`retiredByUserId` IS NOT NULL))
        OR (NEW.`status` = 'ACTIVE' AND NEW.`retiredByUserId` IS NOT NULL)
        OR (NEW.`status` <> 'DISCARDED' AND NEW.`discardedByUserId` IS NOT NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: data of another state';
    END IF;
END;
-- Toda versión nace borrador: una vigente solo llega por la activación.
CREATE TRIGGER `recipe_version_born_draft` BEFORE INSERT ON `recipe_version` FOR EACH ROW
BEGIN
    IF NEW.`status` <> 'DRAFT' OR NEW.`activatedByUserId` IS NOT NULL
        OR NEW.`retiredByUserId` IS NOT NULL OR NEW.`discardedByUserId` IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: a version is born as a draft';
    END IF;
END;
CREATE TRIGGER `recipe_version_no_delete` BEFORE DELETE ON `recipe_version` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_version: versions are never deleted';
END;

-- Materiales y lo que sale solo cambian mientras su versión es un borrador.
CREATE TRIGGER `recipe_input_draft_insert` BEFORE INSERT ON `recipe_input` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `recipe_version` WHERE `id` = NEW.`versionId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_input: the version is not a draft';
    END IF;
END;
CREATE TRIGGER `recipe_input_draft_update` BEFORE UPDATE ON `recipe_input` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `recipe_version` WHERE `id` = OLD.`versionId`) <> 'DRAFT'
        OR NEW.`versionId` <> OLD.`versionId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_input: the version is not a draft';
    END IF;
END;
CREATE TRIGGER `recipe_input_draft_delete` BEFORE DELETE ON `recipe_input` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `recipe_version` WHERE `id` = OLD.`versionId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_input: the version is not a draft';
    END IF;
END;
CREATE TRIGGER `recipe_output_draft_insert` BEFORE INSERT ON `recipe_output` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `recipe_version` WHERE `id` = NEW.`versionId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_output: the version is not a draft';
    END IF;
END;
CREATE TRIGGER `recipe_output_draft_update` BEFORE UPDATE ON `recipe_output` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `recipe_version` WHERE `id` = OLD.`versionId`) <> 'DRAFT'
        OR NEW.`versionId` <> OLD.`versionId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_output: the version is not a draft';
    END IF;
END;
CREATE TRIGGER `recipe_output_draft_delete` BEFORE DELETE ON `recipe_output` FOR EACH ROW
BEGIN
    IF (SELECT `status` FROM `recipe_version` WHERE `id` = OLD.`versionId`) <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_output: the version is not a draft';
    END IF;
END;

-- El candado de activaciones de la empresa no se borra.
CREATE TRIGGER `recipe_lock_no_delete` BEFORE DELETE ON `recipe_lock` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'recipe_lock: the lock is never deleted';
END;
