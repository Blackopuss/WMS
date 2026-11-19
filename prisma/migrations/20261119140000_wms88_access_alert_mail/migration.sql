-- CreateTable
CREATE TABLE `access_alert_email` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `securityEventId` CHAR(36) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `deviceKey` VARCHAR(80) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `status` ENUM('QUEUED', 'SENT', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL,
    `claimToken` CHAR(36) NULL,
    `claimedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `reason` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `access_alert_email_securityEventId_key`(`securityEventId`),
    INDEX `access_alert_email_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `access_alert_email_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notice_unsubscribe` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notice_unsubscribe_organizationId_expiresAt_idx`(`organizationId`, `expiresAt`),
    UNIQUE INDEX `notice_unsubscribe_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `notice_unsubscribe_organizationId_tokenHash_key`(`organizationId`, `tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `security_event_createdAt_idx` ON `security_event`(`createdAt`);

-- AddForeignKey
ALTER TABLE `notice_unsubscribe` ADD CONSTRAINT `notice_unsubscribe_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- WMS-88 (ADR 0084): retention of the access history. Only the round of
-- the worker deletes, and the database lets it delete only an access
-- event (or an internal row of a day) older than 365 days by its own
-- clock. A known device (`access.device_known`) and the events that are
-- not accesses (second step, recovery codes, password change) are never
-- deleted. Updates stay forbidden.
DROP TRIGGER `security_event_no_delete`;
CREATE TRIGGER `security_event_no_delete` BEFORE DELETE ON `security_event` FOR EACH ROW
BEGIN
  IF NOT (
    OLD.`action` IN (
      'sign_in.succeeded', 'mfa.backup_code_used', 'sign_in.failed',
      'mfa_code.failed', 'sign_in.locked', 'pin_sign_in.succeeded',
      'pin_sign_in.failed', 'pin.locked', 'session.revoked',
      'session.revoked_others', 'session.closed_by_team', 'password.reset',
      'access.alert_new_device', 'access.alert_password_new_device',
      'access.alert_failed_attempts', 'access.alert_code_locked',
      'access.alert_pin_locked', 'access.mail_slot', 'access.claim'
    )
    AND OLD.`createdAt` < UTC_TIMESTAMP(3) - INTERVAL 365 DAY
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_event is append-only (only access events older than 365 days may be purged)';
  END IF;
END;
