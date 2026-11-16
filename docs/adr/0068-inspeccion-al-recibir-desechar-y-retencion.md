# ADR 0068 — Inspección al recibir, devolver y desechar lo rechazado, y retención genérica

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-30-0 (propuesta
`docs/flujos/PRODUCCION_CALIDAD.md`, P6, secciones 4, 5.5 punto 2, 5.7, 7 y
13 punto 6) · Completa ADR 0021 (recepción), ADR 0033 (estado del saldo),
ADR 0031 (costo promedio), ADR 0046 (devoluciones de clientes) y ADR 0052
(daños al recibir) · Lo usarán WMS-75 (restauración), WMS-29 (merma de
material) y WMS-30B (verificación de Calidad)

## Contexto

Tres pendientes de ADR 0033 y ADR 0046 (propuesta, sección 13 punto 6):

1. **Recibir en inspección.** Hoy lo que llega de un proveedor entra
   disponible o, si venía roto, dañado (ADR 0052). Hay productos que una
   empresa no deja usar sin revisarlos antes (decidido, P6: para **cualquier
   empresa**, con o sin Calidad).
2. **Qué se hace con lo rechazado.** Lo dañado o rechazado se queda para
   siempre en su estado: la devolución al proveedor solo sale de disponible o
   dañado, y no hay forma de darlo de baja sin un ajuste (que solo toca lo
   disponible).
3. **Retención.** Lo que una devolución de cliente abierta tiene en
   inspección no lo toma nadie más (`heldForReturns`, ADR 0046). La
   verificación de Calidad (WMS-30B) necesita lo mismo, pero vive en otro
   módulo, que depende de Inventario y al que Inventario no puede importar.

Lo que ya existe y se reutiliza sin cambiarlo: el estado `INSPECTION`
(ADR 0033), «hay» frente a «disponible» (**PC-5**: lo no disponible nunca
alimenta salidas, surtido, reposición, mínimos, sugerencias ni
cross-docking, porque todas esas lecturas filtran `AVAILABLE`),
`writeStatusChange` y `permissionForStatusChange` (WMS-11), `postReceiptEntry`
con estado por línea (WMS-54), `postReturnExit` (CMP-12), `openCostBook`
(ADR 0031), `lotForTake`, `serialsForTake` + `writeSerialMoves`,
`createPutawayTasks` (WMS-52) y `assertLocationsInScope` (WMS-20).

## Decisión

### 1. «Inspeccionar al recibir», regla del producto

- Columna nueva `product.inspectOnReceipt` (`BOOLEAN NOT NULL DEFAULT
  FALSE`): por omisión nada cambia. Se cambia en la ficha (Editar producto)
  con `inventory.product.update`; cambia en cualquier momento y vale para las
  recepciones siguientes (lo ya recibido no se toca). Queda en la bitácora
  del cambio del producto, como cualquier otro campo.
- **Flujo.** Quien recibe (Almacenista, Almacén, Supervisor; teléfono o
  tableta en el andén) recibe la orden como siempre: no elige nada nuevo.
  `postReceiptEntry` lee la regla del producto **bajo su candado** y lo sano
  de esa línea entra en `INSPECTION` en lugar de `AVAILABLE`; lo dañado sigue
  en `DAMAGED` (ADR 0052). El resumen lo dice: «Quedó en inspección: 10
  piezas de …».
- `purchase_receipt_line.status` admite el tercer valor (su `CHECK` pasa a
  `AVAILABLE`, `DAMAGED`, `INSPECTION`; el disparador que la compara con su
  línea de movimiento no cambia: ya compara el estado).
- Lo que entra en inspección **cuenta como recibido** para la orden (lo
  pendiente se cuenta por lo capturado, sin estado), **entra al mismo costo**
  (`costs.entry` no mira el estado; el valor cubre todos los estados, ADR
  0033), **no se reparte por cross-docking** ni crea tarea de acomodo (los
  dos ya ignoran lo que no es disponible; además las órdenes de salida que
  bloquea el cross-docking se calculan solo con lo que entra disponible) y
  **no va en la tarima**: se queda suelto, como lo dañado; si todo lo que
  llega es dañado o va a inspección, recibir en tarima se rechaza con su
  motivo.
