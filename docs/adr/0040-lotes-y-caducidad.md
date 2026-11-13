# ADR 0040 — Lotes y caducidad

Fecha: 2026-11-12 (pendientes cerrados el 2026-11-13) · Estado: aceptada ·
Paso: WMS-21A · Completa ADR 0033

## Contexto

Desde WMS-10 la llave del saldo es producto + ubicación + estado + lote
(ADR 0033) y existe la tabla `lot`, pero vacía: todo trabajaba «sin lote». La
especificación (5.1, 6.1) y las instrucciones del fundador piden lotes, fechas
de caducidad y trazabilidad, y el surtido de WMS-14 dejó FIFO y FEFO para
cuando hubiera lotes. Este paso llena el lote de punta a punta. Los números de
serie y la consulta de trazabilidad por serie o por pedido son WMS-21B.

## Flujo

1. **En el producto se elige cómo se controla.** En su ficha, «Control por
   lote»: *sin lote* (por omisión, como hasta hoy) o *por lote*; y, si es por
   lote, su **caducidad**: *no lleva*, *opcional* u *obligatoria*. Lo decide
   quien puede editar el producto (`inventory.product.update`).
   - El control solo cambia mientras el producto no tiene existencias (en
     ningún estado) ni nada apartado; la regla de caducidad se puede cambiar
     cuando sea (vale para los lotes nuevos). Ambos cambios quedan en la
     bitácora (`product.updated`, con antes y después).
   - Una empresa que no usa lotes no ve nada nuevo: los campos de lote solo
     aparecen en las pantallas de un producto por lote.
2. **Al meter existencias** (entrada, saldo inicial, recepción de una orden de
   compra) de un producto por lote se escribe el **lote** y, si el producto la
   lleva, su **caducidad**.
   - El lote es un texto de hasta 64 caracteres; se guarda sin espacios de
     más y en mayúsculas, y es único por producto en la empresa («l-01» y
     «L-01» son el mismo lote).
   - Si el lote ya existe se usa ese. Si se escribe una caducidad distinta a
     la guardada, se rechaza diciendo cuál tiene; sin escribirla, se usa la
     guardada. Un lote nuevo de un producto con caducidad obligatoria no se
     registra sin ella.
   - Una caducidad mal capturada se corrige en la ficha del lote («Corregir
     caducidad», con motivo y bitácora), no registrando el lote otra vez.
   - En una recepción, cada línea de la orden llega en uno o varios lotes:
     «Llegó en otro lote» agrega otra fila (cantidad, lote y caducidad) a
     ese producto. Entre todas nunca pasan de lo pendiente de la línea, y el
     mismo lote no se repite (se suman sus cantidades). Cada fila es una
     línea de recepción con su lote: la devolución sale de ese lote.
3. **Todo lo que saca, mueve o corrige** existencias de un producto por lote
   dice de qué lote: salida y salida rápida, reubicación, tarea de traslado,
   cambio de estado, ajuste y conteo. En pantalla, «de dónde sale» lista cada
   ubicación con cada lote que tiene («Estante 2 · Lote L-01 · caduca
   05/03/2027 — hay 40 piezas»): se elige en un solo paso. La devolución al
   proveedor sale del lote de la recepción y una reversa devuelve cada línea a
   su lote, sin preguntar. **Lo que caduca antes va primero** en ese
   selector, así la opción con la que empieza es la recomendada; el texto
   empieza por lo que distingue una opción de otra («Lote L-01 · caduca
   05/03/2027 · Estante 2 — hay 40 piezas») porque en el teléfono un
   selector cerrado solo muestra el principio.
