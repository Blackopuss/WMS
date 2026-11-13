# ADR 0042 — Acomodo con recomendación

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-52 · Completa ADR 0039
(capacidad), ADR 0040 (lotes), ADR 0041 (series) y el surtido de WMS-14

## Contexto

Lo que llega al almacén entra a «General» o a una ubicación de uso
«Recepción». WMS-72 dejó a la vista lo que sigue ahí («Sin acomodar»), pero
acomodarlo dependía de que alguien lo cambiara de lugar a mano y eligiera,
de memoria, a dónde. La especificación (5.x) y el plan v3 (WMS-52) piden que
al recibir se generen **tareas de acomodo**, que el sistema **recomiende el
destino** (junto a lo mismo, con lugar libre, en una ubicación de
almacenamiento) y que quien acomoda lo confirme escaneando la ubicación,
con un parámetro para que cada empresa decida si trabaja así.

Ya existe todo lo que una tarea necesita: `warehouse_task` con su máquina de
estados (WMS-06), apartado por ubicación (WMS-12, como el surtido de WMS-14),
la regla única de lo que admite una ubicación (`checkPlacement`, WMS-22B),
lotes y series en tareas (WMS-21A/B) y la definición de «de paso» de WMS-72.
Este paso las junta; no agrega otra forma de mover existencias.

## Flujo

1. **La empresa elige cómo se acomoda** en Configuración › Operación, área
   «Acomodo», «Cómo se acomoda lo que llega»:
   - **«Cada quien lo cambia de lugar»** (`manual`, por omisión): todo sigue
     como hasta hoy. Lo que llega se queda donde se recibió y aparece en
     «Sin acomodar». Quien no cambia este ajuste no ve nada nuevo.
   - **«Con tareas de acomodo»** (`tasks`): cada recepción de una orden de
     compra y cada entrada a un lugar «de paso» crea, en la misma operación,
     una tarea de acomodo por lo que entró (por producto, ubicación y lote).
   Y «Qué lugar se recomienda»: **junto a lo mismo** (por omisión) o **la
   ubicación más vacía** (ver «Decisión»).
2. **Qué es «de paso».** Lo mismo que ya usaba «Sin acomodar» (WMS-72):
   «General» y las ubicaciones de uso «Recepción», del almacén, nunca
   «Preparación». Un almacén sin ninguna ubicación de almacenamiento o
   surtido además de «General» no tiene nada que acomodar: ahí no se crean
   tareas. Una sola definición en el código (`WAITING_PLACE`, `unplaced.ts`).
3. **Al recibir** (o registrar una entrada a un lugar de paso) el resumen dice
   cuántas tareas se crearon («Se creó 1 tarea de acomodo»). La mercancía
   **queda apartada para su tarea** en el lugar donde espera: nadie la saca,
   la mueve ni la surte por otro lado hasta que se acomode o se cancele la
   tarea. Lo que llega dañado no es de esta tarea: no se puede mover hasta
   liberarse (ver «Lo que quedó fuera»).
4. **La tarea aparece en Tareas** como «Acomodar», en «Disponibles» (o en
   «Mis tareas» si se asigna) y cuenta en el Inicio como cualquier otra. El
   detalle dice qué, cuánto, de dónde y **«Llévalo a: Zona A › Pasillo 2 ›
   Estante 3»**, o **«Sin lugar recomendado: elige uno»** cuando no hay
   ninguno que lo admita. Los pasos son los de siempre: «Tomar tarea», «Ya
   recogí la carga» (un producto por serie escanea aquí sus unidades) y el
   último, que en el acomodo pide **escanear la etiqueta del lugar donde lo
   dejó** (o escribir su código, su nombre o su ruta) y «Ya lo acomodé».
5. **Otro lugar.** Si quien acomoda lo deja en otra ubicación (la recomendada
   está llena de hecho, o no había recomendación), escanea esa: se valida
   como cualquier entrada a una ubicación (sus restricciones siempre
   detienen; la capacidad, como la empresa decidió: «avisar» muestra por
   cuánto se pasa y ofrece «Dejarlo ahí de todos modos»), y debe estar en su
   almacén y dentro de sus zonas. No puede ser otro lugar de paso ni
   «Preparación». La tarea guarda **dónde quedó de verdad**; la
   recomendación no cambia.
6. **Lo que ya estaba antes** de encender el parámetro (o lo que entró por
   otra vía: saldo inicial, importación, reversa, una tarea cancelada):
   «Sin acomodar» dice, por fila, si ya tiene tarea («Con tarea T-0012»; la
   fila abre esa tarea) y, con el parámetro encendido, ofrece **«Crear
   tareas de acomodo»**: crea las que faltan para todo lo que no tiene tarea
   abierta, en el almacén y las zonas de quien la pulsa. Pulsarla dos veces
   no duplica nada.
