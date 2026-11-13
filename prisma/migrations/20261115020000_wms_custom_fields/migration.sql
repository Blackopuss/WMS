-- WMS-58 (ADR 0056): custom fields of products, locations and suppliers.
-- * custom_field: what a company adds to an entity (label, type, required,
--   order); archived, never deleted. Entity, key and type never change.
-- * custom_field_option: the options of a «list» field.
-- * custom_field_value: one value per field and record, in the typed
--   column of the field; the record is named by the reference column of
--   its entity, with a composite key of the company.
-- Expansion only: nothing existing changes.
-- CreateTable
CREATE TABLE `custom_field` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `entity` ENUM('PRODUCT', 'LOCATION', 'SUPPLIER') NOT NULL,
    `key` VARCHAR(40) NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `type` ENUM('TEXT', 'NUMBER', 'DATE', 'CHOICE', 'BOOLEAN') NOT NULL,
    `required` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `custom_field_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `custom_field_organizationId_id_entity_key`(`organizationId`, `id`, `entity`),
    UNIQUE INDEX `custom_field_organizationId_entity_key_key`(`organizationId`, `entity`, `key`),
    UNIQUE INDEX `custom_field_organizationId_entity_label_key`(`organizationId`, `entity`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_option` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `fieldId` CHAR(36) NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `position` INTEGER NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `custom_field_option_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `custom_field_option_organizationId_fieldId_id_key`(`organizationId`, `fieldId`, `id`),
    UNIQUE INDEX `custom_field_option_organizationId_fieldId_label_key`(`organizationId`, `fieldId`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_value` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `fieldId` CHAR(36) NOT NULL,
    `entity` ENUM('PRODUCT', 'LOCATION', 'SUPPLIER') NOT NULL,
    `productId` CHAR(36) NULL,
    `locationId` CHAR(36) NULL,
    `contactId` CHAR(36) NULL,
    `textValue` VARCHAR(200) NULL,
    `numberValue` DECIMAL(18, 6) NULL,
    `dateValue` DATE NULL,
    `optionId` CHAR(36) NULL,
    `boolValue` BOOLEAN NULL,
    `updatedByUserId` CHAR(36) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `custom_field_value_organizationId_fieldId_optionId_idx`(`organizationId`, `fieldId`, `optionId`),
    INDEX `custom_field_value_organizationId_fieldId_boolValue_idx`(`organizationId`, `fieldId`, `boolValue`),
    INDEX `custom_field_value_organizationId_fieldId_textValue_idx`(`organizationId`, `fieldId`, `textValue`),
    INDEX `custom_field_value_organizationId_productId_idx`(`organizationId`, `productId`),
    INDEX `custom_field_value_organizationId_locationId_idx`(`organizationId`, `locationId`),
    INDEX `custom_field_value_organizationId_contactId_idx`(`organizationId`, `contactId`),
    UNIQUE INDEX `custom_field_value_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `custom_field_value_organizationId_fieldId_productId_key`(`organizationId`, `fieldId`, `productId`),
    UNIQUE INDEX `custom_field_value_organizationId_fieldId_locationId_key`(`organizationId`, `fieldId`, `locationId`),
    UNIQUE INDEX `custom_field_value_organizationId_fieldId_contactId_key`(`organizationId`, `fieldId`, `contactId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `custom_field` ADD CONSTRAINT `custom_field_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `custom_field_option` ADD CONSTRAINT `custom_field_option_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `custom_field_option` ADD CONSTRAINT `custom_field_option_organizationId_fieldId_fkey` FOREIGN KEY (`organizationId`, `fieldId`) REFERENCES `custom_field`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_organizationId_fieldId_entity_fkey` FOREIGN KEY (`organizationId`, `fieldId`, `entity`) REFERENCES `custom_field`(`organizationId`, `id`, `entity`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_organizationId_locationId_fkey` FOREIGN KEY (`organizationId`, `locationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_organizationId_contactId_fkey` FOREIGN KEY (`organizationId`, `contactId`) REFERENCES `contact`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_organizationId_fieldId_optionId_fkey` FOREIGN KEY (`organizationId`, `fieldId`, `optionId`) REFERENCES `custom_field_option`(`organizationId`, `fieldId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- A position is never negative.
ALTER TABLE `custom_field` ADD CONSTRAINT `custom_field_position` CHECK (`position` >= 0);
ALTER TABLE `custom_field_option` ADD CONSTRAINT `custom_field_option_position` CHECK (`position` >= 0);

-- A value belongs to exactly one record, of the entity of its field.
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_owner` CHECK (
    (`entity` = 'PRODUCT' AND `productId` IS NOT NULL AND `locationId` IS NULL AND `contactId` IS NULL)
    OR (`entity` = 'LOCATION' AND `locationId` IS NOT NULL AND `productId` IS NULL AND `contactId` IS NULL)
    OR (`entity` = 'SUPPLIER' AND `contactId` IS NOT NULL AND `productId` IS NULL AND `locationId` IS NULL)
);

-- A value fills exactly one of its typed columns (no value = no row).
ALTER TABLE `custom_field_value` ADD CONSTRAINT `custom_field_value_one` CHECK (
    (`textValue` IS NOT NULL) + (`numberValue` IS NOT NULL) + (`dateValue` IS NOT NULL)
    + (`optionId` IS NOT NULL) + (`boolValue` IS NOT NULL) = 1
);

-- What a field is for, its internal name and its type never change: the
-- values already written are in the column of that type.
CREATE TRIGGER `custom_field_fixed` BEFORE UPDATE ON `custom_field` FOR EACH ROW
BEGIN
    IF NEW.`entity` <> OLD.`entity` OR NEW.`key` <> OLD.`key` OR NEW.`type` <> OLD.`type` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'custom_field: entity, key and type cannot change';
    END IF;
END;

-- An option stays with its field.
CREATE TRIGGER `custom_field_option_fixed` BEFORE UPDATE ON `custom_field_option` FOR EACH ROW
BEGIN
    IF NEW.`fieldId` <> OLD.`fieldId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'custom_field_option: an option stays with its field';
    END IF;
END;

-- The value is written in the column of the type of its field.
CREATE TRIGGER `custom_field_value_type_insert` BEFORE INSERT ON `custom_field_value` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `custom_field` f
        WHERE f.`organizationId` = NEW.`organizationId` AND f.`id` = NEW.`fieldId`
          AND ((f.`type` = 'TEXT' AND NEW.`textValue` IS NOT NULL)
            OR (f.`type` = 'NUMBER' AND NEW.`numberValue` IS NOT NULL)
            OR (f.`type` = 'DATE' AND NEW.`dateValue` IS NOT NULL)
            OR (f.`type` = 'CHOICE' AND NEW.`optionId` IS NOT NULL)
            OR (f.`type` = 'BOOLEAN' AND NEW.`boolValue` IS NOT NULL))
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'custom_field_value: the value does not match the type of its field';
    END IF;
END;

CREATE TRIGGER `custom_field_value_type_update` BEFORE UPDATE ON `custom_field_value` FOR EACH ROW
BEGIN
    IF NOT (NEW.`fieldId` <=> OLD.`fieldId`) OR NOT (NEW.`productId` <=> OLD.`productId`)
        OR NOT (NEW.`locationId` <=> OLD.`locationId`) OR NOT (NEW.`contactId` <=> OLD.`contactId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'custom_field_value: field and record cannot change';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM `custom_field` f
        WHERE f.`organizationId` = NEW.`organizationId` AND f.`id` = NEW.`fieldId`
          AND ((f.`type` = 'TEXT' AND NEW.`textValue` IS NOT NULL)
            OR (f.`type` = 'NUMBER' AND NEW.`numberValue` IS NOT NULL)
            OR (f.`type` = 'DATE' AND NEW.`dateValue` IS NOT NULL)
            OR (f.`type` = 'CHOICE' AND NEW.`optionId` IS NOT NULL)
            OR (f.`type` = 'BOOLEAN' AND NEW.`boolValue` IS NOT NULL))
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'custom_field_value: the value does not match the type of its field';
    END IF;
END;
