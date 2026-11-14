-- WMS-38 (ADR 0061 §1): rotación del secreto de la terminal con detección de
-- reúso. Cada secreto emitido se guarda (solo su SHA-256) con cuándo se
-- emitió y cuándo lo presentó por primera vez una petición.

-- CreateTable
CREATE TABLE `shared_terminal_secret` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `terminalId` CHAR(36) NOT NULL,
    `secretHash` CHAR(64) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `presentedAt` DATETIME(3) NULL,

    UNIQUE INDEX `shared_terminal_secret_secretHash_key`(`secretHash`),
    INDEX `shared_terminal_secret_organizationId_terminalId_issuedAt_idx`(`organizationId`, `terminalId`, `issuedAt`),
    UNIQUE INDEX `shared_terminal_secret_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `shared_terminal_secret` ADD CONSTRAINT `shared_terminal_secret_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shared_terminal_secret` ADD CONSTRAINT `shared_terminal_secret_organizationId_terminalId_fkey` FOREIGN KEY (`organizationId`, `terminalId`) REFERENCES `shared_terminal`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Lo que ya existía: el secreto anterior (presentado al rotar) y el vigente.
-- El id es un UUID v7 armado con la hora de emisión, para que el orden por id
-- siga siendo el de emisión.
INSERT INTO `shared_terminal_secret` (`id`, `organizationId`, `terminalId`, `secretHash`, `issuedAt`, `presentedAt`)
SELECT
    LOWER(CONCAT(
        LPAD(HEX(FLOOR(UNIX_TIMESTAMP(`createdAt`) * 1000)), 12, '0'),
        '7000', '8', SUBSTRING(SHA2(CONCAT(`id`, ':previous'), 256), 1, 15)
    )),
    `organizationId`, `id`, `previousSecretHash`, `createdAt`, `secretRotatedAt`
FROM `shared_terminal` WHERE `previousSecretHash` IS NOT NULL;

INSERT INTO `shared_terminal_secret` (`id`, `organizationId`, `terminalId`, `secretHash`, `issuedAt`, `presentedAt`)
SELECT
    LOWER(CONCAT(
        LPAD(HEX(FLOOR(UNIX_TIMESTAMP(COALESCE(`secretRotatedAt`, `createdAt`)) * 1000) + 1), 12, '0'),
        '7000', '8', SUBSTRING(SHA2(CONCAT(`id`, ':current'), 256), 1, 15)
    )),
    `organizationId`, `id`, `secretHash`, COALESCE(`secretRotatedAt`, `createdAt`), NULL
FROM `shared_terminal`;

UPDATE `shared_terminal_secret`
SET `id` = CONCAT(SUBSTRING(`id`, 1, 8), '-', SUBSTRING(`id`, 9, 4), '-', SUBSTRING(`id`, 13, 4), '-', SUBSTRING(`id`, 17, 4), '-', SUBSTRING(`id`, 21, 12))
WHERE CHAR_LENGTH(`id`) = 32;

-- La regla vieja de rotación se va con sus columnas.
DROP TRIGGER `shared_terminal_fixed`;
ALTER TABLE `shared_terminal` DROP CHECK `shared_terminal_rotation_check`;

-- DropIndex
DROP INDEX `shared_terminal_previousSecretHash_idx` ON `shared_terminal`;

-- DropIndex
DROP INDEX `shared_terminal_secretHash_key` ON `shared_terminal`;

-- AlterTable
ALTER TABLE `shared_terminal` DROP COLUMN `previousSecretHash`,
    DROP COLUMN `secretHash`,
    DROP COLUMN `secretRotatedAt`;

-- Una terminal no cambia de empresa ni de almacén; quitada, no vuelve.
CREATE TRIGGER `shared_terminal_fixed` BEFORE UPDATE ON `shared_terminal` FOR EACH ROW
BEGIN
    IF NEW.`organizationId` <> OLD.`organizationId` OR NEW.`facilityId` <> OLD.`facilityId`
        OR NEW.`createdByUserId` <> OLD.`createdByUserId`
        OR NEW.`createdAt` <> OLD.`createdAt` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal: only name, use and removal change';
    END IF;
    IF OLD.`removedAt` IS NOT NULL AND NOT (NEW.`removedAt` <=> OLD.`removedAt`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal: already removed';
    END IF;
END;

-- Presentado nunca antes de emitido.
ALTER TABLE `shared_terminal_secret` ADD CONSTRAINT `shared_terminal_secret_presented_check` CHECK (
    `presentedAt` IS NULL OR `presentedAt` >= `issuedAt`
);

-- De un secreto solo cambia `presentedAt`, una vez (de vacío a una fecha).
CREATE TRIGGER `shared_terminal_secret_fixed` BEFORE UPDATE ON `shared_terminal_secret` FOR EACH ROW
BEGIN
    IF NEW.`organizationId` <> OLD.`organizationId` OR NEW.`terminalId` <> OLD.`terminalId`
        OR NEW.`secretHash` <> OLD.`secretHash` OR NEW.`issuedAt` <> OLD.`issuedAt`
        OR (OLD.`presentedAt` IS NOT NULL AND NOT (NEW.`presentedAt` <=> OLD.`presentedAt`)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal_secret: only presentedAt changes, once';
    END IF;
END;

-- Solo se borran los de más de 30 días (limpieza al rotar).
CREATE TRIGGER `shared_terminal_secret_cleanup_only` BEFORE DELETE ON `shared_terminal_secret` FOR EACH ROW
BEGIN
    IF OLD.`issuedAt` >= UTC_TIMESTAMP(3) - INTERVAL 30 DAY THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal_secret: only secrets older than 30 days are deleted';
    END IF;
END;

-- La sesión de terminal: `BETWEEN` con vacío quedaba «desconocido» y dejaba
-- pasar una terminal sin tiempo de inactividad.
ALTER TABLE `session` DROP CHECK `session_terminal_check`;
ALTER TABLE `session` ADD CONSTRAINT `session_terminal_check` CHECK (
    (`terminalId` IS NULL AND `terminalIdleSeconds` IS NULL)
    OR (`terminalId` IS NOT NULL AND `terminalIdleSeconds` IS NOT NULL
        AND `terminalIdleSeconds` >= 60 AND `terminalIdleSeconds` <= 3600)
);
