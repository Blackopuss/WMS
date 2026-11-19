# Módulo Compras (`purchasing`)

Carpeta `src/modules/purchasing`. Contrato `purchasingModule` (`contract.ts`):
opcional (`required: false`), depende de `inventory` (una recepción es una
entrada de inventario), usa `catalog` y `contacts` (proveedores), dueño de los
permisos `purchasing.*`, sin límites propios.

## Responsabilidad

Comprar a proveedores y recibir lo comprado: relación producto-proveedor con
último costo, órdenes de compra (borrador, envío, recepción parcial o total,
cierre con faltante, cancelación), PDF y envío por correo de la orden,
recepciones (cada una escribe su entrada de inventario), devoluciones al
proveedor, sugerencias de compra por mínimos y reportes; solicitudes de compra
de quien necesita mercancía, con comparación de proveedores (WMS-57, ADR 0055).

Reglas que no se rompen:

- Todo lo que cambia una orden la bloquea (`lockRows(tx, "purchaseOrder", …)`)
  con `LOCKING_TRANSACTION`; la tabla de estados es
  `PURCHASE_ORDER_TRANSITIONS` (`order-states.ts`) y el disparador
  `purchase_order_transition` la repite.
- Las líneas de una orden que ya no es borrador no se escriben; recepciones y
  devoluciones y sus líneas son inmutables.
- Una recepción escribe su movimiento con `postReceiptEntry` y una devolución
  con `postReturnExit` (de Inventario) en la misma transacción. Un movimiento
  `RECEIPT` o `RETURN` no se reversa desde Inventario. Con el acomodo por
  tareas (WMS-52, ADR 0042) `postReceiptEntry` crea ahí mismo las tareas de
  acomodo de lo que entra a un lugar «de paso»; `receivePurchaseOrder` repite
  la recepción entera si otra operación tomó a la vez el mismo número de
  tarea (`isTaskNumberClash`).
- Lo dañado al recibir (WMS-54, ADR 0052): cada línea (y cada lote) dice
  cuánto llegó dañado (`damaged`, en los términos de la línea, y
  `damagedSerials` para un producto por serie). Esa parte es su propia línea
  de recepción (`purchase_receipt_line.status = DAMAGED`, igual que su línea
  de movimiento; disparador): cuenta como recibida, entra en «Dañado» al
  mismo costo, no va en la tarima ni lleva tarea de acomodo. La devolución
  sale del estado de su línea de recepción; `sameReceipt` compara también lo
  dañado.
- Cross-docking (WMS-54, ADR 0052): con `inventory.crossdock.mode = on`,
  `postReceiptEntry` bloquea los pedidos de salida que esperan lo que llega
  (después de la orden de compra: productos → ubicaciones → orden de compra
  → pedidos de salida → tarima → capacidad) y les manda lo sano con tareas
  de surtido; `receivePurchaseOrder` lo devuelve en `crossDock`.
- Los costos solo existen en la respuesta para quien tiene
  `purchasing.cost.read`. Una solicitud de compra nunca lleva costos; la
  comparación de proveedores responde `{ visible: false }` a los demás.
- El almacén de una orden (WMS-57, ADR 0055): `purchase_order.facilityId`
  (no cambia; `NULL` = de toda la empresa, como todas las anteriores). Una
  orden existe para la persona si no tiene almacén o es de uno de su alcance
  (`orderInScope`, en todo lo que lee o cambia una orden: detalle, líneas,
  confirmar, cancelar, cerrar, PDF, correo, recibir, recepciones,
  devoluciones, rastreo y etiquetas); las listas (Compras y Recepción) son del
  almacén activo más las de toda la empresa (`listedOrdersWhere`) y los
  reportes, de todas las que existen para la persona (`visibleOrdersWhere`).
  Se recibe solo en ubicaciones de su almacén.
- Solicitudes de compra (WMS-57): estados con
  `PURCHASE_REQUEST_TRANSITIONS` (`request-states.ts`) y el disparador
  `purchase_request_transition`; sus líneas solo cambian en borrador; no se
  borran. Un borrador es privado de quien lo escribe. Enviar pide la
  autorización (tipo `purchasing.request`, `approvals.ts`) dentro de su
  transacción si la regla está encendida; si no, llega directo «por atender».
  Convertir bloquea productos → solicitud, crea un borrador por proveedor con
  `insertDraftOrder` (el mismo de las sugerencias) y responde `repeated` si ya
  estaba convertida.
