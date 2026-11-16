-- WMS-75 (ADR 0072): estado «En restauración» y uso de ubicación
-- «Restauración». Solo expansión: un valor más al final de cada ENUM (no
-- cambia ninguna fila; en MySQL agregar al final no reconstruye la tabla) y
-- dos CHECK más amplios. Ninguna fila existente tiene los valores nuevos.
-- AlterTable
ALTER TABLE `container_item` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL DEFAULT 'AVAILABLE';

-- AlterTable
ALTER TABLE `customer_return_decision` MODIFY `outcome` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL;

-- AlterTable
ALTER TABLE `facility_transfer_receipt_line` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL;

-- AlterTable
ALTER TABLE `location` MODIFY `type` ENUM('STORAGE', 'PICKING', 'RECEIVING', 'STAGING', 'QUARANTINE', 'DOCK', 'REPAIR') NOT NULL DEFAULT 'STORAGE';

-- AlterTable
ALTER TABLE `purchase_receipt_line` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL DEFAULT 'AVAILABLE';

-- AlterTable
ALTER TABLE `serial_move` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL;

-- AlterTable
ALTER TABLE `serial_unit` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NULL;

-- AlterTable
ALTER TABLE `stock_balance` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL DEFAULT 'AVAILABLE';

-- AlterTable
ALTER TABLE `stock_hold` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL;

-- AlterTable
ALTER TABLE `stock_movement_line` MODIFY `status` ENUM('AVAILABLE', 'RECEIVING', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'IN_TRANSIT', 'BLOCKED', 'REPAIR') NOT NULL DEFAULT 'AVAILABLE';


-- Una retención puede ser de lo que está en restauración (la orden de
-- reproceso, WMS-29B); nunca de disponible, en tránsito ni en recepción.
ALTER TABLE `stock_hold` DROP CHECK `stock_hold_status`;
ALTER TABLE `stock_hold`
  ADD CONSTRAINT `stock_hold_status` CHECK (`status` IN ('INSPECTION', 'QUARANTINE', 'DAMAGED', 'REJECTED', 'BLOCKED', 'REPAIR'));

-- La decisión de una devolución de cliente gana «A restauración».
ALTER TABLE `customer_return_decision` DROP CHECK `customer_return_decision_outcome`;
ALTER TABLE `customer_return_decision`
  ADD CONSTRAINT `customer_return_decision_outcome` CHECK (`outcome` IN ('AVAILABLE', 'DAMAGED', 'REJECTED', 'REPAIR'));
