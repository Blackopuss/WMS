-- WMS-68 (ADR 0064): access history on security_event. Expansion only:
-- nullable columns; old rows keep them empty (the table is append-only).
-- `eventOrganizationId`, not `organizationId`: this is a table of people,
-- not a company table (TENANT_MODELS), read across companies by its owner.
-- AlterTable
ALTER TABLE `security_event` ADD COLUMN `dedupeKey` VARCHAR(120) NULL,
    ADD COLUMN `deviceKey` VARCHAR(80) NULL,
    ADD COLUMN `eventOrganizationId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `security_event_userId_deviceKey_idx` ON `security_event`(`userId`, `deviceKey`);

-- CreateIndex
CREATE UNIQUE INDEX `security_event_userId_dedupeKey_key` ON `security_event`(`userId`, `dedupeKey`);

