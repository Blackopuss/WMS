# Módulo Inventario (`inventory`)

Carpeta `src/modules/inventory`. Contrato `inventoryModule` (`contract.ts`):
`required: true` (la base que toda empresa tiene), sin dependencias, usa
`catalog`, dueño de todos los permisos `inventory.*` y del límite
`active_products` (compartido por todos los módulos).

## Responsabilidad

Todo lo que cambia o explica existencias: movimientos y saldos (por producto,
ubicación, estado y lote), costo promedio, lotes y caducidad, capacidad de
ubicaciones al meter mercancía, reservas, tareas de traslado y surtido,
pedidos de salida, conteos, mínimos, importaciones y exportaciones, y los
resúmenes de Inicio. Productos y ubicaciones son del núcleo
([catalog](catalog.md), [locations](locations.md)); Inventario los usa.

Reglas que no se rompen (detalle en `AGENTS.md`, sección «Convenciones de
código»):

- El saldo (`stock_balance`) solo cambia junto con un movimiento
  (`stock_movement` + líneas) en la misma transacción; movimientos y líneas son
  inmutables y se corrigen con reversa.
- Candados en orden fijo: productos (`lockRows(tx, "product", ids)`) →
  ubicaciones → documento (pedido, conteo) → tarea → filas de capacidad.
  Transacciones con `LOCKING_TRANSACTION`.
- «Hay» suma todos los estados; «disponible» es solo `AVAILABLE` menos lo
  apartado. Toda operación lee el saldo con `availableOfLot(lotId)` o
  `AVAILABLE_ANY_LOT`.
- Lo que entra resuelve su lote con `lotForEntry`, lo que sale con
  `lotForTake` (`lot-resolve.ts`), bajo el candado del producto.
- Lo que mete existencias llama `checkPlacement` una vez por transacción.
- Cada formulario que confirma un movimiento manda `idempotencyKey`.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Movimientos | `movements.ts` | `registerEntry`, `registerExit`, `registerTransfer`, `registerAdjustment`, `registerInitialBalance`, `reverseMovement`; historial (`listMovements`, `listRecentMovements`, `listMovementAuthors`); lecturas de saldo (`getStockByLocation`, `getStockTotals`, `listStockLocations`, `listProductsWithoutStock`); `findConfirmation` (verificación por clave) y `formatStock` |
| Salida rápida | `quick-exit.ts` | `registerQuickExit`: varias líneas en un movimiento |
| Existencias de un producto | `product-stock.ts`, `stock-status.ts` | `getProductStock` («hay», «disponible», apartado); estados del saldo y filtros `availableOfLot`, `AVAILABLE_ANY_LOT` |
| Cambio de estado | `status-change.ts` | `changeStockStatus` (movimiento `STATUS_CHANGE` con motivo), `permissionForStatusChange` |
| Reservas | `reservations.ts` | `reserveStock`, `consumeReservation`, `releaseReservations`, `freeToTake`, `freeToMoveFrom`, `getReservedTotals`; se llaman dentro de la transacción del documento |
| Lotes | `lots.ts`, `lot-rules.ts` | lotes con existencias, ficha, por caducar (`listExpiringLots`, `countExpiringLots`), `changeLotExpiry`; reglas puras del código y la fecha del lote |
| Capacidad | `placement.ts`, `location-occupancy.ts` | `checkPlacement`, `loadPlacementRules`; `getLocationOccupancy` (ocupación derivada) |
| Costo y valor | `average-cost.ts`, `inventory-value.ts` | `parseCost`, `getInventoryValue`, `getProductCost`, `mayReadInventoryCosts` |
| Para Compras | `receipt-entry.ts`, `return-exit.ts` | `postReceiptEntry` (movimiento `RECEIPT`) y `postReturnExit` (`RETURN`), dentro de la transacción de la recepción o devolución |
| Mínimos | `minimums.ts` | `setMinimum`, `getMinimum`, `listLowStock`, `countLowStock` |
| Conteos | `counts.ts` | `openCount`, `captureCount`, `removeCapture`, `applyCount`, `cancelCount`, `getCount`, `listCounts` |
| Tareas | `tasks.ts`, `task-states.ts` | crear, asignar, tomar, recoger, entregar, reportar, liberar, cancelar, `confirmPick` (surtido); listas; tabla de transiciones `WAREHOUSE_TASK_TRANSITIONS` |
| Pedidos de salida | `outbound-orders.ts`, `outbound-states.ts` | crear, editar líneas, liberar (aparta y crea tareas de surtido), cancelar, listar; transiciones `OUTBOUND_ORDER_TRANSITIONS` |
| Importar pedidos | `outbound-import.ts` | `startOutboundImport` → `reviewOutboundImport` → `confirmOutboundImport` / `cancelOutboundImport` |
| Importar productos y existencias | `imports.ts`, `import-validation.ts`, `import-classification.ts`, `import-confirmation.ts`, `import-apply.ts`, `import-release.ts`, `import-template.ts` | subir, mapear columnas, validar, clasificar, confirmar (aparta cupo), aplicar en el worker, cancelar o liberar |
| Importar salidas | `exit-import.ts`, `exit-import-apply.ts` | `startExitImport` → `reviewExitImport` → `confirmExitImport` → `applyExitImport` (worker); `getExitCoverage` |
| Exportaciones | `exports.ts` | `buildExport` y `EXPORT_KINDS` |
| Inicio y resúmenes | `first-steps.ts`, `day-summary.ts`, `unplaced.ts` | `getFirstSteps`, `getDaySummary`, `listUnplacedStock`, `countUnplacedStock` |
| Reconciliación | `reconciliation.ts` | `reconcileStock`, `reconcileValue`, `reconcileCompany` |
| Ajustes y trabajos | `settings.ts`, `import-apply.ts`, `exit-import-apply.ts` | `INVENTORY_SETTINGS` y cada ajuste; `inventoryJobHandlers`, `exitImportJobHandlers` |