7. **Supervisión.** Una tarea de acomodo se asigna, se libera o se cancela
   como cualquier otra (`inventory.task.create`/`cancel`). Cancelarla suelta
   lo apartado: la mercancía vuelve a «Sin acomodar» sin tarea.

## Decisión

- **Parámetros** en `INVENTORY_SETTINGS`, leídos con `readSetting` dentro de
  la transacción que decide: `inventory.putaway.mode` (`manual` por omisión,
  `tasks`) y `inventory.putaway.preference` (`together` por omisión,
  `emptiest`). Regla 11: cómo se acomoda y qué se prefiere admiten más de una
  forma razonable.
- **Una sola función decide el destino:** `putawayTarget` de
  `src/modules/inventory/putaway.ts`, con su orden puro en `putaway-rules.ts`
  (`rankPutawayPlaces`, prueba unitaria). Entre las ubicaciones del almacén
  del origen que son **hojas** del árbol (no contienen otras), activas, de uso
  «Almacenamiento» o «Surtido», nunca «General», «Preparación» ni el origen,
  y **dentro del alcance de quien crea la tarea** (WMS-20), ordena:
  - con **«junto a lo mismo»**: primero donde ya hay de ese producto **y
    lote**, luego donde hay de ese producto (otro lote), luego donde hay de
    su misma categoría, luego las demás; dentro de cada grupo, la que tiene
    menos unidades (más lugar libre); empate por la ruta en orden de lectura
    y por id (estable).
  - con **«la ubicación más vacía»**: solo por unidades, ruta e id.
  Y toma la primera que **admite** lo que llega: `checkPlacement` con la
  política `report` sobre las reglas leídas una vez (`loadPlacementRules`)
  y sin notas, es decir, sin restricción que lo impida (cuarentena, solo
  ciertos productos o categorías) y sin pasarse de ninguna capacidad del
  lugar ni de lo que lo contiene. No se duplica ninguna regla de capacidad:
  es la misma función de toda entrada. Se revisan como mucho
  `PUTAWAY_CANDIDATES_CHECKED` (100) lugares en ese orden; si ninguno
  admite, no hay recomendación, **nunca se inventa una**.
  - «Unidades» cuenta todo lo que hay físicamente (todos los estados), como
    la capacidad (ADR 0039).
  - **Cercanía** no existe en el modelo (no hay coordenadas ni recorrido):
    queda fuera; cuando exista, será otro criterio de esta misma función.
- **Tareas `PUTAWAY`** en `warehouse_task` (un valor más de `kind`), con la
  misma máquina de estados (`WAREHOUSE_TASK_TRANSITIONS` y el disparador no
  cambian: acomodar es tomar, recoger y entregar). Lote y series como
  cualquier tarea: la tarea lleva su lote (inmutable) y un producto por
  serie escanea sus unidades al recoger (`warehouse_task_serial`).
- **El destino recomendado no cambia; el real se guarda aparte.** El
  destino de una tarea (`toLocationId`) sigue siendo inmutable (disparador):
  en una tarea de acomodo es **el lugar recomendado**, y **sin
  recomendación es el propio origen** (la columna no admite vacío y volverla
  opcional obligaba a revisar cada lectura de tareas y su alcance; el
  `CHECK` de «origen distinto del destino» se relajó solo para `PUTAWAY`).
  Una columna nueva, `placedLocationId`, dice **dónde quedó de verdad**: se
  escribe una sola vez, al entregar, junto con el movimiento, y después no
  cambia (disparador); solo existe en tareas de acomodo y toda tarea de
  acomodo entregada la tiene (`CHECK`). El movimiento `TRANSFER` (clave
  `task:<id>`) también la dice. Así queda el rastro completo: qué recomendó
  el sistema y qué hizo la persona.
- **Entregar** (`deliverTask` con `locationCode`) resuelve lo escaneado antes
  de la transacción (código exacto de la ubicación; si no, su ruta; si no, su
  nombre si es único en el almacén), y dentro toma los candados de siempre
  —producto → ubicaciones (origen y la escaneada) → tarea— y vuelve a
  revisar: misma ubicación del almacén de la tarea, activa, dentro del
  alcance de quien entrega (si no, «no encontramos esa ubicación», sin decir
  si existe), ni de paso ni «Preparación». Suelta lo apartado para la tarea y
  escribe la reubicación con el núcleo existente (`postTaskTransfer` →
  `transferWithin`). La capacidad: si es la recomendada, `report` (como toda
  entrega: ya se preguntó al recomendar); si es otra, `ask` (la persona
  puede elegir otra, así que se le pregunta como en una reubicación).
  Repetida, responde `repeated`; dos personas a la vez: una la entrega, la
  otra no la tiene.
