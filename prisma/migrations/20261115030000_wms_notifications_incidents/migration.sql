-- WMS-39 (ADR 0057): avisos dentro de la app e incidencias del almacén.
-- Solo expansión: cuatro tablas nuevas, sin tocar las que existen.
-- CreateTable
CREATE TABLE `notification` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `recipientUserId` CHAR(36) NOT NULL,
    `typeKey` VARCHAR(80) NOT NULL,
    `text` VARCHAR(300) NOT NULL,
    `href` VARCHAR(300) NOT NULL,
    `dedupeKey` VARCHAR(160) NOT NULL,
    `actorUserId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readAt` DATETIME(3) NULL,

    INDEX `notification_organizationId_recipientUserId_readAt_idx`(`organizationId`, `recipientUserId`, `readAt`),
    INDEX `notification_organizationId_recipientUserId_createdAt_id_idx`(`organizationId`, `recipientUserId`, `createdAt`, `id`),
    INDEX `notification_organizationId_readAt_idx`(`organizationId`, `readAt`),
    UNIQUE INDEX `notification_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `notification_organizationId_recipientUserId_dedupeKey_key`(`organizationId`, `recipientUserId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preference` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `typeKey` VARCHAR(80) NOT NULL,
    `enabled` BOOLEAN NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_preference_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `notification_preference_organizationId_userId_typeKey_key`(`organizationId`, `userId`, `typeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `incident` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `kind` ENUM('DAMAGED_GOODS', 'MISPLACED', 'UNSAFE_LOCATION', 'BROKEN_EQUIPMENT', 'OTHER') NOT NULL,
    `status` ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `description` VARCHAR(1000) NOT NULL,
    `locationId` CHAR(36) NULL,
    `productId` CHAR(36) NULL,
    `taskId` CHAR(36) NULL,
    `outboundOrderId` CHAR(36) NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `reportedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attendedByUserId` CHAR(36) NULL,
    `attendedAt` DATETIME(3) NULL,
    `closedByUserId` CHAR(36) NULL,
    `closedAt` DATETIME(3) NULL,
    `resolution` VARCHAR(500) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `incident_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    INDEX `incident_organizationId_reportedByUserId_number_idx`(`organizationId`, `reportedByUserId`, `number`),
    INDEX `incident_organizationId_locationId_idx`(`organizationId`, `locationId`),
    INDEX `incident_organizationId_productId_idx`(`organizationId`, `productId`),
    INDEX `incident_organizationId_taskId_idx`(`organizationId`, `taskId`),
    INDEX `incident_organizationId_outboundOrderId_idx`(`organizationId`, `outboundOrderId`),
    UNIQUE INDEX `incident_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `incident_organizationId_number_key`(`organizationId`, `number`),
    UNIQUE INDEX `incident_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `incident_note` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `incidentId` CHAR(36) NOT NULL,
    `text` VARCHAR(1000) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `incident_note_organizationId_incidentId_createdAt_id_idx`(`organizationId`, `incidentId`, `createdAt`, `id`),
    UNIQUE INDEX `incident_note_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_preference` ADD CONSTRAINT `notification_preference_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_facilityId_locationId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `locationId`) REFERENCES `location`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_taskId_fkey` FOREIGN KEY (`organizationId`, `taskId`) REFERENCES `warehouse_task`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `incident` ADD CONSTRAINT `incident_organizationId_outboundOrderId_fkey` FOREIGN KEY (`organizationId`, `outboundOrderId`) REFERENCES `outbound_order`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `incident_note` ADD CONSTRAINT `incident_note_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `incident_note` ADD CONSTRAINT `incident_note_organizationId_incidentId_fkey` FOREIGN KEY (`organizationId`, `incidentId`) REFERENCES `incident`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Un aviso: texto de una línea y destino interno de la app («/…», nunca
-- «//…» ni «/\…», sin espacios ni esquemas).
ALTER TABLE `notification` ADD CONSTRAINT `notification_text_check` CHECK (
    CHAR_LENGTH(TRIM(`text`)) > 0 AND CHAR_LENGTH(TRIM(`dedupeKey`)) > 0
);
ALTER TABLE `notification` ADD CONSTRAINT `notification_href_check` CHECK (
    LEFT(`href`, 1) = '/'
    AND SUBSTRING(`href`, 2, 1) NOT IN ('/', '\\')
    AND `href` NOT LIKE '% %'
    AND `href` NOT LIKE '%:%'
);

-- De un aviso solo cambia `readAt`, una vez: lo demás quedó fijo al crearse.
CREATE TRIGGER `notification_read_only` BEFORE UPDATE ON `notification` FOR EACH ROW
BEGIN
    IF NEW.`recipientUserId` <> OLD.`recipientUserId` OR NEW.`typeKey` <> OLD.`typeKey`
        OR NEW.`text` <> OLD.`text` OR NEW.`href` <> OLD.`href`
        OR NEW.`dedupeKey` <> OLD.`dedupeKey` OR NOT (NEW.`actorUserId` <=> OLD.`actorUserId`)
        OR NEW.`createdAt` <> OLD.`createdAt` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'notification: only readAt changes';
    END IF;
    IF OLD.`readAt` IS NOT NULL AND NOT (NEW.`readAt` <=> OLD.`readAt`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'notification: already read';
    END IF;
END;

-- Solo se borran los avisos ya leídos (la ronda de limpieza).
CREATE TRIGGER `notification_delete_read` BEFORE DELETE ON `notification` FOR EACH ROW
BEGIN
    IF OLD.`readAt` IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'notification: unread notices are not deleted';
    END IF;
END;

-- Una incidencia: número desde 1 y cada estado con sus datos.
ALTER TABLE `incident` ADD CONSTRAINT `incident_number_check` CHECK (`number` >= 1);
ALTER TABLE `incident` ADD CONSTRAINT `incident_description_check` CHECK (
    CHAR_LENGTH(TRIM(`description`)) > 0
);
ALTER TABLE `incident` ADD CONSTRAINT `incident_state_check` CHECK (
    (`status` = 'OPEN' AND `attendedAt` IS NULL AND `attendedByUserId` IS NULL AND `closedAt` IS NULL AND `closedByUserId` IS NULL AND `resolution` IS NULL)
    OR (`status` = 'IN_PROGRESS' AND `attendedAt` IS NOT NULL AND `attendedByUserId` IS NOT NULL AND `closedAt` IS NULL AND `closedByUserId` IS NULL AND `resolution` IS NULL)
    OR (`status` IN ('RESOLVED', 'DISMISSED') AND `closedAt` IS NOT NULL AND `closedByUserId` IS NOT NULL AND CHAR_LENGTH(TRIM(COALESCE(`resolution`, ''))) > 0)
);
ALTER TABLE `incident_note` ADD CONSTRAINT `incident_note_text_check` CHECK (
    CHAR_LENGTH(TRIM(`text`)) > 0
);

-- Las transiciones de INCIDENT_TRANSITIONS (incident-states.ts): cambiar una
-- exige cambiar la otra. Lo que se reportó no cambia.
CREATE TRIGGER `incident_transition` BEFORE UPDATE ON `incident` FOR EACH ROW
BEGIN
    IF NEW.`status` <> OLD.`status` AND NOT (
        (OLD.`status` = 'OPEN' AND NEW.`status` IN ('IN_PROGRESS', 'RESOLVED', 'DISMISSED'))
        OR (OLD.`status` = 'IN_PROGRESS' AND NEW.`status` IN ('RESOLVED', 'DISMISSED'))
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident: invalid state transition';
    END IF;
    IF NEW.`number` <> OLD.`number` OR NEW.`facilityId` <> OLD.`facilityId`
        OR NEW.`kind` <> OLD.`kind` OR NEW.`description` <> OLD.`description`
        OR NOT (NEW.`locationId` <=> OLD.`locationId`) OR NOT (NEW.`productId` <=> OLD.`productId`)
        OR NOT (NEW.`taskId` <=> OLD.`taskId`) OR NOT (NEW.`outboundOrderId` <=> OLD.`outboundOrderId`)
        OR NEW.`idempotencyKey` <> OLD.`idempotencyKey`
        OR NEW.`reportedByUserId` <> OLD.`reportedByUserId` OR NEW.`createdAt` <> OLD.`createdAt` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident: what was reported cannot change';
    END IF;
END;

-- Una incidencia no se borra; sus notas no cambian ni se borran.
CREATE TRIGGER `incident_no_delete` BEFORE DELETE ON `incident` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident: incidents are never deleted';
END;

CREATE TRIGGER `incident_note_no_update` BEFORE UPDATE ON `incident_note` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident_note: notes never change';
END;

CREATE TRIGGER `incident_note_no_delete` BEFORE DELETE ON `incident_note` FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident_note: notes are never deleted';
END;
