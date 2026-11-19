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
devoluciones de clientes, conteos (también cíclicos, con su exactitud), mínimos, importaciones y exportaciones, y los
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
- Procesos en embarques (WMS-74B, ADR 0071): el embarque es un documento
  del motor de procesos (`SHIPMENT_PROCESS`, `shipment-process.ts`, clave
  `inventory.shipment`; hitos «Por confirmar», «Despachado» y «Cancelado»,
  que cierra; operación `inventory.shipment.dispatched` «Salida confirmada»
  en «Por confirmar»). `createShipment` llama `startProcess`;
  `dispatchShipment` llama `assertStagesDone` después de su último candado
  (bultos) y, tras escribir `SHIPPED`, `reachMilestone` y
  `completeOperationStage`; `cancelShipment` llama `reachMilestone`
  («Cancelado»). Candados: productos → ubicaciones → embarque → pedidos →
  bultos → progreso. «Despachado» no cierra el proceso: las etapas
  posteriores no tocan existencias ni el estado del embarque. `getShipment`
  trae `dispatchWaits` («Esperando: …», lectura sin candado con
  `operationWaits`). Sin proceso publicado, nada cambia.
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
  escriba ahí. No se reversa desde Inventario. La hoja de traslado en PDF
  (WMS-19B) se lee con la misma ficha (`getFacilityTransfer`), sin costos,
  con lo recibido y espacio para firmas.
- Cross-docking (WMS-54, ADR 0052): con `inventory.crossdock.mode = on`, lo
  sano y suelto que entra a un lugar «de paso» (recepción de una orden de
  compra o entrada manual) para un pedido `RELEASED`/`PICKING` del mismo
  almacén que lo espera (pedido − lo que su línea tiene apartado hoy,
  derivado) se aparta para su línea ahí mismo y lleva su tarea `PICK` normal
  hacia preparación (`warehouse_task.crossDockMovementId` = la entrada); el
  resto sigue a acomodo. Candados: productos → ubicaciones → (orden de
  compra) → pedidos de salida → contenedor → tareas → capacidad
  (`lockCrossDockOrders` antes; `sendToWaitingOrders` después de los
  saldos y antes de las tareas de acomodo). El reparto lo decide solo
  `planCrossDock` (puro). Con el ajuste encendido un pedido se libera aunque
  no haya nada que apartar.
- Lo dañado al recibir (WMS-54, ADR 0052): `postReceiptEntry` acepta `status`
  por línea (`DAMAGED` para la parte dañada: su propia línea, no va en la
  tarima, no lleva tarea de acomodo ni se reparte) y `postReturnExit` sale del
  estado de la línea de recepción.
- Surtido por olas (WMS-25, ADR 0054): con `inventory.picking.mode = waves`
  (`orders` por omisión: nada cambia), una ola (`pick_wave`, `OL-0001`, del
  almacén) agrupa pedidos en borrador o liberados (`pick_wave_order`, un
  pedido en una sola ola abierta por `openOrderId` único); crearla libera los
  borradores con el mismo núcleo de la liberación (`releaseUnderLock`).
  **Cada tarea `PICK` sigue siendo de una línea de un pedido**: la ola solo
  agrupa, ordena (`pick-route.ts`, por el código de la ubicación de origen en
  orden natural) y reparte (por persona o por zona = la raíz del almacén que
  contiene el origen). Lo del mismo producto, origen y lote se confirma junto
  (`confirmPickGroup`: toma y confirma cada tarea con su cantidad completa en
  una transacción; todo o nada) y se deja junto en preparación
  (`deliverPickGroup`: un movimiento `task:<id>` por tarea). La ola se
  termina sola (`settleWaveOf`, al cerrar una tarea de surtido o cancelar un
  pedido) y cancelarla solo desagrupa. Candados: productos → ubicaciones →
  pedidos → contenedor → tareas → capacidad → ola.
- El surtido prefiere las ubicaciones de uso `PICKING` entre iguales de
  caducidad (`rankStockSources`, ADR 0054); sin ellas, el orden es el de
  antes.
