# ADR 0046 — Devoluciones de clientes

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-17 · Completa ADR 0045
(despacho), ADR 0033 (estado del saldo), ADR 0040 (lotes), ADR 0041
(series), ADR 0042 (acomodo) y ADR 0031 (costo promedio)

## Contexto

Lo que sale con un embarque (WMS-16) a veces regresa: el cliente rechaza
parte del pedido, llegó dañado, se equivocaron de producto. El plan v3
(WMS-17) pide **recibir lo devuelto (con o sin pedido), que entre en
inspección y que alguien decida si queda disponible, dañado o rechazado,
con motivo**. Su prueba crítica es la **PC-5: nada devuelto queda
disponible sin decisión**.

El despacho dejó lo necesario (ADR 0045): un `SHIPMENT` no se reversa; qué
salió para qué pedido, con qué lote y series y a qué costo está en
`shipment_line` → `stock_movement_line`; una serie que salió queda fuera
(`serial_unit.locationId = NULL`) y vuelve como la misma unidad con
`serialsForEntry`. El estado `INSPECTION` existe desde WMS-11 y nada que
saca, surte, aparta, cuenta, ajusta o mueve existencias lo toma (todas
esas lecturas son de `AVAILABLE`).

Sin Ventas (ADR 0032): una devolución es un **documento de almacén**: sin
precios, notas de crédito, reembolsos ni cobro.

## Opciones

**Devolver con una entrada manual y después «Cambiar estado».** Ya existe,
pero entra disponible (la PC-5 falla en el primer paso) y no queda ligada
al pedido: nada impide devolver más de lo que salió.

**Reversar el despacho.** El embarque y el pedido seguirían diciendo que
salió (por eso el ADR 0045 lo prohíbe).

**Un documento «devolución de cliente»** que escribe su propia entrada en
inspección y cuyas decisiones son cambios de estado ligados a él. Es lo que
se elige.

## Flujo

1. **Registrar devolución** (Pedidos › «Devoluciones» › «Registrar
   devolución», o desde la ficha de un pedido despachado). Se busca el
   pedido por su número (`PS-0001`) o por su embarque (`EM-0001`; si el
   embarque llevó varios pedidos se elige uno), o se elige «Sin pedido».
   Solo un pedido **despachado** (`SHIPPED`) admite devolución; uno de un
   almacén fuera del alcance de la persona no existe para ella.
2. **Qué regresa.**
   - *Con pedido:* la pantalla lista lo que **salió** de ese pedido,
     agrupado por línea del pedido y lote (suma de sus `shipment_line`):
     producto, lote, series, cantidad que salió y lo ya devuelto. Por cada
     renglón se escribe cuánto regresa (y, si es por serie, cuáles). Nunca
     más de lo que salió menos lo ya devuelto, sumado **bajo el candado del
     pedido** (dos devoluciones a la vez: la segunda ve lo de la primera).
     Un producto por lote vuelve **a su lote** (el que salió). Una serie
     debe haber salido en ese pedido y no haber vuelto ya contra él; entra
     como la misma unidad (`serialsForEntry`).
   - *Sin pedido:* producto, cantidad y, si aplica, lote (código y
     caducidad: `lotForEntry`, existente o nuevo) o series. Lo permite el
     ajuste `inventory.customer_return.without_order` (`allow` por omisión,
     porque hay empresas con existencias anteriores al sistema o clientes
     que devuelven sin referencia; `forbid` lo apaga).
   - Además: quién devuelve (texto; con pedido se propone su
     destinatario), motivo (obligatorio) y notas.
3. **Dónde se recibe.** Una ubicación del almacén donde trabaja la persona,
   dentro de su alcance, no archivada y no «Preparación». Se propone la
   primera de uso «Recepción» (`RECEIVING`), si no hay la primera de uso
   «Cuarentena» y si no «General».
