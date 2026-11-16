-- WMS-28B (ADR 0075, revisión): la orden que nace de una solicitud usa
-- también su área. Solo reemplaza el disparador de la migración anterior
-- (misma tabla, misma regla más el área); no cambia datos.
DROP TRIGGER IF EXISTS `production_order_request_insert`;

CREATE TRIGGER `production_order_request_insert` BEFORE INSERT ON `production_order` FOR EACH ROW
BEGIN
  IF NEW.`requestId` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `production_request` r
      WHERE r.`organizationId` = NEW.`organizationId` AND r.`id` = NEW.`requestId`
        AND r.`status` = 'ACCEPTED' AND r.`productId` = NEW.`productId`
        AND r.`facilityId` = NEW.`facilityId`
        AND r.`areaLocationId` = NEW.`areaLocationId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_order comes from an accepted request of its product, warehouse and area';
  END IF;
END;
