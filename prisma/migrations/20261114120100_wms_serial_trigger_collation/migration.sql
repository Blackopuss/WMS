-- WMS-21B (ADR 0041): las variables de los disparadores de series se
-- comparan con columnas de la tabla; sin decir su intercalación, MySQL las
-- crea con la del servidor y rechaza la comparación ("Illegal mix of
-- collations"). Se vuelven a crear con la de las tablas. Misma regla.

DROP TRIGGER `serial_move_apply`;

CREATE TRIGGER `serial_move_apply` BEFORE INSERT ON `serial_move` FOR EACH ROW
BEGIN
  DECLARE unitProduct CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE unitLocation CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE unitStatus VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  SELECT `productId`, `locationId`, `status` INTO unitProduct, unitLocation, unitStatus
    FROM `serial_unit` WHERE `id` = NEW.`serialUnitId` FOR UPDATE;
  IF NOT (unitProduct <=> NEW.`productId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit belongs to another product';
  END IF;
  IF NEW.`direction` = 'OUT' THEN
    IF NOT (unitLocation <=> NEW.`locationId` AND unitStatus <=> NEW.`status`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit is not there';
    END IF;
    UPDATE `serial_unit` SET `locationId` = NULL, `status` = NULL WHERE `id` = NEW.`serialUnitId`;
  ELSE
    IF unitLocation IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial unit is already inside';
    END IF;
    UPDATE `serial_unit` SET `locationId` = NEW.`locationId`, `status` = NEW.`status` WHERE `id` = NEW.`serialUnitId`;
  END IF;
END;

DROP TRIGGER `stock_movement_line_serial_rule`;

CREATE TRIGGER `stock_movement_line_serial_rule` BEFORE INSERT ON `stock_movement_line` FOR EACH ROW
BEGIN
  DECLARE tracked VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE moves INT;
  SELECT `tracking` INTO tracked FROM `product` WHERE `id` = NEW.`productId`;
  SELECT COUNT(*) INTO moves FROM `serial_move`
    WHERE `organizationId` = NEW.`organizationId` AND `movementLineId` = NEW.`id`;
  IF tracked = 'SERIAL' THEN
    IF moves <> NEW.`baseQuantity` THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product by serial moves one serial per unit';
    END IF;
    IF EXISTS (SELECT 1 FROM `serial_move`
        WHERE `organizationId` = NEW.`organizationId` AND `movementLineId` = NEW.`id`
          AND NOT (`productId` <=> NEW.`productId` AND `locationId` <=> NEW.`locationId`
               AND `status` <=> NEW.`status` AND `direction` <=> NEW.`direction`)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the serial moves do not match their line';
    END IF;
  ELSEIF moves > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a product without serials moves no serial';
  END IF;
END;
