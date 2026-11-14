# ADR 0048 — Traslados entre almacenes

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-19 · Cierra el pendiente
de ADR 0035 (varios almacenes) · Completa ADR 0033 (estado del saldo), ADR
0040 (lotes), ADR 0041 (series), ADR 0042 (acomodo), ADR 0038 (alcance) y
ADR 0031 (costo promedio)

## Contexto

Desde WMS-18 una empresa tiene varios almacenes, pero una reubicación entre
dos de ellos se rechaza («entre almacenes se hace un traslado»). El plan v3
(WMS-19) pide que **el almacén A envíe, la mercancía quede en tránsito y el
almacén B la reciba registrando diferencias**. Sus pruebas: recibir dos
veces no duplica, el total de la empresa no cambia mientras va en tránsito
y la reconciliación cuadra.

El estado `IN_TRANSIT` existe desde WMS-10 y nadie lo pone a mano (está
fuera de `MANUAL_STOCK_STATUSES`). Todo lo que saca, surte, aparta, cuenta,
ajusta o mueve existencias lee solo `AVAILABLE`.

## Dónde vive lo que va en tránsito (la decisión central)

El saldo es por producto + **ubicación** + estado + lote, y una ubicación es
de un almacén. Se consideraron:

- **Sin saldo, solo en el documento.** El total de la empresa («hay» suma los
  saldos) bajaría mientras va en camino y la reconciliación dejaría de
  cuadrar con el historial. Se descarta.
- **En el almacén de origen.** Quien recibe en B tendría que sacar de una
  ubicación de A (fuera de su alcance) y A seguiría «teniendo» lo que ya se
  fue; archivar A dependería de un camión en carretera.
- **En una ubicación «En tránsito» del almacén de destino**, en estado
  `IN_TRANSIT`. Es lo que se elige: lo que va hacia B ya cuenta en B, pero
  aparte y nunca disponible; recibir es mover dentro de B (de «En tránsito»
  a donde se deja) y lo pendiente se ve en B como «por recibir».

Esa ubicación (`location.isTransit`, una por almacén) la crea el sistema con
`ensureTransitLocation` al primer traslado hacia ese almacén, como
«Preparación»: en la raíz, uso «Andén», sin código. A diferencia de
«Preparación», **no se muestra ni se ofrece**: `listLocations`,
`listStockLocations` (y con ella entradas, salidas, ajustes, conteos,
importaciones y tareas), lugares de devoluciones, lugares escaneados,
ocupación y zonas del alcance la excluyen, y los servicios del árbol
(editar, mover, archivar, límites, crear dentro) no la encuentran. La base
lo garantiza aunque llegue un id armado a mano:

- `CHECK location_transit`: en la raíz, nunca General ni preparación, nunca
  archivada; el indicador no cambia y nada va dentro de ella (disparadores).
- Disparador del saldo: **estado `IN_TRANSIT` si y solo si la ubicación es
  de tránsito**.
- Disparador de las líneas: una línea en una ubicación de tránsito o en
  `IN_TRANSIT` es de un movimiento `FACILITY_TRANSFER`, en esa ubicación y en
  ese estado; las demás líneas de un traslado son `AVAILABLE` o `DAMAGED`.

Así se cumple lo que el paso exige:

- **El total de la empresa no cambia en tránsito:** el envío es un solo
  movimiento que saca de A y mete en «En tránsito» de B, en la misma
  transacción.
- **Lo en tránsito no es disponible en ningún almacén:** su estado es
  `IN_TRANSIT`, que ninguna operación lee para sacar, surtir, apartar,
  contar o ajustar; «Cambiar estado» no admite `IN_TRANSIT` ni como origen
  ni como destino, y los movimientos `FACILITY_TRANSFER` no se reversan.
- **El valor no cambia:** el costo promedio es por producto en toda la
  empresa (ADR 0031); envío, recepción y regreso escriben cada línea al
  promedio vigente (`price`) sin tocar `product_cost`. Solo «se perdió» lo
  baja (`exit`), como una salida.
