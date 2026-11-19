-- WMS-32 (ADR 0082): tasks delivered in a period, for the warehouse indicators.
-- CreateIndex
CREATE INDEX `warehouse_task_organizationId_deliveredAt_idx` ON `warehouse_task`(`organizationId`, `deliveredAt`);

