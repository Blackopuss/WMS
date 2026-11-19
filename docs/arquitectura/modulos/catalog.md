# Plataforma: catálogo de productos (`platform/catalog`)

## Responsabilidad

Productos (clave, código de barras, categoría, marca, unidad, paso de cantidad,
peso y volumen por unidad, control por lote y caducidad), unidades de medida,
presentaciones («caja de 12») con historial de su contenido, y la conversión
exacta de lo capturado a la unidad del producto. Es del núcleo porque todo
módulo trabaja con productos; el cupo `active_products` lo comparten todos.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Productos | `products.ts` | `createProduct` (consume cupo), `updateProduct`, `archiveProduct` (sus mensajes de rechazo solo nombran y cuentan órdenes y existencias del alcance de la persona, WMS-57B), `reactivateProduct`, `getProduct`, `listProducts`, filtros y grupos, `normalizeSearch`; etiquetas de control por lote. Crear y editar reciben `customFields` (WMS-58) y los validan y guardan con [custom-fields](custom-fields.md) en su transacción (`customErrors`); `listProducts` filtra por campo (`custom`) y acepta una condición más ya armada por quien llama (`also`, WMS-87: el filtro por estado de las existencias, que construye Inventario) |
| Unidades | `units.ts` | `UNITS`, `convertUnits`, `formatQuantity`, dimensiones |
| Cantidades | `quantity.ts`, `measures.ts` | `parseQuantity` (regla del producto; nunca `Number()`), `parseMeasure`, peso y volumen por unidad |
| Presentaciones | `presentations.ts` | `createPresentation`, `changePresentationFactor` (versión nueva), `listPresentations`, `listPresentationVersions` |
| Conversión | `conversion.ts`, `conversion-service.ts` | `resolveConversion(tx, productId, captura)` dentro de la transacción de un movimiento; `previewConversion` para mostrar la equivalencia |
| Importación | `imported-products.ts` | `applyImportedProduct` (lo usa la importación de Inventario) |

## Permisos

`inventory.product.read|create|update|archive|reactivate` e
`inventory.presentation.read|create|update` (del módulo Inventario).

## Tablas

`product`, `product_category`, `product_brand`, `unit` (sembrada por migración,
referencia sin empresa), `product_presentation`, `presentation_version`. El
costo promedio no está aquí: es `product_cost` de [inventory](inventory.md).

## Ajustes y trabajos

Ninguno.

## ADR

0012 (movimientos: conversión y presentaciones que guardan las líneas), 0031
(el costo vive fuera de `product`), 0040 (control por lote), 0056 (campos personalizados).
