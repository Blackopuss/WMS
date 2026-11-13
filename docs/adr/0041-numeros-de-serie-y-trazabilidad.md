# ADR 0041 — Números de serie y trazabilidad

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-21B · Completa ADR 0040 y
ADR 0033

## Contexto

WMS-21A (ADR 0040) dejó el control por lote de punta a punta y dejó fuera dos
cosas que pide la especificación (5.1, 6.1) y el plan v3 (WMS-21): **números
de serie** —cada unidad identificada, única, para equipos, herramientas o
cualquier artículo que se rastrea pieza por pieza— y una **consulta de
trazabilidad** «de dónde vino y a dónde fue» por lote, serie o pedido.

La llave del saldo es producto + ubicación + estado + lote (ADR 0033). Una
fila por unidad en `stock_balance` la haría crecer sin límite y obligaría a
cambiar cada lectura de existencias. Este paso guarda las unidades aparte y
deja el saldo como está: por cantidad.

## Flujo

1. **En el producto se elige el control.** En su ficha, «Control»: *sin lote
   ni serie* (por omisión), *por lote* o **por número de serie**. Por serie se
   cuenta en unidades enteras (precisión 1; si no, se rechaza diciendo por
   qué) y no lleva lote. Cambiar el control sigue las mismas reglas que con
   lotes: sin existencias, sin apartados, sin conteo abierto, tarea sin
   terminar ni salidas de archivo por registrar. Una empresa que no usa
   series no ve nada nuevo: los campos de serie solo existen en las pantallas
   de un producto por serie.
2. **Lo que entra dice sus series.** Entrada, saldo inicial y recepción de
   una orden de compra piden tantas series como unidades entran, en un cuadro
   de texto, una por renglón: un lector manda Enter después de cada lectura y
   en el cuadro eso es un renglón nuevo, así que se escanea una etiqueta tras
   otra sin tocar nada. El cuadro dice cuántas lleva. Hasta 500 series por
   movimiento (`MAX_SERIALS_PER_OPERATION`), dicho en pantalla.
   - La serie se guarda como el código de lote: sin espacios de más y en
     mayúsculas; «sn-01» y «SN-01» son la misma. Es única **por producto** en
     la empresa (dos productos pueden repetir un número de su fabricante).
   - Una serie que ya está en existencias de ese producto se rechaza
     diciendo cuál. Una que está dos veces en la lista, también.
   - Una serie que **ya salió** del almacén (se vendió, se devolvió al
     proveedor, se reversó su entrada) puede volver a entrar: es la misma
     unidad, con su historia. Esto cambia la propuesta inicial («una serie
     que ya existe se rechaza»): sin ello, una devolución de un cliente o una
     entrada corregida con su reversa dejarían la serie inservible. Lo que
     nunca ocurre es tener dos unidades con la misma serie dentro.
3. **Lo que sale, se mueve o cambia de estado dice qué unidades.** Salida,
   salida rápida (en la línea del producto: sus unidades son tantas como
   series escaneadas), reubicación, cambio de estado y devolución al proveedor
   piden las series. Cada una debe estar justo ahí (ubicación y estado); si
   no, se rechaza diciendo cuál («La serie S-9 no está en Estante 2»). Una
   reversa mueve de regreso **las mismas** unidades del movimiento original,
   sin preguntar; si una ya no está (salió después, o volvió a entrar), se
   rechaza diciendo cuál.
4. **Surtido y tareas.** La serie **se aparta al surtir**, no al liberar el
   pedido: liberar aparta cantidad por ubicación (como hasta hoy) y el
   almacenista, al confirmar lo que toma en el origen, escanea las series de
   las unidades que toma. Desde ese momento esas unidades son de la tarea
   (`warehouse_task_serial`): nadie más las saca, mueve ni ajusta hasta que
   la tarea se entregue, se libere (vuelve a pedir el escaneo a quien la tome)
   o se cancele. La entrega mueve exactamente esas. Es lo habitual en piso:
   quien libera un pedido no sabe qué pieza física hay en el estante, quien
   surte sí. Una tarea de traslado de un producto por serie pide las series
   al recoger la carga, con la misma regla.
5. **Correcciones.** «Corregir existencias» de un producto por serie pide
   **todas** las series que hay en esa ubicación: las que el sistema tenía y
   no se nombraron salen, las nombradas que no estaban entran (una línea de
   cada una, con motivo y bitácora que las nombra). Una serie que está en otra
   ubicación o en otro estado no se «encuentra» con un ajuste: se reubica o se
   cambia de estado. **Un conteo no captura series**: un producto por serie
   se rechaza en la captura con el motivo y la indicación de corregirlo con un
   ajuste (pendiente abajo).
