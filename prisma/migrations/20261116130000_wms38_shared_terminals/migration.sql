-- AlterTable
ALTER TABLE `session` ADD COLUMN `terminalId` CHAR(36) NULL,
    ADD COLUMN `terminalIdleSeconds` INTEGER NULL;

-- CreateTable
CREATE TABLE `shared_terminal` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `secretHash` CHAR(64) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NULL,
    `removedAt` DATETIME(3) NULL,
    `removedByUserId` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shared_terminal_secretHash_key`(`secretHash`),
    INDEX `shared_terminal_organizationId_removedAt_name_idx`(`organizationId`, `removedAt`, `name`),
    INDEX `shared_terminal_organizationId_facilityId_idx`(`organizationId`, `facilityId`),
    UNIQUE INDEX `shared_terminal_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_pin` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `pinHash` VARCHAR(255) NOT NULL,
    `setAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `member_pin_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `member_pin_organizationId_userId_key`(`organizationId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `session_terminalId_idx` ON `session`(`terminalId`);

-- AddForeignKey
ALTER TABLE `shared_terminal` ADD CONSTRAINT `shared_terminal_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shared_terminal` ADD CONSTRAINT `shared_terminal_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `member_pin` ADD CONSTRAINT `member_pin_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- WMS-38 (ADR 0061). Una sesión de terminal guarda su terminal y su tiempo
-- sin actividad, juntos (de 1 a 60 minutos). Sin llave foránea: la fila de
-- una persona no apunta a una tabla de empresa; quitar una terminal borra
-- sus sesiones y una terminal nunca se borra.
ALTER TABLE `session` ADD CONSTRAINT `session_terminal_check` CHECK (
    (`terminalId` IS NULL AND `terminalIdleSeconds` IS NULL)
    OR (`terminalId` IS NOT NULL AND `terminalIdleSeconds` BETWEEN 60 AND 3600)
);

ALTER TABLE `shared_terminal` ADD CONSTRAINT `shared_terminal_name_check` CHECK (
    CHAR_LENGTH(TRIM(`name`)) > 0
);
ALTER TABLE `shared_terminal` ADD CONSTRAINT `shared_terminal_removed_check` CHECK (
    (`removedAt` IS NULL AND `removedByUserId` IS NULL)
    OR (`removedAt` IS NOT NULL AND `removedByUserId` IS NOT NULL)
);

-- Una terminal no se borra ni cambia de empresa, almacén o secreto; quitada,
-- no vuelve.
CREATE TRIGGER `shared_terminal_no_delete` BEFORE DELETE ON `shared_terminal` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal: terminals are removed, never deleted';
END;

CREATE TRIGGER `shared_terminal_fixed` BEFORE UPDATE ON `shared_terminal` FOR EACH ROW
BEGIN
    IF NEW.`organizationId` <> OLD.`organizationId` OR NEW.`facilityId` <> OLD.`facilityId`
        OR NEW.`secretHash` <> OLD.`secretHash` OR NEW.`createdByUserId` <> OLD.`createdByUserId`
        OR NEW.`createdAt` <> OLD.`createdAt` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal: only name, use and removal change';
    END IF;
    IF OLD.`removedAt` IS NOT NULL AND NOT (NEW.`removedAt` <=> OLD.`removedAt`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal: already removed';
    END IF;
END;
