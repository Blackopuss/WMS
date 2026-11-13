# ADR 0045 — Despacho y embarques

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-16 · Completa ADR 0044
(empaque), ADR 0043 (contenedores), ADR 0041 (series), ADR 0033 (reservas)
y ADR 0019 (PDF)

## Contexto

Al terminar el surtido (WMS-14) lo de un pedido espera en «Preparación»,
apartado para sus líneas; si la empresa empaca (WMS-15), además está dentro
de bultos (`container` con `purpose = PACKING`) y el pedido queda `PACKED`.
Falta que la mercancía **salga**: la especificación (5.2) y el plan v3
(WMS-16) piden armar un **embarque** con uno o varios pedidos, registrar
transportista, guía, placas y quién se lo lleva, y **confirmar la salida**:
escribir la salida de inventario una sola vez (clave `ship:<id>`), consumir
lo apartado en preparación, cerrar los pedidos, dar un PDF del embarque y
dejar la entrega rastreable (en qué embarque salió un lote o una serie, a
quién y con qué guía).

Preguntas del paso: qué es un embarque, qué pedidos pueden salir, cómo se
escribe la salida sin descontar dos veces, qué pasa con los bultos y qué se
conserva de ellos, y dónde vive en pantalla.

## Opciones

**Despachar pedido por pedido** (un botón «Despachar» en cada pedido). Es lo
más corto, pero no responde lo que pide el plan: un camión se lleva varios
pedidos con un solo transportista, una guía y una hoja firmada.

**Un documento «embarque» que agrupa pedidos** y que se confirma una vez. El
camión es el embarque: sus datos (transportista, guía, placas, quién se lo
lleva) son de él, no de cada pedido; la hoja de embarque es una y la firma
también. Un pedido solo puede ir en un embarque abierto.

**Se elige el embarque.** Para un solo pedido, el embarque tiene uno.

Para la salida: **un movimiento por embarque** (tipo nuevo `SHIPMENT`, clave
`ship:<id del embarque>`, referencia `EM-0001`) con una línea por renglón
de bulto o por lo suelto de cada línea del pedido, y no un movimiento por
pedido: la clave del plan es la del embarque, y una sola clave hace que
confirmar dos veces (o dos personas a la vez) no pueda escribir dos
salidas. Qué pedido llevó cada línea lo dice `shipment_line` (inmutable),
que apunta a la línea del movimiento: de ahí salen el PDF, la ficha del
pedido y la trazabilidad.

## Flujo

1. **Listo para salir.** Con `inventory.packing.mode = on` solo un pedido
   `PACKED` («no se despacha sin empacar»). Con `off`, también `PICKED`
   (despacho directo desde preparación). Un pedido `PACKING` nunca sale (el
   empaque está a medias), ni uno con una tarea de surtido abierta, ni uno
   de otro almacén. En «Pedidos» el filtro «Por despachar» lista los listos;
   en Inicio, «Pedidos por despachar» aparece solo si hay y solo para quien
   puede despachar.
2. **Armar el embarque.** Pedidos › «Embarques» › «Armar embarque»: casillas
   con los pedidos listos del almacén donde trabaja la persona que no están
   en otro embarque abierto, y los datos del transporte: transportista
   (texto libre: no hay catálogo de transportistas), guía o número de
   rastreo, placas, quién se lo lleva y notas. Todo opcional; si la empresa
   quiere exigirlo, lo dice el ajuste `inventory.shipment.details`
   («Transportista y quién se lo lleva, obligatorios»), que se comprueba al
   confirmar la salida. El embarque nace en borrador (`DRAFT`) con su número
   `EM-0001` y es del almacén activo. Desde la ficha de un pedido listo,
   «Armar embarque» abre el formulario con ese pedido marcado.
3. **Mientras es borrador** se cambian sus datos, se agregan pedidos listos
   y se quitan. Un pedido va en **un solo embarque abierto** (lo impide un
   índice único en la base, no solo el servicio). «Cancelar embarque» (con
   motivo) suelta sus pedidos, que siguen listos; nada se movió.