- **Apartado de la tarea** en `stock_reservation` con la ubicación y el lote
  de origen y la fuente `warehouse_task` + id de la tarea (`TASK_HOLD`).
  Como mover dentro de un mismo producto no cambia su total, **un apartado de
  tarea solo cuenta en su ubicación**: no resta de lo disponible del
  producto (ficha, mínimos, sugerencias de compra, totales apartados), así
  recibir no hace que el sistema pida comprar lo que acaba de llegar. Las
  lecturas de toda la empresa filtran con `PRODUCT_HOLDS`. Cancelar la
  tarea lo libera (`releaseReservations`); liberarla (con problema →
  disponible) lo conserva. El mensaje de lo apartado dice ahora «apartado
  para pedidos o tareas».
- **Misma transacción.** `postReceiptEntry` (lo llama Compras) y `post`
  (entrada manual) llaman `createPutawayTasks` al final de su transacción,
  después de escribir saldos: candados producto → ubicación → documento, y
  la tarea nueva al final, sin candados propios. Inventario no importa de
  Compras.
- **Números de tarea.** Dos operaciones a la vez pueden tomar el mismo número
  (`T-0007`); la base guarda una y la otra repite toda la operación
  (`isTaskNumberClash`, hasta cinco intentos), como ya hacía `createTask`.
- **Crear las que faltan:** `createPendingPutawayTasks` (permiso
  `inventory.task.create`, solo con el parámetro en `tasks`) recorre lo que
  espera en el almacén activo y las zonas de la persona, por lotes de 25
  productos (una transacción cada uno, productos → ubicaciones), y crea una
  tarea por lo que no cubren las tareas abiertas: disponible del lugar y
  lote − lo que ya llevan sus tareas de acomodo abiertas, sin pasar de lo
  libre ahí. Es lo que la hace repetible sin duplicar.
- **Permisos:** ninguno nuevo. Crear tareas al recibir es consecuencia de
  recibir (`purchasing.receipt.create`) o de la entrada
  (`inventory.entry.create`); el botón pide `inventory.task.create`; hacerlas,
  `inventory.task.execute`.

## Dónde se aplica

| Operación | Con el parámetro en `tasks` |
| --- | --- |
| Recepción de orden de compra (`postReceiptEntry`) | Una tarea por línea que entra a un lugar de paso |
| Entrada manual (`registerEntry`) a un lugar de paso | Una tarea por lo que entró |
| Saldo inicial, importación, reversa, reubicación a «General» | No crean tarea; «Crear tareas de acomodo» las cubre |
| «Sin acomodar» › «Crear tareas de acomodo» | Las que faltan, repetible |
| Salida, reubicación, cambio de estado, surtido desde el lugar de paso | No toman lo apartado para la tarea |
| Entregar la tarea (`deliverTask`) | Mueve al lugar escaneado; registra dónde quedó |

## Lo que quedó fuera (pendiente)

- ~~**Daños al recibir**~~: hecho en WMS-54 (ADR 0052). Cada línea dice
  cuánto llegó dañado; esa parte es su propia línea de recepción en
  «Dañado», no genera tarea y se devuelve al proveedor desde «Dañado», con
  su lote y sus series. La **diferencia** contra lo pedido
  ya se deriva (pedido − recibido) y ya se ve: la pantalla de recibir dice
  por línea «faltan 2 cajas de 3» y la orden «Recibido: 1 caja de 3 · faltan
  2 cajas» (CMP-08/11); no se guarda ni se cambió.
- **Cercanía** (coordenadas, recorrido, pasillo más cercano) y
  **dimensiones** de la ubicación.
- Las tareas abiertas hacia un destino **no se descuentan** de su capacidad
  al recomendar otra (pendiente de ADR 0039): dos tareas pueden recomendar el
  mismo estante; al entregar la segunda, la capacidad se dice o se pregunta.
- **Recomendación al momento de acomodar:** se calcula al crear la tarea. Si
  cambió el almacén, la persona elige otro lugar.
- Mover existencias **no disponibles** a su lugar (cuarentena) sigue siendo
  «Cambiar estado» con destino (ADR 0039).
- Acomodo **por tarima o contenedor** (LPN): WMS-53.

## Consecuencias

- Una operación nueva que meta existencias a un lugar de paso y deba quedar
  «con tarea» llama `createPutawayTasks(tx, actor, llegadas)` al final de su
  transacción y repite la operación ante `isTaskNumberClash`.
- Un apartado nuevo que no cambie el total del producto (otro movimiento
  dentro del mismo producto) usa la fuente `TASK_HOLD`; una lectura nueva de
  lo apartado de todo un producto filtra con `PRODUCT_HOLDS`.
- Migración `20261114130000_wms_putaway` (solo expansión): un valor más del
  enumerado `kind`, la columna `placedLocationId` con su llave foránea, el
  `CHECK` de origen y destino relajado para `PUTAWAY`, dos `CHECK` nuevos y
  el disparador `warehouse_task_transition` vuelto a crear con la regla de
  `placedLocationId` (la tabla de transiciones no cambia).