- Cada formulario que confirma un movimiento manda `idempotencyKey`.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Movimientos | `movements.ts` | `registerEntry`, `registerExit`, `registerTransfer`, `registerAdjustment` (sobre el umbral, con la regla encendida, responde `pending_approval` y no escribe nada, WMS-41), `registerInitialBalance`, `reverseMovement`; historial (`listMovements`, `listRecentMovements`, `listMovementAuthors`); lecturas de saldo (`getStockByLocation`, `getStockTotals`, `listStockLocations`, `listProductsWithoutStock`); `findConfirmation` (verificación por clave) y `formatStock` |
| Salida rápida | `quick-exit.ts` | `registerQuickExit`: varias líneas en un movimiento |
| Existencias de un producto | `product-stock.ts`, `stock-status.ts` | `getProductStock` («hay», «disponible», apartado); estados del saldo y filtros `availableOfLot`, `AVAILABLE_ANY_LOT` |
| Cambio de estado | `status-change.ts` | `changeStockStatus` (movimiento `STATUS_CHANGE` con motivo; lo que termina disponible en un lugar de paso crea su tarea de acomodo, WMS-30-0), `permissionForStatusChange`, `MANUAL_STOCK_STATUSES` (con `REPAIR`, WMS-75) |
| Filtro por estado (WMS-87) | `status-filter.ts` | `chosenStockStatus` (un valor de la dirección solo cuenta si es un estado), `STOCK_STATUS_FILTER_OPTIONS`, `productsInStatusWhere` (la condición «tiene existencias en ese estado» del almacén activo y dentro del alcance; el catálogo la suma a su consulta con la opción `also` de `listProducts`, así la página se corta en la base) |
| Restauración (WMS-75) | `repair-release.ts`, `inspection.ts` | Estado `REPAIR` («En restauración», no disponible); `repairReleaseProblem` (ajuste `inventory.repair.release`, leído en `writeStatusChange` y en la reversa de un cambio de estado; con `inspection` solo sale a inspección, dañado o rechazado, `REPAIR_EXITS_THROUGH_INSPECTION`), `repairExitsOf` (lo que «Cambiar estado» ofrece desde restauración); `listInRepair`/`countInRepair` (derivadas, mismo núcleo que «Por inspeccionar»). Uso de ubicación `REPAIR` («Restauración»), que como la cuarentena no admite disponible (ADR 0072) |
| Inspección al recibir (WMS-30-0) | `inspection.ts` | `listAwaitingInspection` y `countAwaitingInspection` (derivadas: saldos en `INSPECTION` del almacén activo y del alcance, con su origen y lo retenido); la regla es `product.inspectOnReceipt` y la aplica `postReceiptEntry` |
| Retención genérica (WMS-30-0) | `holds.ts` | `holdStock`, `releaseHold`, `releaseHoldsOf` (dentro de la transacción del documento, después de sus candados) y `heldStock` (la única lectura: suma `stock_hold` y lo que retienen las devoluciones de clientes); la usan «Cambiar estado» (`holdSource` en `writeStatusChange`), las reversas, «Desechar» y la devolución al proveedor. Para WMS-30B (ADR 0068) |
| Desechar (WMS-30-0) | `disposal.ts` | `disposeStock` (de dañado o rechazado, con motivo, clave de confirmación, `repeated`; con la regla `inventory.disposal` encendida responde `pending_approval` sin escribir, WMS-83), `disposalNeedsApproval`, `findDisposalConfirmation`, `postDisposal` (núcleo dentro de una transacción ajena, para WMS-29 y WMS-30B; `allowedStatuses`, `holdSource`), `DISPOSABLE_STATUSES`. Movimiento `DISPOSAL` al costo promedio; no se reversa |
| Reservas | `reservations.ts` | `reserveStock`, `consumeReservation`, `releaseReservations`, `releaseReservationPart`, `freeToTake`, `freeToMoveFrom`, `getReservedTotals`; se llaman dentro de la transacción del documento. `TASK_HOLD` (fuente de lo que aparta una tarea de acomodo o de reposición) y `PRODUCT_HOLDS` (filtro de lo apartado de todo un producto) |
| Acomodo | `putaway.ts`, `putaway-rules.ts` | `putawayTarget` (la única que decide el lugar recomendado), `createPutawayTasks` (dentro de la transacción de una recepción o entrada), `createContainerPutawayTask` (una tarea por tarima, WMS-53), `createPendingPutawayTasks` («Crear tareas de acomodo», también para tarimas), `isTaskNumberClash`; orden puro `rankPutawayPlaces` |
| Lotes | `lots.ts`, `lot-rules.ts` | lotes con existencias, ficha, por caducar (`listExpiringLots`, `countExpiringLots`), `changeLotExpiry`; reglas puras del código y la fecha del lote |
| Series y trazabilidad | `serials.ts`, `serial-rules.ts`, `traceability.ts` | reglas puras de la serie (`normalizeSerial`, `parseSerialList`, `MAX_SERIALS_PER_OPERATION`, `serialsText`); `serialUnitsOfLines` (para Compras); `findTraceMatches` (un cuadro: lote, serie, `PS-…`, `EM-…`, `DV-…`, `OC-…`), `traceSerial`, `traceLot` (ambos dicen en qué embarque salió y con qué devolución volvió), `tracePurchaseOrder`, `listProductSerials`; `listMovements` filtra por `serialUnitId` y cada línea trae sus `serials` |
| Tarimas y contenedores | `containers.ts`, `container-rules.ts`, `contained.ts` | `packStock` (armar o agregar), `unpackStock` (sacar), `closeContainer` (desarmar), `moveContainer` (un escaneo) y su núcleo `moveContainerWithin`, `prepareReceiptContainer`/`packReceived` (para la recepción), lecturas `listContainers`, `getContainer`, `listContainerEvents`, `findContainerByCode`, `listOpenContainersAt`, `containersEnabled`, `containersVisible`, `createContainer`; `containedAt` (lo que hay en contenedores de una llave; `storageOnly` sin bultos de empaque); reglas puras del código (`C-0001`), del tipo y del peso (`parseWeightKg`) |
| Capacidad | `placement.ts`, `location-occupancy.ts` | `checkPlacement`, `loadPlacementRules`; `getLocationOccupancy` (ocupación derivada) |
| Costo y valor | `average-cost.ts`, `inventory-value.ts` | `parseCost`, `getInventoryValue`, `getProductCost`, `mayReadInventoryCosts` |
| Para Compras | `receipt-entry.ts`, `return-exit.ts` | `postReceiptEntry` (movimiento `RECEIPT`; `status` por línea para lo dañado y el reparto de cross-docking, que responde en `crossDock`) y `postReturnExit` (`RETURN`, del estado que diga cada línea: disponible, en inspección, dañado o rechazado, `RETURNABLE_STATUSES`; lo retenido no sale), dentro de la transacción de la recepción o devolución |
| Cross-docking | `cross-docking.ts`, `cross-dock-rules.ts` | `planCrossDock` y `rankWaitingLines` (puras: a qué pedidos va lo que llega); `lockCrossDockOrders` y `sendToWaitingOrders` son internas (las llaman la recepción y la entrada manual); `CROSS_DOCK_MODE`; tipo `CrossDockSent` |
| Mínimos | `minimums.ts` | `setMinimum`, `getMinimum`, `listLowStock`, `countLowStock` |
| Reposición de surtido | `replenishment.ts`, `replenishment-rules.ts`, `stock-sources.ts` | Reglas por producto y ubicación de surtido (`saveReplenishmentRule`, `removeReplenishmentRule`, `listReplenishmentRules`, `getReplenishmentRule`, `listPickingPlaces`, `replenishmentVisible`); `replenishNow` («Reponer ahora») y `runReplenishmentRound` (la ronda del worker) crean tareas `REPLENISH`; `replenishmentPlan` (interna) es la única que decide cuánto y de dónde; piezas puras `replenishQuantity`, `largestThatFits`, `splitAmongSources`, `replenishmentStateOf` y el orden de orígenes `rankStockSources`, compartido con el surtido (WMS-23/24) |
| Conteos | `counts.ts` | `openCount`, `captureCount`, `removeCapture`, `applyCount` (con `reviewed` cuando la empresa pide revisar diferencias grandes, WMS-55; con la regla `inventory.count_apply` encendida responde `pending_approval`, WMS-41), `cancelCount`, `getCount` (programa, líneas por revisar, lo que está en tarimas y `pendingApprovalId`), `listCountPage` (paginada; vista «De hoy»), `listCounts` (su primera página); `applyApprovedCount` (efecto de la autorización) |
| Aprobaciones (WMS-41) | `approvals.ts`, `approval-keys.ts`, `approval-rules.ts` | `INVENTORY_APPROVAL_TYPES` (`inventory.adjustment` con `applyApprovedAdjustment` de `movements.ts`, `inventory.count_apply` con `applyApprovedCount`), `ADJUSTMENT_APPROVAL`, `COUNT_APPROVAL`; regla pura del umbral `exceedsThreshold` |
| Conteos cíclicos (WMS-55) | `cycle-counts.ts`, `abc-rules.ts`, `count-accuracy.ts` | `createCountProgram`, `updateCountProgram`, `setCountProgramPaused`, `listCountPrograms`, `getCountProgram` (con lo que generaría hoy), `generateTodayCounts` («Generar los de hoy»), `runCycleCountRound` (la ronda del worker), `countTodayCounts` (Inicio); `getCountAccuracy` (exactitud por semana o mes contra el periodo anterior, por programa; tope `ACCURACY_MAX_ROWS`); reglas puras `classifyAbc`, `locationClass`, `parseAbcCuts` |
| Tareas | `tasks.ts`, `task-states.ts` | crear, asignar, tomar, recoger, entregar (`deliverTask`; un acomodo con la ubicación escaneada, `locationCode`), reportar, liberar, cancelar, `confirmPick` (surtido); listas; tabla de transiciones `WAREHOUSE_TASK_TRANSITIONS`. Tipos `TRANSFER`, `PICK`, `PUTAWAY`, `REPLENISH` (WMS-24: entregar consume su apartado y mueve a la ubicación de surtido; cancelar lo suelta) e `ISSUE` («Surtir a producción», WMS-28, ADR 0073: la crea Producción al liberar una orden con `setAsideForProduction` de `issue.ts`; entregar consume la reserva de su línea en el origen, mueve al área y la vuelve a apartar ahí para la misma línea; cancelar suelta su parte; cada paso bloquea la orden de producción antes que la tarea); una tarea mueve un producto o un contenedor entero (`containerId`, WMS-53). Foto al entregar (WMS-37B, ADR 0076): `uploadTaskPhoto` (propósito `task_photo`; solo la tarea propia «Por entregar», en alcance y con el ajuste encendido), `discardTaskPhoto`, `photoIds` en `deliverTask` (todas las entregas; se ligan al final de su transacción y, con `inventory.task.photo = required`, sin foto no se mueve nada), `photos` en `getTask` (con quién y cuándo), `reachesTask` (dueño de las fotos para `evidenceOwners`) y `taskPhotoMode`; `deliverPickGroup` se rechaza con la foto obligatoria |
| Pedidos de salida | `outbound-orders.ts`, `outbound-states.ts` | crear, editar líneas, liberar (aparta y crea tareas de surtido), cancelar, listar; transiciones `OUTBOUND_ORDER_TRANSITIONS`; `releaseUnderLock` y `lockedOutboundOrder` (internas, para las olas) |
| Olas de surtido (WMS-25) | `waves.ts`, `wave-states.ts`, `wave-settle.ts`, `pick-route.ts` | `createWave` (libera los borradores; todo o nada), `cancelWave` (solo desagrupa), `listWaves`, `listWaveCandidates`, `listOpenWaves`, `getWave` (lo que sigue, recorrido agrupado por producto + origen + lote, zonas, pedidos), `confirmWavePick`, `deliverWavePicks`, `takeWaveTasks`, `assignWaveTasks`, `waveOfOrder`, `wavesEnabled`; transiciones `PICK_WAVE_TRANSITIONS`; orden de recorrido `inRouteOrder`/`compareRoute` (puro); en `tasks.ts`, `confirmPickGroup`, `deliverPickGroup`, `takeTasks`, `assignTasks` y `nextTaskFor` («Siguiente tarea»); «Mis tareas» va en orden de recorrido |
| Despacho y embarques | `shipments.ts`, `shipment-states.ts`, `shipment-ready.ts`, `shipment-pdf.ts` | `createShipment` (borrador con pedidos listos y datos del transporte), `updateShipment`, `addShipmentOrders`, `removeShipmentOrder`, `cancelShipment`, `dispatchShipment` (confirmar salida); lecturas `listShipments`, `getShipment`, `listReadyOrders`, `countOrdersToArm` (los pedidos que aún caben en un embarque nuevo: la misma condición que `listReadyOrders`, es el número de «Embarques»), `countOrdersToShip` (lo que no ha salido, aunque ya esté en un embarque por confirmar; lo usa Inicio), `shipmentOfOrder`, `shipmentDetailsRequired`; `buildShipmentPdf` (hoja de embarque, sin precios); `SHIPMENT_PROCESS` y `SHIPMENT_DISPATCHED_OPERATION` (documento del motor de procesos, WMS-74B); transiciones `SHIPMENT_TRANSITIONS`; `TO_SHIP` y `shippedOn` en `listOutboundOrders`; `shippedOnWhere` (resumen del día) |
| Traslados entre almacenes | `facility-transfers.ts`, `facility-transfer-states.ts`, `facility-transfer-pdf.ts` | `createFacilityTransfer`, `addFacilityTransferLine`, `removeFacilityTransferLine`, `cancelFacilityTransfer` (borrador), `sendFacilityTransfer`, `receiveFacilityTransfer` (bien y dañado, en varias veces), `resolveFacilityTransfer` (`LOST`/`RETURNED`), `listFacilityTransfers` (`sent`, `incoming`, `received`), `getFacilityTransfer`, `countTransfersToReceive`, `listTransferDestinations`, `listTransferReceivePlaces`, `hasSeveralFacilities`, `findFacilityTransferByKey`, `findFacilityTransferByNumber`; `buildFacilityTransferPdf` (hoja de traslado, sin costos); transiciones `FACILITY_TRANSFER_TRANSITIONS` |
| Devoluciones de clientes | `customer-returns.ts`, `customer-return-states.ts`, `return-holds.ts` | `receiveCustomerReturn` (entra en inspección), `decideCustomerReturn` (disponible, dañado o rechazado), `findReturnableOrders` (`PS-…` o `EM-…`), `getReturnableOrder` (lo que salió y lo que puede regresar), `listReturnPlaces`, `returnsWithoutOrderAllowed`, `listCustomerReturns`, `getCustomerReturn`, `countReturnsToReview`, `returnsOfOrder`, `findCustomerReturnByKey`; `heldForReturns` (lo retenido en inspección); transiciones `CUSTOMER_RETURN_TRANSITIONS`. El núcleo del cambio de estado, `writeStatusChange` (`status-change.ts`), lo comparten «Cambiar estado» y las decisiones |
| Verificación y empaque | `packing.ts` | `startPacking` (PICKED → PACKING), `packScan` (un escaneo al bulto abierto: serie, clave o código de barras, o lote), `unpackFromPackage`, `sealPackage` (tipo y peso), `reopenPackage`, `reportPackShortage` (faltante con motivo), `finishPacking` (→ PACKED); lecturas `getPackingView`, `countOrdersToPack`, `packingEnabled`; `TO_PACK` en `listOutboundOrders` |
| Incidencias (WMS-39) | `incidents.ts`, `incident-states.ts` | `reportIncident` (del almacén activo; ubicación y producto escaneados; tarea o pedido opcionales; clave de confirmación), `startIncident` («Atender»), `resolveIncident` (qué se hizo), `dismissIncident` (motivo), `addIncidentNote`, `listIncidents` (`open`, `closed`, `mine`), `getIncident`, `countOpenIncidents` (Inicio, para quien atiende); transiciones `INCIDENT_TRANSITIONS`, tipos `INCIDENT_KINDS`, número `INC-0001`. No tocan existencias. Fotos (WMS-37, ADR 0063): `uploadIncidentPhoto` (propósito `incident_photo`), `discardIncidentPhoto` («Quitar» una foto propia sin ligar), `photoIds` en `reportIncident` y `addIncidentNote` (una nota puede ser solo fotos), `photos` en `getIncident`, `reachesIncident` (dueño de las fotos para `evidenceOwners`), `incidentPhotoRequired` |
| Equipos (WMS-42) | `equipment.ts`, `equipment-rules.ts` | Tipos (`listEquipmentTypes`, `saveEquipmentType`, `setEquipmentTypeArchived` y `mayEditEquipmentTypes`: solo quien ve toda la empresa los escribe), registro (`createEquipment`, `updateEquipment`), estado (`setEquipmentOutOfService`, `returnEquipmentToService`, `retireEquipment`), `recordMaintenance` (con clave de confirmación; solo el registro más reciente cambia el próximo mantenimiento); dar de baja o cambiar de tipo el último equipo de un tipo pedido por tareas pendientes responde `pending_tasks` hasta `acceptPendingTasks`; lecturas (`listEquipment`: en uso, piden atención, dados de baja; `getEquipment`: mantenimientos, incidencias y últimas tareas), `countEquipmentAttention` (Inicio), `equipmentTypesForTasks` y `hasEquipmentHere` (para mostrar los campos solo si hay equipos), `runEquipmentMaintenanceRound` (ronda). En `tasks.ts`: `acceptTask` con `equipmentCode`, `changeTaskEquipment`, `taskEquipmentChoices`; `pickUpTask` y `confirmPick` rechazan con el equipo fuera de servicio. En `incidents.ts`: `equipment` escaneado; «Equipo descompuesto» lo deja fuera de servicio según `inventory.equipment.on_broken_report`. Candados: tarea → equipo; lo que cambia un equipo bloquea solo el equipo y lee sus tareas sin bloquearlas (ADR 0065) |
| Avisos (WMS-39) | `notices.ts` | `INVENTORY_NOTIFICATION_TYPES`: los tipos que este módulo manda con `notify` (ver «Avisos») y `DAILY_DIGEST_NOTICE` (solo por correo) |
| Resumen diario por correo (WMS-39B) | `daily-digest.ts` | `runDailyDigestRound` (ronda), `sendDailyDigest` y `dailyDigestJobHandlers` (worker), `digestSections` (lee con `listExpiringLots` por almacén alcanzado y `listLowStock`, como la persona; `DIGEST_LINES` por sección; WMS-88: «Existencias bajas» se lee una vez por empresa cada 10 minutos en memoria del proceso y a cada persona se le revisa antes permiso y `seesWholeCompany`), `digestGoesOn` (días del ajuste `inventory.digest.days`), `purgeEndedDigests` (lo llama la ronda de limpieza de avisos, para toda empresa) |
| Etiquetas | `labels.ts` | `buildLabels` (PDF de etiquetas de ubicaciones, producto, lotes, series, tarima o bulto, bultos de un pedido, pedido, embarque y equipo (WMS-42), con Code 128 y QR; lee con los servicios de cada ficha y su alcance; tope `LABELS_MAX` y `LABEL_COPIES_MAX`), `previewLocationLabels` (cuántas salen y cuáles no tienen código), `productLabelOptions`, `labelDefaults`; `LABEL_KINDS` (WMS-26) |
| Importar pedidos | `outbound-import.ts` | `startOutboundImport` → `reviewOutboundImport` → `confirmOutboundImport` / `cancelOutboundImport` |
| Importar productos y existencias | `imports.ts`, `import-validation.ts`, `import-classification.ts`, `import-confirmation.ts`, `import-apply.ts`, `import-release.ts`, `import-template.ts` | subir, mapear columnas, validar, clasificar, confirmar (aparta cupo), aplicar en el worker, cancelar o liberar; los campos personalizados de productos (WMS-58) se reconocen por título (`customImportColumns`), se revisan con las reglas del formulario y se aplican con `prepareCustomValues`/`writeCustomValues`; la plantilla trae sus columnas |
| Importar salidas | `exit-import.ts`, `exit-import-apply.ts` | `startExitImport` → `reviewExitImport` → `confirmExitImport` → `applyExitImport` (worker); `getExitCoverage` |
| Exportaciones | `exports.ts` | `buildExport` y `EXPORT_KINDS`; el catálogo agrega una columna por campo personalizado en uso (WMS-58) |
| Sugerencias de reubicación (WMS-65) | `slotting.ts`, `slotting-rules.ts` | `listSlottingSuggestions` (derivadas en cada consulta, almacén activo y alcance; tres tipos: acercar a surtido, sacar de surtido, juntar; tope `SLOTTING_SCAN_MAX`) y `acceptSlottingSuggestion` (vuelve a decidir la sugerencia y crea la tarea de traslado con `createTaskGuarded`, el núcleo de `createTask` con una guarda bajo sus candados) |
| Indicadores (WMS-32) | `indicators.ts`, `indicator-rules.ts`, `zones.ts` | `getWarehouseIndicators` (periodo del calendario de la empresa, almacén, producto y persona; topes `KPI_TOP_PRODUCTS`, `KPI_ORDERS_MAX`, `KPI_TASK_ROWS_MAX`, `KPI_COST_GROUPS_MAX`, `KPI_MAX_DAYS`); reglas puras `resolvePeriod`, `rotationOf`, `daysOfInventory`, `timeFigures`, `durationText`; `zonesOf` (zona de cada ubicación, compartida con las olas); `accuracyFigures` de `count-accuracy.ts` (exactitud de cualquier periodo, la usan Exactitud e Indicadores) |
| Inicio y resúmenes | `first-steps.ts`, `setup-rules.ts`, `day-summary.ts`, `unplaced.ts` | `getFirstSteps` (avance de la configuración inicial derivado de lo que existe; almacén y ubicaciones dentro del alcance; la pantalla pasa `seesTeam`, `changesSettings` y, en Inicio, `whileSettingUp`; WMS-43, ADR 0083), `planSetupSteps`/`setupAbilities`/`offeredSteps`/`doneSteps` (puras: qué pasos se ofrecen y cuál sigue; un paso no hecho antes del último hecho cuenta como saltado), `waitsForCatalog`, `SETUP_SETTINGS` (ajustes que pregunta la guía), `getDaySummary`, `listUnplacedStock` (dice qué fila ya tiene tarea de acomodo), `countUnplacedStock` |
| Reconciliación | `reconciliation.ts` | `reconcileStock`, `reconcileValue`, `reconcileCompany` |
| Ajustes y trabajos | `settings.ts`, `import-apply.ts`, `exit-import-apply.ts` | `INVENTORY_SETTINGS` y cada ajuste; `inventoryJobHandlers`, `exitImportJobHandlers` |
| Búsqueda global | `search.ts` | `INVENTORY_SEARCH_SOURCES` (WMS-66, ADR 0081): productos, ubicaciones del almacén activo y tarimas con una consulta propia que repite las condiciones de su lista (una revisión de permisos por búsqueda, alcance leído una vez con `reachOf`), lotes y series exactos (`findLotsByCode`/`findSerialsBySerial` de `traceability.ts`, compartidos con el rastreo) y por número pedidos, embarques, devoluciones, traslados, tareas e incidencias (confirmados con el getter de su ficha) |

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
- Indicadores (WMS-32): `kpi.read` (titular, Administración, Supervisor de
  almacén y Gerencia) y `worker_performance.read` (los mismos; rendimiento
  por persona, no se conserva en una sesión de PIN). El valor, solo con
  `cost.read`; la exactitud, solo con `count_accuracy.read`.