- **La reconciliación cuadra** por producto, ubicación, estado y lote: todo
  pasa por movimientos; las series viajan con `serial_move` (la unidad queda
  en «En tránsito», `IN_TRANSIT`, y llega como la misma unidad).

## Flujo

1. **Nuevo traslado** (Movimientos › «Traslados entre almacenes» › «Nuevo
   traslado»; el enlace solo existe si la empresa tiene más de un almacén
   activo). El origen es el almacén donde trabaja la persona; se elige el
   destino (otro almacén activo de la empresa, aunque esté fuera de su
   alcance) y, opcional, notas. Nace en **borrador** (`TR-0001`), con clave
   de confirmación (`repeated` si se repite).
2. **Productos** (en la ficha del borrador): por nombre, clave o código de
   barras; después de dónde sale (una ubicación del origen dentro del
   alcance; para un producto por lote, `lotSourceChoices`: lo que caduca
   antes primero), cuánto (en la unidad del producto) y, si es por serie,
   cuáles. Se revisa lo que hay libre, pero **el borrador no aparta nada**:
   lo decide el envío. Un producto, ubicación y lote no se repite; se quita
   y se agrega de nuevo.
3. **Enviar** (botón grande de la ficha; quién lo lleva, opcional). Una
   transacción (`LOCKING_TRANSACTION`), candados productos → ubicaciones
   (las del origen y «En tránsito» del destino; `lockRows` las ordena) →
   traslado. Clave de confirmación en el movimiento: repetirla responde
   `repeated`; si ya se envió con otra clave, también `repeated` («ya se
   envió»), nunca dos salidas. Se revalida todo bajo los candados: producto
   activo, lote del producto, series en esa ubicación y disponibles (una
   tarea abierta o una tarima las retienen), lo libre con `freeToTake` por
   ubicación y lote y la suma por producto (respeta reservas, tareas de
   acomodo y lo que está en tarimas), alcance sobre las ubicaciones de
   origen. Escribe **un** movimiento `FACILITY_TRANSFER` (referencia
   `TR-0001`) con dos líneas por renglón: sale `AVAILABLE` de su ubicación y
   entra `IN_TRANSIT` en «En tránsito» del destino; cada renglón guarda su
   línea de llegada (`transitLineId`). Bitácora
   `inventory.facility_transfer_sent`.
4. **Recibir** (en el destino; quien recibe debe alcanzar el almacén de
   destino y la ubicación donde lo deja). Por renglón: cuánto **llegó
   bien** y cuánto **llegó dañado** (y sus series); a dónde entra (una
   ubicación del destino: se propone una de uso «Recepción» y si no
   «General»; nunca «Preparación»). Otra transacción y otra clave: candados
   productos → ubicaciones («En tránsito» y la de llegada) → traslado; lo
   pendiente de cada renglón (enviado − ya resuelto) se calcula **bajo el
   candado del traslado**, así recibir dos veces —o dos personas a la vez—
   nunca recibe más de lo enviado. Las series deben ser de ese renglón y
   seguir en tránsito. `checkPlacement` una vez con todas las llegadas (lo
   dañado llega en `DAMAGED`; una cuarentena lo admite), capacidad según la
   empresa. Escribe un `FACILITY_TRANSFER` (sale `IN_TRANSIT` de «En
   tránsito», entra `AVAILABLE` o `DAMAGED`), su recepción
   (`facility_transfer_receipt`, tipo `RECEIVED`) y sus renglones. Lo que
   llega disponible a un lugar «de paso» con el acomodo por tareas crea su
   tarea de acomodo (WMS-52). Se puede recibir **en varias veces**: lo que
   no se escribe sigue en tránsito.
