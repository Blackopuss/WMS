-- WMS-03 (ADR 0032): el WMS no incluye Ventas. Se borran sus tablas (con
-- sus disparadores), los tipos de movimiento SALE y SALE_RETURN y los roles
-- de caja. Este repositorio no tiene producción: la regla de migraciones
-- solo de expansión vuelve a aplicar desde el primer despliegue.

-- DropForeignKey
ALTER TABLE `cash_movement` DROP FOREIGN KEY `cash_movement_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `cash_movement` DROP FOREIGN KEY `cash_movement_organizationId_sessionId_fkey`;

-- DropForeignKey
ALTER TABLE `cash_session` DROP FOREIGN KEY `cash_session_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `sale_organizationId_cashSessionId_fkey`;

-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `sale_organizationId_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `sale_organizationId_discountAuthorizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `sale_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `sale_organizationId_movementId_fkey`;

-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `sale_organizationId_salesOrderId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_discount_authorization` DROP FOREIGN KEY `sale_discount_authorization_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_locationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_orderLineId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_presentationId_presentationVersion_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_productId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_productId_presentationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_line` DROP FOREIGN KEY `sale_line_organizationId_saleId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_payment` DROP FOREIGN KEY `sale_payment_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_payment` DROP FOREIGN KEY `sale_payment_organizationId_saleId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_price` DROP FOREIGN KEY `sale_price_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_price` DROP FOREIGN KEY `sale_price_organizationId_productId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_price` DROP FOREIGN KEY `sale_price_organizationId_productId_presentationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return` DROP FOREIGN KEY `sale_return_organizationId_cashSessionId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return` DROP FOREIGN KEY `sale_return_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return` DROP FOREIGN KEY `sale_return_organizationId_movementId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return` DROP FOREIGN KEY `sale_return_organizationId_saleId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_locationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_presentationId_presentation_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_productId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_productId_presentationId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_returnId_fkey`;

-- DropForeignKey
ALTER TABLE `sale_return_line` DROP FOREIGN KEY `sale_return_line_organizationId_saleLineId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_installment_term` DROP FOREIGN KEY `sales_installment_term_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order` DROP FOREIGN KEY `sales_order_organizationId_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order` DROP FOREIGN KEY `sales_order_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order` DROP FOREIGN KEY `sales_order_organizationId_quoteId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order_line` DROP FOREIGN KEY `sales_order_line_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order_line` DROP FOREIGN KEY `sales_order_line_organizationId_orderId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order_line` DROP FOREIGN KEY `sales_order_line_organizationId_presentationId_presentation_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order_line` DROP FOREIGN KEY `sales_order_line_organizationId_productId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_order_line` DROP FOREIGN KEY `sales_order_line_organizationId_productId_presentationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote` DROP FOREIGN KEY `sales_quote_organizationId_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote` DROP FOREIGN KEY `sales_quote_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_delivery` DROP FOREIGN KEY `sales_quote_delivery_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_delivery` DROP FOREIGN KEY `sales_quote_delivery_organizationId_quoteId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_line` DROP FOREIGN KEY `sales_quote_line_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_line` DROP FOREIGN KEY `sales_quote_line_organizationId_presentationId_presentation_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_line` DROP FOREIGN KEY `sales_quote_line_organizationId_productId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_line` DROP FOREIGN KEY `sales_quote_line_organizationId_productId_presentationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_quote_line` DROP FOREIGN KEY `sales_quote_line_organizationId_quoteId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable` DROP FOREIGN KEY `sales_receivable_organizationId_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable` DROP FOREIGN KEY `sales_receivable_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable` DROP FOREIGN KEY `sales_receivable_organizationId_saleId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_credit` DROP FOREIGN KEY `sales_receivable_credit_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_credit` DROP FOREIGN KEY `sales_receivable_credit_organizationId_receivableId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_credit` DROP FOREIGN KEY `sales_receivable_credit_organizationId_returnId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_installment` DROP FOREIGN KEY `sales_receivable_installment_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_installment` DROP FOREIGN KEY `sales_receivable_installment_organizationId_receivableId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_payment` DROP FOREIGN KEY `sales_receivable_payment_organizationId_cashSessionId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_payment` DROP FOREIGN KEY `sales_receivable_payment_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_payment` DROP FOREIGN KEY `sales_receivable_payment_organizationId_receivableId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_reminder` DROP FOREIGN KEY `sales_receivable_reminder_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_receivable_reminder` DROP FOREIGN KEY `sales_receivable_reminder_organizationId_receivableId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_settings` DROP FOREIGN KEY `sales_settings_organizationId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_statement_delivery` DROP FOREIGN KEY `sales_statement_delivery_organizationId_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `sales_statement_delivery` DROP FOREIGN KEY `sales_statement_delivery_organizationId_fkey`;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN') NOT NULL;

-- DropTable
DROP TABLE `cash_movement`;

-- DropTable
DROP TABLE `cash_session`;

-- DropTable
DROP TABLE `sale`;

-- DropTable
DROP TABLE `sale_discount_authorization`;

-- DropTable
DROP TABLE `sale_line`;

-- DropTable
DROP TABLE `sale_payment`;

-- DropTable
DROP TABLE `sale_price`;

-- DropTable
DROP TABLE `sale_return`;

-- DropTable
DROP TABLE `sale_return_line`;

-- DropTable
DROP TABLE `sales_installment_term`;

-- DropTable
DROP TABLE `sales_order`;

-- DropTable
DROP TABLE `sales_order_line`;

-- DropTable
DROP TABLE `sales_quote`;

-- DropTable
DROP TABLE `sales_quote_delivery`;

-- DropTable
DROP TABLE `sales_quote_line`;

-- DropTable
DROP TABLE `sales_receivable`;

-- DropTable
DROP TABLE `sales_receivable_credit`;

-- DropTable
DROP TABLE `sales_receivable_installment`;

-- DropTable
DROP TABLE `sales_receivable_payment`;

-- DropTable
DROP TABLE `sales_receivable_reminder`;

-- DropTable
DROP TABLE `sales_settings`;

-- DropTable
DROP TABLE `sales_statement_delivery`;


-- Roles: solo los del WMS (Cajero y Encargado de caja se quitaron).
DELETE FROM `membership_role` WHERE `role` IN ('cashier', 'cash_manager');
ALTER TABLE `membership_role` DROP CHECK `membership_role_role_check`;
ALTER TABLE `membership_role`
  ADD CONSTRAINT `membership_role_role_check`
  CHECK (`role` IN ('administrator', 'warehouse', 'buyer', 'viewer'));

-- Derechos de Ventas que hubieran quedado.
DELETE FROM `entitlement` WHERE `kind` = 'MODULE' AND `key` = 'sales';