- Sugerencias de reubicación (WMS-65): `slotting.read` (titular,
  Administración, Almacén, Supervisor de almacén, Consulta y Gerencia);
  convertir una en tarea pide además `task.create`.
- Movimientos: `entry.create`, `opening.create`, `exit.create`,
  `transfer.create`, `adjustment.create`, `movement.reverse`.
- Estados: `status.change`, `status.release`, `damage.report`.
- Desechar (WMS-30-0): `disposal.create` (titular, Administrador, Almacén y
  Supervisor de almacén).
- Conteos: `count.read|create|update|apply`; programas de conteo cíclico
  `count_program.read|manage` y exactitud `count_accuracy.read` (WMS-55; el
  valor de las diferencias, solo con `cost.read`).
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
- Traslados entre almacenes: `facility_transfer.read|create|send|receive|resolve|export`
  (WMS-19: ver, armar y cancelar el borrador, enviar, recibir y resolver lo
  que no llegó; WMS-19B: PDF).
- Incidencias (WMS-39): `incident.read|create|manage` (ver las del almacén,
  reportar y comentar, atender y cerrar).
- Equipos (WMS-42): `equipment.read|manage` (ver; registrar, cambiar, dejar
  fuera de servicio, dar de baja, tipos y mantenimientos). Elegir equipo al
  tomar una tarea va con `task.execute` y reportar una falla con
  `incident.create`.