4. **Surtido.** Al liberar un pedido, el sistema elige ubicación **y lote**.
   **Lo que caduca antes sale antes, siempre** (fundador, 2026-11-13): los
   lotes se ordenan por su caducidad, los que no tienen fecha al final,
   sea cual sea el ajuste de la empresa. El ajuste «De dónde se surte
   primero» (la ubicación más llena, la menos llena o **el lote más
   antiguo, FIFO**) decide solo entre ubicaciones del mismo lote y para
   productos sin caducidad o sin lotes. La reserva y la tarea de surtido
   llevan su lote; el almacenista confirma producto, ubicación, **lote** y
   cantidad. Un lote ya caducado no se propone, salvo que la empresa diga
   otra cosa («Lotes caducados al surtir»). Si por eso no alcanza, el pedido
   lo dice como cualquier faltante. La página del pedido dice el lote de
   cada línea de surtido.
5. **Caducidad próxima.** Inventario › «Por caducar» lista los lotes con
   existencias que ya caducaron o caducan dentro de los días que eligió la
   empresa («Avisar de lotes por caducar», 30 por omisión). Inicio e
   Inventario avisan «N lotes por caducar» solo cuando hay algo. «Hoy» es el
   día del calendario de la empresa. Un lote caduca al terminar su fecha: el
   día de su caducidad todavía sirve.
6. **Ficha del lote.** Desde la ficha del producto («Lotes») o desde «Por
   caducar»: su caducidad, dónde está hoy por ubicación y estado, y sus
   movimientos (de dónde vino y a dónde fue), con los mismos filtros y el
   mismo alcance que el historial.
7. **Importaciones.** El archivo de existencias (saldos iniciales) tiene las
   columnas «Lote» y «Caducidad» (día del calendario: 2027-03-05 o
   05/03/2027, nunca mes/día): un producto por lote se repite en una fila
   por ubicación y lote; el lote se crea la primera vez, con su caducidad,
   y uno que ya existe conserva la suya (el archivo puede dejarla vacía o
   repetirla; distinta se rechaza). El archivo de salidas tiene la columna
   «Lote»: un producto por lote dice de qué lote salió, uno que ya exista.
   Un producto por lote sin lote, o cualquier otro con lote, es un problema
   de su fila antes de confirmar; si el control cambió después de
   confirmar, el producto (o la fila de salida) falla con su motivo. Un
   producto que nace de una importación es «sin lote»: una fila suya con
   lote se rechaza, diciendo que primero se marque «por lote».
8. **Un lote que aparece y el sistema no conoce** (en un conteo o en el
   estante) se da de alta con «Corregir existencias» (ajuste): además de los
   lotes de la lista, «Un lote que no está en la lista» pide su código y su
   caducidad. El lote nace en la misma transacción que el ajuste que trae
   sus existencias; si el ajuste se rechaza, el lote no queda. En la
   captura de un conteo, quien puede ajustar ve el enlace «Registrar un
   lote nuevo»; quien no, el aviso de pedírselo a quien corrige existencias.
9. **Cambiar el control** de un producto, además de pedir que no tenga
   existencias ni apartados, se impide mientras haya algo empezado con el
   control anterior que ya no podría terminar: un conteo abierto que lo
   incluya, una tarea sin terminar o salidas de un archivo por registrar.
   Cada caso dice qué hacer.

## Decisión

- **En el producto:** `product.tracking` (`NONE`, `LOT`; «serie» será otro
  valor del mismo control en WMS-21B) y `product.lotExpiry` (`NONE`,
  `OPTIONAL`, `REQUIRED`). El disparador `product_tracking_change` repite la
  regla de «solo sin existencias ni apartados».
- **El lote** (`lot`, ya existía): producto + código normalizado
  (`normalizeLotCode`) + caducidad opcional (un día del calendario, `DATE`).
  Producto y código no cambian y un lote no se borra (disparadores). La
  caducidad solo cambia con `changeLotExpiry` (permiso
  `inventory.product.update`, motivo, bitácora `inventory.lot_expiry_changed`).
  El lote nace dentro de la transacción del movimiento que lo trae, bajo el
  candado de su producto: dos entradas simultáneas del mismo lote nuevo no
  crean dos.