- Cada servicio empieza con `assertModulePermission`;
  `tests/purchasing/module-guard.int.test.ts` llama cada función exportada en
  una empresa sin el módulo.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Producto-proveedor | `product-suppliers.ts` | ligar, editar y listar proveedores de un producto y productos de un proveedor; `recordLastCost` (solo dentro de la transacción de una compra) |
| Órdenes | `orders.ts`, `order-states.ts` | crear, editar encabezado y líneas, `submitPurchaseOrder`, `cancelPurchaseOrder`, listar (`toReceive` para Recepción), detalle; `advanceOrderOnReceipt` dentro de la recepción |
| Cierre | `order-close.ts` | `closePurchaseOrder`: cierra una orden `PARTIAL` con faltante |
| PDF | `order-pdf.ts` | `buildOrderPdf` |
| Envío por correo | `order-delivery.ts` | `requestOrderDelivery` (encola), `getOrderDeliveries`; manejador `purchasingJobHandlers` |
| Recepciones | `receipts.ts` | `receivePurchaseOrder` (parcial, destino por línea, lote por línea, series por línea para un producto por serie, todo en una tarima con `container`, WMS-53; lo dañado por línea y lo que fue directo a pedidos, WMS-54; lo sano de un producto que se inspecciona al recibir entra en inspección, WMS-30-0), `getOrderReceipts` (cada línea de recepción dice su estado: dañada o en inspección, y de qué estados puede devolverse, `returnStates`), `findReceiptConfirmation` |
| Devoluciones | `returns.ts` | `returnToSupplier` (un producto por serie devuelve unidades que llegaron con esa línea de recepción; lo dañado sale de «Dañado», WMS-54; cada renglón puede decir de qué estado sale, `status`, según solo cómo llegó su línea de recepción, `returnStatesFor` de `return-states.ts`: dañada solo de dañado; en inspección de inspección, disponible, rechazado o dañado; disponible de disponible, rechazado o dañado; las existencias del mismo producto, lote, ubicación y estado son intercambiables entre recepciones, WMS-30-0, ADR 0068), `findReturnConfirmation` |
| Sugerencias | `suggestions.ts` | `getPurchaseSuggestions`, `generateSuggestedOrders` (borradores por proveedor, con `insertDraftOrder`) |
| Solicitudes | `requests.ts`, `request-states.ts`, `approvals.ts` | `createPurchaseRequest`, `updatePurchaseRequest`, `addRequestLine`, `updateRequestLine`, `removeRequestLine`, `submitPurchaseRequest` (`pending_approval` con la regla encendida), `cancelPurchaseRequest`, `rejectPurchaseRequest`, `convertPurchaseRequest`, `listPurchaseRequests` (`attend`, `mine`, `all`), `getPurchaseRequest`, `countRequestsToAttend`; tipo de aprobación `PURCHASING_APPROVAL_TYPES` |
| Comparar proveedores | `supplier-comparison.ts` | `compareSuppliers`: último costo por unidad del producto, días de entrega y cumplimiento (y dañado) de las últimas 10 órdenes de cada proveedor, con tope de 500 órdenes (`truncated`) y el sugerido |
| Reportes | `reports.ts` | `getPendingReport`, `getPurchasesBySupplier`, `buildPurchaseReport` (archivo) |
| Al quitar el módulo | `deactivation.ts` | `purchasingOpenWork`: lo que quedaría a medias, para la consola |
| Búsqueda global | `search.ts` | `PURCHASING_SEARCH_SOURCES` (WMS-66, ADR 0081): órdenes `OC-` y solicitudes `SC-` por número (confirmadas con `getPurchaseOrder`/`getPurchaseRequest`) y proveedores por nombre o RFC (una consulta con las condiciones de `listSuppliers`) |

Proveedores (`createSupplier`, `listSuppliers`…) viven en
[contacts](contacts.md) y usan los permisos `purchasing.supplier.*`.

## Permisos

