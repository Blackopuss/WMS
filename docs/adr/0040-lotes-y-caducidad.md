# ADR 0040 — Lotes y caducidad

Fecha: 2026-11-12 · Estado: aceptada · Paso: WMS-21A · Completa ADR 0033

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
   - En una recepción, cada línea de la orden llega en un lote. Dos lotes de
     la misma línea se reciben en dos recepciones (la orden queda parcial
     entre una y otra).
3. **Todo lo que saca, mueve o corrige** existencias de un producto por lote
   dice de qué lote: salida y salida rápida, reubicación, tarea de traslado,
   cambio de estado, ajuste y conteo. En pantalla, «de dónde sale» lista cada
   ubicación con cada lote que tiene («Estante 2 · Lote L-01 · caduca
   05/03/2027 — hay 40 piezas»): se elige en un solo paso. La devolución al
   proveedor sale del lote de la recepción y una reversa devuelve cada línea a
   su lote, sin preguntar.
4. **Surtido.** Al liberar un pedido, el sistema elige ubicación **y lote**
   según el ajuste de la empresa «De dónde se surte primero»: la ubicación más
   llena, la menos llena, **lo que caduca primero (FEFO)** o **el lote más
   antiguo (FIFO)**. La reserva y la tarea de surtido llevan su lote; el
   almacenista confirma producto, ubicación, **lote** y cantidad. Un lote ya
   caducado no se propone, salvo que la empresa diga otra cosa («Lotes
   caducados al surtir»). Si por eso no alcanza, el pedido lo dice como
   cualquier faltante.
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
7. **Importaciones.** Ningún archivo dice todavía de qué lote es cada
   cantidad, así que no mueven productos por lote: en el archivo de
   existencias (saldos iniciales) ese producto falla entero con su motivo y
   el resto del archivo sigue; en un archivo de salidas, sus filas se
   rechazan con su motivo. Se registran a mano, lote por lote. Un producto
   que nace de una importación es «sin lote».

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
- **Surtido.** `pickSources` sigue siendo el único lugar que decide: devuelve
  ubicación, lote y cantidad. `PICKING_STRATEGY` gana `fefo` y `fifo`. FEFO
  ordena por caducidad (sin fecha al final) y FIFO por antigüedad del lote
  (cuándo se registró por primera vez); con «la más llena» y «la menos llena»
  un producto por lote también surte de un lote concreto. Un producto sin
  lote no tiene fechas: con FEFO o FIFO sale de la ubicación más llena, y el
  ajuste lo dice. Ajuste nuevo `inventory.picking.expired` (`skip` por
  omisión, `allow`): hay empresas para las que la fecha es «consumo
  preferente» y sí despachan después.
- **Tareas.** `warehouse_task.lotId` (inmutable, disparador). Una tarea de
  traslado de un producto por lote se crea con su lote; la de surtido lo
  recibe de `pickSources`. `confirmPick` pide el lote y lo compara con el de
  la tarea.
- **Conteos.** `stock_count_line` lleva lote: una línea por producto y lote
  (índice único ensanchado), con su referencia propia (`systemQuantity` del
  saldo de ese lote). Aplicar ajusta cada lote por separado.
- **Recepción y devolución.** `purchase_receipt_line.lotId` guarda el lote en
  que llegó cada línea; `postReturnExit` saca de ese lote.
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
- **Un conteo o un ajuste no dan de alta lotes.** Se cuenta y se ajusta un
  lote que el sistema conoce; lo que aparece de un lote desconocido se
  registra con una entrada (que pide su caducidad). Evita lotes fantasma por
  un error de captura al contar.

## Dónde se aplica

| Operación | Lote |
| --- | --- |
| Entrada, saldo inicial (`registerEntry`, `registerInitialBalance`) | Se escribe (código y caducidad); se crea o se reutiliza |
| Recepción de orden de compra (`receivePurchaseOrder` → `postReceiptEntry`) | Se escribe por línea; queda en la línea de recepción |
| Salida (`registerExit`), salida rápida (`registerQuickExit`) | Se elige con la ubicación |
| Reubicación (`registerTransfer`) | Se elige con el origen; el destino recibe el mismo lote |
| Tarea de traslado (`createTask` → `deliverTask`) | Se elige al crearla; la entrega mueve ese lote |
| Cambio de estado (`changeStockStatus`) | Se elige con el origen; conserva el lote |
| Ajuste (`registerAdjustment`) | Se elige entre los lotes del producto |
| Conteo (`captureCount`, `applyCount`) | Se elige al capturar; una línea y un ajuste por lote |
| Devolución al proveedor (`returnToSupplier` → `postReturnExit`) | El de la línea de recepción |
| Reversa (`reverseMovement`) | El de cada línea original |
| Liberar pedido y surtir (`pickSources`, `createPickTasks`, `confirmPick`, `deliverPick`) | Lo elige la estrategia; se confirma al surtir; la reserva lo lleva |
| Existencias importadas (`checkImportedStock`) | No admite productos por lote: el producto falla entero con su motivo |
| Salidas importadas (`applyExitImport`) | No admite productos por lote: la fila falla con su motivo |

El selector de lotes de cada pantalla se arma en el servidor
(`listLotStock`, `listProductLots`) y viaja solo el id del lote; el servicio
vuelve a comprobar que es de ese producto.

## Lo que quedó fuera (pendiente)

- **Números de serie** y la **consulta de trazabilidad** por serie o por
  pedido: WMS-21B. `product.tracking` ya es un enumerado para recibir
  `SERIAL`.
- **Varios lotes de una misma línea en una sola recepción.** Hoy son dos
  recepciones.
- **Vida útil mínima al surtir** («no despachar lo que caduca en menos de N
  días») y **bloqueo automático** de lo caducado (pasarlo a «Bloqueado»): hoy
  solo deja de proponerse al surtir; sacarlo a mano sigue permitido, porque
  así se da de baja.
- **Dar de alta un lote desde un conteo** (lo que se encuentra de un lote que
  el sistema no conoce se registra con una entrada).
- **Importaciones con lote:** columnas «Lote» y «Caducidad» en el archivo de
  existencias y «Lote» en el de salidas. Hoy esos productos se rechazan con
  su motivo; nunca entran ni salen sin lote.
- **Un producto que cambió de control** (solo posible sin existencias) deja
  sin efecto lo que estaba a medias con el control anterior: sus movimientos
  viejos ya no se reversan, un conteo abierto pide recontarlo y una
  devolución de una recepción anterior se hace con una salida. Cada caso
  responde con su motivo; no hay una pantalla que los liste antes de cambiar.
- **Reintento de una recepción con otro lote:** una clave repetida compara
  líneas, cantidades y ubicaciones (CMP-10), no el lote tecleado.
- **Pantallas de verificación** (`verify:a11y`, `load:test`): «Por caducar» y
  la ficha del lote no se agregaron a sus listas.
- **Exportación de existencias por lote** y lote en el PDF de la orden y en
  los reportes de Compras.
- **Fecha de fabricación** y otros datos del lote (proveedor, certificado):
  cuando un paso los pida.
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
  `purchase_receipt_line`. Ninguna tabla nueva.
