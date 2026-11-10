-- WMS-22A: niveles de ubicación configurables por almacén (ADR 0036).
-- Antes, tres tipos fijos (zona > pasillo > estante). Ahora cada almacén
-- define sus niveles con nombre libre y en orden (profundidad 1 = el más
-- amplio); una ubicación solo va dentro de otra de un nivel más amplio, así
-- que sigue sin poder haber ciclos. «General» no tiene nivel. Además, cada
-- ubicación puede tener un código (lo que se escanea) y un tipo de uso.
-- Sin producción todavía: se puede quitar `kind` (ADR 0032).

CREATE TABLE `location_level` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `depth` INTEGER NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `location_level_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `location_level_organizationId_facilityId_id_key`(`organizationId`, `facilityId`, `id`),
    UNIQUE INDEX `location_level_organizationId_facilityId_depth_key`(`organizationId`, `facilityId`, `depth`),
    UNIQUE INDEX `location_level_organizationId_facilityId_name_key`(`organizationId`, `facilityId`, `name`),
    PRIMARY KEY (`id`),
    CONSTRAINT `location_level_depth` CHECK (`depth` BETWEEN 1 AND 108),
    CONSTRAINT `location_level_name` CHECK (CHAR_LENGTH(TRIM(`name`)) > 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `location_level` ADD CONSTRAINT `location_level_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `location_level` ADD CONSTRAINT `location_level_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Cada almacén que ya existe arranca con los niveles de antes.
INSERT INTO `location_level` (`id`, `organizationId`, `facilityId`, `depth`, `name`, `updatedAt`)
SELECT UUID(), f.`organizationId`, f.`id`, l.`depth`, l.`name`, CURRENT_TIMESTAMP(3)
FROM `facility` f
CROSS JOIN (SELECT 1 AS `depth`, 'Zona' AS `name` UNION ALL SELECT 2, 'Pasillo' UNION ALL SELECT 3, 'Estante') l;

ALTER TABLE `location`
    ADD COLUMN `levelId` CHAR(36) NULL,
    ADD COLUMN `code` VARCHAR(30) NULL,
    ADD COLUMN `type` ENUM('STORAGE', 'PICKING', 'RECEIVING', 'STAGING', 'QUARANTINE', 'DOCK') NOT NULL DEFAULT 'STORAGE';

UPDATE `location` loc
JOIN `location_level` lvl
  ON lvl.`organizationId` = loc.`organizationId`
 AND lvl.`facilityId` = loc.`facilityId`
 AND lvl.`depth` = FIELD(loc.`kind`, 'ZONE', 'AISLE', 'SHELF')
SET loc.`levelId` = lvl.`id`
WHERE loc.`kind` <> 'GENERAL';

UPDATE `location` SET `type` = 'STAGING' WHERE `isStaging` = 1;

-- Las reglas viejas miraban `kind`.
DROP TRIGGER `location_tree_insert`;
DROP TRIGGER `location_tree_update`;
ALTER TABLE `location` DROP CHECK `location_general_check`;
ALTER TABLE `location` DROP CHECK `location_staging`;
ALTER TABLE `location` DROP COLUMN `kind`;

CREATE UNIQUE INDEX `location_organizationId_facilityId_code_key` ON `location`(`organizationId`, `facilityId`, `code`);
ALTER TABLE `location` ADD CONSTRAINT `location_organizationId_facilityId_levelId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `levelId`) REFERENCES `location_level`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- «General» y solo ella no tiene nivel; va en la raíz y no se archiva.
ALTER TABLE `location` ADD CONSTRAINT `location_general_check` CHECK (
    (COALESCE(`isDefault`, 0) = 0 AND `levelId` IS NOT NULL)
    OR (COALESCE(`isDefault`, 0) = 1 AND `levelId` IS NULL AND `parentId` IS NULL AND `archivedAt` IS NULL)
);
-- La de preparación es de tipo preparación y nunca «General».
ALTER TABLE `location` ADD CONSTRAINT `location_staging` CHECK (
    `isStaging` IS NULL OR (`isStaging` = 1 AND `isDefault` IS NULL AND `type` = 'STAGING')
);
-- Código en mayúsculas, sin espacios: letras, números y . _ / -
ALTER TABLE `location` ADD CONSTRAINT `location_code` CHECK (
    `code` IS NULL OR REGEXP_LIKE(`code`, '^[A-Z0-9][A-Z0-9._/-]{0,29}$', 'c')
);

-- Reglas que miran otra fila: los servicios las revisan antes, con el
-- almacén bloqueado; estos disparadores son la última defensa.
CREATE TRIGGER `location_tree_insert` BEFORE INSERT ON `location` FOR EACH ROW
BEGIN
    DECLARE parent_depth INT;
    DECLARE child_depth INT;
    IF NEW.`parentId` IS NOT NULL THEN
        SELECT lvl.`depth` INTO parent_depth FROM `location` p
            JOIN `location_level` lvl ON lvl.`id` = p.`levelId`
            WHERE p.`id` = NEW.`parentId`;
        SELECT `depth` INTO child_depth FROM `location_level` WHERE `id` = NEW.`levelId`;
        IF parent_depth IS NULL OR child_depth IS NULL OR parent_depth >= child_depth THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_tree: a location only goes inside a wider level';
        END IF;
    ELSEIF EXISTS (
        SELECT 1 FROM `location`
        WHERE `organizationId` = NEW.`organizationId` AND `facilityId` = NEW.`facilityId`
            AND `parentId` IS NULL AND `name` = NEW.`name`
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_tree: name repeated at the root of the facility';
    END IF;
END;

CREATE TRIGGER `location_tree_update` BEFORE UPDATE ON `location` FOR EACH ROW
BEGIN
    DECLARE parent_depth INT;
    DECLARE child_depth INT;
    IF NOT (NEW.`levelId` <=> OLD.`levelId`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_tree: the level of a location never changes';
    END IF;
    IF OLD.`isDefault` = 1 AND NEW.`isDefault` IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_tree: General is always the default location';
    END IF;
    IF NEW.`parentId` IS NOT NULL THEN
        SELECT lvl.`depth` INTO parent_depth FROM `location` p
            JOIN `location_level` lvl ON lvl.`id` = p.`levelId`
            WHERE p.`id` = NEW.`parentId`;
        SELECT `depth` INTO child_depth FROM `location_level` WHERE `id` = NEW.`levelId`;
        IF parent_depth IS NULL OR child_depth IS NULL OR parent_depth >= child_depth THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_tree: a location only goes inside a wider level';
        END IF;
    ELSEIF EXISTS (
        SELECT 1 FROM `location`
        WHERE `organizationId` = NEW.`organizationId` AND `facilityId` = NEW.`facilityId`
            AND `parentId` IS NULL AND `name` = NEW.`name` AND `id` <> NEW.`id`
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_tree: name repeated at the root of the facility';
    END IF;
END;

-- Un nivel no cambia de almacén.
CREATE TRIGGER `location_level_update` BEFORE UPDATE ON `location_level` FOR EACH ROW
BEGIN
    IF NEW.`facilityId` <> OLD.`facilityId` OR NEW.`organizationId` <> OLD.`organizationId` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location_level: a level never changes warehouse';
    END IF;
END;