- `sameReceipt` (CMP-10) compara «sano» contra lo guardado en `AVAILABLE` o
  `INSPECTION`: un reintento después de que alguien cambió la regla del
  producto sigue siendo el mismo reintento.
- Solo las recepciones de compra. Una entrada manual, un saldo inicial, una
  importación o un traslado entre almacenes no miran la regla (su flujo ya
  dice en qué estado entra lo suyo).

### 2. Decidir sin Calidad: «Cambiar estado» y la lista «Por inspeccionar»

- Decide el jefe de almacén (Administrador, Almacén o Supervisor de almacén,
  P3) con «Cambiar estado» (WMS-11), como hoy las devoluciones: a disponible
  (`inventory.status.release`), a rechazado o a dañado
  (`inventory.status.change`), con motivo obligatorio. «A restauración»
  llega con WMS-75. El Almacenista no decide (no tiene esos permisos).
- **Lo liberado en un lugar de paso crea su tarea de acomodo.**
  `changeStockStatus` llama `createPutawayTasks` al final de su transacción
  cuando el cambio termina en `AVAILABLE` (de cualquier estado, no solo de
  inspección: «nada se queda en un lugar de paso sin su tarea», WMS-52); con
  el acomodo manual (por omisión) no pasa nada nuevo. Repite la operación
  ante `isTaskNumberClash`, como la decisión de una devolución.
- **«Por inspeccionar»** (`/inventario/por-inspeccionar`) es una lista
  **derivada** como «Sin acomodar»: saldos en `INSPECTION` del almacén activo
  y dentro del alcance de la persona, paginada en la base. Cada renglón dice
  producto, lote, ubicación, cuánto hay, **de dónde vino** (la última entrada
  en inspección de ese saldo: la recepción `OC-…` o la devolución `DV-…`) y
  cuánto está **retenido** por un documento abierto (sección 5), que no se
  decide desde ahí. La fila abre «Cambiar estado» con ese origen elegido; lo
  retenido por una devolución se decide desde la devolución.
- Quién la ve: `inventory.stock.read` (como «Sin acomodar»); quién recibe el
  aviso «N por inspeccionar» en Inicio e Inventario: quien tiene
  `inventory.status.release` o `inventory.status.change`, y solo si hay algo.
- WMS-30B pone encima la bandeja del inspector sin rehacerla: la lista ya
  devuelve cada saldo con lo retenido y por qué documento
  (`sourceType`/`sourceId` de la retención), y su origen; la bandeja agrega
  sus inspecciones `IN-…` como una fuente de retención más.

### 3. Devolver al proveedor lo rechazado

- Cada renglón de una devolución puede decir **de qué estado sale**
  (`status`): `AVAILABLE`, `INSPECTION`, `DAMAGED` o `REJECTED`. Por omisión,
  el estado en que llegó su línea de recepción (como hoy). En pantalla el
  selector «Sale de» aparece solo cuando ese producto tiene existencias de
  esa recepción en más de uno de esos estados, o en uno distinto del que
  llegó.
- Lo demás no cambia: nunca más de lo recibido (sumado bajo el candado de la
  orden), su lote y sus series (las que llegaron con esa línea), el factor y
  el costo de la línea de recepción. Desde un estado no disponible no hay
  reservas que mirar, pero sí retenciones (sección 5): lo retenido por un
  documento abierto no se devuelve.
- El reintento compara también el estado (lo lee de las líneas del
  movimiento de la devolución; la tabla `purchase_return_line` no cambia).

### 4. «Desechar» (`DISPOSAL`)

