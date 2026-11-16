# ADR 0072 — Estado «En restauración»

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-75 (propuesta
`docs/flujos/PRODUCCION_CALIDAD.md`, P6, R1 a R3, secciones 5.7, 5.10 y 10)
· Completa ADR 0033 (estado del saldo), ADR 0039 (usos de ubicación y
capacidad), ADR 0046 (devoluciones de clientes) y ADR 0068 (retención,
desechar, devolver lo rechazado) · Lo usarán WMS-30B (decisión de Calidad
«A restauración») y WMS-29B (orden de reproceso)

## Contexto

Hay empresas que restauran lo que regresa o llega mal: reparan,
reacondicionan, limpian o reempacan (P6). Hoy esas existencias solo pueden
quedar como «Dañado», «Rechazado» o «Bloqueado», que dicen otra cosa. El
fundador decidió (R1, «si, ambas») un estado nuevo, fijo y genérico para
todas las empresas, y aparte, con Producción, una orden de reproceso
(WMS-29B). Lo restaurado vuelve directo al inventario o pasa antes por
inspección según un ajuste de la empresa (R2) y el Almacenista de piso no
manda a restauración (R3).

Lo que ya existe y se reutiliza sin cambiarlo: el estado es parte de la
llave del saldo (ADR 0033), así que agregar un valor no cambia la llave;
`changeStockStatus` y su núcleo `writeStatusChange` (WMS-11, con cambio de
lugar de WMS-22B); `permissionForStatusChange`; `decideCustomerReturn`
(WMS-17); `heldStock`/`holdStock` (ADR 0068); el patrón de lista derivada de
«Por inspeccionar» (`inspection.ts`); `checkPlacement` y el uso
«Cuarentena» (ADR 0039).

## Decisión

### 1. Un valor más de `StockStatus`: `REPAIR`, «En restauración»

- Es un estado **no disponible**: «hay» lo cuenta (desglose por estado,
  archivar producto o ubicación, valor del inventario, exportaciones) y
  «disponible» no (**PC-5**). Ninguna lectura que alimenta una operación lo
  toma, porque todas filtran `AVAILABLE` (`availableOfLot`,
  `AVAILABLE_ANY_LOT`); no hace falta tocar salidas, surtido, reservas,
  reposición, mínimos, sugerencias, cross-docking ni traslados.
- Migración solo de expansión (`20261117060000_wms75_repair_status`): el
  valor se agrega al ENUM de cada columna que lo usa (`stock_balance`,
  `stock_movement_line`, `purchase_receipt_line`, `serial_unit`,
  `serial_move`, `stock_hold`, `container_item`, `customer_return_decision`,
  `facility_transfer_receipt_line`). Lo que ya existe no cambia: ninguna fila
  tiene el valor nuevo. Los `CHECK` y disparadores que nombran estados se
  revisaron uno por uno (tabla del punto 6); solo se amplían dos: la
  retención (`stock_hold_status`) y la decisión de una devolución
  (`customer_return_decision_outcome`). Los demás siguen rechazando
  `REPAIR` donde no corresponde: una recepción de compra (solo disponible,
  dañado o inspección), lo que entra con una devolución de cliente (solo
  inspección), una recepción de traslado (disponible o dañado) y la
  ubicación de tránsito (solo `IN_TRANSIT`).

### 2. Cómo entra y cómo sale

Cada paso es un `STATUS_CHANGE` escrito por `writeStatusChange` (con cambio
de lugar opcional en el mismo almacén). No hay movimiento nuevo.

| De → a | Permiso | Quién (matriz) |
| --- | --- | --- |
| cualquier estado manual → En restauración | `inventory.status.change` | titular, Administrador, Almacén, Supervisor de almacén |
| En restauración → Disponible | `inventory.status.release` | los mismos |
| En restauración → inspección, dañado, rechazado, cuarentena, bloqueado | `inventory.status.change` | los mismos |
| Devolución de cliente → «A restauración» | `inventory.status.change` (y `inventory.transfer.create` si cambia de lugar) | los mismos |

