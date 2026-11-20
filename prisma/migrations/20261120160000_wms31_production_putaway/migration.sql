-- WMS-31 (ADR 0093): el lote producido de una tarea de acomodo.

-- AlterTable
ALTER TABLE `warehouse_task` ADD COLUMN `productionReportId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_productionReportId_idx` ON `warehouse_task`(`organizationId`, `productionReportId`);

-- AddForeignKey
ALTER TABLE `warehouse_task` ADD CONSTRAINT `warehouse_task_organizationId_productionReportId_fkey` FOREIGN KEY (`organizationId`, `productionReportId`) REFERENCES `production_report`(`organizationId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Solo una tarea de acomodo lleva el lote producido del que viene.
ALTER TABLE `warehouse_task`
  ADD CONSTRAINT `warehouse_task_production_report_putaway` CHECK (`productionReportId` IS NULL OR `kind` = 'PUTAWAY');

-- No cambia (sin leer otras tablas: ADR 0077).
CREATE TRIGGER `warehouse_task_production_report_fixed` BEFORE UPDATE ON `warehouse_task` FOR EACH ROW
BEGIN
  IF NOT (NEW.`productionReportId` <=> OLD.`productionReportId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'warehouse_task: productionReportId never changes';
  END IF;
END;
