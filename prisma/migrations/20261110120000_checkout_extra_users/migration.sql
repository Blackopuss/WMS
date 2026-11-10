-- BIL-11: usuarios adicionales como concepto de cobro. La compra guarda
-- cuántas personas se agregan a las que incluye el nivel; al pagarse, el
-- límite «users» del plan es la suma. Solo expansión.
ALTER TABLE `checkout_order`
    ADD COLUMN `extraUsers` INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT `checkout_order_extra_users` CHECK (`extraUsers` BETWEEN 0 AND 50);

DROP TRIGGER `checkout_order_frozen`;
CREATE TRIGGER `checkout_order_frozen` BEFORE UPDATE ON `checkout_order` FOR EACH ROW
BEGIN
  IF NEW.`organizationId` <> OLD.`organizationId` OR NEW.`transactionId` <> OLD.`transactionId`
    OR NEW.`userId` <> OLD.`userId` OR NEW.`tier` <> OLD.`tier` OR NEW.`modules` <> OLD.`modules`
    OR NEW.`includedUsers` <> OLD.`includedUsers` OR NEW.`extraUsers` <> OLD.`extraUsers`
    OR NEW.`months` <> OLD.`months` OR NEW.`subtotal` <> OLD.`subtotal`
    OR NEW.`prorated` <> OLD.`prorated` OR NOT (NEW.`proratedDays` <=> OLD.`proratedDays`)
    OR NEW.`discount` <> OLD.`discount` OR NEW.`tax` <> OLD.`tax` OR NEW.`total` <> OLD.`total`
    OR NEW.`provider` <> OLD.`provider` OR NOT (NEW.`promoCodeId` <=> OLD.`promoCodeId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checkout_order amounts are immutable';
  END IF;
  IF OLD.`status` <> 'PENDING' AND NEW.`status` <> OLD.`status` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checkout_order status is final';
  END IF;
  IF OLD.`status` = 'PAID' AND (NOT (NEW.`validUntilAfter` <=> OLD.`validUntilAfter`)
    OR NOT (NEW.`paidAt` <=> OLD.`paidAt`) OR NOT (NEW.`paymentRef` <=> OLD.`paymentRef`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a paid checkout_order is immutable';
  END IF;
END;