5. **Diferencias.** Lo que no llega no se inventa ni se pierde en silencio:
   **sigue en tránsito** (sin estar disponible en ningún lado) hasta que
   alguien con `inventory.facility_transfer.resolve` lo resuelve, con motivo
   obligatorio:
   - **«Se perdió»**: baja desde «En tránsito» (sale `IN_TRANSIT`, el valor
     baja al promedio vigente, la serie queda fuera). Lo decide quien
     alcanza el destino.
   - **«Regresó al origen»**: vuelve disponible a la ubicación de donde
     salió (o a «General» del origen si se archivó). Lo decide quien alcanza
     el origen.
   - Lo dañado se recibe como «llegó dañado» (entra `DAMAGED`).
   Lo que llega de más no se registra en el traslado: se da de alta con una
   entrada o un ajuste en el destino.
6. **Cierre.** Cuando a ningún renglón le queda nada en tránsito, el
   traslado pasa a **recibido** en la misma transacción. Si algo se perdió,
   regresó o llegó dañado, la ficha dice «Recibido con diferencias»
   (derivado de sus recepciones, no un estado aparte).
7. **Qué no se puede.** Cancelar un traslado enviado (se resuelve
   recibiendo o con las diferencias); reversar desde Inventario un
   `FACILITY_TRANSFER`; trasladar a o desde un almacén archivado; archivar
   un almacén con traslados en borrador o en camino hacia o desde él; una
   reubicación o tarea entre almacenes (sigue rechazándose y remite aquí).
   El borrador se cancela con motivo. Nada se borra.

## Decisión

- **Tablas:** `facility_transfer` (número, estado, almacenes de origen y
  destino, ubicación de tránsito, notas, quién lo lleva, movimiento del
  envío, quién y cuándo creó, envió, cerró o canceló),
  `facility_transfer_line` (producto, ubicación de origen, lote, cantidad en
  la unidad del producto, series, línea de llegada a tránsito),
  `facility_transfer_receipt` (cada recepción o diferencia: tipo
  `RECEIVED`/`LOST`/`RETURNED`, ubicación, movimiento, clave, motivo,
  persona) y `facility_transfer_receipt_line` (renglón, estado en que quedó,
  cantidad, línea del movimiento, series). Disparadores: renglones solo
  cambian en borrador (y su línea de llegada se escribe una vez al enviar);
  recepciones y sus renglones son inmutables y nunca resuelven más de lo
  enviado; nada se borra.
- **Estados:** `DRAFT → SENT → RECEIVED`, `DRAFT → CANCELLED`
  (`FACILITY_TRANSFER_TRANSITIONS` de `facility-transfer-states.ts`, pura, y
  el disparador `facility_transfer_transition`, que cambian juntos).
- **Movimiento nuevo `FACILITY_TRANSFER`** («Traslado entre almacenes»): uno
  solo para enviar, recibir, regresar o dar de baja; las líneas dicen qué
  pasó. Se eligió un tipo con dos lados en vez de una salida y una entrada
  porque el envío debe ser un único movimiento (el total no cambia) y así el
  historial, los filtros y las exportaciones ganan una sola etiqueta. No se
  reversa desde Inventario.
- **Permisos nuevos:** `inventory.facility_transfer.read` (titular,
  administración, almacén, supervisión, almacenista, Consulta y Gerencia),
  `.create` y `.send` (titular, administración, almacén y supervisión),
  `.receive` (además almacenista) y `.resolve` (titular, administración,
  almacén y supervisión).
- **Alcance (WMS-20):** un traslado existe para quien alcanza su origen o su
  destino. Quien solo alcanza el origen lo crea, lo envía y ve qué llegó,
  sin la ubicación donde quedó; quien solo alcanza el destino lo ve en «Por
  recibir aquí» y lo recibe, sin las ubicaciones de origen. La ubicación de
  tránsito no pide alcance (es del sistema); las de origen y llegada sí.
- **Dónde vive:** enlace «Traslados entre almacenes» bajo el título de
  Movimientos (solo con más de un almacén). Pestañas «Enviados desde aquí»
  y «Por recibir aquí», del almacén activo. En Inicio, «Traslados por
  recibir» solo si hay y solo para quien puede recibir. La ficha del
  producto dice aparte cuánto va en tránsito. `/inventario/rastrear` acepta
  `TR-0001`; el historial de un lote o una serie muestra sus movimientos de
  traslado.
