-- WMS-82, revisión (ADR 0077): un SELECT dentro de un disparador toma un
-- candado compartido sobre las filas que lee, también en READ COMMITTED.
-- Los disparadores de documentos y de tareas, conteos y contenedores de la
-- migración anterior tomaban así el almacén o la ubicación en un lugar que
-- el orden global (ADR 0074) no contempla, y cerraban círculos con la
-- operación diaria (entregar un acomodo contra una entrada al mismo muelle;
-- el primer surtido de un almacén contra una devolución de cliente). Se
-- quitan: lo sostienen los servicios, que toman el almacén compartido
-- (holdOpenFacility) o bloquean una ubicación del almacén en su orden.
-- Se quedan los de `stock_balance` (todo servicio ya bloqueó la ubicación
-- antes de escribir el saldo) y los de `location` (toda escritura de una
-- ubicación ocurre con su almacén ya bloqueado).
DROP TRIGGER IF EXISTS `count_program_archived_facility`;
DROP TRIGGER IF EXISTS `purchase_order_archived_facility`;
DROP TRIGGER IF EXISTS `purchase_request_archived_facility`;
DROP TRIGGER IF EXISTS `outbound_order_archived_facility`;
DROP TRIGGER IF EXISTS `shipment_archived_facility`;
DROP TRIGGER IF EXISTS `customer_return_archived_facility`;
DROP TRIGGER IF EXISTS `pick_wave_archived_facility`;
DROP TRIGGER IF EXISTS `incident_archived_facility`;
DROP TRIGGER IF EXISTS `equipment_archived_facility`;
DROP TRIGGER IF EXISTS `shared_terminal_archived_facility`;
DROP TRIGGER IF EXISTS `api_key_archived_facility`;
DROP TRIGGER IF EXISTS `production_order_archived_facility`;
DROP TRIGGER IF EXISTS `production_request_archived_facility`;
DROP TRIGGER IF EXISTS `facility_transfer_archived_facility`;
DROP TRIGGER IF EXISTS `warehouse_task_archived_location`;
DROP TRIGGER IF EXISTS `stock_count_archived_location`;
DROP TRIGGER IF EXISTS `container_archived_location`;
