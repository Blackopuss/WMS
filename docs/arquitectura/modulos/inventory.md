# Módulo Inventario (`inventory`)

Carpeta `src/modules/inventory`. Contrato `inventoryModule` (`contract.ts`):
`required: true` (la base que toda empresa tiene), sin dependencias, usa
`catalog`, dueño de todos los permisos `inventory.*` y del límite
`active_products` (compartido por todos los módulos).

## Responsabilidad

Todo lo que cambia o explica existencias: movimientos y saldos (por producto,
ubicación, estado y lote), costo promedio, lotes y caducidad, números de
serie y trazabilidad, capacidad de
ubicaciones al meter mercancía, reservas, tareas de traslado, surtido y
acomodo con recomendación, tarimas y contenedores,
pedidos de salida con su verificación, empaque y despacho en embarques,
devoluciones de clientes, conteos, mínimos, importaciones y exportaciones, y los
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
- Un producto por serie (WMS-21B, ADR 0041) dice qué unidades mueve:
  `serialsForEntry` (lo que entra) o `serialsForTake` (lo que sale, se mueve
  o cambia de estado) de `serials.ts`, bajo el candado del producto, y
  `writeSerialMoves` **antes** de escribir sus líneas (con el id que tendrán).
  Los disparadores rechazan una línea de un producto por serie sin una
  `serial_move` por unidad, y mueven cada `serial_unit`.
- Lo que mete existencias llama `checkPlacement` una vez por transacción.
- Con el acomodo por tareas (WMS-52, ADR 0042), lo que entra a un lugar «de
  paso» (`WAITING_PLACE` de `unplaced.ts`) crea su tarea `PUTAWAY` con
  `createPutawayTasks` al final de la misma transacción; el destino lo
  decide solo `putawayTarget`. Un apartado de tarea (`TASK_HOLD`) solo
  cuenta en su ubicación: las lecturas de todo un producto filtran con
  `PRODUCT_HOLDS`.
- Tarimas y contenedores (WMS-53, ADR 0043): un contenedor agrupa parte del
  saldo de su ubicación (`container_item`) sin entrar en la llave del saldo.
  Lo que está dentro no se toma suelto: `freeToTake`/`freeToMoveFrom` lo
  restan como un apartado de la ubicación, `serialsForTake` rechaza sus
  unidades y ajustes, conteos y salidas importadas comparan con
  `containedAt`; la base rechaza cualquier saldo por debajo de lo contenido.
  Moverlo es `moveContainerWithin` (un `TRANSFER` con `containerId`).
  Candados: productos → ubicaciones → documento → contenedor → tarea →
  capacidad.
- Empaque (WMS-15, ADR 0044): un bulto es un contenedor con `purpose =
  PACKING` y su pedido (`outboundOrderId`); escanear lo pone ahí sin mover
  existencias (verificado = empacado). Lo que trae un bulto ya lo aparta la
  reserva de su pedido: `freeToTake`/`freeToMoveFrom` restan solo los
  contenedores de almacenamiento, y nunca se empaca más de lo que esa
  reserva aparta (también en `reconcileStock`). Lo que falta se escribe en
  `outbound_pack_shortage` y se libera de la reserva. Los servicios de
  tarimas rechazan un bulto.
- Despacho (WMS-16, ADR 0045): un embarque (`shipment`) agrupa pedidos
  listos para salir (`PACKED`; también `PICKED` con el empaque apagado) de un
  almacén; un pedido va en un solo embarque abierto
  (`shipment_order.openOrderId`, único). Confirmar la salida es una
  transacción: candados productos → ubicaciones → embarque → pedidos →
  bultos; vacía los bultos (evento `SHIPPED`, contenedor `CLOSED`) **antes**
  de escribir **una** salida `SHIPMENT` (clave `ship:<id>`) con exactamente
  lo apartado en preparación, consume esas reservas y deja `shipment_line`
  por línea. Un movimiento `SHIPMENT` no se reversa.