- Archivos: `import.create|read|confirm|cancel`, `export.create`.
- Etiquetas (WMS-26): sin permiso propio; imprimir pide la lectura de lo que
  se etiqueta (`location.read`, `product.read`, `stock.read`,
  `outbound.read`, `shipment.read`, `equipment.read`, y `purchasing.receipt.read` para las
  series de una recepción).

Los de productos, presentaciones y ubicaciones los comprueban los servicios de
[catalog](catalog.md) y [locations](locations.md), pero son de este módulo
(prefijo `inventory.`).

## Tablas

`stock_movement`, `stock_movement_line`, `stock_balance`, `lot`,
`serial_unit`, `serial_move`, `warehouse_task_serial`, `container`,
`container_item`, `container_event`,
`product_cost`, `stock_minimum`, `stock_count`, `stock_count_line`,
`stock_count_capture`, `count_program`, `warehouse_task`, `replenishment_rule`,
`stock_reservation`, `stock_hold`, `stock_hold_unit` (WMS-30-0),
`outbound_order`, `outbound_order_line`, `outbound_pack_shortage`,
`pick_wave`, `pick_wave_order`,
`shipment`, `shipment_order`, `shipment_line`, `customer_return`,
`customer_return_line`, `customer_return_decision`, `facility_transfer`,
`facility_transfer_line`, `facility_transfer_receipt`,
`facility_transfer_receipt_line`,
`incident`, `incident_note` (sus fotos en `evidence_photo` de plataforma, como las de `warehouse_task`, WMS-37B),
`equipment_type`, `equipment`, `equipment_maintenance`,
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
| `inventory.repair.release` | **`direct`**, `inspection` (lo restaurado vuelve directo a disponible o pasa antes por inspección, WMS-75) |
| `inventory.incident.photo` | **`optional`**, `required` (foto al reportar una incidencia, WMS-37) |
| `inventory.task.photo` | `off`, **`optional`**, `required` (foto de dónde quedó al entregar una tarea, todos los tipos; con `required` las olas se entregan tarea por tarea; WMS-37B) |
| `inventory.labels.format` | **`letter_10`** (hoja carta, 10 por hoja), `100x50`, `100x150` (mm; WMS-26) |
| `inventory.labels.codes` | **`both`** (barras y QR), `barcode`, `qr` (WMS-26) |
| `inventory.replenishment.mode` | **`off`** (solo con «Reponer ahora»), `round` (la ronda del worker, cada hora; WMS-24) |
| `inventory.abc.basis` | **`lines`** (veces que salió), `value` (cantidad que salió × costo promedio de hoy) (WMS-55) |
| `inventory.abc.cuts` | **`80_15_5`**, `70_20_10`, `50_30_20` (reparto A/B/C) |
| `inventory.abc.period` | `30`, **`90`**, `180`, `365` (días de salidas que mira la clasificación) |
| `inventory.count.review_threshold` | **`off`**, `any`, `10`, `25`, `50` (% de diferencia de un producto que pide revisar el conteo antes de aplicarlo) |
| `inventory.crossdock.mode` | **`off`**, `on` (lo que llega para un pedido que espera va directo a preparación; WMS-54) |
| `inventory.picking.mode` | **`orders`** (pedido por pedido), `waves` (por olas; WMS-25) |
| `inventory.adjustment.approval_threshold` | **`any`**, `10`, `25`, `50` (% de lo que hay en la ubicación que, con la regla de `inventory.adjustment` encendida, hace esperar una corrección; WMS-41) |
| `inventory.digest.hour` | `6`, **`7`**, `8`, `9`, `12`, `17` (hora del calendario de la empresa a la que sale el resumen diario por correo; WMS-39B) |
| `inventory.kpi.idle_days` | `30`, `60`, **`90`**, `180` (días sin ningún movimiento para que un producto con existencias cuente como «sin movimiento» en los indicadores; WMS-32) |
| `inventory.slotting.fast_classes` | **`a`**, `ab` (qué clases ABC se sugiere acercar a surtido; WMS-65) |
| `inventory.slotting.consolidate` | **`on`**, `off` (sugerir juntar el mismo lote repartido en almacenaje; WMS-65) |
| `inventory.slotting.limit` | `10`, **`20`**, `50` (cuántas sugerencias de reubicación a la vez; WMS-65) |
| `inventory.digest.days` | **`all`**, `weekdays`, `monday_saturday` (días de la semana en que sale el resumen diario, en el calendario de la empresa; WMS-88) |

