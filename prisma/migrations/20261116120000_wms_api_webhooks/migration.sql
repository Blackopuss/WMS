-- AlterTable
ALTER TABLE `outbound_order` ADD COLUMN `apiRequestKey` CHAR(64) NULL;

-- CreateTable
CREATE TABLE `api_key` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `prefix` VARCHAR(16) NOT NULL,
    `secretHash` CHAR(64) NOT NULL,
    `capabilities` JSON NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `facilityOnly` BOOLEAN NOT NULL DEFAULT false,
    `requestsPerMinute` INTEGER NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `revokedByUserId` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `api_key_secretHash_key`(`secretHash`),
    INDEX `api_key_organizationId_revokedAt_createdAt_idx`(`organizationId`, `revokedAt`, `createdAt`),
    INDEX `api_key_organizationId_facilityId_idx`(`organizationId`, `facilityId`),
    UNIQUE INDEX `api_key_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `api_key_organizationId_prefix_key`(`organizationId`, `prefix`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_rate_window` (
    `key` VARCHAR(80) NOT NULL,
    `windowStart` DATETIME(3) NOT NULL,
    `count` INTEGER NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_endpoint` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `description` VARCHAR(120) NULL,
    `events` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'PAUSED') NOT NULL DEFAULT 'ACTIVE',
    `pausedByFailures` BOOLEAN NOT NULL DEFAULT false,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `secretCiphertext` VARCHAR(255) NOT NULL,
    `previousSecretCiphertext` VARCHAR(255) NULL,
    `previousSecretExpiresAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `removedAt` DATETIME(3) NULL,

    INDEX `webhook_endpoint_organizationId_removedAt_createdAt_idx`(`organizationId`, `removedAt`, `createdAt`),
    UNIQUE INDEX `webhook_endpoint_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_event` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `type` VARCHAR(80) NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_event_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `webhook_event_organizationId_id_key`(`organizationId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_delivery` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `endpointId` CHAR(36) NOT NULL,
    `eventId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastAttemptAt` DATETIME(3) NULL,
    `lastStatusCode` INTEGER NULL,
    `reason` VARCHAR(200) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_delivery_organizationId_endpointId_createdAt_idx`(`organizationId`, `endpointId`, `createdAt`),
    INDEX `webhook_delivery_organizationId_eventId_idx`(`organizationId`, `eventId`),
    UNIQUE INDEX `webhook_delivery_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `webhook_delivery_organizationId_endpointId_eventId_key`(`organizationId`, `endpointId`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `outbound_order_organizationId_apiRequestKey_key` ON `outbound_order`(`organizationId`, `apiRequestKey`);

-- AddForeignKey
ALTER TABLE `api_key` ADD CONSTRAINT `api_key_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_key` ADD CONSTRAINT `api_key_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `webhook_endpoint` ADD CONSTRAINT `webhook_endpoint_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_event` ADD CONSTRAINT `webhook_event_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_delivery` ADD CONSTRAINT `webhook_delivery_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_delivery` ADD CONSTRAINT `webhook_delivery_organizationId_endpointId_fkey` FOREIGN KEY (`organizationId`, `endpointId`) REFERENCES `webhook_endpoint`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `webhook_delivery` ADD CONSTRAINT `webhook_delivery_organizationId_eventId_fkey` FOREIGN KEY (`organizationId`, `eventId`) REFERENCES `webhook_event`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- WMS-60 (ADR 0058): what the database rejects of the new tables. Case-
-- sensitive checks with REGEXP_LIKE ('c'), not the deprecated LIKE BINARY.
ALTER TABLE `api_key` ADD CONSTRAINT `api_key_rate` CHECK (`requestsPerMinute` BETWEEN 1 AND 100000);
ALTER TABLE `api_rate_window` ADD CONSTRAINT `api_rate_window_count` CHECK (`count` >= 0);
ALTER TABLE `webhook_endpoint` ADD CONSTRAINT `webhook_endpoint_https` CHECK (REGEXP_LIKE(`url`, '^https://', 'c'));
-- The API's idempotency key of an order: 64 lowercase hex characters.
ALTER TABLE `outbound_order` ADD CONSTRAINT `outbound_order_api_request_key` CHECK (`apiRequestKey` IS NULL OR REGEXP_LIKE(`apiRequestKey`, '^[0-9a-f]{64}$', 'c'));

-- The API's idempotency key is part of the identity of an order: it never
-- changes (same trigger as WMS-16, with the new column).
DROP TRIGGER `outbound_order_transition`;
CREATE TRIGGER `outbound_order_transition` BEFORE UPDATE ON `outbound_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`
      AND NEW.`importId` <=> OLD.`importId`
      AND NEW.`sourceKey` <=> OLD.`sourceKey`
      AND NEW.`apiRequestKey` <=> OLD.`apiRequestKey`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order identity is immutable';
  END IF;
  IF OLD.`status` <> 'DRAFT' AND NOT (NEW.`recipient` <=> OLD.`recipient`
      AND NEW.`address` <=> OLD.`address`
      AND NEW.`reference` <=> OLD.`reference`
      AND NEW.`dueOn` <=> OLD.`dueOn`
      AND NEW.`priority` <=> OLD.`priority`
      AND NEW.`note` <=> OLD.`note`
      AND NEW.`facilityId` <=> OLD.`facilityId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order header only changes in draft';
  END IF;
  IF NEW.`status` <> OLD.`status` AND NOT (
       (OLD.`status` = 'DRAFT' AND NEW.`status` IN ('RELEASED', 'CANCELLED'))
    OR (OLD.`status` = 'RELEASED' AND NEW.`status` IN ('PICKING', 'CANCELLED'))
    OR (OLD.`status` = 'PICKING' AND NEW.`status` = 'PICKED')
    OR (OLD.`status` = 'PICKED' AND NEW.`status` IN ('PACKING', 'SHIPPED'))
    OR (OLD.`status` = 'PACKING' AND NEW.`status` = 'PACKED')
    OR (OLD.`status` = 'PACKED' AND NEW.`status` = 'SHIPPED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order transition not allowed';
  END IF;
  IF OLD.`status` IN ('SHIPPED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order is closed';
  END IF;
  IF NEW.`status` = 'SHIPPED' AND NOT EXISTS (SELECT 1 FROM `shipment_order`
      WHERE `organizationId` = NEW.`organizationId` AND `openOrderId` = NEW.`id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an order ships only within a shipment';
  END IF;
END;