- Devoluciones de clientes (WMS-17, ADR 0046): lo que regresa entra con un
  movimiento propio `CUSTOMER_RETURN`, **siempre en `INSPECTION`** (también
  disparador), con o sin pedido despachado; con pedido nunca más de lo que
  salió menos lo ya devuelto (bajo el candado del pedido), a su lote y con
  sus mismas series, al costo con que salió; sin pedido, al costo promedio
  vigente. Solo una decisión (`decideCustomerReturn`: un `STATUS_CHANGE`
  escrito con el núcleo `writeStatusChange` y ligado a la devolución) lo
  vuelve disponible, dañado o rechazado. Lo que una devolución abierta tiene
  en inspección queda retenido (`heldForReturns`): «Cambiar estado» y la
  reversa no lo toman. Ni `CUSTOMER_RETURN` ni sus decisiones se reversan.
- Traslados entre almacenes (WMS-19, ADR 0048): un borrador lista qué va
  (producto, ubicación de origen, lote, series) y no aparta nada. Enviar es
  **un** movimiento `FACILITY_TRANSFER` que saca disponible del origen y lo
  deja en `IN_TRANSIT` en la ubicación «En tránsito» del destino
  (`location.isTransit`, del sistema, nunca ofrecida ni listada); recibir,
  «se perdió» y «regresó al origen» son otros `FACILITY_TRANSFER` que sacan
  de tránsito, con lo pendiente calculado bajo el candado del traslado
  (nunca más de lo enviado). El total de la empresa y el valor no cambian en
  tránsito (solo «se perdió» baja el valor); los disparadores obligan a que
  `IN_TRANSIT` viva solo en la ubicación de tránsito y que solo un traslado
  escriba ahí. No se reversa desde Inventario.
