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


-- WMS-60 (ADR 0058): an order created by the API keeps its idempotency key in
-- sourceKey without an import. An imported order still needs its key; a key
-- without an import must start with «API:» (keys of a file go through
-- foldName, which leaves no capital letters, so they never collide).
ALTER TABLE `outbound_order` DROP CHECK `outbound_order_source`;
ALTER TABLE `outbound_order`
  ADD CONSTRAINT `outbound_order_source` CHECK (
    (`importId` IS NOT NULL AND `sourceKey` IS NOT NULL)
    OR (`importId` IS NULL AND (`sourceKey` IS NULL OR `sourceKey` LIKE BINARY 'API:%'))
  );

-- The counters and events reject what does not make sense.
ALTER TABLE `api_key` ADD CONSTRAINT `api_key_rate` CHECK (`requestsPerMinute` BETWEEN 1 AND 100000);
ALTER TABLE `api_rate_window` ADD CONSTRAINT `api_rate_window_count` CHECK (`count` >= 0);
ALTER TABLE `webhook_endpoint` ADD CONSTRAINT `webhook_endpoint_https` CHECK (`url` LIKE BINARY 'https://%');
