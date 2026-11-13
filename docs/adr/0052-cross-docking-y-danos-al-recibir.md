# ADR 0052 — Cross-docking y daños al recibir

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-54 (cross-docking) y el
pendiente «daños al recibir de un proveedor» de ADR 0042 y ADR 0046 ·
Completa ADR 0021 (recepción), ADR 0042 (acomodo), ADR 0040 (lotes), ADR
0041 (series), ADR 0043 (tarimas) y el surtido de WMS-14

## Contexto

Dos cosas pasan en el mismo momento, cuando llega la mercancía de un
proveedor, y por eso se diseñan juntas:

1. **Lo que llega dañado.** Hoy todo lo recibido entra disponible y, si venía
   roto, alguien lo marca después con «Cambiar estado» (WMS-11). Mientras
   tanto se ofrece para acomodar y para surtir, y la devolución al proveedor
   (CMP-12) solo sabe sacar existencias disponibles: lo marcado como dañado
   ya no se puede devolver con su recepción. Se pospuso dos veces (ADR 0042,
   ADR 0046) porque hacerlo a medias dejaría mercancía dañada sin forma de
   regresar.
2. **Cross-docking (WMS-54).** Un pedido de salida liberado al que le faltó
   mercancía se queda esperando. Cuando esa mercancía llega, hoy se acomoda
   en un estante y alguien tiene que volver a surtirla de ahí. El plan pide
   mandarla directo a preparación: una regla de la empresa reparte lo
   recibido entre los pedidos que lo esperan y el acomodo.

Lo que ya existe y se reutiliza sin cambiarlo: la recepción en una sola
transacción (ADR 0021), `postReceiptEntry` (la entrada de Inventario),
`checkPlacement` (WMS-22B), el apartado (`reserveStock`), las tareas de
surtido `PICK` con su flujo completo (confirmar, entregar, `PICKED`,
empacar, despachar) y las tareas de acomodo con `TASK_HOLD` (WMS-52).

## Flujo operativo

### Parte A — Lo que llega dañado

1. En «Recibir mercancía», cada producto (y cada lote de un producto por
   lote) tiene, plegado, **«¿Llegó algo dañado?»**. Al abrirlo pide **«De
   eso, dañado»**: cuánto de lo que llegó (en los mismos términos de la
   línea: cajas si se pidió en cajas, piezas si en piezas). Para un producto
   por serie pide además **«Series de las dañadas»** (de las que llegaron).
2. Al confirmar, la parte dañada **cuenta como recibida** (contra lo pedido y
   contra lo pendiente: la orden queda recibida igual) pero entra en estado
   **«Dañado»** (`DAMAGED`), en el mismo lugar que el resto de su línea y con
   el mismo lote. No es disponible: no se aparta, no se surte, no lleva tarea
   de acomodo y no se manda a un pedido (cross-docking).
3. La orden muestra en cada recepción cuánto llegó dañado («2 cajas × 10 = 20
   piezas · Dañado»). La ficha del producto ya muestra los estados: ahí
   aparece en «Dañado».
4. **Devolverlo al proveedor:** «Devolver al proveedor» de esa recepción
   ofrece la parte dañada como una línea propia («Dañado · llegaron 2
   cajas»). Sale **de «Dañado»**, de su lote y con sus series, nunca más de lo
   que llegó dañado menos lo ya devuelto. La parte sana se devuelve como
   hasta hoy (de lo disponible, sin tomar lo apartado).
5. Si alguien ya movió lo dañado o le cambió el estado, la devolución lo dice:
   «En General solo hay 0 piezas de este producto en «Dañado». Si ya cambió
   de estado o de lugar, elige de dónde sale o sácalo con una salida.» Se puede elegir
   otra ubicación de donde sale (como hoy), siempre de «Dañado».
6. **En una tarima:** lo dañado **no va dentro de la tarima**: queda suelto
   en el mismo lugar. La tarima lleva solo lo sano y su tarea de acomodo
   cubre solo eso.

### Parte B — Cross-docking

1. **Ajuste de la empresa** `inventory.crossdock.mode` (Configuración ›
   Operación › Acomodo, «Lo que llega para un pedido que espera»): `off` por
   omisión (nada cambia) u `on` («Se manda directo a preparación»).
2. **Un pedido espera** cuando está liberado (`RELEASED`) o en surtido
   (`PICKING`) y a alguna de sus líneas le falta por apartar:

   > espera = pedido − lo que su línea tiene apartado hoy (reservas activas
   > de la línea: en su origen mientras se surte, en preparación ya
   > surtido)

   Se deriva en cada recepción; no se guarda ninguna bandera. Faltar puede
   venir de liberar «con lo que hay» o de surtir menos de lo pedido (el
   motivo libera lo que no se tomó). Un pedido ya surtido (`PICKED`) o en
   empaque sigue con lo que tiene (el despacho parcial es otro pendiente).