| `inventory.equipment.maintenance_notice` | `3`, **`7`**, `15`, `30` (días antes del mantenimiento de un equipo en que pide atención; WMS-42) |
| `inventory.equipment.on_broken_report` | **`stop`** (queda fuera de servicio), `notify` (solo se avisa) (WMS-42) |

`inventory.count.review_threshold` e `inventory.adjustment.approval_threshold` se muestran en Configuración › Reglas de aprobación, junto a la
regla de su tipo, y no en Operación. Los de equipos (`EQUIPMENT_SETTINGS`), en
Configuración › Equipos del almacén.

## Aprobaciones

Tipos declarados en `approvals.ts` (`INVENTORY_APPROVAL_TYPES`), registrados en
`src/modules/registry/approvals.ts` (ADR 0053):

| Tipo | Cuándo pide | Quien autoriza necesita | Al autorizar |
| --- | --- | --- | --- |
| `inventory.adjustment` («Corregir existencias») | `registerAdjustment` con la regla encendida y la diferencia sobre `inventory.adjustment.approval_threshold` | `inventory.adjustment.create` | `applyApprovedAdjustment`: el mismo ajuste, a nombre de quien lo pidió, solo si nada se movió de ese producto en esa ubicación desde que se pidió (si no, vence) |
| `inventory.count_apply` («Aplicar conteos con diferencias grandes») | `applyCount` con la regla encendida y líneas sobre `inventory.count.review_threshold` (el conteo queda congelado mientras espera) | `inventory.count.apply` e `inventory.adjustment.create` | `applyApprovedCount`: el mismo `applyCount`, a nombre de quien lo pidió, si lo capturado no cambió |
| `inventory.disposal` («Desechar mercancía», WMS-83, ADR 0078) | `disposeStock` con la regla encendida, siempre (sin umbral: así se cierra el rodeo disponible → dañado → desechar); `postDisposal` no pide | `inventory.disposal.create` | `applyApprovedDisposal`: el mismo desecho, a nombre de quien lo pidió (bitácora con `autorizadoPor`), solo si nada se movió de ese producto, ubicación, estado y lote desde que se pidió y quien pidió sigue activo y en alcance (si no, vence); no retiene mientras espera |