- Cada formulario que confirma un movimiento manda `idempotencyKey`.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Movimientos | `movements.ts` | `registerEntry`, `registerExit`, `registerTransfer`, `registerAdjustment`, `registerInitialBalance`, `reverseMovement`; historial (`listMovements`, `listRecentMovements`, `listMovementAuthors`); lecturas de saldo (`getStockByLocation`, `getStockTotals`, `listStockLocations`, `listProductsWithoutStock`); `findConfirmation` (verificación por clave) y `formatStock` |
| Salida rápida | `quick-exit.ts` | `registerQuickExit`: varias líneas en un movimiento |
| Existencias de un producto | `product-stock.ts`, `stock-status.ts` | `getProductStock` («hay», «disponible», apartado); estados del saldo y filtros `availableOfLot`, `AVAILABLE_ANY_LOT` |
| Cambio de estado | `status-change.ts` | `changeStockStatus` (movimiento `STATUS_CHANGE` con motivo), `permissionForStatusChange` |
| Reservas | `reservations.ts` | `reserveStock`, `consumeReservation`, `releaseReservations`, `releaseReservationPart`, `freeToTake`, `freeToMoveFrom`, `getReservedTotals`; se llaman dentro de la transacción del documento. `TASK_HOLD` (fuente de lo que aparta una tarea de acomodo o de reposición) y `PRODUCT_HOLDS` (filtro de lo apartado de todo un producto) |
| Acomodo | `putaway.ts`, `putaway-rules.ts` | `putawayTarget` (la única que decide el lugar recomendado), `createPutawayTasks` (dentro de la transacción de una recepción o entrada), `createContainerPutawayTask` (una tarea por tarima, WMS-53), `createPendingPutawayTasks` («Crear tareas de acomodo», también para tarimas), `isTaskNumberClash`; orden puro `rankPutawayPlaces` |
| Lotes | `lots.ts`, `lot-rules.ts` | lotes con existencias, ficha, por caducar (`listExpiringLots`, `countExpiringLots`), `changeLotExpiry`; reglas puras del código y la fecha del lote |
| Series y trazabilidad | `serials.ts`, `serial-rules.ts`, `traceability.ts` | reglas puras de la serie (`normalizeSerial`, `parseSerialList`, `MAX_SERIALS_PER_OPERATION`, `serialsText`); `serialUnitsOfLines` (para Compras); `findTraceMatches` (un cuadro: lote, serie, `PS-…`, `EM-…`, `DV-…`, `OC-…`), `traceSerial`, `traceLot` (ambos dicen en qué embarque salió y con qué devolución volvió), `tracePurchaseOrder`, `listProductSerials`; `listMovements` filtra por `serialUnitId` y cada línea trae sus `serials` |
| Tarimas y contenedores | `containers.ts`, `container-rules.ts`, `contained.ts` | `packStock` (armar o agregar), `unpackStock` (sacar), `closeContainer` (desarmar), `moveContainer` (un escaneo) y su núcleo `moveContainerWithin`, `prepareReceiptContainer`/`packReceived` (para la recepción), lecturas `listContainers`, `getContainer`, `listContainerEvents`, `findContainerByCode`, `listOpenContainersAt`, `containersEnabled`, `containersVisible`, `createContainer`; `containedAt` (lo que hay en contenedores de una llave; `storageOnly` sin bultos de empaque); reglas puras del código (`C-0001`), del tipo y del peso (`parseWeightKg`) |
| Capacidad | `placement.ts`, `location-occupancy.ts` | `checkPlacement`, `loadPlacementRules`; `getLocationOccupancy` (ocupación derivada) |
| Costo y valor | `average-cost.ts`, `inventory-value.ts` | `parseCost`, `getInventoryValue`, `getProductCost`, `mayReadInventoryCosts` |
| Para Compras | `receipt-entry.ts`, `return-exit.ts` | `postReceiptEntry` (movimiento `RECEIPT`) y `postReturnExit` (`RETURN`), dentro de la transacción de la recepción o devolución |
| Mínimos | `minimums.ts` | `setMinimum`, `getMinimum`, `listLowStock`, `countLowStock` |
| Reposición de surtido | `replenishment.ts`, `replenishment-rules.ts`, `stock-sources.ts` | Reglas por producto y ubicación de surtido (`saveReplenishmentRule`, `removeReplenishmentRule`, `listReplenishmentRules`, `getReplenishmentRule`, `listPickingPlaces`, `replenishmentVisible`); `replenishNow` («Reponer ahora») y `runReplenishmentRound` (la ronda del worker) crean tareas `REPLENISH`; `replenishmentPlan` (interna) es la única que decide cuánto y de dónde; piezas puras `replenishQuantity`, `largestThatFits`, `splitAmongSources`, `replenishmentStateOf` y el orden de orígenes `rankStockSources`, compartido con el surtido (WMS-23/24) |
| Conteos | `counts.ts` | `openCount`, `captureCount`, `removeCapture`, `applyCount`, `cancelCount`, `getCount`, `listCounts` |
| Tareas | `tasks.ts`, `task-states.ts` | crear, asignar, tomar, recoger, entregar (`deliverTask`; un acomodo con la ubicación escaneada, `locationCode`), reportar, liberar, cancelar, `confirmPick` (surtido); listas; tabla de transiciones `WAREHOUSE_TASK_TRANSITIONS`. Tipos `TRANSFER`, `PICK`, `PUTAWAY` y `REPLENISH` (WMS-24: entregar consume su apartado y mueve a la ubicación de surtido; cancelar lo suelta); una tarea mueve un producto o un contenedor entero (`containerId`, WMS-53) |
| Pedidos de salida | `outbound-orders.ts`, `outbound-states.ts` | crear, editar líneas, liberar (aparta y crea tareas de surtido), cancelar, listar; transiciones `OUTBOUND_ORDER_TRANSITIONS` |
| Despacho y embarques | `shipments.ts`, `shipment-states.ts`, `shipment-ready.ts`, `shipment-pdf.ts` | `createShipment` (borrador con pedidos listos y datos del transporte), `updateShipment`, `addShipmentOrders`, `removeShipmentOrder`, `cancelShipment`, `dispatchShipment` (confirmar salida); lecturas `listShipments`, `getShipment`, `listReadyOrders`, `countOrdersToShip`, `shipmentOfOrder`, `shipmentDetailsRequired`; `buildShipmentPdf` (hoja de embarque, sin precios); transiciones `SHIPMENT_TRANSITIONS`; `TO_SHIP` y `shippedOn` en `listOutboundOrders`; `shippedOnWhere` (resumen del día) |
| Traslados entre almacenes | `facility-transfers.ts`, `facility-transfer-states.ts` | `createFacilityTransfer`, `addFacilityTransferLine`, `removeFacilityTransferLine`, `cancelFacilityTransfer` (borrador), `sendFacilityTransfer`, `receiveFacilityTransfer` (bien y dañado, en varias veces), `resolveFacilityTransfer` (`LOST`/`RETURNED`), `listFacilityTransfers` (`sent`, `incoming`, `received`), `getFacilityTransfer`, `countTransfersToReceive`, `listTransferDestinations`, `listTransferReceivePlaces`, `hasSeveralFacilities`, `findFacilityTransferByKey`, `findFacilityTransferByNumber`; transiciones `FACILITY_TRANSFER_TRANSITIONS` |
| Devoluciones de clientes | `customer-returns.ts`, `customer-return-states.ts`, `return-holds.ts` | `receiveCustomerReturn` (entra en inspección), `decideCustomerReturn` (disponible, dañado o rechazado), `findReturnableOrders` (`PS-…` o `EM-…`), `getReturnableOrder` (lo que salió y lo que puede regresar), `listReturnPlaces`, `returnsWithoutOrderAllowed`, `listCustomerReturns`, `getCustomerReturn`, `countReturnsToReview`, `returnsOfOrder`, `findCustomerReturnByKey`; `heldForReturns` (lo retenido en inspección); transiciones `CUSTOMER_RETURN_TRANSITIONS`. El núcleo del cambio de estado, `writeStatusChange` (`status-change.ts`), lo comparten «Cambiar estado» y las decisiones |
| Verificación y empaque | `packing.ts` | `startPacking` (PICKED → PACKING), `packScan` (un escaneo al bulto abierto: serie, clave o código de barras, o lote), `unpackFromPackage`, `sealPackage` (tipo y peso), `reopenPackage`, `reportPackShortage` (faltante con motivo), `finishPacking` (→ PACKED); lecturas `getPackingView`, `countOrdersToPack`, `packingEnabled`; `TO_PACK` en `listOutboundOrders` |
| Etiquetas | `labels.ts` | `buildLabels` (PDF de etiquetas de ubicaciones, producto, lotes, series, tarima o bulto, bultos de un pedido, pedido y embarque, con Code 128 y QR; lee con los servicios de cada ficha y su alcance; tope `LABELS_MAX` y `LABEL_COPIES_MAX`), `previewLocationLabels` (cuántas salen y cuáles no tienen código), `productLabelOptions`, `labelDefaults`; `LABEL_KINDS` (WMS-26) |
| Importar pedidos | `outbound-import.ts` | `startOutboundImport` → `reviewOutboundImport` → `confirmOutboundImport` / `cancelOutboundImport` |
| Importar productos y existencias | `imports.ts`, `import-validation.ts`, `import-classification.ts`, `import-confirmation.ts`, `import-apply.ts`, `import-release.ts`, `import-template.ts` | subir, mapear columnas, validar, clasificar, confirmar (aparta cupo), aplicar en el worker, cancelar o liberar |
| Importar salidas | `exit-import.ts`, `exit-import-apply.ts` | `startExitImport` → `reviewExitImport` → `confirmExitImport` → `applyExitImport` (worker); `getExitCoverage` |
| Exportaciones | `exports.ts` | `buildExport` y `EXPORT_KINDS` |
| Inicio y resúmenes | `first-steps.ts`, `day-summary.ts`, `unplaced.ts` | `getFirstSteps`, `getDaySummary`, `listUnplacedStock` (dice qué fila ya tiene tarea de acomodo), `countUnplacedStock` |
| Reconciliación | `reconciliation.ts` | `reconcileStock`, `reconcileValue`, `reconcileCompany` |
| Ajustes y trabajos | `settings.ts`, `import-apply.ts`, `exit-import-apply.ts` | `INVENTORY_SETTINGS` y cada ajuste; `inventoryJobHandlers`, `exitImportJobHandlers` |