3. Con el ajuste encendido, **un pedido se puede liberar sin nada apartado**
   («Liberar con lo que hay» cuando no hay nada): queda liberado, sin tareas,
   esperando. Apagado, liberar sin nada sigue rechazándose como hoy.
4. **Qué se reparte:** lo **sano** (disponible) que llega a un lugar «de
   paso» (General o una ubicación de uso Recepción, `isWaitingPlace`) del
   almacén del pedido, suelto (no en tarima), de un lote que no esté caducado
   salvo que la empresa permita surtir caducados (`PICK_EXPIRED = allow`).
   Lo que se recibe directamente en un estante ya quedó almacenado y no se
   reparte.
5. **A quién primero:** urgentes primero, luego por día de salida (sin día al
   final), luego el que se liberó antes y, al final, el número de pedido. Lo
   decide **solo** `planCrossDock` (`cross-dock-rules.ts`, pura, con prueba
   de escenario conocido): de cada llegada, cuánto va a cada línea que espera
   (nunca más de lo que espera) y cuánto sigue a acomodo. Entre llegadas del
   mismo producto toma primero la que caduca antes.
6. **Qué pasa con lo repartido,** en la misma transacción de la recepción:
   se aparta para la línea del pedido **en el lugar donde se recibió**
   (reserva con ubicación y lote, fuente `outbound_order_line`, como el
   surtido) y se crea su tarea de surtido normal (`kind = PICK`, con
   `outboundLineId`, lote y `crossDockMovementId` = la entrada que lo trajo)
   de ese lugar hacia la preparación del almacén. De ahí sigue el flujo de
   siempre: tomar, confirmar (con series si las lleva), entregar, `PICKED`,
   empacar, despachar. Cancelar el pedido cancela la tarea y libera lo
   apartado, como hoy.
7. **El resto** sigue a acomodo como hoy: tarea `PUTAWAY` por lo que quedó
   si el acomodo es por tareas, o queda en «Sin acomodar». Nada se cuenta dos
   veces: la tarea de acomodo se crea con lo recibido menos lo repartido, y
   además nunca cubre lo apartado (`freeToTake`).
8. **A la vista:** el aviso de la recepción dice «12 piezas van directo al
   pedido PS-0004 (tarea T-0031).» con un enlace al pedido; en el pedido, la
   línea dice «12 piezas llegaron con OC-0007» y la tarea, «Llegó con
   OC-0007»; en `/tareas` son tareas de surtido normales.
9. **Entrada manual:** una entrada a un lugar «de paso» reparte igual (es el
   mismo punto que crea las tareas de acomodo).

## Decisiones

### Lo dañado es una línea de recepción aparte

Cada parte dañada es **su propia línea de recepción** (`purchase_receipt_line`
con `status = DAMAGED`) y su propia línea del movimiento `RECEIPT` (en
`DAMAGED`), con el mismo número de línea, como toda línea de recepción. Así:

- lo recibido de la línea de la orden sigue siendo la suma de
  `capturedQuantity` de sus líneas de recepción (sano + dañado): lo pendiente
  no cambia de fórmula;
- la devolución sigue siendo por línea de recepción y su límite (lo recibido
  menos lo devuelto, con el disparador que ya existe) vale igual para la
  parte dañada; la línea dice de qué estado sale;
- las series de la parte dañada son las de su línea de movimiento: la
  devolución solo acepta series que llegaron con esa línea.

La alternativa (columnas «dañado» en la misma línea) obligaba a partir cada
lectura y cada devolución en dos y a guardar qué series de la línea son las
dañadas. Descartada.

Un disparador nuevo (`purchase_receipt_line_status`) exige que la línea de
recepción y su línea de movimiento tengan el mismo estado y producto, y la
columna solo admite `AVAILABLE` o `DAMAGED`.

### Lo dañado se cuenta en los términos de la línea

Si se pidió en cajas, «De eso, dañado» es en cajas completas (cada caja
entra con el contenido vigente, como el resto). Una pieza rota dentro de una
caja sana se recibe sana y se marca después con «Cambiar estado»: partir una
caja en piezas cambiaría la cuenta de lo pendiente, que es en cajas.

### Costo

Lo dañado entra **al mismo costo** que lo demás de su línea (el de la línea
de la orden): el proveedor lo cobró igual y el valor del inventario cubre
todos los estados (ADR 0031, ADR 0033). Al devolverlo sale al costo con que
entró, como toda devolución. No hay otra regla de costo.

### `sameReceipt` compara también lo dañado

Un reintento con la misma clave se reconoce si pide lo mismo: líneas,
cantidades, lugar, lote **y la parte dañada** (cada parte pedida se expande
en su parte sana y su parte dañada, y se compara con las líneas guardadas
con su estado). La misma clave con otra cantidad dañada es `KEY_REUSED`.

### Candados