## Avisos

Tipos en `notices.ts` (`INVENTORY_NOTIFICATION_TYPES`), registrados en
`src/modules/registry/notifications.ts`; cada servicio llama `notify` de
`@/platform/notifications` en su transacción (WMS-39, ADR 0057):

| Tipo | Quién lo manda | A quién |
| --- | --- | --- |
| `inventory.task_assigned` | `createTask` con persona, `assignTask`, `assignTasks` (uno por grupo) | a quien se le asigna |
| `inventory.task_blocked` | `blockTask` | `inventory.task.create` que alcance el origen de la tarea |
| `inventory.customer_return` | `receiveCustomerReturn` | `inventory.status.release` o `inventory.status.change` en su ubicación |
| `inventory.transfer_incoming` | `sendFacilityTransfer` | `inventory.facility_transfer.receive` del almacén de destino |
| `inventory.transfer_differences` | `receiveFacilityTransfer` (con algo dañado), `resolveFacilityTransfer` (`LOST`) | quien lo envió |
| `inventory.incident_reported` | `reportIncident` | `inventory.incident.manage` que alcance su ubicación o su almacén |
| `inventory.incident_changed` | atender, resolver, descartar, nota | quien la reportó |
| `inventory.equipment_maintenance` | la ronda `inventory.equipment_maintenance` | `inventory.equipment.manage` del almacén del equipo (una vez al entrar en la ventana y otra al pasarse) |
| `inventory.equipment_out_of_service` | fuera de servicio a mano o por una incidencia «Equipo descompuesto» | quien tiene el equipo en una tarea abierta |

