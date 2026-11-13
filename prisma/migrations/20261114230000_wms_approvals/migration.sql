-- WMS-56/41 (ADR 0053): reglas y solicitudes de aprobación.
-- Solo de expansión: dos tablas nuevas.

-- CreateTable
CREATE TABLE `approval_rule` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `typeKey` VARCHAR(80) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `approverRoles` VARCHAR(200) NOT NULL DEFAULT '',
    `allowSelfApproval` BOOLEAN NOT NULL DEFAULT false,
    `updatedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `approval_rule_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `approval_rule_organizationId_typeKey_key`(`organizationId`, `typeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_request` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `typeKey` VARCHAR(80) NOT NULL,
    `sourceType` VARCHAR(40) NULL,
    `sourceId` CHAR(36) NULL,
    `openKey` VARCHAR(120) NULL,
    `idempotencyKey` VARCHAR(64) NULL,
    `facilityId` CHAR(36) NULL,
    `locationId` CHAR(36) NULL,
    `summary` VARCHAR(1000) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `requestedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedByUserId` CHAR(36) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` VARCHAR(500) NULL,
    `outcome` VARCHAR(1000) NULL,

    INDEX `approval_request_organizationId_status_createdAt_id_idx`(`organizationId`, `status`, `createdAt`, `id`),
    INDEX `approval_request_organizationId_requestedByUserId_createdAt__idx`(`organizationId`, `requestedByUserId`, `createdAt`, `id`),
    INDEX `approval_request_organizationId_sourceType_sourceId_idx`(`organizationId`, `sourceType`, `sourceId`),
    UNIQUE INDEX `approval_request_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `approval_request_organizationId_openKey_key`(`organizationId`, `openKey`),
    UNIQUE INDEX `approval_request_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `approval_rule` ADD CONSTRAINT `approval_rule_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `approval_request_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `approval_request_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `approval_request_organizationId_facilityId_locationId_fkey` FOREIGN KEY (`organizationId`, `facilityId`, `locationId`) REFERENCES `location`(`organizationId`, `facilityId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Una solicitud pendiente no tiene decisión; una decidida tiene su fecha,
-- ya no ocupa su llave abierta, quien la decidió (salvo al vencer, que puede
-- ser el sistema), el motivo si se rechazó y el porqué si venció.
ALTER TABLE `approval_request`
    ADD CONSTRAINT `approval_request_decision` CHECK (
      (`status` = 'PENDING' AND `decidedByUserId` IS NULL AND `decidedAt` IS NULL
        AND `decisionReason` IS NULL AND `outcome` IS NULL)
      OR (`status` <> 'PENDING' AND `decidedAt` IS NOT NULL AND `openKey` IS NULL
        AND (`status` = 'EXPIRED' OR `decidedByUserId` IS NOT NULL)
        AND (`status` <> 'REJECTED' OR `decisionReason` IS NOT NULL)
        AND (`status` <> 'EXPIRED' OR `outcome` IS NOT NULL))
    ),
    ADD CONSTRAINT `approval_request_place` CHECK (`locationId` IS NULL OR `facilityId` IS NOT NULL),
    ADD CONSTRAINT `approval_request_source` CHECK (
      (`sourceType` IS NULL AND `sourceId` IS NULL)
      OR (`sourceType` IS NOT NULL AND `sourceId` IS NOT NULL)
    );

-- La misma tabla de estados que APPROVAL_TRANSITIONS (approvals/states.ts):
-- de pendiente a autorizada, rechazada, retirada o vencida, una sola vez.
-- Lo que se pidió no cambia nunca.
CREATE TRIGGER `approval_request_transition` BEFORE UPDATE ON `approval_request` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`)
    OR NOT (NEW.`typeKey` <=> OLD.`typeKey`)
    OR NOT (NEW.`sourceType` <=> OLD.`sourceType`)
    OR NOT (NEW.`sourceId` <=> OLD.`sourceId`)
    OR NOT (NEW.`idempotencyKey` <=> OLD.`idempotencyKey`)
    OR NOT (NEW.`facilityId` <=> OLD.`facilityId`)
    OR NOT (NEW.`locationId` <=> OLD.`locationId`)
    OR NOT (NEW.`summary` <=> OLD.`summary`)
    OR NOT (JSON_CONTAINS(NEW.`payload`, OLD.`payload`) AND JSON_CONTAINS(OLD.`payload`, NEW.`payload`))
    OR NOT (NEW.`requestedByUserId` <=> OLD.`requestedByUserId`)
    OR NOT (NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an approval request keeps what it asks for';
  END IF;
  IF OLD.`status` <> 'PENDING' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a decided approval request does not change';
  END IF;
  IF NEW.`status` NOT IN ('APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval request: not a transition';
  END IF;
END;

-- Nunca se borra una solicitud ni una regla.
CREATE TRIGGER `approval_request_no_delete` BEFORE DELETE ON `approval_request` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an approval request is never deleted';
END;

CREATE TRIGGER `approval_rule_no_delete` BEFORE DELETE ON `approval_rule` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an approval rule is turned off, never deleted';
END;