- **La regla en la base.** Disparadores al insertar en `stock_movement_line` y
  en `stock_balance`: un producto por lote exige lote, uno sin lote lo
  rechaza, y el lote es de ese producto. Así ningún servicio, presente o
  futuro, puede mezclar lotes aunque olvide preguntar. En el código la
  pregunta vive en un solo archivo (`lot-resolve.ts`): `lotForEntry` (lo que
  entra: busca o crea el lote por su código) y `lotForTake` (lo que sale, se
  mueve o se corrige: un lote que ya existe, por id); el mensaje para la
  persona sale de ahí, el disparador es la última defensa. Otros
  disparadores cuidan que el lote de una reserva o de una tarea sea de su
  producto.
- **Lecturas del saldo.** `AVAILABLE_STOCK` desaparece: cada lectura dice qué
  quiere. `availableOfLot(lotId)` es la fila exacta de un lote (o «sin lote»)
  y la usa lo que escribe; `AVAILABLE_ANY_LOT` suma todos los lotes y la usan
  los totales (mínimos, sugerencias, libre del producto, «sin acomodar»).
- **Reservas por lote.** Una reserva puede nombrar su lote
  (`stock_reservation.lotId`, ya existía). Lo libre para tomar de un lote en
  una ubicación es el mínimo entre lo libre del producto, lo libre de la
  ubicación (todos los lotes) y lo libre de ese lote ahí (`freeToTake`,
  `freeToMoveFrom`, con el lote como parámetro). Una reserva sin lote en una
  ubicación (no las crea el surtido) resta de todos sus lotes.
- **Surtido.** `pickSources` sigue siendo el único lugar que decide:
  devuelve ubicación, lote y cantidad. Ordena **primero por caducidad**
  (sin fecha al final) y después según `PICKING_STRATEGY` (`fullest`,
  `emptiest`, `fifo`: antigüedad del lote, cuándo se registró por primera
  vez). La opción `fefo` existió un día (2026-11-12) y se quitó al
  volverse la regla para todos: una empresa que la tenía guardada lee el
  valor por omisión (`fullest`), con el mismo resultado para lo que
  caduca. Un producto sin lote no tiene fechas: sale según el ajuste.
  Ajuste `inventory.picking.expired` (`skip` por omisión, `allow`): hay
  empresas para las que la fecha es «consumo preferente» y sí despachan
  después. **Sin vida útil mínima** al surtir (fundador, 2026-11-13).
- **Tareas.** `warehouse_task.lotId` (inmutable, disparador). Una tarea de
  traslado de un producto por lote se crea con su lote; la de surtido lo
  recibe de `pickSources`. `confirmPick` pide el lote y lo compara con el de
  la tarea.
- **Conteos.** `stock_count_line` lleva lote: una línea por producto y lote
  (índice único ensanchado), con su referencia propia (`systemQuantity` del
  saldo de ese lote). Aplicar ajusta cada lote por separado.
- **Recepción y devolución.** `purchase_receipt_line.lotId` guarda el lote en
  que llegó cada línea; `postReturnExit` saca de ese lote. Una línea de la
  orden puede llegar en varias líneas de recepción (una por lote, hasta
  `RECEIPT_LOTS_PER_LINE`) en la misma recepción: lo pendiente se cuenta
  sumándolas, el mismo lote no se repite, y un producto sin lote sigue
  llegando en una sola. El reintento (`sameReceipt`, CMP-10) compara
  también el lote tecleado de cada línea: la misma clave con otro lote es
  un formulario reutilizado.
- **Importaciones.** Existencias: columnas `lot` y `lotExpiry` en
  `IMPORT_COLUMNS`; la revisión valida forma y fecha (`parseCalendarDay`,
  el mismo lector de días de las salidas) y que un lote no traiga dos
  fechas; la clasificación pregunta al catálogo con `checkLotEntry` (la
  misma regla de `lotForEntry`, sin escribir); se fija al confirmar y
  `checkImportedStock` vuelve a preguntar antes de tocar el producto. Solo
  `postImportedStock` crea el lote (`lotForEntry`), con el movimiento
  `INITIAL`. Salidas: columna `lot`; la revisión busca el lote por código
  entre los del producto y lo fija en `exit_import_row.lotId` (columna
  nueva, con disparador que exige que el lote sea de su producto); el
  worker lo vuelve a resolver con `lotForTake`. **El folio sigue siendo lo
  único que deduplica** (`exitKey` = producto + folio): una venta de un
  producto sale una sola vez, nombre el lote que nombre, así que un ticket
  que sacó dos lotes del mismo producto no cabe en el archivo (se registra
  a mano).