4. **Confirmar salida.** Botón grande en la ficha, con confirmación clara
   («No se puede deshacer»). En **una transacción** (`LOCKING_TRANSACTION`):
   - candados: productos de todos sus pedidos → ubicaciones donde espera lo
     apartado → embarque → pedidos → bultos (`lockRows`), y todo se relee
     bajo ellos; si el embarque cambió de pedidos o lo apartado de lugar
     antes de los candados, se repite;
   - ya despachado responde `repeated` (dos confirmaciones a la vez: una
     escribe, la otra responde `repeated`); además la clave `ship:<id>` es
     única en la empresa (`stock_movement.idempotencyKey`);
   - cada pedido se revisa otra vez (listo según el ajuste de hoy, del mismo
     almacén, sin tareas de surtido abiertas, bultos cerrados) y lo que
     traen sus bultos debe ser **exactamente** lo que su reserva aparta en
     preparación; si no, se dice qué pedido revisar y no sale nada;
   - **lo que sale es exactamente lo apartado en preparación**: lo pedido
     menos lo que faltó al surtir o al empacar (ya liberado entonces);
   - primero se escribe el encabezado del movimiento; después se **vacían
     los bultos** (se borra su `container_item`, se suelta
     `serial_unit.containerId`, un evento `SHIPPED` por renglón con
     producto, lote, cantidad, series y el movimiento, y el contenedor queda
     `CLOSED`), porque la base no deja bajar un saldo por debajo de lo
     contenido; luego se **consumen** las reservas de preparación de cada
     línea (y se sueltan las viejas sin ubicación, si quedara alguna) y se
     comprueba que lo que sale ya no le quite nada a otro (`freeToTake`);
   - la salida: series con `serialsForTake` + `writeSerialMoves` (las
     unidades quedan fuera del almacén), costo promedio con `openCostBook`
     y `exit` como cualquier salida (bajo el candado del producto), líneas
     con su lote, y cada saldo baja una vez con `updateMany` condicionado;
   - `shipment_line` por cada línea (pedido, línea del pedido, producto,
     ubicación, lote, bulto, cantidad, series y línea del movimiento);
   - los pedidos pasan a `SHIPPED` y el embarque a `SHIPPED` (con quién y
     cuándo, y su movimiento); bitácora `inventory.shipment_dispatched`.
   Todo o nada. Un embarque cuyos pedidos no traen nada (todo faltó) sale
   sin movimiento.
5. **Si la respuesta se pierde** (INV-22), la pantalla pregunta si el
   embarque ya está despachado antes de dejar intentar otra vez; la clave
   es el propio embarque.
6. **PDF.** «Descargar PDF» (hoja de embarque, sin precios): datos del
   almacén y del transporte; por pedido, destinatario, dirección y
   referencia, sus productos (cantidad, lote y series) y sus bultos (código,
   tipo y peso); total de bultos y de peso, y renglones de firma «Entrega» y
   «Recibe». Un borrador dice arriba «BORRADOR · todavía no sale»; uno
   cancelado, «CANCELADO».
7. **Trazabilidad.** El rastreo de un lote o de una serie dice en qué
   embarque salió, para qué pedido y destinatario, con transportista y guía;
   `/inventario/rastrear` acepta el número `EM-0001`; la ficha del pedido
   muestra su embarque y lo que salió; el resumen del día cuenta los pedidos
   despachados hoy con la misma condición que su lista (`/pedidos?salio=…`).

## Decisión

- **Tablas:** `shipment` (número `EM-0001`, almacén, estado
  `DRAFT`/`SHIPPED`/`CANCELLED`, datos del transporte, quién y cuándo
  salió, su movimiento, cancelación con motivo), `shipment_order` (un pedido
  en un embarque; `openOrderId` = el pedido mientras el embarque no esté
  cancelado, único por empresa: un pedido no entra en dos embarques
  abiertos) y `shipment_line` (lo que salió, inmutable). Ninguna se borra
  salvo un `shipment_order` mientras su embarque es borrador (quitar un
  pedido).
- **Estados del embarque:** `DRAFT → SHIPPED`, `DRAFT → CANCELLED`; nada
  más. `SHIPMENT_TRANSITIONS` (`shipment-states.ts`, pura) y el disparador
  `shipment_transition` cambian juntos. Un embarque despachado o cancelado
  no cambia (disparador). Despachado exige que todos sus pedidos ya estén
  `SHIPPED` y que su movimiento, si tiene, sea `SHIPMENT`.
- **Estados del pedido:** se agrega `PICKED → SHIPPED` (despacho con el
  empaque apagado) a `OUTBOUND_ORDER_TRANSITIONS` y al disparador
  `outbound_order_transition`, que además exige que un pedido pase a
  `SHIPPED` solo dentro de un embarque (`shipment_order` abierto). Un pedido
  despachado no se cancela ni se edita (ya era así).
