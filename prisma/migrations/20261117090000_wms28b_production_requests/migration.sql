-- WMS-28B (ADR 0075): solicitudes de producción. Solo expansión: una tabla
-- nueva y una columna opcional en `production_order` (la solicitud de la
-- que nació), con su índice único y disparadores propios. No cambia ningún
-- disparador de WMS-28.
-- AlterTable
ALTER TABLE `production_order` ADD COLUMN `requestId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `production_request` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `facilityId` CHAR(36) NOT NULL,
    `areaLocationId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unitCode` VARCHAR(12) NOT NULL,
    `note` VARCHAR(300) NULL,
    `status` ENUM('SUBMITTED', 'ACCEPTED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
    `requestedByUserId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedAt` DATETIME(3) NULL,
    `decidedByUserId` CHAR(36) NULL,
    `rejectReason` VARCHAR(300) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `production_request_organizationId_facilityId_status_number_idx`(`organizationId`, `facilityId`, `status`, `number`),
    INDEX `production_request_organizationId_status_number_idx`(`organizationId`, `status`, `number`),
    INDEX `production_request_organizationId_productId_status_idx`(`organizationId`, `productId`, `status`),
    INDEX `production_request_organizationId_requestedByUserId_status_idx`(`organizationId`, `requestedByUserId`, `status`),
    INDEX `production_request_organizationId_areaLocationId_idx`(`organizationId`, `areaLocationId`),
    UNIQUE INDEX `production_request_organizationId_id_key`(`organizationId`, `id`),
    UNIQUE INDEX `production_request_organizationId_number_key`(`organizationId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `production_order_organizationId_requestId_key` ON `production_order`(`organizationId`, `requestId`);

-- AddForeignKey
ALTER TABLE `production_order` ADD CONSTRAINT `production_order_organizationId_requestId_fkey` FOREIGN KEY (`organizationId`, `requestId`) REFERENCES `production_request`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_request` ADD CONSTRAINT `production_request_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_request` ADD CONSTRAINT `production_request_organizationId_facilityId_fkey` FOREIGN KEY (`organizationId`, `facilityId`) REFERENCES `facility`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_request` ADD CONSTRAINT `production_request_organizationId_areaLocationId_fkey` FOREIGN KEY (`organizationId`, `areaLocationId`) REFERENCES `location`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `production_request` ADD CONSTRAINT `production_request_organizationId_productId_fkey` FOREIGN KEY (`organizationId`, `productId`) REFERENCES `product`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── La solicitud ─────────────────────────────────────────────────────────

ALTER TABLE `production_request`
  ADD CONSTRAINT `production_request_quantity` CHECK (`quantity` > 0),
  ADD CONSTRAINT `production_request_number` CHECK (`number` > 0),
  -- Decidida (aceptada o rechazada) dice quién y cuándo; por atender o
  -- cancelada, no.
  ADD CONSTRAINT `production_request_decided` CHECK (
    (`status` IN ('ACCEPTED', 'REJECTED')) = (`decidedAt` IS NOT NULL AND `decidedByUserId` IS NOT NULL)),
  ADD CONSTRAINT `production_request_decided_null` CHECK (
    `status` IN ('ACCEPTED', 'REJECTED') OR (`decidedAt` IS NULL AND `decidedByUserId` IS NULL)),
  -- Rechazada, siempre con motivo; en otro estado, sin él.
  ADD CONSTRAINT `production_request_rejected` CHECK (
    (`status` = 'REJECTED') = (`rejectReason` IS NOT NULL)),
  -- Cancelada, con quién y cuándo; en otro estado, sin eso.
  ADD CONSTRAINT `production_request_cancelled` CHECK (
    (`status` = 'CANCELLED') = (`cancelledAt` IS NOT NULL AND `cancelledByUserId` IS NOT NULL)),
  ADD CONSTRAINT `production_request_cancelled_null` CHECK (
    `status` = 'CANCELLED' OR (`cancelledAt` IS NULL AND `cancelledByUserId` IS NULL));

-- Una solicitud no se borra.
CREATE TRIGGER `production_request_no_delete` BEFORE DELETE ON `production_request` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request cannot be deleted';

-- Nace por atender, con un área de uso «Producción» de su almacén.
CREATE TRIGGER `production_request_insert_rules` BEFORE INSERT ON `production_request` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'SUBMITTED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request starts submitted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM `location` l
      WHERE l.`organizationId` = NEW.`organizationId` AND l.`id` = NEW.`areaLocationId`
        AND l.`facilityId` = NEW.`facilityId` AND l.`type` = 'PRODUCTION') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request area is a production location of its warehouse';
  END IF;
END;

-- Lo pedido nunca cambia; los estados solo por
-- PRODUCTION_REQUEST_TRANSITIONS (request-states.ts): cambiar una exige
-- cambiar la otra.
CREATE TRIGGER `production_request_transition` BEFORE UPDATE ON `production_request` FOR EACH ROW
BEGIN
  IF OLD.`status` <> 'SUBMITTED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request is decided';
  END IF;
  IF NOT (NEW.`organizationId` <=> OLD.`organizationId`
      AND NEW.`number` <=> OLD.`number`
      AND NEW.`facilityId` <=> OLD.`facilityId`
      AND NEW.`areaLocationId` <=> OLD.`areaLocationId`
      AND NEW.`productId` <=> OLD.`productId`
      AND NEW.`quantity` <=> OLD.`quantity`
      AND NEW.`unitCode` <=> OLD.`unitCode`
      AND NEW.`note` <=> OLD.`note`
      AND NEW.`requestedByUserId` <=> OLD.`requestedByUserId`
      AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request is immutable';
  END IF;
  IF NEW.`status` <> OLD.`status`
     AND NOT (NEW.`status` IN ('ACCEPTED', 'REJECTED', 'CANCELLED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request transition not allowed';
  END IF;
END;

-- ── La orden que nace de una solicitud ──────────────────────────────────

-- Solo de una solicitud aceptada, del mismo producto y almacén.
CREATE TRIGGER `production_order_request_insert` BEFORE INSERT ON `production_order` FOR EACH ROW
BEGIN
  IF NEW.`requestId` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `production_request` r
      WHERE r.`organizationId` = NEW.`organizationId` AND r.`id` = NEW.`requestId`
        AND r.`status` = 'ACCEPTED' AND r.`productId` = NEW.`productId`
        AND r.`facilityId` = NEW.`facilityId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order comes from an accepted request of its product and warehouse';
  END IF;
END;

-- La solicitud de la que nació nunca cambia.
CREATE TRIGGER `production_order_request_fixed` BEFORE UPDATE ON `production_order` FOR EACH ROW
BEGIN
  IF NOT (NEW.`requestId` <=> OLD.`requestId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order request is immutable';
  END IF;
END;