Internos que no se exportan pero deciden reglas: `picking.ts` (`pickSources`:
de dónde y de qué lote se surte, con el orden de `stock-sources.ts`), `lot-resolve.ts`, `serials.ts` (qué
unidades por serie mueve una operación), `entry-repeat.ts` (aviso de
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
- Tareas: `task.read|create|execute|cancel` («Reponer ahora» pide `task.create`).
- Reposición de surtido (WMS-23): sin permiso propio; ver las reglas es
  `minimum.read` y crearlas, cambiarlas o quitarlas, `minimum.update`.
- Pedidos: `outbound.read|create|release|cancel|pack` (`pack`: verificar y
  empacar, WMS-15).
- Embarques: `shipment.read|create|dispatch|export` (WMS-16: ver, armar,
  confirmar la salida, PDF).
- Devoluciones de clientes: `customer_return.read|create` (WMS-17: ver y
  registrar; decidir usa `status.release` para disponible y `status.change`
  para dañado o rechazado).
- Traslados entre almacenes: `facility_transfer.read|create|send|receive|resolve`
  (WMS-19: ver, armar y cancelar el borrador, enviar, recibir y resolver lo
  que no llegó).
- Archivos: `import.create|read|confirm|cancel`, `export.create`.
- Etiquetas (WMS-26): sin permiso propio; imprimir pide la lectura de lo que
  se etiqueta (`location.read`, `product.read`, `stock.read`,
  `outbound.read`, `shipment.read`, y `purchasing.receipt.read` para las
  series de una recepción).

Los de productos, presentaciones y ubicaciones los comprueban los servicios de
[catalog](catalog.md) y [locations](locations.md), pero son de este módulo
(prefijo `inventory.`).

## Tablas

`stock_movement`, `stock_movement_line`, `stock_balance`, `lot`,
`serial_unit`, `serial_move`, `warehouse_task_serial`, `container`,
`container_item`, `container_event`,
`product_cost`, `stock_minimum`, `stock_count`, `stock_count_line`,
`stock_count_capture`, `warehouse_task`, `replenishment_rule`,
`stock_reservation`,
`outbound_order`, `outbound_order_line`, `outbound_pack_shortage`,
`shipment`, `shipment_order`, `shipment_line`, `customer_return`,
`customer_return_line`, `customer_return_decision`, `facility_transfer`,
`facility_transfer_line`, `facility_transfer_receipt`,
`facility_transfer_receipt_line`,
`product_import`,
`product_import_item`, `exit_import`, `exit_import_row`, `outbound_import`.
Detalle en [modelo-de-datos.md](../modelo-de-datos.md).

## Ajustes de operación

Declarados en `settings.ts` (`INVENTORY_SETTINGS`), registrados en
`src/modules/registry/settings.ts` y leídos con `readSetting(tx, …)` dentro de
la transacción que decide:

| Clave | Opciones (por omisión en negritas) |
| --- | --- |
| `inventory.picking.strategy` | **`fullest`**, `emptiest`, `fifo` (lo que caduca antes sale primero siempre) |
| `inventory.picking.expired` | **`skip`**, `allow` |
| `inventory.entry.repeat_window` | `off`, `10`, **`30`**, `120` (minutos) |
| `inventory.capacity.mode` | **`warn`**, `block` |
| `inventory.lot.expiry_notice` | `7`, `15`, **`30`**, `60`, `90` (días) |
| `inventory.putaway.mode` | **`manual`**, `tasks` (WMS-52) |
| `inventory.putaway.preference` | **`together`** (junto a lo mismo), `emptiest` |
| `inventory.containers.mode` | **`off`**, `on` (tarimas y cajas, WMS-53) |
| `inventory.packing.mode` | **`off`**, `on` (verificar y empacar antes de despachar, WMS-15) |
| `inventory.shipment.details` | **`optional`**, `required` (transportista y quién se lo lleva antes de confirmar la salida, WMS-16) |
| `inventory.customer_return.without_order` | **`allow`**, `forbid` (devoluciones de clientes sin pedido, WMS-17) |
| `inventory.labels.format` | **`letter_10`** (hoja carta, 10 por hoja), `100x50`, `100x150` (mm; WMS-26) |
| `inventory.labels.codes` | **`both`** (barras y QR), `barcode`, `qr` (WMS-26) |
| `inventory.replenishment.mode` | **`off`** (solo con «Reponer ahora»), `round` (la ronda del worker, cada hora; WMS-24) |

## Trabajos en segundo plano

| Tipo | Manejador | Qué hace |
| --- | --- | --- |
| `inventory.import_products` | `inventoryJobHandlers` (`import-apply.ts`) | Aplica una importación confirmada por lotes; `onFailed` devuelve el cupo apartado |
| `inventory.import_exits` | `exitImportJobHandlers` (`exit-import-apply.ts`) | Registra las salidas de un archivo confirmado; el folio evita descontar dos veces |

Rondas (`scheduledRounds` de `src/modules/registry/rounds.ts`, cada hora):

| Ronda | Función | Qué hace |
| --- | --- | --- |
| `inventory.replenishment` | `runReplenishmentRound` (`replenishment.ts`) | Con `inventory.replenishment.mode = round` y el módulo con escritura, crea en cada almacén activo las tareas de reposición que hacen falta, como el titular; repetirla o correrla dos veces a la vez no duplica (ADR 0051) |

## ADR

0012 (movimientos y saldos), 0013 (cola), 0014 (archivos), 0015 (importación de
salidas), 0031 (costo promedio), 0032 (sin Ventas), 0033 (estado y lote del
saldo), 0034 (ajustes), 0035 (varios almacenes), 0038 (alcance), 0039
(capacidad), 0040 (lotes y caducidad), 0041 (números de serie y
trazabilidad), 0042 (acomodo con recomendación), 0043 (tarimas y
contenedores), 0044 (verificación y empaque), 0045 (despacho y embarques),
0046 (devoluciones de clientes), 0047 (etiquetas e impresión), 0048 (traslados
entre almacenes), 0051 (reposición de surtido).

## Pruebas

`tests/inventory/*.int.test.ts` (terminan con `reconcileStock` vacío) y las
unitarias junto al código (`*-states.test.ts`, `average-cost.test.ts`,
`lot-rules.test.ts`, `entry-repeat.test.ts`, `putaway-rules.test.ts`,
`replenishment-rules.test.ts`). Reposición de surtido en
`replenishment.int.test.ts`.
Acomodo en `putaway.int.test.ts`; etiquetas en `labels.int.test.ts` (leen de
vuelta los códigos dibujados con `tests/setup/pdf.ts`); empaque en `packing.int.test.ts`; despacho en `shipments.int.test.ts`; devoluciones de clientes (PC-5) en
`customer-returns.int.test.ts`; traslados entre almacenes en
`facility-transfers.int.test.ts`. Casos de alcance en
`tests/inventory/scope.int.test.ts`, de capacidad en `capacity.int.test.ts` y de
lotes en `lots.int.test.ts`; de series en `serials.int.test.ts` y de
trazabilidad en `traceability.int.test.ts`. `reconcileStock` también compara
cada saldo de un producto por serie con sus unidades dentro (`source:
"serial_units"` y `"serial_moves"`), y lo que dicen los contenedores contra el
saldo, su ubicación y sus series (`source: "containers"`). Tarimas en
`containers.int.test.ts`.
