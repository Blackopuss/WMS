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
proveedor, sugerencias de compra por mínimos y reportes.

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
- Los costos solo existen en la respuesta para quien tiene
  `purchasing.cost.read`.
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
| Recepciones | `receipts.ts` | `receivePurchaseOrder` (parcial, destino por línea, lote por línea, series por línea para un producto por serie, todo en una tarima con `container`, WMS-53), `getOrderReceipts`, `findReceiptConfirmation` |
| Devoluciones | `returns.ts` | `returnToSupplier` (un producto por serie devuelve unidades que llegaron con esa línea de recepción), `findReturnConfirmation` |
| Sugerencias | `suggestions.ts` | `getPurchaseSuggestions`, `generateSuggestedOrders` (borradores por proveedor) |
| Reportes | `reports.ts` | `getPendingReport`, `getPurchasesBySupplier`, `buildPurchaseReport` (archivo) |
| Al quitar el módulo | `deactivation.ts` | `purchasingOpenWork`: lo que quedaría a medias, para la consola |

Proveedores (`createSupplier`, `listSuppliers`…) viven en
[contacts](contacts.md) y usan los permisos `purchasing.supplier.*`.

## Permisos

`purchasing.supplier.read|create|update`,
`purchasing.product_supplier.read|create|update`, `purchasing.cost.read|record`,
`purchasing.order.read|create|update|submit|export|send|cancel|close`,
`purchasing.receipt.read|create`, `purchasing.return.read|create`,
`purchasing.suggestion.read|generate`, `purchasing.report.read|export`.

## Tablas

`product_supplier`, `purchase_order`, `purchase_order_line`,
`purchase_order_delivery`, `purchase_receipt`, `purchase_receipt_line`,
`purchase_return`, `purchase_return_line`. Usa `contact` (núcleo) y escribe en
las de Inventario solo por `postReceiptEntry`/`postReturnExit`.

## Ajustes de operación

Ninguno todavía.

## Trabajos en segundo plano

| Tipo | Manejador | Qué hace |
| --- | --- | --- |
| `purchasing.send_order` | `purchasingJobHandlers` (`order-delivery.ts`) | Manda la orden en PDF por correo al proveedor; `onFailed` cierra el envío como fallido |

## Pantallas

`/compras` (órdenes, proveedores, sugerencias, reportes) y `/recepcion` (órdenes
`SENT`/`PARTIAL` por recibir). Descargas en `/api/compras/…`.

## ADR

0016 (contactos), 0017 (producto-proveedor y costos), 0018 (órdenes), 0019
(PDF propio), 0020 (envío por correo), 0021 (recepción).

## Pruebas

`tests/purchasing/*.int.test.ts` (incluye concurrencia de recepciones y el guard
del módulo) y `order-states.test.ts`. Pendiente conocido (ADR 0038): los
documentos de Compras no tienen almacén.