4. **Recibir = entra en inspección.** En una transacción
   (`LOCKING_TRANSACTION`), candados productos → ubicación → pedido (si lo
   hay); después se busca la clave de confirmación (`repeated` si es la
   misma persona con el mismo pedido y las mismas líneas; si no,
   `KEY_REUSED`), se valida todo, `checkPlacement` una vez con todas las
   llegadas en estado `INSPECTION` (una ubicación de cuarentena las admite;
   la capacidad se pregunta como siempre) y se escribe:
   - la devolución (`customer_return`, número `DV-0001` por empresa,
     estado `RECEIVED`);
   - **un movimiento nuevo `CUSTOMER_RETURN`** («Devolución de cliente»),
     referencia `DV-0001`, motivo el de la devolución, con una línea `IN`
     por renglón **en estado `INSPECTION`**, su lote y sus series
     (`writeSerialMoves` antes de las líneas);
   - una `customer_return_line` por renglón (inmutable), ligada a la línea
     del movimiento y, con pedido, a la línea del pedido;
   - los saldos en inspección y el costo (abajo); bitácora
     `inventory.customer_return_received`.
   No crea tarea de acomodo (no es disponible) ni cuenta como disponible.
5. **Costo (ADR 0031).** Con pedido, lo devuelto **vuelve a valer lo que
   valía al salir**: el `unitCost` de las líneas del despacho de esa línea
   del pedido y lote (promedio ponderado por cantidad si fueron varias;
   todas son del mismo `SHIPMENT`). Sin pedido, al **costo promedio
   vigente** (`entry` con costo desconocido = el promedio de hoy). Siempre
   con `openCostBook` y `entry`, bajo el candado del producto; el valor
   cubre todos los estados, así que lo que está en inspección ya cuenta en
   el valor del inventario.
6. **Decidir (PC-5).** En la ficha, cada renglón con algo por revisar
   ofrece tres botones: **«Disponible»**, **«Dañado»** y **«Rechazado»**,
   con cantidad (por omisión, todo lo que falta; se puede decidir una
   parte), series si es por serie, motivo (obligatorio para dañado y
   rechazado; para disponible se propone uno) y, opcional, a dónde va (en
   el mismo almacén). Cada decisión es **un `STATUS_CHANGE` desde
   `INSPECTION`** escrito con el mismo núcleo que «Cambiar estado»
   (`writeStatusChange`: candados, lote, series, `checkPlacement`, saldo,
   bitácora `inventory.status_changed`), ligado a la devolución por una
   fila inmutable `customer_return_decision` (persona, resultado,
   cantidad, motivo, destino y su movimiento). Permisos: los del cambio de
   estado (`permissionForStatusChange("INSPECTION", resultado)`: a
   disponible `inventory.status.release`; a dañado o rechazado
   `inventory.status.change`) y `inventory.transfer.create` si cambia de
   lugar. Candados: productos → ubicaciones → devolución → capacidad. Si
   queda disponible en un lugar «de paso» y el acomodo es por tareas, se
   crea su tarea de acomodo (WMS-52). Cuando no queda nada por revisar la
   devolución pasa a `RESOLVED` en la misma transacción.
7. **El camino lateral.** Se **bloquea**, no se deriva: lo que una
   devolución tiene pendiente en inspección queda **retenido** para ella
   (`heldForReturns`, derivado en cada consulta: recibido − decidido de las
   devoluciones abiertas, por producto, ubicación y lote, y las series que
   entraron con ellas y no se han decidido). «Cambiar estado» desde
   inspección y la reversa de un cambio que sacaría de inspección solo
   toman lo que **no** está retenido; lo demás responde «es de la
   devolución DV-0003: decídelo desde la devolución». Se prefirió bloquear
   a contar el cambio lateral como decisión porque entonces el documento
   diría «por revisar» algo que ya no está, y quien libera desde la ficha
   del producto no ve de qué devolución es ni a qué cliente.
8. **Qué no se puede.** Reversar desde Inventario el movimiento
   `CUSTOMER_RETURN` ni los cambios de estado que son decisiones de una
   devolución (son de un documento; lo decidido mal se corrige con otro
   cambio de estado, ya fuera de la devolución). Devolver contra un pedido
   no despachado. Borrar o cambiar una devolución, sus líneas o sus
   decisiones (disparadores).