- **Lo que sale del sistema.** La exportación de existencias agrega
  «Lote» y «Caducidad» y la de movimientos «Lote», solo cuando el archivo
  tiene algún lote (una empresa sin lotes recibe el archivo de siempre).
  El PDF de la orden de compra y los reportes de Compras **no** llevan lote:
  una orden no tiene lote hasta que se recibe, y los reportes cuentan
  órdenes y pendientes por línea, no existencias; el lote recibido está en
  la recepción y en sus movimientos.
- **Caducidad próxima.** `listExpiringLots`/`countExpiringLots`
  (`src/modules/inventory/lots.ts`): derivado en cada consulta de `lot` +
  saldos con existencias, sin banderas; dentro del alcance de la persona
  (WMS-20) y de su almacén activo. Ajuste `inventory.lot.expiry_notice`
  (7, 15, 30, 60 o 90 días).
- **Aviso de entrada repetida (WMS-71):** dos entradas del mismo producto con
  lotes distintos **no** son la misma entrada; el aviso compara también el
  lote.
- **Costo promedio:** sigue siendo por producto (ADR 0031), no por lote.
- **Permisos:** ninguno nuevo. Quien registra una entrada captura su lote;
  ver lotes es `inventory.stock.read`; sus movimientos,
  `inventory.movement.read`; corregir una caducidad,
  `inventory.product.update`.

### Cambios a la propuesta inicial, y por qué

- **Corregir la caducidad de un lote** no estaba en la propuesta. Sin eso, un
  error de dedo al dar de alta un lote lo deja inservible: toda entrada
  posterior con la fecha correcta se rechazaría.
- **«De dónde sale» es un solo selector** (ubicación + lote) en vez de dos
  campos dependientes: es el mismo patrón del cambio de estado
  (`<ubicación>|<estado>`), funciona sin JavaScript y no deja elegir un lote
  que no está en esa ubicación.
- **El control de caducidad tiene tres valores** (no lleva, opcional,
  obligatoria) en lugar de «lleva / no lleva» + «obligatoria»: es un solo
  campo y no admite combinaciones sin sentido.
- **Un conteo no da de alta lotes; un ajuste sí** (2026-11-13). La captura
  de un conteo no escribe movimientos: si creara el lote, un conteo
  cancelado dejaría un lote sin existencias por un error de dedo. El ajuste
  lo crea en la misma transacción que el movimiento que trae sus
  existencias, pide permiso de ajustar y motivo, y queda en la bitácora.

## Dónde se aplica

| Operación | Lote |
| --- | --- |
| Entrada, saldo inicial (`registerEntry`, `registerInitialBalance`) | Se escribe (código y caducidad); se crea o se reutiliza |
| Recepción de orden de compra (`receivePurchaseOrder` → `postReceiptEntry`) | Se escribe por línea; queda en la línea de recepción |
| Salida (`registerExit`), salida rápida (`registerQuickExit`) | Se elige con la ubicación |
| Reubicación (`registerTransfer`) | Se elige con el origen; el destino recibe el mismo lote |
| Tarea de traslado (`createTask` → `deliverTask`) | Se elige al crearla; la entrega mueve ese lote |
| Cambio de estado (`changeStockStatus`) | Se elige con el origen; conserva el lote |
| Ajuste (`registerAdjustment`) | Se elige entre los lotes del producto, o uno nuevo por su código (nace con el ajuste) |
| Conteo (`captureCount`, `applyCount`) | Se elige al capturar; una línea y un ajuste por lote |
| Devolución al proveedor (`returnToSupplier` → `postReturnExit`) | El de la línea de recepción |
| Reversa (`reverseMovement`) | El de cada línea original |
| Liberar pedido y surtir (`pickSources`, `createPickTasks`, `confirmPick`, `deliverPick`) | Lo elige la estrategia; se confirma al surtir; la reserva lo lleva |
| Existencias importadas (`checkImportedStock` → `postImportedStock`) | Columnas «Lote» y «Caducidad»; se crea o se reutiliza |
| Salidas importadas (`applyExitImport`) | Columna «Lote», uno que ya existe; fijado al confirmar |