- **R3, el piso no manda a restauración:** el Almacenista (`operator`) solo
  tiene `inventory.damage.report`, que sirve únicamente para disponible →
  dañado (`permissionForStatusChange`). No hace falta un permiso nuevo ni
  tocar la matriz: el caso negativo queda en las pruebas.
- `MANUAL_STOCK_STATUSES` agrega `REPAIR`, así que «Cambiar estado» lo
  ofrece como origen y como destino a quien tiene el permiso.
- Pasar a restauración pide motivo, como todo cambio de estado; liberar
  también (el formulario ya lo exige; «Restaurado» es un motivo válido).

### 3. Ajuste `inventory.repair.release` (R2)

- `direct` (por omisión, propuesta de la sección 10 que el fundador no
  corrigió): lo restaurado puede pasar directo a disponible.
- `inspection`: lo que está en restauración **no pasa directo a
  disponible**. Solo sale hacia «En inspección», o hacia «Dañado» o
  «Rechazado» si no se pudo restaurar (para desecharlo o devolverlo):
  `REPAIR_EXITS_THROUGH_INSPECTION` de `repair-release.ts`. Disponible,
  cuarentena y bloqueado se rechazan, porque pasar por cuarentena o
  bloqueado sería una forma de saltarse la inspección (revisión
  independiente, hallazgo medio 1). Desde inspección lo libera quien tiene
  `inventory.status.release` (y, con WMS-30B, el inspector).
- Lo que se mandó a dañado o rechazado se libera después con el permiso de
  siempre (`inventory.status.release`): las piezas del mismo producto,
  lote, ubicación y estado son intercambiables y el sistema no guarda de
  dónde vino cada una, así que no se intenta saber si esa pieza estuvo en
  restauración (no se aproxima con el historial).
- «Cambiar estado» arma en el servidor los estados que ofrece cuando el
  origen está en restauración con `repairExitsOf` (la misma regla pura,
  `breaksRepairRule`, que usa el servicio), así la pantalla no ofrece lo
  que se rechazaría; el servicio lo decide otra vez bajo sus candados.
- Se lee con `readSetting` **dentro de `writeStatusChange`**, después de los
  candados, así vale para «Cambiar estado» y para cualquier llamador futuro
  (WMS-30B, WMS-29B).
- La reversa de un cambio disponible → restauración devolvería a disponible
  lo que está en restauración: con `inspection` se rechaza con el mismo
  mensaje (las piezas son intercambiables, el sistema no sabe si son las
  mismas). Con `direct` se permite, como cualquier reversa de un cambio de
  estado.

### 4. Ubicación de restauración (uso nuevo, opcional)

- Un valor más de `LocationType`: `REPAIR`, «Restauración». Se elige al
  crear o editar una ubicación, como «Cuarentena».
- Igual que la cuarentena, **no admite existencias disponibles**
  (`checkPlacement`): ni siquiera un cambio de estado hecho ahí. Así lo que
  está en una zona de restauración no se libera sin moverlo a otro lugar
  («Para liberarlas, elige también dónde quedan»).
- No es lugar de almacenaje para acomodo (`STORE_PLACE` sigue siendo
  almacenamiento y surtido) ni de paso (`WAITING_PLACE`), ni origen de
  reposición.
- **Cambiar el uso** de una ubicación a «Cuarentena» o «Restauración»
  (`editLocation`) se rechaza mientras ella o algo dentro de ella tenga
  existencias disponibles («Aquí hay existencias disponibles de N
  productos… Cámbialas de estado o muévelas antes»). Antes de este paso la
  cuarentena tenía el mismo hueco: la regla solo detenía lo que llegaba
  después, y lo disponible que ya estaba ahí se seguía sacando y surtiendo
  (revisión independiente, hallazgo medio 2). Se bloquean primero las filas
  de toda la rama (un movimiento hacia cualquiera de ellas bloquea la suya,
  así nada llega mientras se decide) y se cuenta con `groupBy`, sin cargar
  saldos. Quien edita una ubicación la alcanza, y el alcance es por zona,
  así que alcanza todo lo que contiene: el conteo nunca nombra algo de
  fuera de su alcance.
