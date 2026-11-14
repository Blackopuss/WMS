-- AlterTable
ALTER TABLE `notification_preference` ADD COLUMN `email` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `notification_email` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `notificationId` CHAR(36) NOT NULL,
    `recipientUserId` CHAR(36) NOT NULL,
    `typeKey` VARCHAR(80) NOT NULL,
    `text` VARCHAR(300) NOT NULL,
    `href` VARCHAR(300) NOT NULL,
    `requirement` JSON NOT NULL,
    `status` ENUM('QUEUED', 'SENT', 'SKIPPED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `claimedBy` CHAR(36) NULL,
    `reason` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    INDEX `notification_email_organizationId_recipientUserId_status_cla_idx`(`organizationId`, `recipientUserId`, `status`, `claimedBy`),
    INDEX `notification_email_organizationId_recipientUserId_sentAt_idx`(`organizationId`, `recipientUserId`, `sentAt`),
    INDEX `notification_email_organizationId_status_createdAt_idx`(`organizationId`, `status`, `createdAt`),
    UNIQUE INDEX `notification_email_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `notification_email_organizationId_notificationId_key`(`organizationId`, `notificationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_digest` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `day` DATE NOT NULL,
    `status` ENUM('QUEUED', 'SENT', 'EMPTY', 'SKIPPED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `reason` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    INDEX `daily_digest_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `daily_digest_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `daily_digest_organizationId_userId_day_key`(`organizationId`, `userId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `notification_preference_organizationId_typeKey_email_idx` ON `notification_preference`(`organizationId`, `typeKey`, `email`);

-- AddForeignKey
ALTER TABLE `notification_email` ADD CONSTRAINT `notification_email_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `daily_digest` ADD CONSTRAINT `daily_digest_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- WMS-39B (ADR 0060): el correo de un aviso lleva el mismo destino interno
-- que el aviso («/…», nunca «//…» ni «/\…», sin espacios ni esquemas).
ALTER TABLE `notification_email` ADD CONSTRAINT `notification_email_href_check` CHECK (
    LEFT(`href`, 1) = '/'
    AND SUBSTRING(`href`, 2, 1) NOT IN ('/', '\\')
    AND `href` NOT LIKE '% %'
    AND `href` NOT LIKE '%:%'
);
ALTER TABLE `notification_email` ADD CONSTRAINT `notification_email_text_check` CHECK (
    CHAR_LENGTH(TRIM(`text`)) > 0
);
-- Un correo enviado dice cuándo salió.
ALTER TABLE `notification_email` ADD CONSTRAINT `notification_email_sent_check` CHECK (
    `status` <> 'SENT' OR `sentAt` IS NOT NULL
);
ALTER TABLE `daily_digest` ADD CONSTRAINT `daily_digest_sent_check` CHECK (
    `status` <> 'SENT' OR `sentAt` IS NOT NULL
);
