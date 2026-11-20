-- WMS-44 (ADR 0089): demonstration companies.

-- AlterTable
ALTER TABLE `organization` ADD COLUMN `isDemo` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `demo_company` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `dataset` VARCHAR(40) NOT NULL,
    `status` ENUM('PREPARING', 'READY', 'FAILED') NOT NULL DEFAULT 'PREPARING',
    `claimedAt` DATETIME(3) NULL,
    `failure` VARCHAR(500) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `demo_company_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `demo_company_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `demo_company_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `demo_company` ADD CONSTRAINT `demo_company_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- A demonstration never becomes a real company, nor the other way round.
CREATE TRIGGER `organization_demo_keep` BEFORE UPDATE ON `organization` FOR EACH ROW
BEGIN
    IF NEW.`isDemo` <> OLD.`isDemo` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization: isDemo does not change';
    END IF;
END;

-- It starts preparing (the service also writes it only for a demonstration).
CREATE TRIGGER `demo_company_starts` BEFORE INSERT ON `demo_company` FOR EACH ROW
BEGIN
    IF NEW.`status` <> 'PREPARING' OR NEW.`claimedAt` IS NOT NULL OR NEW.`finishedAt` IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'demo_company: starts preparing';
    END IF;
END;

-- What it is never changes; its state goes from preparing to an end once.
CREATE TRIGGER `demo_company_rules` BEFORE UPDATE ON `demo_company` FOR EACH ROW
BEGIN
    IF NEW.`organizationId` <> OLD.`organizationId` OR NEW.`dataset` <> OLD.`dataset`
       OR NEW.`createdByUserId` <> OLD.`createdByUserId` OR NEW.`createdAt` <> OLD.`createdAt` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'demo_company: only its state changes';
    END IF;
    IF OLD.`status` <> 'PREPARING' AND (NEW.`status` <> OLD.`status`
       OR NOT (NEW.`finishedAt` <=> OLD.`finishedAt`) OR NOT (NEW.`failure` <=> OLD.`failure`)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'demo_company: already finished';
    END IF;
    IF OLD.`claimedAt` IS NOT NULL AND NOT (NEW.`claimedAt` <=> OLD.`claimedAt`) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'demo_company: claimed once';
    END IF;
END;

CREATE TRIGGER `demo_company_no_delete` BEFORE DELETE ON `demo_company` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'demo_company is not deleted';