- **Mover** una ubicación (`moveLocation`) dentro de otra que es, o está
  dentro de, una de cuarentena o restauración pasa por la misma revisión de
  toda la rama que se mueve (segunda revisión, hallazgo medio B). Las demás
  puertas no hacen falta: una ubicación nueva nace vacía, una archivada no
  tenía existencias (archivar lo exige) y al reactivarse sigue vacía, y los
  límites (`setLocationLimits`) y los niveles no cambian el uso.
- **Interbloqueo investigado (segunda revisión, hallazgo medio A).** La
  primera versión bloqueaba toda la rama con un solo `lockRows`. Con un id,
  MySQL resuelve `organizationId = ? AND id IN (?)` por la llave primaria;
  con varios, recorre el índice único `(organizationId, id)` y bloquea
  primero su entrada y después la llave primaria. Una entrada o un cambio de
  estado hacia un estante de la rama bloquea la llave primaria de esa fila
  (`lockRows` con una fila) y, al insertar su línea de movimiento, pide un
  candado compartido en el mismo índice único por la llave foránea
  compuesta: orden contrario, interbloqueo en 9 a 11 de cada 12 corridas
  (`SHOW ENGINE INNODB STATUS`), con la edición como víctima y un error 500.
  **Salida elegida: quitar la causa.** `refuseAvailableInside` bloquea las
  filas una por una, en orden de id, así cada candado se toma como el de un
  movimiento (llave primaria primero). No se cambió `lockRows` para el resto
  del sistema ni se agregó un reintento. La prueba con `Promise.all`
  (`location-limits.int.test.ts`: editar el uso de una zona contra una
  entrada y contra un cambio de estado a disponible en un estante suyo, y
  mover un pasillo bajo una cuarentena contra una entrada) falla con la
  versión anterior por el error 1213 y pasa con esta en cuatro corridas
  seguidas: siempre pasa exactamente uno de los dos y nunca queda
  disponible dentro.
- **Pendiente:** la revisión limita la profundidad pero no el número de
  filas; una zona con miles de ubicaciones toma miles de candados (uno por
  consulta). Es aceptable para algo que se hace rara vez; no se puso un
  tope arbitrario.

### 5. Lista derivada «En restauración»

- `listInRepair`/`countInRepair` (`inspection.ts`, mismo núcleo que «Por
  inspeccionar»: `listInStatus(actor, status)`): saldos en `REPAIR` del
  almacén activo y dentro del alcance de la persona, derivados en cada
  consulta, paginados en la base, con desde cuándo y de dónde vino (la última
  entrada a ese estado) y lo que retiene un documento (`heldStock`). Nada
  guardado. Permiso `inventory.stock.read`.
- Pantalla `/inventario/en-restauracion`: la fila abre «Cambiar estado» con
  esas existencias elegidas (quien decide) o la ficha del producto (los
  demás). El aviso «N renglones en restauración» aparece en Inventario solo
  si hay algo y solo para quien puede decidir; **no en Inicio**: es trabajo
  en curso, no algo que pida atención hoy (regla KISS del Inicio).
- No hay filtro por estado en la lista de Inventario hoy: esta lista es el
  filtro. El desglose por estado de la ficha, del lote y de las
  exportaciones de existencias ya recorre todos los estados.
- Una empresa que no usa el estado no ve nada nuevo salvo la opción en
  «Cambiar estado», el botón «A restauración» en la decisión de una
  devolución, el uso de ubicación y el ajuste en Operación. No se ocultó tras
  otro ajuste: es una opción más de una lista que ya existe, y esconderla
  sumaría un ajuste para algo que no estorba.

### 6. Operación → qué hace con «En restauración»