6. **Importaciones.** Un archivo de existencias o de salidas no lleva series:
   una fila de un producto por serie es un problema de su fila, con su
   motivo; si el control cambió después de confirmar, el producto (o la fila
   de salida) falla con el mismo motivo. Sus existencias se capturan a mano.
7. **Rastrear.** Inventario › «Rastrear lote, serie o pedido»: un cuadro de
   búsqueda que acepta un lote, una serie, un pedido `PS-0001` o una orden de
   compra `OC-0001`. Si hay una sola coincidencia abre directo su ficha; si
   hay varias (el mismo lote o serie en dos productos), deja elegir.
   - **Lote:** abre su ficha (WMS-21A), que ya dice dónde está y sus
     movimientos; ahora además «Compras y pedidos»: la recepción que lo trajo
     (orden de compra y proveedor) y los pedidos para los que se surtió.
   - **Serie:** dónde está hoy (o que ya salió), «Compras y pedidos» y su
     recorrido completo, movimiento por movimiento.
   - **Pedido:** abre el pedido, que dice el lote y las series de cada tarea
     de surtido, con enlaces a la ficha de cada lote y al rastreo de cada
     serie.
   - **Orden de compra:** lo que trajo cada recepción, con los lotes y las
     series de cada línea.
   - Se llega también desde la ficha del producto (lista paginada «Series en
     existencia», cada una abre su rastreo; los lotes ya abrían su ficha) y
     desde el pedido.

## Decisión

- **`product.tracking` gana `SERIAL`.** El disparador de lotes ya rechazaba
  un lote en cualquier producto que no fuera `LOT`, así que un producto por
  serie nunca lleva lote.
- **Unidades aparte del saldo.** `serial_unit`: producto + serie (única por
  producto en la empresa) + dónde está ahora (`locationId` y `status`, o
  ambos nulos fuera del almacén, `CHECK`). Producto y serie no cambian y una
  unidad no se borra (disparadores). Nace fuera (disparador): solo entra con
  un movimiento.
- **Qué unidades movió cada línea.** `serial_move`: una fila por unidad y
  línea, con producto, ubicación, estado y sentido. Se escribe **antes** de
  su línea, con el id que tendrá la línea (por eso no lleva llave foránea a
  ella), en la misma transacción. Dos disparadores ponen la regla en la base:
  - `serial_move_apply` (al insertar la fila): lo que sale debe estar justo
    ahí y queda fuera; lo que entra debe estar fuera y queda ahí. La unidad
    siempre dice dónde la dejó su último movimiento; ningún servicio la mueve
    a mano.
  - `stock_movement_line_serial_rule` (al insertar la línea): una línea de un
    producto por serie tiene **exactamente** una fila por unidad que mueve
    (`baseQuantity`, que así es entera), todas con su producto, ubicación,
    estado y sentido; la de cualquier otro producto, ninguna.
  Así ninguna operación, presente o futura, puede mover unidades sin decir
  cuáles: si una olvida las series, la base la rechaza. Como el saldo cambia
  solo con sus líneas (ADR 0012), el número de unidades dentro de cada
  ubicación y estado es siempre su saldo.
- **Reconciliación.** `reconcileStock` agrega, para productos por serie, dos
  comparaciones con el saldo: las unidades que dicen estar ahí
  (`source: "serial_units"`) y las que su último movimiento dejó ahí
  (`"serial_moves"`). Toda prueba que ya terminaba con `reconcileStock`
  vacío lo comprueba sin cambios.
- **Un solo lugar en el código.** `serials.ts`: `serialsForEntry`,
  `serialsForTake` (incluye «no la tomó otra tarea abierta»),
  `writeSerialMoves` (crea las unidades nuevas y escribe todas las salidas
  antes que las entradas: en un traslado la unidad sale del origen antes de
  llegar), `serialsOfLines`. Reglas puras en `serial-rules.ts`. Todo se llama
  dentro de la transacción del movimiento, bajo el candado del producto, como
  `lot-resolve.ts`; los pasos de tarea que escanean series (`pickUpTask`,
  `confirmPick`) bloquean ahora también el producto, antes del pedido y la
  tarea (orden de siempre).
- **Reintentos.** La misma clave de confirmación con otras series es otro
  movimiento (`KEY_REUSED`), en entrada, salida, salida rápida, reubicación y
  cambio de estado.
- **Aviso de entrada repetida (WMS-71):** no aplica a un producto por serie:
  otras series son otras unidades y las mismas se rechazan solas.