- **Un solo lugar en el código:** `facility-transfers.ts` (servicios),
  `facility-transfer-states.ts` (estados) y `ensureTransitLocation` de
  `@/platform/locations`.

## Lo que quedó fuera (pendiente)

- **Trasladar una tarima o caja entera:** lo que está en un contenedor no se
  toma suelto; se saca de la tarima antes de agregarlo.
- **Recibir en varias ubicaciones a la vez:** una recepción entra a una
  ubicación; se reciben las partes en varias veces.
- **Apartar al crear el borrador:** hoy lo decide el envío.
- **Tareas de surtido para preparar un traslado.**

## Hoja de traslado en PDF (WMS-19B, 2026-11-14)

Cierra el pendiente «documento impreso del traslado».

- **Qué es:** el papel que viaja con la mercancía y se firma al salir y al
  llegar. Se arma con `buildFacilityTransferPdf`
  (`facility-transfer-pdf.ts`) siguiendo la hoja de embarque (ADR 0045) y el
  PDF propio (ADR 0019): `PdfPageWriter` + `buildPdf`, sin librería nueva.
- **Qué lleva:** número, almacén de origen y de destino (nombre y código),
  quién lo lleva, cuándo se creó y quién, cuándo se envió y quién, cuándo
  se cerró, estado, y por renglón producto (clave), lote (con caducidad),
  cantidad enviada, ubicación de origen y series. Abajo, «Entrega» y
  «Recibe» con línea para nombre, firma y fecha. **Sin costos** (es un
  documento de almacén). Un borrador dice «BORRADOR · todavía no sale» y un
  cancelado «CANCELADO» con su motivo.
- **Lo recibido sí se muestra** (decisión de este paso): una vez enviado,
  cada renglón dice qué llegó bien, qué llegó dañado, qué se perdió, qué
  regresó y qué sigue en camino, y una sección «Recepciones y diferencias»
  lista cada recepción, baja o regreso con fecha, quién lo registró, dónde
  quedó y el motivo. Así la misma hoja sirve para mandar con la mercancía
  (recién enviada, todo «En camino») y para archivar la llegada con sus
  diferencias. Para eso la ficha (`getFacilityTransfer`) ganó
  `createdByName`, `sentByName` y `byName` por recepción; la pantalla
  muestra «Lo envió» (o «Lo creó» en borrador).
- **Alcance (WMS-20):** se lee con el mismo servicio que la ficha, así que
  existe solo para quien alcanza el origen o el destino; quien solo alcanza
  un lado no ve las ubicaciones del otro (ni de origen ni de llegada) y la
  ubicación de tránsito nunca se nombra.
- **Permiso nuevo `inventory.facility_transfer.export`**, concedido a los
  mismos roles que `.read` (titular, administración, almacén, supervisión,
  almacenista, Consulta y Gerencia); termina en `.export`, así que sigue
  disponible con el plan vencido.
- **Descarga:** `GET /api/movimientos/traslados/[id]/pdf` (agregada a
  `PROTECTED` en `src/proxy.ts`), con `attachment`, `nosniff` y `no-store`;
  sin permiso o sin traslado responde lo mismo (404). Cada descarga deja
  `inventory.facility_transfer_exported` en la bitácora. Enlace «Descargar
  PDF» en la ficha, solo si la persona tiene el permiso.

## Consecuencias

- Migración `20261114190000_wms_facility_transfers` (solo expansión): valor
  nuevo `FACILITY_TRANSFER` del tipo de movimiento, `location.isTransit` con
  su `CHECK`, cuatro tablas con llaves, `CHECK`s y disparadores, y las reglas
  de tránsito del saldo y de las líneas.
- `MOVEMENT_TYPE_LABELS` gana «Traslado entre almacenes»: aparece en el
  historial, sus filtros y las exportaciones; la reversa lo rechaza.
- `archiveFacility` revisa los traslados abiertos.
- `reconcileStock` no cambia.
