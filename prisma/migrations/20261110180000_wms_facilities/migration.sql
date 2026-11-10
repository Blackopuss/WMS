-- WMS-18: varios almacenes por empresa. Cada uno con código, dirección y su
-- propia ubicación General; uno es el principal. Cada persona trabaja en un
-- almacén activo y cada pedido de salida sale de un almacén.

-- Ya no una por empresa (la llave única que empieza por organizationId sigue
-- sirviendo a la llave foránea).
ALTER TABLE `facility` DROP FOREIGN KEY `facility_organizationId_fkey`;
DROP INDEX `facility_organizationId_key` ON `facility`;
ALTER TABLE `facility` ADD CONSTRAINT `facility_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `facility`
    ADD COLUMN `code` VARCHAR(20) NULL,
    ADD COLUMN `address` VARCHAR(300) NULL,
    ADD COLUMN `isDefault` BOOLEAN NULL,
    ADD COLUMN `archivedAt` DATETIME(3) NULL;
-- El que ya existía es el principal.
UPDATE `facility` SET `code` = 'PRINCIPAL', `isDefault` = 1;
ALTER TABLE `facility` MODIFY `code` VARCHAR(20) NOT NULL;
CREATE UNIQUE INDEX `facility_organizationId_code_key` ON `facility`(`organizationId`, `code`);
CREATE UNIQUE INDEX `facility_organizationId_isDefault_key` ON `facility`(`organizationId`, `isDefault`);
ALTER TABLE `facility`
  ADD CONSTRAINT `facility_default` CHECK (`isDefault` IS NULL OR (`isDefault` = 1 AND `archivedAt` IS NULL)),
  ADD CONSTRAINT `facility_code` CHECK (CHAR_LENGTH(TRIM(`code`)) >= 1),
  ADD CONSTRAINT `facility_name` CHECK (CHAR_LENGTH(TRIM(`name`)) >= 1);

CREATE TRIGGER `facility_no_delete` BEFORE DELETE ON `facility` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility cannot be deleted: archive it';

-- El almacén en que trabaja cada persona; vacío = el principal.
ALTER TABLE `membership` ADD COLUMN `activeFacilityId` CHAR(36) NULL;
ALTER TABLE `membership` ADD CONSTRAINT `membership_organizationId_activeFacilityId_fkey` FOREIGN KEY (`organizationId`, `activeFacilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Cada pedido de salida sale de un almacén; los que había, del principal.
ALTER TABLE `outbound_order` ADD COLUMN `facilityId` CHAR(36) NULL;
UPDATE `outbound_order` o
  JOIN `facility` f ON f.`organizationId` = o.`organizationId` AND f.`isDefault` = 1
  SET o.`facilityId` = f.`id`;
ALTER TABLE `outbound_order` MODIFY `facilityId` CHAR(36) NOT NULL;
ALTER TABLE `outbound_order` ADD CONSTRAINT `outbound_order_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- El almacén de un pedido, como el resto del encabezado, solo cambia en borrador.
DROP TRIGGER `outbound_order_transition`;
CREATE TRIGGER `outbound_order_transition` BEFORE UPDATE ON `outbound_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`createdByUserId` <=> OLD.`createdByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`
      AND NEW.`importId` <=> OLD.`importId`
      AND NEW.`sourceKey` <=> OLD.`sourceKey`) THEN
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
    OR (OLD.`status` = 'PICKED' AND NEW.`status` = 'PACKED')
    OR (OLD.`status` = 'PACKED' AND NEW.`status` = 'SHIPPED')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order transition not allowed';
  END IF;
  IF OLD.`status` IN ('SHIPPED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order is closed';
  END IF;
END;
