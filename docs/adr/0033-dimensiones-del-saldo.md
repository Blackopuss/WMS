# ADR 0033 — Dimensiones del saldo: estado y lote

Fecha: 2026-11-09 · Estado: aceptada · Paso: WMS-09 (plan v2) · Amplía: ADR 0012

## Contexto

Hoy `stock_balance` tiene una fila por empresa, producto y ubicación (ADR 0012).
La especificación del WMS pide distinguir el **estado** de lo que hay
(disponible, en recepción, en inspección, en cuarentena, dañado, rechazado, en
tránsito, bloqueado; sección 6.2), **lotes y series** (5.1, 6.1), **reservas**
que no descuentan (5.2) y, para operadores logísticos, **propietario** del
inventario (3PL). Si cada una de esas piezas cambiara la llave del saldo por su
cuenta, surtido, producción y calidad se tendrían que rehacer varias veces.

Esta decisión fija la llave una vez, antes de construir los flujos (etapa A del
plan v2), y dice qué hace cada servicio actual con ella.

## Decisión

### Llave del saldo

Una fila de `stock_balance` por **empresa + producto + ubicación + estado +
lote**:

- `status` (`StockStatus`, no nulo): `AVAILABLE`, `RECEIVING`, `INSPECTION`,
  `QUARANTINE`, `DAMAGED`, `REJECTED`, `IN_TRANSIT`, `BLOCKED`.
- `lotId` (opcional) hacia la tabla `lot` (empresa + producto + código + caducidad
  opcional). Sin lote = `NULL`.
- MySQL no compara `NULL` en un índice único, así que la llave usa además
  `lotKey VARCHAR(36) NOT NULL DEFAULT ''`, igual a `COALESCE(lotId, '')`. Un
  disparador exige esa igualdad al insertar y prohíbe cambiar producto,
  ubicación, estado o lote de una fila de saldo (solo cambia `quantity`).
- Índice único: `(organizationId, productId, locationId, status, lotKey)`. El
  índice actual `(organizationId, productId, locationId)` se quita.
- **Propietario (3PL)** queda fuera por ahora. Cuando llegue (etapa I) se agrega
  igual: `ownerId` opcional + `ownerKey` no nulo dentro del mismo índice. Nada de
  lo que se construye antes debe suponer que la llave termina en el lote.

`stock_movement_line` lleva las mismas dimensiones (`status`, `lotId`,
`lotKey`), así que cada línea dice qué estado y qué lote movió. La reconciliación
agrupa por producto + ubicación + estado + lote.

### Qué es «disponible»

- **Hay** = suma de todos los estados en la ubicación (lo que físicamente está).
- **Disponible** = saldo `AVAILABLE` − reservas activas (las reservas llegan en
  WMS-12; hasta entonces disponible = `AVAILABLE`).
- Solo `AVAILABLE` se puede surtir, sacar, reubicar libremente o reservar. Los
  demás estados se mueven solo con su operación (cambio de estado, inspección,
  traslado entre almacenes, devolución).
- «Reservado» **no** es un estado físico: es una tabla aparte (`stock_reservation`,
  WMS-12) que resta de lo disponible sin mover el saldo.

### Movimientos

- Tipo nuevo `STATUS_CHANGE` (WMS-11): dos líneas en la misma ubicación y lote,
  sale de un estado y entra al otro, con motivo obligatorio (`CHECK` en
  `stock_movement`, como los ajustes).
- Entradas, salidas, salida rápida, saldos iniciales, ajustes, conteos,
  importaciones, recepciones de Compras y devoluciones al proveedor trabajan
  sobre `AVAILABLE` y sin lote hasta que su paso diga otra cosa (recepción con
  inspección en WMS-17/30, lotes en WMS-21).
- Una reubicación (y la entrega de una tarea) conserva estado y lote: mueve
  `AVAILABLE` a `AVAILABLE`. Mover mercancía no disponible es otra operación.
- Una reversa copia estado y lote de cada línea del original.

### Valor (costo promedio, ADR 0031)

`product_cost` sigue siendo uno por producto y cubre **todos** los estados: lo
dañado o en cuarentena sigue siendo de la empresa hasta que sale. Un cambio de
estado no mueve el valor. Lo rechazado o dañado que se desecha sale con una
salida normal, al costo promedio. `reconcileValue` no cambia.

### Lecturas actuales

| Servicio | Regla |
| --- | --- |
| Existencias por producto y ubicación (`product-stock`, pantallas de movimientos) | Muestran «hay» y, cuando no todo está disponible, el desglose por estado |
| Mínimos y existencias bajas (`minimums`) | Comparan contra lo **disponible** |
| Sugerencias de compra (`suggestions`) | Usan lo **disponible** |
| Archivar producto o ubicación | Bloquean si **hay** algo en cualquier estado |
| Conteos | Cuentan y ajustan lo `AVAILABLE` de la ubicación; lo no disponible debe estar separado por estado y se cuenta con su propia operación (pendiente, sin paso todavía) |
| Exportación de existencias | Una fila por producto, ubicación y estado |
| Valor del inventario | Igual que hoy (todos los estados) |

### Candados

No cambian: producto → ubicación → documento (`LOCKING_TRANSACTION`). El estado
y el lote son parte de la fila de saldo, no candados nuevos. Las reservas se
escriben bajo el candado del producto.

### Migración (WMS-10)

Sin producción todavía (ADR 0032), en una sola migración:

1. Crear `lot` vacía.
2. Agregar `status` (por omisión `AVAILABLE`), `lotId` y `lotKey` (por omisión
   `''`) a `stock_balance` y `stock_movement_line`; los registros existentes
   quedan disponibles y sin lote.
3. Cambiar el índice único del saldo a la llave nueva.
4. Disparadores: `lotKey = COALESCE(lotId, '')` al insertar; las dimensiones de
   un saldo no cambian. Los disparadores de inmutabilidad de las líneas siguen
   igual.

Con producción, la misma migración es de expansión salvo el cambio de índice;
eso se resolvería en dos despliegues.

## Consecuencias

- Surtido (WMS-14), lotes con FEFO (WMS-21), inspección (WMS-30) y traslados entre
  almacenes con mercancía en tránsito (WMS-19) se construyen sin volver a tocar
  la llave.
- Cada consulta que suma existencias tiene que decir si quiere «hay» o
  «disponible». Los servicios exponen las dos cifras con nombres distintos
  (`onHand`, `available`); nunca un número sin aclarar cuál es.
- La prueba crítica 5 de la especificación («una pieza rechazada no aparece como
  disponible») se cumple por construcción: disponible solo suma `AVAILABLE`.
- Lo no disponible no se puede contar con el conteo actual; queda anotado como
  pendiente en `docs/ESTADO_WMS.md`.
