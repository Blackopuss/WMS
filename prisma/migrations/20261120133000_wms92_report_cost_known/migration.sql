-- WMS-92: si algún material de la orden tenía costo al reportar. Vacío en
-- los reportes de antes; no cambia (como el resto del reporte).
ALTER TABLE `production_report` ADD COLUMN `costKnown` BOOLEAN NULL;

DROP TRIGGER `production_report_update_rule`;

-- Solo se marca una vez como revertido; nada más cambia.
CREATE TRIGGER `production_report_update_rule` BEFORE UPDATE ON `production_report` FOR EACH ROW
BEGIN
  IF NOT (NEW.`orderId` <=> OLD.`orderId` AND NEW.`number` <=> OLD.`number`
          AND NEW.`movementId` <=> OLD.`movementId` AND NEW.`goodQuantity` <=> OLD.`goodQuantity`
          AND NEW.`badQuantity` <=> OLD.`badQuantity` AND NEW.`badReason` <=> OLD.`badReason`
          AND NEW.`unitCode` <=> OLD.`unitCode` AND NEW.`lotCode` <=> OLD.`lotCode`
          AND NEW.`costKnown` <=> OLD.`costKnown`
          AND NEW.`createdByUserId` <=> OLD.`createdByUserId` AND NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: a report does not change';
  END IF;
  IF OLD.`reversedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: a report is reversed once';
  END IF;
  IF NEW.`reversalMovementId` IS NOT NULL
     AND NOT ((SELECT `type` FROM `stock_movement` WHERE `organizationId` = NEW.`organizationId` AND `id` = NEW.`reversalMovementId`) <=> 'REVERSAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_report: its reversal is a REVERSAL movement';
  END IF;
END;
