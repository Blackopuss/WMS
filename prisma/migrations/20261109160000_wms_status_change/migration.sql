-- WMS-11: cambio de estado de existencias (ADR 0033).

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('ENTRY', 'EXIT', 'TRANSFER', 'ADJUSTMENT', 'INITIAL', 'REVERSAL', 'RECEIPT', 'RETURN', 'STATUS_CHANGE') NOT NULL;


-- Un cambio de estado siempre dice por qué, también si alguien escribe con
-- SQL sin pasar por la aplicación.
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_status_change_reason_check` CHECK (
    `type` <> 'STATUS_CHANGE' OR (`reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reason`)) >= 3)
);