- **Costo promedio:** sigue por producto (ADR 0031), no por unidad.
- **Trazabilidad sin consultas duplicadas.** El recorrido de una serie es
  `listMovements({ serialUnitId })`; el de un lote, la ficha que ya existía
  (`getLot` + `listMovements({ lotId })`). `traceability.ts` agrega solo lo
  que el historial no dice: recepción y proveedor (`traceLot`,
  `traceSerial`), pedidos surtidos, lo que trajo una orden de compra
  (`tracePurchaseOrder`) y la búsqueda (`findTraceMatches`). Las líneas de
  `listMovements` traen sus `serials`, así que el historial de Movimientos y
  la ficha del producto los muestran.
- **Alcance y permisos.** Ver es `inventory.movement.read` (ningún permiso
  nuevo); la lista de series de un producto, `inventory.stock.read`. Un lote o
  una serie sin ningún movimiento en los almacenes o zonas de la persona no
  existe para ella (no aparece en la búsqueda, su ficha da «no encontrado»);
  de los que sí ve, solo los movimientos dentro de su alcance, y si hoy está
  fuera se dice «en un almacén o zona fuera de los tuyos» sin nombrarlo. Un
  pedido de un almacén cerrado tampoco existe. La orden de compra y el
  proveedor salen solo para quien tiene `purchasing.order.read` con Compras
  activo; los demás ven «Llegó con una recepción de compra».

## Dónde se aplica

| Operación | Series |
| --- | --- |
| Entrada, saldo inicial (`registerEntry`, `registerInitialBalance`) | Se escriben; nuevas o que ya salieron |
| Recepción de orden de compra (`receivePurchaseOrder` → `postReceiptEntry`) | Se escriben por línea; una serie no se repite en la recepción |
| Salida (`registerExit`), salida rápida (`registerQuickExit`) | Se escanean; deben estar en esa ubicación; una unidad no va en dos líneas |
| Reubicación (`registerTransfer`) | Se escanean en el origen; llegan las mismas |
| Tarea de traslado (`pickUpTask` → `deliverTask`) | Se escanean al recoger; la entrega mueve esas |
| Surtido (`confirmPick` → `deliverPick`) | Se escanean al confirmar; quedan de la tarea hasta entregar |
| Cambio de estado (`changeStockStatus`) | Se escanean en el estado de origen |
| Ajuste (`registerAdjustment`) | Todas las que hay; faltantes salen, nuevas entran |
| Devolución al proveedor (`returnToSupplier` → `postReturnExit`) | Unidades que llegaron con esa línea de recepción y siguen ahí |
| Reversa (`reverseMovement`) | Las del movimiento original, sin preguntar |
| Conteo (`captureCount`, `applyCount`) | Rechaza el producto por serie, con motivo |
| Existencias y salidas importadas | Rechazan el producto por serie, con motivo |

## Lo que quedó fuera (pendiente)

- **Conteo por serie** (escanear las unidades de una ubicación y aplicar las
  diferencias): hoy se rechaza y se corrige con un ajuste, que hace lo mismo
  de una vez. Cuando se agregue, la captura guardará las series y aplicar
  reutilizará la regla del ajuste.
- **Series en archivos** (existencias y salidas importadas): una columna de
  series con una fila por unidad. Hoy se rechaza la fila con su motivo.
- **Elegir de una lista** las series que hay en una ubicación (además de
  escanearlas): la ficha del producto las lista por ubicación; en los
  formularios se escanean o escriben.
- **Lote y serie a la vez** en un mismo producto: un control u otro.
- **Una serie única en toda la empresa** (no solo por producto): si una
  empresa lo necesita, será un ajuste de operación.
- **Venta, garantía o cliente final** de una serie: el WMS llega hasta el
  pedido surtido (no hay despacho todavía, Fase 2); el rastreo dice el pedido
  y su destinatario.
- La reimpresión de etiquetas con la serie: cuando haya etiquetas (Fase 2).

## Consecuencias

- Una operación nueva que mueva existencias, para un producto por serie,
  resuelve sus unidades con `serialsForEntry`/`serialsForTake` bajo el
  candado del producto y llama `writeSerialMoves` antes de escribir sus
  líneas, con los ids que tendrán; si no, la base la rechaza.
- Cada línea insertada cuesta dos lecturas más por índice (el disparador
  cuenta sus `serial_move`), haya o no series.
- Tablas nuevas: `serial_unit`, `serial_move`, `warehouse_task_serial`
  (en `TENANT_MODELS`, con su dato de ejemplo entre empresas). Migraciones
  `20261114120000_wms_serials` (solo expansión: un valor más del enumerado y
  tablas nuevas) y `20261114120100_wms_serial_trigger_collation` (vuelve a
  crear dos disparadores de la anterior declarando la intercalación de sus
  variables; sin ella MySQL rechazaba sus comparaciones).
- Se quitaron de paso tres plantillas de correo de Ventas sin uso
  (`salesQuoteEmail`, `salesStatementEmail`, `overdueReminderEmail`, ADR 0032).