## Decisión

- **Tablas:** `customer_return` (número, almacén, ubicación donde se
  recibió, pedido opcional, quién devuelve, motivo, notas, estado,
  movimiento, clave de confirmación, quién y cuándo; `resolvedAt`),
  `customer_return_line` (producto, lote, cantidad en la unidad del
  producto, series como texto, línea del pedido opcional, línea del
  movimiento) y `customer_return_decision` (renglón, resultado
  `AVAILABLE`/`DAMAGED`/`REJECTED`, cantidad, motivo, destino, movimiento
  `STATUS_CHANGE`, persona). Ninguna se borra; líneas y decisiones no
  cambian; de la devolución solo cambian estado y `resolvedAt`.
- **Estados:** `RECEIVED → RESOLVED`, nada más (`CUSTOMER_RETURN_TRANSITIONS`
  de `customer-return-states.ts`, pura, y el disparador
  `customer_return_transition`, que cambian juntos).
- **Movimiento `CUSTOMER_RETURN`:** una entrada de un documento, siempre
  en `INSPECTION` (disparador de su línea), con referencia. No se reversa
  desde Inventario (como `RECEIPT`, `RETURN` y `SHIPMENT`).
- **Permisos nuevos:** `inventory.customer_return.read` (titular,
  administración, almacén, supervisión, almacenista, Consulta y Gerencia,
  como los embarques) e `inventory.customer_return.create` (registrar:
  titular, administración, almacén, supervisión y almacenista). Decidir usa
  los permisos de estado que ya existen; el almacenista registra pero no
  decide (no libera ni marca desde inspección).
- **Ajuste nuevo:** `inventory.customer_return.without_order` (`allow` por
  omisión, `forbid`).
- **Alcance (WMS-20):** una devolución es de su almacén; una de un almacén
  fuera del alcance no existe para la persona (`isFacilityInScope`), y su
  ubicación pasa por `assertLocationsInScope`.
- **Dónde vive:** dentro de «Pedidos» (enlace «Devoluciones» bajo el
  título), no una sección del menú: quien recibe lo devuelto ya trabaja con
  pedidos. En Inicio, «Devoluciones por revisar» solo si hay y solo para
  quien puede decidir. El rastreo de un lote o una serie dice que volvió y
  `/inventario/rastrear` acepta `DV-0001`.
- **Un solo lugar en el código:** `customer-returns.ts`
  (`receiveCustomerReturn`, `decideCustomerReturn`, `findReturnableOrders`,
  `getReturnableOrder`, `listCustomerReturns`, `getCustomerReturn`,
  `countReturnsToReview`, `suggestReturnLocation`), `return-holds.ts`
  (`heldForReturns`, lo retenido) y el núcleo `writeStatusChange` de
  `status-change.ts`.

## Lo que quedó fuera (pendiente)

- **Devolver al proveedor lo rechazado** de un cliente: hoy queda
  «Rechazado» en su lugar y se saca con un ajuste (o queda para WMS-19 y
  una salida por desecho cuando exista).
- ~~**Cantidad dañada al recibir de un proveedor**~~ (la parte del paso que
  no entró aquí): hecha en WMS-54 (ADR 0052), con su propia línea de
  recepción en «Dañado» y la devolución al proveedor desde «Dañado».
- **Devolución en tarima o caja** (contenedor): entra suelta.
- **Varios pedidos en una devolución:** una por pedido.
- **Fotos o archivos** de la inspección.

## Consecuencias

- Migración `20261114180000_wms_customer_returns` (solo expansión): valor
  nuevo `CUSTOMER_RETURN` en el tipo de movimiento, tres tablas con sus
  llaves, `CHECK`s y disparadores.
- `MOVEMENT_TYPE_LABELS` gana «Devolución de cliente»: aparece en el
  historial, sus filtros y las exportaciones; la reversa lo rechaza.
- «Cambiar estado» y la reversa respetan lo retenido por devoluciones.
- `reconcileStock` no cambia: la devolución es un movimiento más.