| Operación | Qué hace con `REPAIR` |
| --- | --- |
| Disponible, «libre para tomar», reservas, liberar un pedido, surtido, olas, empaque, despacho | No lo toma (solo `AVAILABLE`). |
| Mínimos, existencias bajas, sugerencias de compra, reposición, cross-docking | No cuenta. |
| «Hay», archivar producto o ubicación, cambiar control por lote, valor del inventario | Cuenta. |
| Salida y salida rápida, salidas importadas | No lo toman (sacan disponible). |
| Ajustes, conteos y conteos cíclicos | No lo tocan: comparan y corrigen solo lo disponible, como con dañado. |
| Reubicar, tareas de traslado y acomodo | No lo mueven (disponible). Se mueve con «Cambiar estado» con destino. |
| Cambiar estado | Origen y destino manuales; permisos del punto 2; ajuste del punto 3. |
| Devolución de cliente | Nueva decisión «A restauración» (motivo obligatorio). Entrar sigue siendo solo en inspección. |
| Recepción de compra | No entra en restauración (CHECK: disponible, dañado o inspección). |
| Devolver al proveedor (`returnStatesFor`) | No sale de restauración: si no se pudo restaurar, se pasa a dañado o rechazado y de ahí se devuelve (5.10, paso 3). |
| Desechar (`disposeStock`) | No directo: igual que al devolver, lo que no se pudo restaurar pasa antes a dañado o rechazado, que es lo que dice la 5.10 y deja en el historial por qué se perdió. `postDisposal` acepta `allowedStatuses` para WMS-29B. |
| Retención (`HOLDABLE_STATUSES`, `stock_hold_status`) | Se puede retener (la orden de reproceso, WMS-29B). `heldStock` lo cuenta como cualquier otro estado. |
| Reversas | Una reversa que saca de restauración pasa por `heldStock`; con `inspection`, la de disponible → restauración se rechaza (punto 3). |
| Traslados entre almacenes | No lo envían (solo disponible); recibir sigue siendo disponible o dañado. |
| Tarimas y contenedores | No se arma con él (solo disponible). La base lo exige desde este paso: `container_item_available` (`CHECK (status = 'AVAILABLE')`, migración `20261117060100`; lo único que escribe ahí es `putIn`, y escribe disponible). |
| Capacidad | Cuenta como cualquier existencia en la ocupación. El uso «Restauración» no admite disponible. |
| Uso «Cuarentena» | Admite restauración (no es disponible). |
| API (`/api/v1`) | `status` admite `REPAIR` en existencias y lotes; `docs/api/openapi.json` regenerado. |
| Webhooks | `inventory.stock_status.changed` lleva `REPAIR` como cualquier estado. |
| Exportaciones, etiquetas, rastreo, lotes | Aparece con su nombre «En restauración». |
| Resumen diario, resumen del día | Sin cambio (no cuentan estados). |
| Reconciliación | Sin cambio: compara por las cuatro dimensiones, el estado incluido. |

### 7. Costo

Un cambio de estado no mueve el valor (ADR 0033): lo restaurado vuelve a
disponible al costo promedio del producto, y cada línea guarda el precio
vigente. Repuestos usados para restaurar: sin Producción, una salida con
motivo; con Producción, la orden de reproceso (WMS-29B).

### 8. Candados

Los de siempre, sin cambios: producto → ubicaciones → (devolución o
documento) → capacidad. El ajuste se lee después de los candados. La lista
derivada no bloquea nada.

## Fuera de este paso

- La decisión de Calidad «A restauración» y el inspector que libera cuando
  el ajuste pide inspección: WMS-30B.
- La orden de reproceso que consume desde restauración: WMS-29B.
- Un filtro por estado en la lista de Inventario (no existe para ningún
  estado).

## Decisiones que el fundador puede cambiar

- `inventory.repair.release` va en `direct` por omisión.
- El motivo al liberar de restauración es obligatorio, como en todo cambio
  de estado (la 5.10 decía «motivo opcional»).
- La opción «En restauración» no se oculta tras un ajuste.
- Desechar y devolver al proveedor no salen directo de restauración.
- Con `inspection`, la reversa de un cambio hacia restauración se rechaza.
- El aviso va en Inventario y no en Inicio.
- En «Por inspeccionar» (y «En restauración») el origen de lo que entró por
  un cambio de estado dice «Desde <estado> · referencia» en vez de «Cambio
  de estado».
- El nombre «En restauración» (la sección 11 de la propuesta lo dejaba
  abierto).

## Consecuencias

- Un estado más en la lista de «Cambiar estado» para quien no restaura.
- La ubicación de restauración obliga a elegir destino al liberar, como la
  cuarentena.
- Código anterior a este paso no conoce `REPAIR`: una vez escrito, volver a
  esa versión mostraría el valor sin nombre (migración solo de expansión; no
  se borra nada).