- **Flujo.** El jefe de almacén abre el producto, «Desechar», elige de dónde
  (ubicación · estado · lote, solo `DAMAGED` o `REJECTED`), cuánto (y las
  series si el producto es por serie) y por qué (obligatorio). Confirma una
  vez. Teléfono o computadora.
- Escribe un movimiento nuevo `DISPOSAL` (`CHECK` de motivo, al menos 3
  letras, como `STATUS_CHANGE`), una línea `OUT` por origen, con su lote
  (`lotForTake`) y sus series (`serialsForTake` + `writeSerialMoves`; la
  serie queda fuera, `serial_unit.locationId = NULL`). El valor sale **al
  costo promedio vigente** (`costs.exit`, `valueExit`): es una pérdida. Clave
  de confirmación con `repeated` (la misma clave con otra cosa es
  `KEY_REUSED`) y verificación si la respuesta se pierde
  (`findDisposalConfirmation`). Bitácora `inventory.disposed`.
- **No se reversa.** Lo desechado ya no existe físicamente; además, el mismo
  `DISPOSAL` lo escribirán la merma de material (WMS-29) y los faltantes de
  una verificación (WMS-30B), cuyos documentos dirían otra cosa si su salida
  se deshiciera. Un error se corrige con una entrada (o un ajuste) con su
  motivo.
- **Núcleo reutilizable.** `postDisposal(tx, actor, { lines, reason,
  reference, idempotencyKey, allowedStatuses, holdSource })` escribe el
  movimiento dentro de una transacción ajena, después de los candados del
  llamador (los vuelve a tomar en el mismo orden, sin efecto). Por omisión
  solo sale de `DAMAGED`/`REJECTED`; WMS-30B lo llamará con
  `allowedStatuses: ["INSPECTION"]` y su propia retención como `holdSource`
  (lo que su inspección retiene no se le opone), y WMS-29 con lo que diga su
  ADR. Nunca saca existencias disponibles: eso es una salida o un ajuste.
- **Permiso nuevo `inventory.disposal.create`** (titular, Administrador,
  Almacén y Supervisor de almacén: los mismos que ajustan; ni Gerencia, que
  solo lee, ni el piso). Se prefirió uno propio a reutilizar
  `inventory.adjustment.create` porque dar de baja mercancía es una decisión
  distinta de corregir un conteo y una empresa puede querer separarlas. **El
  fundador puede cambiar qué roles lo tienen.**
- **Autorización: pendiente.** El motor de aprobaciones (ADR 0053) podría
  pedirla con una regla apagada por omisión; no se agrega en este paso
  porque ninguna decisión del fundador la pide y el efecto (volver a validar
  lo desechado bajo candado) merece su propio paso.

### 5. Retención genérica (`stock_hold`)

Se eligió **una tabla propia más las fuentes derivadas que ya existían**:

- `stock_hold`: producto, ubicación, **estado no disponible** (`CHECK`
  `status <> 'AVAILABLE'`), lote (`lotKey`), cantidad (inmutable), `remaining`
  (solo baja, nunca bajo 0), `ACTIVE` → `CLOSED` al llegar a 0, documento
  (`sourceType` + `sourceId`), quién y cuándo. `stock_hold_unit`: las
  unidades por serie que retiene, con `releasedAt` que se escribe una vez.
  Disparadores: ni una ni otra se borran; de una retención solo cambian
  `remaining`, `state` y `closedAt`, en ese sentido.
- La escriben **solo** `holdStock(tx, actor, …)` y `releaseHold(tx, …)` de
  `holds.ts`, **dentro de la transacción del documento y después de sus
  candados** (productos → ubicaciones → documento): el candado del producto
  es lo que impide retener dos veces lo mismo, como en las reservas (por eso
  no se bloquean filas de `stock_hold`). `holdStock` comprueba que el saldo
  de ese estado, menos lo ya retenido, alcance, y que cada serie esté ahí y
  no retenida.