El selector de lotes de cada pantalla se arma en el servidor
(`listLotStock`, `listProductLots`) y viaja solo el id del lote; el servicio
vuelve a comprobar que es de ese producto.

## Decisiones del fundador (2026-11-13)

1. **Lo que caduca antes sale antes, siempre.** Con cinco lotes de un
   producto y un pedido de 500, salen primero los más próximos a caducar,
   sin que la empresa tenga que elegir nada. El surtido lo hace así sea cual
   sea el ajuste, y al sacar a mano (salida, salida rápida, reubicación,
   tarea de traslado) el selector «ubicación · lote» lista primero lo que
   caduca antes.
2. **Sin vida útil mínima** al surtir, ni fecha de fabricación ni otros
   datos del lote. Se quedan los valores por omisión: aviso a 30 días y los
   caducados no se surten.

## Lo que quedó fuera (pendiente)

- **Números de serie** y la **consulta de trazabilidad** por serie o por
  pedido: WMS-21B. `product.tracking` ya es un enumerado para recibir
  `SERIAL`.
- **Bloqueo automático** de lo caducado (pasarlo a «Bloqueado»): hoy solo
  deja de proponerse al surtir; sacarlo a mano sigue permitido, porque así
  se da de baja.
- **Un ticket con dos lotes del mismo producto** en un archivo de salidas:
  el folio deduplica por producto, así que se registra a mano.
- **Fecha de fabricación** y otros datos del lote (proveedor, certificado):
  cuando un paso los pida.
- **Varios lotes de una línea guardados en lugares distintos** dentro de la
  misma recepción: la ubicación es de la línea («Guardar en»), no de cada
  lote; si van a lugares distintos, se reubica después o se reciben en dos
  recepciones.
- Lo que ya terminó con el control anterior de un producto (sus
  movimientos viejos, la devolución de una recepción anterior) no se
  reversa ni se devuelve después del cambio: cada caso responde con su
  motivo y se corrige con una salida o un ajuste. Lo que estaba a medias
  (conteo, tarea, archivo de salidas) ya impide el cambio.
- Lo no disponible sigue sin poder contarse (ADR 0033), también por lote.

## Consecuencias

- Una operación nueva que mueva existencias recibe el lote como parámetro y
  lo resuelve con `lotForEntry` o `lotForTake` (`lot-resolve.ts`) bajo el
  candado del producto, y escribe línea y saldo con `lotColumns(lote)`;
  toda lectura del saldo dice si quiere un lote (`availableOfLot`) o todos
  (`AVAILABLE_ANY_LOT`).
- Cada inserción de línea o de saldo cuesta una lectura más por llave
  primaria (el disparador consulta el producto).
- La reconciliación ya comparaba por lote (ADR 0033): no cambia.
- Tablas tocadas: `product`, `lot`, `warehouse_task`, `stock_count_line`,
  `purchase_receipt_line` y, el 2026-11-13, `exit_import_row` (`lotId`,
  migración `20261113120000_wms_lot_imports`, solo de expansión). Ninguna
  tabla nueva.
- Pantallas de verificación: «Por caducar» y la ficha de un lote están en
  `SCREENS` de `scripts/verify-a11y.mjs` y en `screens()` de
  `scripts/load-test.mts`; `npm run db:seed:ejemplo` agrega un producto por
  lote con dos lotes de caducidad distinta.
