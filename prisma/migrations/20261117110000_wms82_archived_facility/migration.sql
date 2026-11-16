-- WMS-82 (ADR 0077): un almacén archivado no recibe existencias ni
-- documentos. Los servicios ponen en fila a quien archiva con quien mete
-- existencias (las ubicaciones del almacén se archivan con él, bajo sus
-- candados) o crea un documento (el almacén compartido antes de nacer) y
-- dan el mensaje para la persona; estos disparadores son la última defensa
-- ante una escritura directa.

-- «General» y la ubicación de tránsito se archivan solo con su almacén: la
-- regla pasa de los CHECK (que no pueden mirar el almacén) a los
-- disparadores de abajo. Los servicios siguen sin archivarlas por separado.
ALTER TABLE `location` DROP CHECK `location_general_check`;
ALTER TABLE `location` ADD CONSTRAINT `location_general_check` CHECK (
    (COALESCE(`isDefault`, 0) = 0 AND `levelId` IS NOT NULL)
    OR (COALESCE(`isDefault`, 0) = 1 AND `levelId` IS NULL AND `parentId` IS NULL)
);
ALTER TABLE `location` DROP CHECK `location_transit`;
ALTER TABLE `location` ADD CONSTRAINT `location_transit` CHECK (
    `isTransit` IS NULL
    OR (`isTransit` = 1 AND `isDefault` IS NULL AND `isStaging` IS NULL AND `parentId` IS NULL)
);

-- Lo que ya existe: las ubicaciones activas de un almacén ya archivado se
-- archivan con la fecha del almacén. No se toca ningún saldo, movimiento ni
-- documento.
UPDATE `location` l
  JOIN `facility` f ON f.`id` = l.`facilityId` AND f.`organizationId` = l.`organizationId`
  SET l.`archivedAt` = f.`archivedAt`
  WHERE f.`archivedAt` IS NOT NULL AND l.`archivedAt` IS NULL;

-- Una ubicación de un almacén archivado nace y queda archivada; «General» y
-- la de tránsito solo se archivan con su almacén.
CREATE TRIGGER `location_archived_facility_insert` BEFORE INSERT ON `location` FOR EACH ROW
BEGIN
  DECLARE closed DATETIME(3);
  SELECT f.`archivedAt` INTO closed FROM `facility` f WHERE f.`id` = NEW.`facilityId`;
  IF NEW.`archivedAt` IS NULL AND closed IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location: an archived facility takes no active location';
  END IF;
  IF NEW.`archivedAt` IS NOT NULL AND closed IS NULL
      AND (NEW.`isDefault` = 1 OR NEW.`isTransit` = 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location: General and transit are archived only with their facility';
  END IF;
END;

CREATE TRIGGER `location_archived_facility_update` BEFORE UPDATE ON `location` FOR EACH ROW
BEGIN
  DECLARE closed DATETIME(3);
  SELECT f.`archivedAt` INTO closed FROM `facility` f WHERE f.`id` = NEW.`facilityId`;
  IF NEW.`archivedAt` IS NULL AND closed IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location: an archived facility takes no active location';
  END IF;
  IF NEW.`archivedAt` IS NOT NULL AND closed IS NULL
      AND (NEW.`isDefault` = 1 OR NEW.`isTransit` = 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'location: General and transit are archived only with their facility';
  END IF;
END;

-- Nada entra a una ubicación archivada: ni un saldo nuevo ni más cantidad
-- en uno que ya existe (sacar sí). Lee la ubicación con candado compartido
-- por su llave primaria: quien ya la bloqueó (todo servicio) no espera nada;
-- un camino que se olvidó de bloquearla queda en fila con archivar.
CREATE TRIGGER `stock_balance_archived_location_insert` BEFORE INSERT ON `stock_balance` FOR EACH ROW
BEGIN
  DECLARE archived DATETIME(3);
  IF NEW.`quantity` > 0 THEN
    SELECT `archivedAt` INTO archived FROM `location` WHERE `id` = NEW.`locationId` FOR SHARE;
    IF archived IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_balance: an archived location takes no stock';
    END IF;
  END IF;
END;

CREATE TRIGGER `stock_balance_archived_location_update` BEFORE UPDATE ON `stock_balance` FOR EACH ROW
BEGIN
  DECLARE archived DATETIME(3);
  IF NEW.`quantity` > OLD.`quantity` THEN
    SELECT `archivedAt` INTO archived FROM `location` WHERE `id` = NEW.`locationId` FOR SHARE;
    IF archived IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_balance: an archived location takes no stock';
    END IF;
  END IF;
END;

-- Ningún documento nace en un almacén archivado.
CREATE TRIGGER `count_program_archived_facility` BEFORE INSERT ON `count_program` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'count_program: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `purchase_order_archived_facility` BEFORE INSERT ON `purchase_order` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_order: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `purchase_request_archived_facility` BEFORE INSERT ON `purchase_request` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_request: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `outbound_order_archived_facility` BEFORE INSERT ON `outbound_order` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'outbound_order: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `shipment_archived_facility` BEFORE INSERT ON `shipment` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shipment: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `customer_return_archived_facility` BEFORE INSERT ON `customer_return` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_return: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `pick_wave_archived_facility` BEFORE INSERT ON `pick_wave` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pick_wave: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `incident_archived_facility` BEFORE INSERT ON `incident` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `equipment_archived_facility` BEFORE INSERT ON `equipment` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `shared_terminal_archived_facility` BEFORE INSERT ON `shared_terminal` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `api_key_archived_facility` BEFORE INSERT ON `api_key` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'api_key: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `production_order_archived_facility` BEFORE INSERT ON `production_order` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `production_request_archived_facility` BEFORE INSERT ON `production_request` FOR EACH ROW
BEGIN
  IF NEW.`facilityId` IS NOT NULL AND EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` = NEW.`facilityId` AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_request: an archived facility takes no new document';
  END IF;
END;

CREATE TRIGGER `facility_transfer_archived_facility` BEFORE INSERT ON `facility_transfer` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `facility` f
      WHERE f.`id` IN (NEW.`fromFacilityId`, NEW.`toFacilityId`) AND f.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'facility_transfer: an archived facility takes no new document';
  END IF;
END;

-- Ni una tarea, un conteo o un contenedor en una ubicación archivada.
CREATE TRIGGER `warehouse_task_archived_location` BEFORE INSERT ON `warehouse_task` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `location` l
      WHERE l.`id` IN (NEW.`fromLocationId`, NEW.`toLocationId`) AND l.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: an archived location takes no new task';
  END IF;
END;

CREATE TRIGGER `stock_count_archived_location` BEFORE INSERT ON `stock_count` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `location` l
      WHERE l.`id` = NEW.`locationId` AND l.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_count: an archived location takes no new count';
  END IF;
END;

CREATE TRIGGER `container_archived_location` BEFORE INSERT ON `container` FOR EACH ROW
BEGIN
  IF NEW.`locationId` IS NOT NULL AND EXISTS (SELECT 1 FROM `location` l
      WHERE l.`id` = NEW.`locationId` AND l.`archivedAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'container: an archived location takes no new container';
  END IF;
END;