Internos que no se exportan pero deciden reglas: `picking.ts` (`pickSources`:
de dónde y de qué lote se surte), `lot-resolve.ts`, `entry-repeat.ts` (aviso de
entrada repetida), `calendar-day.ts` (`dayWindow`: un día del calendario de la
empresa), `valuation.ts`.

## Permisos

Todos los `inventory.*` del catálogo, por grupo:

- Catálogo y consulta: `product.*`, `unit.read`, `presentation.*`,
  `location.*`, `stock.read`, `movement.read`, `minimum.*`, `cost.read`,
  `cost.record`, `dashboard.read`, `summary.read`.
- Movimientos: `entry.create`, `opening.create`, `exit.create`,
  `transfer.create`, `adjustment.create`, `movement.reverse`.
- Estados: `status.change`, `status.release`, `damage.report`.
- Conteos: `count.read|create|update|apply`.
- Tareas: `task.read|create|execute|cancel`.
- Pedidos: `outbound.read|create|release|cancel`.
- Archivos: `import.create|read|confirm|cancel`, `export.create`.

Los de productos, presentaciones y ubicaciones los comprueban los servicios de
[catalog](catalog.md) y [locations](locations.md), pero son de este módulo
(prefijo `inventory.`).

## Tablas

`stock_movement`, `stock_movement_line`, `stock_balance`, `lot`,
`product_cost`, `stock_minimum`, `stock_count`, `stock_count_line`,
`stock_count_capture`, `warehouse_task`, `stock_reservation`,
`outbound_order`, `outbound_order_line`, `product_import`,
`product_import_item`, `exit_import`, `exit_import_row`, `outbound_import`.
Detalle en [modelo-de-datos.md](../modelo-de-datos.md).

## Ajustes de operación

Declarados en `settings.ts` (`INVENTORY_SETTINGS`), registrados en
`src/modules/registry/settings.ts` y leídos con `readSetting(tx, …)` dentro de
la transacción que decide:

| Clave | Opciones (por omisión en negritas) |
| --- | --- |
| `inventory.picking.strategy` | **`fullest`**, `emptiest`, `fefo`, `fifo` |
| `inventory.picking.expired` | **`skip`**, `allow` |
| `inventory.entry.repeat_window` | `off`, `10`, **`30`**, `120` (minutos) |
| `inventory.capacity.mode` | **`warn`**, `block` |
| `inventory.lot.expiry_notice` | `7`, `15`, **`30`**, `60`, `90` (días) |

## Trabajos en segundo plano

| Tipo | Manejador | Qué hace |
| --- | --- | --- |
| `inventory.import_products` | `inventoryJobHandlers` (`import-apply.ts`) | Aplica una importación confirmada por lotes; `onFailed` devuelve el cupo apartado |
| `inventory.import_exits` | `exitImportJobHandlers` (`exit-import-apply.ts`) | Registra las salidas de un archivo confirmado; el folio evita descontar dos veces |

## ADR

0012 (movimientos y saldos), 0013 (cola), 0014 (archivos), 0015 (importación de
salidas), 0031 (costo promedio), 0032 (sin Ventas), 0033 (estado y lote del
saldo), 0034 (ajustes), 0035 (varios almacenes), 0038 (alcance), 0039
(capacidad), 0040 (lotes y caducidad).

## Pruebas

`tests/inventory/*.int.test.ts` (terminan con `reconcileStock` vacío) y las
unitarias junto al código (`*-states.test.ts`, `average-cost.test.ts`,
`lot-rules.test.ts`, `entry-repeat.test.ts`). Casos de alcance en
`tests/inventory/scope.int.test.ts`, de capacidad en `capacity.int.test.ts` y de
lotes en `lots.int.test.ts`.