La recepción bloqueaba productos → ubicaciones → orden de compra. Con
cross-docking bloquea además **los pedidos de salida que esperan**, justo
después de la orden de compra y antes de la tarima y la capacidad:

> productos → ubicaciones → orden de compra → pedidos de salida →
> contenedor → tareas → capacidad

Coherente con el orden de siempre (productos → ubicaciones → documento →
contenedor → tarea → capacidad): ninguna operación bloquea un pedido de
salida y luego una orden de compra. Liberar bloquea productos → pedido (si el
pedido tiene un producto de la recepción, espera al candado de ese
producto); cancelar bloquea solo el pedido y no toma ningún candado que la
recepción tenga antes de pedirlo; entregar una tarea de surtido bloquea
producto → ubicaciones → pedido → tarea. Los pedidos candidatos se leen
antes de bloquearlos y **se vuelven a leer bajo el candado** (estado, líneas
y lo apartado): uno liberado después de la lectura no recibe nada esta vez
(no es un error), uno cancelado entre tanto se salta. La entrada manual
bloquea igual: producto → ubicación → pedidos → capacidad.

La tarea de surtido nace de un pedido `RELEASED` o `PICKING`: el disparador
`warehouse_task_insert_rules` se amplía (antes solo `RELEASED`). Un pedido en
surtido sigue en surtido hasta que no quede tarea abierta (`settlePickedOrder`
no cambia).

### Lo que no se reparte

- **Lo que llega en tarima** no se reparte: la tarima entera va a acomodo
  (surtir de una tarima sin sacarla antes es un pendiente de ADR 0043).
- **Lo dañado** nunca.
- **Lo que llega directo a un estante** (no a un lugar de paso).
- Pedidos de otro almacén, o de un almacén fuera del alcance de quien recibe.

### Ajuste y su relación con el acomodo

`inventory.crossdock.mode` es independiente de `inventory.putaway.mode`:
con acomodo manual, lo repartido lleva su tarea de surtido y el resto queda
en «Sin acomodar»; con acomodo por tareas, el resto lleva su tarea de
acomodo. «Sin acomodar» sigue sin restar lo apartado (ADR 0042, WMS-72): lo
repartido también tiene que salir de ese lugar y aparece ahí hasta que se
surte.

## Modelo

- `purchase_receipt_line.status` (`StockStatus`, `AVAILABLE` por omisión;
  `CHECK` solo `AVAILABLE`/`DAMAGED`), con el disparador
  `purchase_receipt_line_status`.
- `warehouse_task.crossDockMovementId` (opcional; solo `PICK`; la entrada
  `RECEIPT` o `ENTRY` que lo trajo; no cambia: disparador
  `warehouse_task_cross_dock_fixed`).
- `warehouse_task_insert_rules` acepta `PICK` de un pedido `RELEASED` o
  `PICKING`.

Migración `20261114220000_wms_cross_docking` (solo expansión). Sin tablas,
permisos ni acciones de bitácora nuevos: la recepción ya deja
`purchase_order.received` y las reservas y tareas son su propio rastro.

## Servicios

- Compras: `receivePurchaseOrder` acepta por línea `damaged` y
  `damagedSerials` y responde `crossDock` (a qué pedidos fue y con qué
  tareas); `returnToSupplier` sale del estado de su línea de recepción;
  `getOrderReceipts` dice qué líneas son dañadas.
- Inventario: `postReceiptEntry` acepta `status` por línea y reparte;
  `postReturnExit` acepta `status` por línea; `cross-docking.ts`
  (`lockCrossDockOrders`, `sendToWaitingOrders`) y `cross-dock-rules.ts`
  (`planCrossDock`, pura); `CROSS_DOCK_MODE`.

## Lo que quedó fuera (pendiente)

- Lo dañado va al mismo lugar que el resto de su línea; mandarlo directo a
  una cuarentena al recibir (hoy: «Cambiar estado» con destino).
- Daño dentro de una caja (por pieza) cuando la línea se pidió en cajas.
- Repartir a pedidos ya surtidos (`PICKED`) o en empaque: necesita volver a
  surtido o el despacho parcial (ADR 0045).
- Repartir lo que llega en tarima, o lo que llega directo a un estante.
- Volver a repartir lo que ya está acomodado cuando un pedido queda
  esperando (hoy se libera con lo que hay y lo cubre la siguiente recepción).
- Devolver al proveedor lo rechazado de un cliente (ADR 0046).

## Alternativas descartadas

- **Tareas de traslado a preparación sin apartado:** el pedido no sabría que
  ya tiene esa mercancía y otro pedido podría tomarla. Se usa el apartado de
  la línea y una tarea de surtido normal para que el resto del flujo no
  cambie.
- **Guardar «cuánto falta» en la línea del pedido:** sería una bandera que se
  desincroniza con cada surtido corto o cancelación; se deriva de las
  reservas.
