-- AlterTable
ALTER TABLE `automation_run` ADD COLUMN `remembers` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `subjectKey` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `automation_run_organizationId_ruleId_subjectKey_idx` ON `automation_run`(`organizationId`, `ruleId`, `subjectKey`);


-- WMS-64 (revisión): el sujeto de un estado y si se recuerda tampoco cambian.
DROP TRIGGER `automation_run_update_rule`;

CREATE TRIGGER `automation_run_update_rule` BEFORE UPDATE ON `automation_run` FOR EACH ROW
BEGIN
  IF NOT (NEW.`ruleId` <=> OLD.`ruleId` AND NEW.`eventKey` <=> OLD.`eventKey`
          AND NEW.`ruleVersion` <=> OLD.`ruleVersion` AND NEW.`triggerKey` <=> OLD.`triggerKey`
          AND NEW.`depth` <=> OLD.`depth` AND NEW.`createdAt` <=> OLD.`createdAt`
          AND NEW.`subjectKey` <=> OLD.`subjectKey` AND NEW.`remembers` <=> OLD.`remembers`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_run: rule, key and version do not change';
  END IF;
  IF OLD.`status` IN ('DONE', 'SKIPPED', 'FAILED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'automation_run: a finished run does not change';
  END IF;
END;
