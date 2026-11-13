# ADR 0055 — Solicitudes de compra y comparación de proveedores

Fecha: 2026-11-15 · Estado: aceptada · Paso: WMS-57 y el pendiente «los
documentos de Compras no tienen almacén» de ADR 0035 y ADR 0038 · Usa ADR
0053 (aprobaciones) · Completa ADR 0017 (producto-proveedor y costos), ADR
0018 (órdenes de compra) y ADR 0021 (recepción)

## Contexto

Hoy solo Compras escribe órdenes: quien ve que algo hace falta en el almacén
lo dice por fuera del sistema y nadie sabe en qué quedó. El plan v3 (WMS-57)
pide que quien necesita mercancía la **solicite**, que Compras la **apruebe**
con el motor de WMS-56, **compare proveedores** (último costo, tiempo de
entrega, cumplimiento de recepciones) y la **convierta en orden de compra**.
Sus pruebas: una solicitud se convierte en una sola orden; la comparación
contra datos conocidos; costos solo para quien puede verlos.

Además, las órdenes de compra no tenían almacén (ADR 0035, ADR 0038): una
persona limitada a un almacén veía todas las órdenes y recepciones de la
empresa. Una solicitud es del almacén de quien pide, y la orden que sale de
ella también; por eso se resuelven juntos.

## Flujo operativo

1. **Pedir** (quien tiene `purchasing.request.create`: titular,
   administración, Almacén, Comprador y supervisión). Desde «Existencias
   bajas», desde la ficha de un producto («Solicitar compra», con el producto
   ya elegido) o desde Compras › Solicitudes: busca el producto por nombre,
   clave o código de barras (o con la cámara), dice cuánto (en su unidad o en
   una presentación, como en una orden), para cuándo lo necesita (opcional) y
   una nota. Queda un **borrador** `SC-0001` del almacén activo de quien
   pide; puede agregar más productos (uno por línea, hasta 100) y quitarlos.
   **Sin costos**: quien pide no los ve ni los escribe.
2. **Enviar.** Con la regla de aprobación de solicitudes **apagada** (por
   omisión) la solicitud llega directo a Compras como **por atender**. Con la
   regla **encendida** (Configuración › Aprobaciones, tipo
   `purchasing.request`) queda **esperando autorización**: se abre una
   solicitud de aprobación (WMS-56) y quien puede autorizar la ve en
   Aprobaciones. Al autorizar pasa a por atender; al rechazar, a
   **rechazada** con su motivo.
3. **Retirar.** Quien pidió la cancela mientras no esté autorizada (borrador
   o esperando autorización). Si esperaba autorización, primero se retira esa
   solicitud de aprobación y después se cancela; si en medio alguien la
   autorizó, se le dice y no se cancela.
4. **Atender** (Compras, `purchasing.order.create`). En Compras ›
   Solicitudes › «Por atender» abre la solicitud. Quien tiene
   `purchasing.cost.read` ve la **comparación de proveedores** de cada
   producto (abajo) con el sugerido marcado; elige el proveedor de cada línea
   (o uno para todas) y **Crear orden**: sale **un borrador de orden por
   proveedor** con sus líneas. O la **rechaza** con motivo («ya hay», «no se
   compra»).
5. **Seguir.** Quien pidió ve en su solicitud en qué va: borrador, esperando
   autorización, por atender, rechazada (con el motivo), o convertida en
   «OC-0012 · Enviada», «OC-0013 · Recibida». Nunca ve costos ni la
   comparación.

## Estados

`DRAFT → SUBMITTED | APPROVED | CANCELLED`, `SUBMITTED → APPROVED |
REJECTED | CANCELLED`, `APPROVED → CONVERTED | REJECTED`; rechazada,
convertida y cancelada son finales. La tabla pura es
`PURCHASE_REQUEST_TRANSITIONS` (`request-states.ts`, con prueba unitaria) y
el disparador `purchase_request_transition` la repite; además número,
almacén y quién la pidió no cambian, una solicitud no se borra, sus líneas
solo cambian en borrador (disparadores) y cada estado lleva sus datos
(`CHECK`).

«Esperando autorización» es `SUBMITTED` **con** una solicitud de aprobación
pendiente (`openKey = purchase_request:<id>`). Si quien pidió retira esa
aprobación desde Aprobaciones, o vence, la solicitud sigue `SUBMITTED` sin
aprobación pendiente: la pantalla dice «Se retiró la autorización» y ofrece
**Enviar de nuevo** (abre otra, o la pasa a por atender si la regla ya está
apagada) o **Cancelar**. Así el motor de aprobaciones no necesita saber de
compras (no hay un gancho «al retirar»), y no queda ningún estado colgado.

## Aprobación (WMS-56)

Tipo `purchasing.request` en `src/modules/purchasing/approvals.ts`:
`requestPermissions = purchasing.request.create`; `decidePermissions =
purchasing.order.create` (autorizar no da más poder que el que ya se tiene:
lo que se autoriza es comprar). Sin umbral: con la regla encendida toda
solicitud enviada espera. Se pide **dentro de la transacción de «Enviar»,
después del candado de la solicitud**, con el almacén de la solicitud (así
solo la decide quien alcanza ese almacén) y un resumen sin costos («SC-0003:
3 productos, para el 20 de noviembre»). El efecto bloquea la solicitud,
vuelve a comprobar que siga `SUBMITTED` y la pasa a `APPROVED`; si ya no
espera, lanza `ApprovalExpired`. Rechazar la pasa a `REJECTED` con el motivo
de quien decidió. Lo que escribe va a nombre de quien la pidió con
`autorizadoPor` en su bitácora, como los ajustes.