`purchasing.supplier.read|create|update`,
`purchasing.product_supplier.read|create|update`, `purchasing.cost.read|record`,
`purchasing.order.read|create|update|submit|export|send|cancel|close`,
`purchasing.receipt.read|create`, `purchasing.return.read|create`,
`purchasing.suggestion.read|generate`, `purchasing.report.read|export`,
`purchasing.request.read|create` (WMS-57: Almacén y supervisión piden sin
comprar; atender y convertir exige `purchasing.order.create`).

## Tablas

`product_supplier`, `purchase_order`, `purchase_order_line`,
`purchase_order_delivery`, `purchase_receipt`, `purchase_receipt_line`,
`purchase_return`, `purchase_return_line`, `purchase_request`,
`purchase_request_line`. Usa `contact` (núcleo) y escribe en
las de Inventario solo por `postReceiptEntry`/`postReturnExit`.

## Ajustes de operación

| Clave | Opciones | Qué decide |
| --- | --- | --- |
| `purchasing.compare.min_fulfillment` | `any`, `80`, `90` (omisión), `95` | Proveedor sugerido al comparar: el de menor costo por unidad entre los que entregaron al menos ese porcentaje (o no tienen historial) |

## Tipos de aprobación

`purchasing.request` («Solicitudes de compra»): autoriza `purchasing.order.create`;
sin umbral.

## Avisos

Tipos en `notices.ts` (`PURCHASING_NOTIFICATION_TYPES`), registrados en
`src/modules/registry/notifications.ts` (WMS-39, ADR 0057), sin costos ni
proveedores:

| Tipo | Quién lo manda | A quién |
| --- | --- | --- |
| `purchasing.request_to_attend` | `submitPurchaseRequest` (regla apagada) y el efecto de autorizarla | `purchasing.order.create` que alcance el almacén de la solicitud |
| `purchasing.request_answered` | `rejectPurchaseRequest`, `convertPurchaseRequest` | quien la pidió (la autorización rechazada la avisa `approvals.decided`) |

## Eventos de webhooks

`purchasing.receipt.confirmed` (`webhooks.ts`, `PURCHASING_WEBHOOK_EVENTS`):
lo emite `receivePurchaseOrder` en su transacción, con lo que entró por
línea (producto, ubicación, lote, cantidad base, dañado) y cómo quedó la
orden; nunca costos (WMS-60, ADR 0058). `ReceiptSummary` agrega producto,
cantidad base, unidad y lote de cada línea para la API.

## Trabajos en segundo plano

| Tipo | Manejador | Qué hace |
| --- | --- | --- |
| `purchasing.send_order` | `purchasingJobHandlers` (`order-delivery.ts`) | Manda la orden en PDF por correo al proveedor; `onFailed` cierra el envío como fallido |

## Pantallas

`/compras` (órdenes, proveedores, sugerencias, reportes, solicitudes),
`/compras/solicitudes` («Por atender», «Mis solicitudes», «Todas»),
`/compras/solicitudes/nueva` («Solicitar compra», también desde «Existencias
bajas» y la ficha del producto), `/compras/solicitudes/[id]` (y `/producto`) y
`/recepcion` (órdenes `SENT`/`PARTIAL` por recibir). Descargas en
`/api/compras/…`.

**Almacén archivado (WMS-82, ADR 0077).** `createPurchaseOrder` y
`createPurchaseRequest` toman el almacén de la orden o la solicitud compartido
(`holdOpenFacility`) dentro de su transacción y rechazan uno archivado;
`convertPurchaseRequest` lo toma después de los productos y antes de la
solicitud (la solicitud se cierra en la misma transacción que abre la orden). Archivar un almacén se rechaza con órdenes
(borrador, enviada, parcial) o solicitudes (borrador, enviada, por atender)
de ese almacén.

## ADR

0016 (contactos), 0017 (producto-proveedor y costos), 0018 (órdenes), 0019
(PDF propio), 0020 (envío por correo), 0021 (recepción), 0052 (cross-docking y
daños al recibir), 0055 (solicitudes de compra y almacén de las órdenes),
0057 (avisos).

## Pruebas

`tests/purchasing/*.int.test.ts` (incluye concurrencia de recepciones y el guard
del módulo; `requests.int.test.ts` y `order-facility.int.test.ts`, WMS-57),
`order-states.test.ts` y `request-states.test.ts`.