- **Las devoluciones de clientes no se migran**: su retención sigue
  derivándose de la devolución (recibido − decidido), con sus pruebas igual.
  Se convierten en una fuente más de `heldStock(tx, lugar, { except })`, que
  suma las dos y es **la única lectura** que usan «Cambiar estado», las
  reversas, «Desechar» y la devolución al proveedor, para cualquier estado no
  disponible. `heldForReturns` queda como la fuente de las devoluciones
  (también la usa la decisión de una devolución para no oponerse a sí
  misma).
- No duplica las reservas: una reserva aparta lo **disponible** para un
  documento que lo va a tomar; una retención congela lo **no disponible**
  mientras un documento lo decide. Lo apartado y lo retenido nunca son el
  mismo saldo.
- `reconcileStock` agrega `source: "holds"`: por cada producto + ubicación +
  estado + lote, lo retenido (retenciones activas y devoluciones abiertas)
  nunca pasa del saldo, y cada serie retenida sigue en ese lugar y estado.
- **Cómo la usará WMS-30B.** «Iniciar verificación» llama `holdStock` con
  `sourceType = "quality_inspection"` en la transacción que crea `IN-0001`;
  cada decisión escribe sus `STATUS_CHANGE` con `writeStatusChange(…, {
  holdSource })` y sus faltantes con `postDisposal(…, { holdSource })`, y
  llama `releaseHold` por lo decidido; cancelar la inspección libera lo que
  quede.

### Candados (sin cambiar el orden del proyecto)

| Operación | Orden |
| --- | --- |
| Recibir (CMP-07) | productos → ubicaciones → orden de compra → pedidos de salida (cross-docking) → contenedor → tareas → capacidad (igual que hoy) |
| Cambiar estado | producto → ubicaciones → (tareas de acomodo) → capacidad |
| Devolver al proveedor | productos → ubicaciones → orden de compra |
| Desechar | productos → ubicaciones (ordenados por id) |
| Retener / soltar | dentro de la transacción del documento, sin candado propio |

### Lo demás

- **Lotes y series:** cada operación resuelve su lote bajo el candado del
  producto; un producto por serie dice cuáles unidades salen o cambian.
- **Contenedores:** lo que está en inspección, dañado o rechazado no va en
  tarimas; «Desechar» no toca contenedores.
- **Capacidad:** recibir en inspección ocupa lugar como cualquier entrada;
  desechar libera lugar (no se comprueba).
- **Alcance:** todo pasa por `assertLocationsInScope` (recibir, cambiar,
  desechar, devolver); la lista «Por inspeccionar» filtra con
  `locationScopeWhere`.
- **Conteos, ajustes, traslados, surtido, reposición, mínimos, sugerencias,
  cross-docking y salidas** solo leen `AVAILABLE`: nada en inspección,
  dañado o rechazado los alimenta (PC-5).
- **Exportaciones y existencias:** el desglose por estado ya incluye
  inspección. **Rastreo e historial:** `DISPOSAL` aparece como «Desecho».
  **Resumen del día** y **API:** sin cambios (la recepción sigue siendo
  `RECEIPT`). El evento de webhook `purchase_order.received` dice ahora el
  estado de cada línea (`status`) además de `damaged`.

## Consecuencias

- Una empresa que no marca productos no ve nada nuevo salvo «Desechar» en la
  ficha (solo si tiene algo dañado o rechazado) y el selector «Sale de» de la
  devolución cuando aplica.
- PC-5 se mantiene por construcción: lo recibido en inspección nunca es
  disponible hasta que una persona con permiso lo decide.

## Pendientes

- Autorización de «Desechar» con el motor de aprobaciones.
- Evento de webhook propio de «Desechar».
- Aviso dentro de la app a quien decide cuando algo entra en inspección (hoy
  lo dice el aviso de Inicio).
- Inspeccionar al recibir en la importación de productos (la regla se pone
  en la ficha).
- Migrar las devoluciones de clientes a `stock_hold` si algún día conviene
  tener una sola fuente.
