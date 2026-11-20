-- CreateTable
CREATE TABLE `automation_rule` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `triggerKey` VARCHAR(80) NOT NULL,
    `facilityId` CHAR(36) NULL,
    `conditions` JSON NOT NULL,
    `actions` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'PAUSED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `pauseReason` VARCHAR(12) NULL,
    `actorUserId` CHAR(36) NOT NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `automation_rule_organizationId_status_triggerKey_idx`(`organizationId`, `status`, `triggerKey`),
    INDEX `automation_rule_organizationId_facilityId_idx`(`organizationId`, `facilityId`),
    UNIQUE INDEX `automation_rule_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_run` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `ruleId` CHAR(36) NOT NULL,
    `ruleVersion` INTEGER NOT NULL,
    `triggerKey` VARCHAR(80) NOT NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `depth` INTEGER NOT NULL DEFAULT 1,
    `summary` VARCHAR(300) NOT NULL,
    `subject` JSON NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `reason` VARCHAR(300) NULL,
    `results` JSON NULL,
    `claimToken` CHAR(36) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `automation_run_organizationId_ruleId_createdAt_idx`(`organizationId`, `ruleId`, `createdAt`),
    INDEX `automation_run_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `automation_run_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `automation_run_organizationId_ruleId_eventKey_key`(`organizationId`, `ruleId`, `eventKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `automation_rule` ADD CONSTRAINT `automation_rule_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_rule` ADD CONSTRAINT `automation_rule_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `automation_run` ADD CONSTRAINT `automation_run_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_run` ADD CONSTRAINT `automation_run_organizationId_ruleId_fkey` FOREIGN KEY (`organizationId`, `ruleId`) REFERENCES `automation_rule`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- WMS-64 (ADR 0092): una regla pausada dice por qué; una archivada tiene fecha.
ALTER TABLE `automation_rule`
    ADD CONSTRAINT `automation_rule_pause_reason` CHECK ((`status` = 'PAUSED' AND `pauseReason` IN ('MANUAL', 'ACTOR', 'FAILURES', 'MODULE')) OR (`status` <> 'PAUSED' AND `pauseReason` IS NULL)),
    ADD CONSTRAINT `automation_rule_archived` CHECK ((`status` = 'ARCHIVED') = (`archivedAt` IS NOT NULL)),
    ADD CONSTRAINT `automation_rule_counters` CHECK (`version` >= 1 AND `consecutiveFailures` >= 0);

-- Una regla no se borra, no cambia de disparador ni de autor, y archivada no vuelve.
CREATE TRIGGER `automation_rule_update_rule` BEFORE UPDATE ON `automation_rule` FOR EACH ROW
BEGIN
  IF NOT (NEW.`triggerKey` <=> OLD.`triggerKey` AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
          AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_rule: trigger and author do not change';
  END IF;
  IF OLD.`status` = 'ARCHIVED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_rule: an archived rule does not change';
  END IF;
  IF NEW.`version` < OLD.`version` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_rule: its version only goes up';
  END IF;
END;

CREATE TRIGGER `automation_rule_no_delete` BEFORE DELETE ON `automation_rule` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_rule: a rule is archived, never deleted';
END;

-- Una ejecución nace pendiente o ya resuelta; regla, llave y versión no cambian,
-- y una terminada no cambia. Se borra al limpiar el historial.
ALTER TABLE `automation_run`
    ADD CONSTRAINT `automation_run_counters` CHECK (`depth` >= 1 AND `attempts` >= 0 AND `ruleVersion` >= 1),
    ADD CONSTRAINT `automation_run_finished` CHECK ((`status` IN ('DONE', 'SKIPPED', 'FAILED')) = (`finishedAt` IS NOT NULL));

CREATE TRIGGER `automation_run_update_rule` BEFORE UPDATE ON `automation_run` FOR EACH ROW
BEGIN
  IF NOT (NEW.`ruleId` <=> OLD.`ruleId` AND NEW.`eventKey` <=> OLD.`eventKey`
          AND NEW.`ruleVersion` <=> OLD.`ruleVersion` AND NEW.`triggerKey` <=> OLD.`triggerKey`
          AND NEW.`depth` <=> OLD.`depth` AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_run: rule, key and version do not change';
  END IF;
  IF OLD.`status` IN ('DONE', 'SKIPPED', 'FAILED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_run: a finished run does not change';
  END IF;
END;