**Candados:** aprobación → solicitud (decidir); solicitud (enviar, cancelar,
convertir, rechazar desde Compras). Enviar **inserta** la aprobación, no
bloquea una existente; cancelar retira la aprobación en su propia
transacción y después bloquea la solicitud. Convertir: productos de la
solicitud → solicitud → órdenes nuevas. No hay ciclo.

## Comparar proveedores

`compareSuppliers(actor, requestId)`; para quien no tiene
`purchasing.cost.read` responde `{ visible: false }` y **ningún** dato de
proveedores ni costos (el detalle de la solicitud nunca los trae). Para
cada producto de la solicitud, los proveedores vinculados (`product_supplier`,
no archivados), con:

- **Último costo**: el de `product_supplier` (CMP-13), por lo que se compró
  (una caja o una pieza) y llevado a la unidad del producto con el contenido
  de la versión con que se pagó, para comparar proveedores que venden en
  presentaciones distintas.
- **Tiempo de entrega**: de las últimas 10 órdenes de ese proveedor que se
  dieron por enviadas y ya recibieron algo, los días entre `sentAt` y su
  primera recepción, en promedio.
- **Cumplimiento**: de las últimas 10 órdenes de ese proveedor ya
  **recibidas o cerradas con faltante**, qué parte de lo pedido llegó
  (promedio por línea, en los términos de cada línea, sin pasar de 100 %), y
  qué parte de lo recibido llegó **dañado** (WMS-54).

Todo se deriva en la consulta, sin banderas ni tablas de resumen; se leen a
lo más 500 órdenes en total y, si se corta, la respuesta dice `truncated` y
la pantalla lo avisa. **Sugerido:** el de menor costo por unidad entre los
que cumplen el mínimo de la empresa — ajuste `purchasing.compare.min_fulfillment`
(sin mínimo, 80 %, **90 %** por omisión, 95 %); un proveedor sin historial
cuenta como que cumple —, y si ninguno tiene costo, ninguno. La pantalla
dice el criterio en una línea.

La ventana de 10 órdenes es fija (es una forma de medir, no una forma de
trabajar). Si una empresa la pide distinta, será otro ajuste.

## Convertir en orden

`convertPurchaseRequest(actor, requestId, { suppliers })`, con
`purchasing.order.create`: el navegador manda solo qué proveedor para cada
línea. En una transacción (`LOCKING_TRANSACTION`): productos de la solicitud
→ solicitud; si ya está `CONVERTED` responde `repeated` con sus órdenes (un
doble clic o dos personas a la vez **convierten una sola vez**); si no está
`APPROVED`, se rechaza. Comprueba cada proveedor (de la empresa, activo y
proveedor) y cada producto (activo), y crea **un borrador por proveedor**
con `insertDraftOrder` de `orders.ts` — la misma función que usan ahora las
sugerencias (CMP-14): número siguiente, `resolveConversion` con lo que pidió
(misma presentación y cantidad; el contenido vigente), código del producto en
ese proveedor, y el último costo solo para quien puede registrarlo y solo si
fue por esa misma forma de compra. La orden guarda `purchaseRequestId` y el
almacén de la solicitud, y como fecha esperada el «para cuándo». La
solicitud queda `CONVERTED`, con quién y cuándo, y bitácora
(`purchase_request.converted` y `purchase_order.created` por orden).

Las sugerencias desde mínimos (CMP-14) **siguen igual**: no se fusionan. Una
solicitud por atender **no** cuenta como «en camino» en las sugerencias:
nadie la ha pedido todavía a un proveedor, y contarla escondería una
sugerencia; al convertirla, su borrador sí cuenta (como todo borrador).

## El almacén de las órdenes

- `purchase_order.facilityId` (admite `NULL`; no cambia, disparador
  `purchase_order_origin`). Una orden nueva es del almacén activo de quien la
  crea, o del que elija entre los que alcanza; la que sale de una solicitud,
  del almacén de la solicitud. Las órdenes que ya existían quedan sin
  almacén: **de toda la empresa**, visibles como antes. Las que crean las
  sugerencias tampoco llevan almacén: se calculan con las existencias de
  toda la empresa y solo las ve quien no tiene límite.
- **Existe para la persona** una orden sin almacén o de un almacén de su
  alcance (`isFacilityInScope`); si no, «no existe» (`not_found`/`null`):
  detalle, cambios, confirmar, cancelar, cerrar, PDF, correo, recibir,
  recepciones, devoluciones, rastreo y etiquetas de recepción.
- **Listas** (Compras y Recepción): las del almacén activo más las que no
  tienen almacén. **Reportes** (pendientes, compras por proveedor): todas las
  que existen para la persona.
- **Recibir:** si la orden tiene almacén, cada ubicación de destino debe ser
  de ese almacén (además del alcance de siempre); si no, «Esta orden es del
  almacén X».

## Pendientes

- Aviso por correo a Compras de una solicitud nueva (como en ADR 0053).
- Que el piso (Almacenista) pida: decisión del fundador.
- Ventana de la comparación como ajuste, y medir el tiempo de entrega contra
  la fecha esperada de la orden.
- Elegir de la comparación una presentación distinta de la que se pidió.
- Mover una orden sin almacén a un almacén.

## Alternativas descartadas

- **Usar la orden en borrador como solicitud:** quien pide vería órdenes,
  proveedores y costos.
- **Un permiso «aprobar solicitudes» en la matriz:** el motor de WMS-56 ya
  decide con roles por empresa y el permiso de la operación.
- **Un gancho «al retirar» en el motor de aprobaciones:** cambiaría la
  plataforma por una sola necesidad; derivar «se retiró la autorización» de
  la solicitud de aprobación basta.
- **Guardar cumplimiento y tiempo de entrega por proveedor:** se
  desactualizan con cada recepción; derivados en la consulta, con tope, no.