- **Movimiento `SHIPMENT`** («Despacho»): una salida de un documento. **No
  se reversa desde Inventario** (como `RECEIPT` y `RETURN`): el embarque y
  sus pedidos seguirían diciendo que salió. Lo que regresa entra con una
  devolución de cliente (WMS-17).
- **Bultos al salir:** evento nuevo `SHIPPED` en `container_event`, uno por
  renglón, con el movimiento; el contenedor queda `CLOSED`. Lo que llevaba
  cada bulto queda en esos eventos y en `shipment_line.containerId`.
- **Candados:** productos → ubicaciones → embarque → pedidos → bultos. El
  embarque va antes que sus pedidos también al agregar o quitar pedidos;
  empacar (que no toca embarques) sigue productos → ubicaciones → pedido →
  bultos: el orden parcial es el mismo.
- **Permisos nuevos:** `inventory.shipment.read` (ver embarques: los mismos
  que ven pedidos), `inventory.shipment.create` (armar, cambiar datos,
  agregar y quitar pedidos, cancelar un borrador),
  `inventory.shipment.dispatch` (confirmar la salida) y
  `inventory.shipment.export` (PDF). Armar y despachar: titular,
  administración, almacén, supervisión y almacenista (el almacenista ya
  registra salidas y empaca: cargar el camión es trabajo de piso). Gerencia
  y Consulta: ver y descargar el PDF. Ni compras ni montacargas.
- **Ajuste nuevo** `inventory.shipment.details` (`optional` por omisión,
  `required`): si la empresa exige transportista y quién se lo lleva antes
  de confirmar.
- **Alcance (WMS-20):** un embarque es de su almacén; uno de un almacén
  fuera del alcance de la persona no existe para ella (`isFacilityInScope`),
  como los pedidos.
- **Dónde vive:** dentro de «Pedidos» (enlace «Embarques» bajo el título y
  filtro «Por despachar»), no una sección nueva del menú: despachar es el
  último paso del pedido y quien despacha ya trabaja en Pedidos; el aviso de
  Inicio lleva directo a los pedidos por despachar.
- **Un solo lugar en el código:** `shipments.ts` (`createShipment`,
  `updateShipment`, `addShipmentOrders`, `removeShipmentOrder`,
  `cancelShipment`, `dispatchShipment`, `listShipments`, `getShipment`,
  `listReadyOrders`, `countOrdersToShip`, `shippedOnWhere`) y
  `shipment-pdf.ts` (`buildShipmentPdf`).

## Lo que debe saber la devolución de clientes (WMS-17)

- Un pedido `SHIPPED` y su embarque no cambian; lo que regresa es un
  documento nuevo. Qué salió (producto, lote, series, bulto, para qué
  pedido) está en `shipment_line`, ligado a la línea del movimiento
  `SHIPMENT`; una serie que salió queda con `serial_unit.locationId = NULL`
  y vuelve como la misma unidad con `serialsForEntry`.
- El movimiento `SHIPMENT` no se reversa: la devolución escribe su propia
  entrada (en inspección, PC-5) y puede citar el embarque y el pedido.
- El costo de lo que salió está en `stock_movement_line.unitCost` de cada
  línea del despacho, por si la devolución quiere entrar a ese costo (como
  la reversa de una salida).

## Lo que quedó fuera (pendiente)

- **Andenes o puertas de salida** y mover bultos a ellos antes de cargar.
- **Despacho parcial de un pedido** (que una parte salga hoy y otra
  después): hoy sale todo lo apartado del pedido.
- **Catálogo de transportistas** (hoy texto libre) y conexión con sus
  sistemas para generar guías.
- **Imprimir etiquetas** de bulto (WMS-26).
- **Varios almacenes en un embarque** (cada embarque es de su almacén).

## Consecuencias

- Migración `20261114160000_wms_shipments` (solo expansión): enumeraciones
  con valores nuevos (`SHIPMENT` en el tipo de movimiento, `SHIPPED` en la
  historia del contenedor), tres tablas nuevas con sus llaves foráneas,
  `CHECK`s y disparadores, y el disparador `outbound_order_transition`
  reemplazado con la tabla nueva.
- `MOVEMENT_TYPE_LABELS` gana «Despacho»: aparece en el historial, sus
  filtros y las exportaciones; la reversa lo rechaza con motivo.
- El resumen del día agrega «Pedidos despachados» (`shippedOnWhere`).
- Una operación nueva que saque existencias de preparación por un pedido
  pregunta primero si ese pedido está en un embarque abierto.