Cualquiera de estos puede salir también por correo a quien lo pidió (WMS-39B,
ADR 0060): lo decide `notify`, el módulo no hace nada más.

`inventory.daily_digest` (solo por correo, apagado por omisión; se ofrece a
quien tiene `inventory.stock.read` o `inventory.minimum.read`): la ronda
`inventory.daily_digest` aparta, cuando en la empresa ya es la hora de
`inventory.digest.hour`, un resumen por persona y día (`daily_digest`, única
por persona y día) y encola `inventory.send_daily_digest`; el trabajo lee
como esa persona con `listExpiringLots` (un bloque por almacén que alcanza;
acepta `facilityId`) y `listLowStock` (solo para quien no tiene límite), y
no manda nada si no hay qué decir. Nunca costos.

## Eventos de webhooks

Tipos en `webhooks.ts` (`INVENTORY_WEBHOOK_EVENTS`), registrados en
`src/modules/registry/webhooks.ts`; cada servicio llama `emitWebhookEvent`
de `@/platform/api` en su transacción, después de sus escrituras (WMS-60,
ADR 0058). El cuerpo lleva ids y cantidades como texto, nunca costos.

| Evento | Quién lo emite |
| --- | --- |
| `inventory.shipment.dispatched` | `dispatchShipment` (pedidos y lo que salió de cada uno) |
| `inventory.adjustment.applied` | el núcleo del ajuste (`registerAdjustment` y el efecto de la autorización) y `applyCount` (un evento por conteo) |
| `inventory.stock_status.changed` | `writeStatusChange` (`changeStockStatus` y las decisiones de devoluciones de clientes) |

`createOutboundDraft` (`outbound-orders.ts`) crea un pedido en borrador con
sus líneas en una transacción, idempotente por su columna propia `apiRequestKey` (nunca el `sourceKey` de la importación): lo usa
`POST /api/v1/outbound-orders`. `MovementSummary`, `ShipmentLineView`
agregan los datos exactos (producto, cantidad base, unidad, estado) que la
API necesita.

## Trabajos en segundo plano

| Tipo | Manejador | Qué hace |
| --- | --- | --- |
| `inventory.import_products` | `inventoryJobHandlers` (`import-apply.ts`) | Aplica una importación confirmada por lotes; `onFailed` devuelve el cupo apartado |
| `inventory.import_exits` | `exitImportJobHandlers` (`exit-import-apply.ts`) | Registra las salidas de un archivo confirmado; el folio evita descontar dos veces |
| `inventory.send_daily_digest` | `dailyDigestJobHandlers` (`daily-digest.ts`) | Manda el resumen diario de una persona si hay algo que decir; vuelve a comprobar membresía, correo confirmado, preferencia, canal y plan; `onFailed` lo deja `FAILED` |

Rondas (`scheduledRounds` de `src/modules/registry/rounds.ts`, cada hora):

| Ronda | Función | Qué hace |
| --- | --- | --- |
| `inventory.replenishment` | `runReplenishmentRound` (`replenishment.ts`) | Con `inventory.replenishment.mode = round` y el módulo con escritura, crea en cada almacén activo las tareas de reposición que hacen falta, como el titular; repetirla o correrla dos veces a la vez no duplica (ADR 0051) |
| `inventory.cycle_counts` | `runCycleCountRound` (`cycle-counts.ts`) | Genera los conteos de hoy de cada programa activo; repetirla no duplica (programa bloqueado, cupo del día contado bajo el candado y llave única programa + día + ubicación). |
| `inventory.equipment_maintenance` | `runEquipmentMaintenanceRound` (`equipment.ts`) | Avisa del mantenimiento por vencer o vencido de cada equipo no dado de baja; repetirla no duplica (llave por equipo, día y fase) |
| `inventory.daily_digest` | `runDailyDigestRound` (`daily-digest.ts`) | A partir de la hora de la empresa, aparta el resumen de hoy de quien lo pidió y encola su envío; repetirla o correrla dos veces a la vez no duplica (llave única persona + día). Borra los resúmenes terminados de más de 90 días. |

**Almacén archivado (WMS-82, ADR 0077).** Un almacén archivado tiene todas
sus ubicaciones archivadas, así que toda operación que mete existencias lo
rechaza con la revisión de siempre («… está archivada»), después de bloquear
la ubicación. La entrada manual y el saldo inicial resuelven y bloquean
«General» antes de leerla (`generalLocationIdOf`). Pedidos de salida (pantalla,
API e importación), embarques, programas de conteo, incidencias y equipos
toman su almacén compartido con `holdOpenFacility` antes de nacer, y la
devolución de cliente lo toma después de sus productos y antes de su
ubicación; la ola (nace de pedidos abiertos) y lo que nace bloqueando una
ubicación del almacén (tareas, conteos, contenedores) no lo necesitan.

## ADR

0012 (movimientos y saldos), 0013 (cola), 0014 (archivos), 0015 (importación de
salidas), 0031 (costo promedio), 0032 (sin Ventas), 0033 (estado y lote del
saldo), 0034 (ajustes), 0035 (varios almacenes), 0038 (alcance), 0039
(capacidad), 0040 (lotes y caducidad), 0041 (números de serie y
trazabilidad), 0042 (acomodo con recomendación), 0043 (tarimas y
contenedores), 0044 (verificación y empaque), 0045 (despacho y embarques),
0046 (devoluciones de clientes), 0047 (etiquetas e impresión), 0048 (traslados
entre almacenes), 0050 (conteos cíclicos), 0051 (reposición de surtido), 0052
(cross-docking y daños al recibir), 0053 (ajustes y conteos con autorización),
0054 (surtido por olas), 0057 (avisos e incidencias), 0060 (avisos por correo y resumen diario), 0065 (equipos del almacén), 0068
(inspección al recibir, desechar y retención genérica), 0071 (procesos en
embarques), 0072 (estado «En restauración»), 0076 (foto al entregar una tarea), 0078
(desechar con autorización), 0082 (indicadores de almacén), 0086 (sugerencias de reubicación).

## Pruebas

`tests/inventory/*.int.test.ts` (terminan con `reconcileStock` vacío) y las
unitarias junto al código (`*-states.test.ts`, `average-cost.test.ts`,
`lot-rules.test.ts`, `entry-repeat.test.ts`, `putaway-rules.test.ts`,
`replenishment-rules.test.ts`). Reposición de surtido en
`replenishment.int.test.ts`.
Fotos al entregar una tarea en `task-photos.int.test.ts`. Indicadores de
almacén (cada indicador contra un escenario calculado a mano, alcance, roles,
costos y calendario de la empresa) en `indicators.int.test.ts` e
`indicator-rules.test.ts`. Sugerencias de reubicación en
`slotting.int.test.ts` y `slotting-rules.test.ts`. Acomodo en `putaway.int.test.ts`; etiquetas en `labels.int.test.ts` (leen de
vuelta los códigos dibujados con `tests/setup/pdf.ts`); empaque en `packing.int.test.ts`; despacho en `shipments.int.test.ts`; procesos en embarques en `shipment-process.int.test.ts`; devoluciones de clientes (PC-5) en
`customer-returns.int.test.ts`; traslados entre almacenes en
`facility-transfers.int.test.ts`; equipos en `equipment.int.test.ts`;
inspección al recibir, desechar, PC-5 y retención genérica en
`inspection-on-receipt.int.test.ts` y el desecho con autorización en
`disposal-approval.int.test.ts` (`reconcileStock` agrega `source:
"holds"`: lo retenido nunca pasa del saldo); el estado «En restauración»
(PC-5, permisos, ajuste, ubicación, lotes, series, retención) en
`repair.int.test.ts`. Casos de alcance en
`tests/inventory/scope.int.test.ts`, de capacidad en `capacity.int.test.ts` y de
lotes en `lots.int.test.ts`; de series en `serials.int.test.ts` y de
trazabilidad en `traceability.int.test.ts`. `reconcileStock` también compara
cada saldo de un producto por serie con sus unidades dentro (`source:
"serial_units"` y `"serial_moves"`), y lo que dicen los contenedores contra el
saldo, su ubicación y sus series (`source: "containers"`). Tarimas en
`containers.int.test.ts`. Olas, recorrido, juntar por estante y zonas en
`waves.int.test.ts` (y `pick-route.test.ts`, `stock-sources.test.ts`). Conteos cíclicos (ronda repetida y simultánea,
vuelta completa, ABC, exactitud, revisión) en `cycle-counts.int.test.ts`.
