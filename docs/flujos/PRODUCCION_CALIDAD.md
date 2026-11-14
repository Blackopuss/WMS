# Propuesta de flujo: producción y calidad (WMS-27..31 y WMS-59)

Fecha: 2026-11-14. Estado: **propuesta para decidir con el fundador**. Nada de
esto está programado ni decidido; los ADR se escriben cuando el fundador
decida (regla 15 de `docs/INSTRUCCIONES_WMS.md`).

Cómo leer este documento:

- **Hecho** = lo dice el código, la especificación o las instrucciones (con su
  referencia).
- **Propuesta** = lo que este documento sugiere. Puede cambiar.
- Los nombres en `código` son tablas, servicios o ajustes reales del
  repositorio; los que están marcados «(nuevo)» todavía no existen.

---

## 1. Resumen de una página (para el fundador)

**Qué se propone construir.** Dos módulos que se contratan por separado:

- **Producción** (`production`): recetas de lo que se fabrica, arma, mezcla o
  reempaca; órdenes de producción que apartan los insumos; un «reporte de
  producción» desde el teléfono o la tableta que dice en un solo paso qué se
  usó, cuánto salió bien, cuánto se echó a perder y por qué, quién lo hizo y en
  qué turno; y el cierre de la orden con sus cuentas cuadradas.
- **Calidad** (`quality`): inspecciones de lo que espera revisión (lo que llega
  del proveedor, lo que sale de producción, lo que devuelve un cliente, o
  cualquier existencia), con criterios por producto, defectos y la decisión:
  aprobado, rechazado o en cuarentena. Solo lo aprobado queda disponible.

**Ideas centrales de la propuesta.**

1. Una receta es «lo que entra y lo que sale». Así sirve igual para ensamblar
   (muchos insumos, un producto), mezclar a granel (kilos que rinden kilos),
   armar un kit (varios productos, una caja) y desarmarlo (una caja, varios
   productos). No hay recetas «de un giro».
2. Cada reporte de producción es **un solo movimiento de inventario** con dos
   lados: lo que salió de existencias (insumos) y lo que entró (producto). Eso
   da tres cosas sin inventar mecanismos nuevos: el costo del producto sale del
   costo de lo que se usó; la trazabilidad (qué lote de insumo fue a qué lote de
   producto) se lee del propio movimiento; y nada queda a medias si falla la
   red.
3. Lo que necesita revisión entra **en inspección**, un estado que el sistema
   ya tiene (`INSPECTION`). Ya funciona así con las devoluciones de clientes.
   Mientras esté en inspección no se puede surtir, sacar ni apartar.
4. Las etapas intermedias (material cortado, subensambles) son **productos con
   su propia receta y su propia orden**. «Materia prima → corte → subensamble →
   producto terminado» son tres órdenes encadenadas, no un estado nuevo.
5. Calidad sin producción sirve desde el primer día: inspección al recibir y de
   devoluciones. Producción sin calidad también: lo producido entra disponible
   o en inspección según el producto, y alguien con permiso lo libera como hoy
   se libera cualquier existencia.

**Orden propuesto** (detalle en la sección 9):

1. Roles y esqueleto de los dos módulos (WMS-59).
2. Inspección al recibir y desechar o devolver lo rechazado (base en
   Inventario y Compras; sirve antes de tener los módulos).
3. Recetas (WMS-27) y, en paralelo, criterios de inspección (WMS-30A).
4. Órdenes de producción con insumos apartados (WMS-28).
5. Reporte de producción: consumo, producción, merma, turno y trabajador
   (WMS-29, con el caso 5.5 de la especificación como prueba de aceptación).
6. Inspección y liberación por lote (WMS-30B, PC-4 y PC-5).
7. Producto terminado a su lugar y cierre de la orden (WMS-31).

**Qué necesita decidir el fundador antes de empezar** (detalle en la sección
8): qué entra al costo del producto (solo materiales o también mano de obra);
si se registra producción de trabajadores que no tienen cuenta en el sistema;
cómo salen los insumos del almacén (directo o surtidos a la línea); cómo se
captura el consumo; qué se inspecciona; cómo se entiende «no liberar más de lo
inspeccionado» cuando se inspecciona por muestra; si con Calidad contratada
alguien más puede liberar a mano; cómo se nombra el lote del producto
terminado; si Calidad puede contratarse sin Producción; y qué hacer cuando se
produce de más.

---

## 2. Lo que ya existe y se reutiliza

Hechos del código (rama `pruebas`, 2026-11-14). Producción y calidad se
apoyan en esto; no se duplica.

| Pieza | Dónde | Cómo la usan producción y calidad (propuesta) |
| --- | --- | --- |
| Estados del saldo `AVAILABLE`, `RECEIVING`, `INSPECTION`, `QUARANTINE`, `DAMAGED`, `REJECTED`, `IN_TRANSIT`, `BLOCKED` | `StockStatus` en `prisma/schema.prisma`, `stock-status.ts`, ADR 0033 | Lo producido o recibido que pide revisión entra en `INSPECTION`; las decisiones lo pasan a `AVAILABLE`, `QUARANTINE` o `REJECTED`. Ningún estado nuevo. |
| «Disponible» = solo `AVAILABLE` menos lo apartado | ADR 0033, `freeToTake`, `getProductStock` | Lo que está en inspección, cuarentena o rechazado nunca se surte, se aparta ni se consume como insumo normal (**PC-5** ya se cumple en las lecturas). |
| Cambio de estado con motivo, `STATUS_CHANGE` | `changeStockStatus` y su núcleo `writeStatusChange` (`status-change.ts`), `permissionForStatusChange` | Cada decisión de calidad se escribe con `writeStatusChange`, igual que hoy las decisiones de devoluciones. |
| Devoluciones de clientes entran siempre en inspección y se deciden | `receiveCustomerReturn`, `decideCustomerReturn`, `heldForReturns` (`customer-returns.ts`, `return-holds.ts`), ADR 0046 | Ya es un flujo de inspección mínimo. Calidad las muestra en su bandeja y decide **a través de `decideCustomerReturn`** (no otra forma de decidir). |
| Lo dañado al recibir es su propia línea en `DAMAGED` | `postReceiptEntry` con `status` por línea, ADR 0052 | La inspección al recibir agrega `INSPECTION` como tercer valor posible de esa línea. |
| Lotes, caducidad y series | `lot`, `lotForEntry`/`lotForTake` (`lot-resolve.ts`), `serial_unit`, `serialsForEntry`/`serialsForTake` (`serials.ts`), ADR 0040/0041 | Insumos y producto por lote o serie usan exactamente estas funciones. |
| Rastreo | `findTraceMatches`, `traceLot`, `traceSerial` (`traceability.ts`) | Se amplía para seguir un lote a través de un reporte de producción (hacia adelante y hacia atrás). |
| Reservas con fuente genérica | `stock_reservation` (`sourceType` + `sourceId`), `reserveStock`, `consumeReservation`, `releaseReservations` (`reservations.ts`), WMS-12 | Liberar una orden aparta sus insumos con la fuente `production_order_line` (nueva constante, sin tabla nueva). |
| Tareas de almacén | `warehouse_task`, `tasks.ts`, `WAREHOUSE_TASK_TRANSITIONS`, tipos `TRANSFER`, `PICK`, `PUTAWAY`, `REPLENISH` | Surtir insumos a la línea es un tipo de tarea más; llevar producto terminado a su lugar es el acomodo que ya existe. |
| Acomodo con recomendación | `createPutawayTasks`, `putawayTarget`, `WAITING_PLACE` (`unplaced.ts`), ADR 0042 | Lo liberado en el área de producción crea su tarea de acomodo como hoy lo liberado de una devolución (WMS-31 casi no programa nada nuevo). |
| Costo promedio por producto | `product_cost`, `average-cost.ts` (`valueEntry`/`valueExit`), `valuation.ts`, ADR 0031 | El producto terminado entra al costo de lo consumido en su reporte. |
| Aprobaciones | `src/platform/approvals`, `approvalTypes` (registro), ADR 0053 | Liberar de cuarentena y cerrar una orden con faltante pueden pedir autorización si la empresa lo enciende (apagado por omisión). |
| Avisos | `notify` de `@/platform/notifications`, `notificationTypes`, ADR 0057 | «Hay un lote por inspeccionar», «Calidad liberó el lote L-…» (lo pidió la retroalimentación de campo, `PLAN_WMS_V3.md`). |
| Incidencias | `incidents.ts`, ADR 0057 | Un paro de línea o un insumo que no llegó se reporta como incidencia; no se crea otra cosa. |
| Ajustes por empresa | `SettingDefinition`, `readSetting`, `operationSettings`, ADR 0034 | Todo lo que admite más de una forma va como ajuste con valor por omisión (sección 6). |
| Campos personalizados | `src/platform/custom-fields`, ADR 0056 | Recetas y órdenes pueden ser entidades nuevas más adelante (fuera de la primera versión). |
| Registro de módulos, derechos y solo lectura | `defineModule`, `createModuleRegistry`, `assertModulePermission`, `ROLE_MODULE` (hoy vacío), MOD-11 | Cada módulo con su contrato; sus roles, ligados a su módulo. |
| Unidades y presentaciones | `UNITS` (pieza, par, docena, kg, g, m, cm, mm, l, ml, m²), `resolveConversion`, presentaciones | «Tarima de 50 hojas de triplay» es una presentación; el consumo puede capturarse en hojas, m² o kg según el producto. |

Hechos que **limitan** la propuesta:

- Las cantidades del saldo y de los movimientos tienen 3 decimales
  (`Decimal(12, 3)`). Una receta de «0.0025 kg por pieza» no cabe: por eso se
  propone que la receta se escriba **por una cantidad base** («para 100
  piezas», «para un lote de 500 kg»).
- Una tarea `PICK` exige un pedido de salida (`CHECK warehouse_task_pick_line`).
  Surtir a producción necesita su propio tipo de tarea.
- `postReceiptEntry` y `postReturnExit` solo aceptan `AVAILABLE` o `DAMAGED`;
  `registerExit` solo saca disponible. Recibir en inspección, desechar lo
  rechazado y devolver al proveedor lo rechazado requieren extender
  Inventario y Compras.
- Hoy `changeStockStatus` permite pasar `REJECTED` o `INSPECTION` a
  disponible a quien tenga `inventory.status.release`. Ver la sección 10
  (contradicciones).
- No existe un uso de ubicación «Producción» (`LocationType`: `STORAGE`,
  `PICKING`, `RECEIVING`, `STAGING`, `QUARANTINE`, `DOCK`).

---

## 3. Conceptos (propuesta)

| Palabra en pantalla | Qué es | Tabla (nueva) |
| --- | --- | --- |
| Receta | Lo que entra y lo que sale para hacer una cantidad base de un producto, con su merma esperada. Tiene versiones. | `recipe`, `recipe_version`, `recipe_input`, `recipe_output`, `recipe_step` |
| Orden de producción | «Hacer 200 crates tipo A con la receta v3 para el jueves en el almacén Norte». Número `OP-0001`. | `production_order`, `production_order_input`, `production_order_output` |
| Reporte de producción | Lo que se hizo en un rato de trabajo: cuánto salió bien, cuántas piezas malas, qué se usó, cuánto se tiró, quién y en qué turno. Escribe un movimiento `PRODUCTION`. | `production_report`, `production_report_scrap` |
| Trabajador | Persona que produce. Puede no tener cuenta en el sistema (ver decisión D2). | `production_worker` |
| Turno | Nombre y horario por almacén («Matutino 6:00-14:00»). | `production_shift` |
| Área de producción | Una ubicación con uso «Producción» donde se dejan insumos surtidos y aparece lo producido. | `LocationType.PRODUCTION` (valor nuevo) |
| Inspección | La revisión de una cantidad de un producto (y lote) que espera en inspección. Número `IN-0001`. | `quality_inspection`, `quality_inspection_result`, `quality_inspection_defect` |
| Plan de inspección | Qué se revisa de un producto o categoría: preguntas sí/no, mediciones con mínimo y máximo, notas; y si es por muestra o completa. | `quality_plan`, `quality_check` |
| Defecto | Catálogo de la empresa («rayado», «medida fuera», «humedad»). | `quality_defect` |
| Disposición de lo rechazado | Qué se hace con lo rechazado: devolver al proveedor, desechar o reprocesar. | Usa movimientos existentes y nuevos (sección 4.6) |

---

## 4. Flujos paso a paso

### 4.1 WMS-27 · Recetas versionadas

**Quién y dónde.** Supervisor de producción o administración, en escritorio.

**Flujo (propuesta).**

1. En Producción › Recetas, «Nueva receta» para un producto. La receta dice:
   - **Cantidad base** y su unidad (la del producto): «para 1 crate», «para
     100 piezas», «para 500 kg».
   - **Entradas (insumos):** producto, cantidad por la cantidad base (en la
     unidad del producto o en una presentación, convertida con
     `resolveConversion` al guardar), merma esperada en % (opcional),
     sustitutos permitidos (otros productos con su propia cantidad).
   - **Salidas:** el producto principal (siempre una) y, si hay, coproductos o
     subproductos con su cantidad esperada y su **parte del costo** (por
     omisión 100 % al principal y 0 % a los demás; ver D-E3).
   - **Pasos** (opcional): nombres libres en orden («Corte», «Ensamble»,
     «Pintura»). Solo sirven para decir en qué paso se reportó algo; no crean
     existencias intermedias (decisión D10).
2. Guardar crea la versión 1 en borrador. «Activar» la vuelve la versión que
   usan las órdenes nuevas. Un producto tiene como mucho una versión activa
   por receta; puede tener varias recetas (p. ej. «en planta» y «de emergencia»)
   y una marcada como principal.
3. Una versión que ya usó una orden **no se edita**: «Nueva versión» copia la
   activa en un borrador nuevo (disparador en la base, como las órdenes de
   compra).

**Qué valida el sistema.** Cantidades con `parseQuantity` y la regla de cada
producto; un insumo no puede ser el mismo producto que la salida principal
salvo en reproceso (D-E2); sin ciclos directos (A usa B y B usa A); productos
activos; las partes del costo suman 100 %.

**Rastro.** La versión guarda quién la creó y la activó (bitácora
`production.recipe_activated`). Las versiones nunca se borran.

**Estados de una versión.** `DRAFT → ACTIVE → RETIRED` (`DRAFT → DISCARDED`).
Tabla de transiciones pura más disparador, como `order-states.ts`.

**Mismo modelo para todos los giros.**

| Empresa | Cantidad base | Entradas | Salidas |
| --- | --- | --- | --- |
| Ensambla (crates, muebles, equipos) | 1 pieza | 2.5 hojas de triplay, 40 clavos, 4 patines | 1 crate |
| Mezcla a granel (alimentos, químicos, pinturas) | 500 kg | 300 kg A, 150 kg B, 60 l agua; merma esperada 2 % | 500 kg de mezcla |
| Reempaca (kits, promociones) | 1 kit | 1 de A, 2 de B, 1 caja | 1 kit |
| Desarma (abrir kits, despiezar) | 1 kit | 1 kit | 1 de A, 2 de B (coproductos con su parte del costo) |
| Corta (materia prima a material cortado) | 1 hoja | 1 hoja de triplay | 4 tableros (y recorte como subproducto, si se aprovecha) |

**Reutiliza:** conversión de unidades y presentaciones, catálogo de productos,
bitácora. **Nuevo:** tablas de receta, servicios en `src/modules/production`.

**Permisos (propuesta):** `production.recipe.read`, `production.recipe.manage`.

**Listo cuando:** una receta se crea, se activa, se versiona; la versión usada
no cambia (disparador); el caso «0.0025 kg por pieza» se escribe como «0.25 kg
por 100 piezas» sin perder exactitud; aislamiento entre empresas.

---

### 4.2 WMS-28 · Órdenes de producción con insumos apartados

**Quién y dónde.** Supervisor de producción, en escritorio o tableta.

**Flujo (propuesta).**

1. «Nueva orden»: producto, cantidad objetivo, receta (la principal por
   omisión), día compromiso, prioridad, área de producción (ubicación con uso
   «Producción» del almacén activo) y notas. Número `OP-0001`. La orden copia
   de la versión de receta, multiplicadas por la cantidad objetivo, sus
   líneas de insumo y de salida (`production_order_input`,
   `production_order_output`): así cambiar la receta después no cambia la
   orden.
2. En borrador se pueden ajustar cantidades de los insumos (con motivo
   guardado) o cambiar un insumo por un sustituto de la receta.
3. **«Liberar orden»**: en una transacción, bloquea productos → orden, y
   aparta cada insumo con `reserveStock` (fuente `production_order_line` + id
   de la línea, sin ubicación, igual que un pedido de salida). Si algo no
   alcanza, responde qué falta y se puede liberar apartando lo que hay
   (`takeWhatThereIs`, igual que los pedidos), o no liberar (ajuste
   `production.release.short`, D-E5).
4. Según el ajuste `production.materials.mode` (D3):
   - `direct` (propuesta por omisión): los insumos se quedan donde están; al
     reportar se consumen de donde estén apartados (el sistema propone de
     dónde con el mismo orden de `rankStockSources`: lo que caduca antes,
     primero).
   - `issue`: liberar crea tareas **«Surtir a producción»** (tipo nuevo de
     `warehouse_task`, ver abajo) desde almacenamiento hasta el área de
     producción. Al entregar, lo surtido queda apartado ahí para la misma línea
     (como `deliverPick` deja lo surtido apartado en Preparación).
5. Avisa a los operarios del almacén y área (`notify`, tipo
   `production.order_released`).

**Estados de la orden (propuesta).**

```text
DRAFT -> RELEASED -> IN_PROGRESS -> CLOSED
  \-> CANCELLED   \-> CANCELLED   \-> (cerrar con faltante: CLOSED, motivo)
```

- `IN_PROGRESS` empieza con el primer reporte.
- `CLOSED` se alcanza con «Cerrar orden» (WMS-31): si lo producido no llega
  al objetivo, pide motivo (faltante derivado, nunca guardado, como
  `closePurchaseOrder`).
- Tabla `PRODUCTION_ORDER_TRANSITIONS` pura y disparador
  `production_order_transition` que la repite.

**Tarea «Surtir a producción» (propuesta).** Tipo nuevo `ISSUE` de
`warehouse_task`. Como Inventario no debe conocer las tablas de Producción, la
tarea no apunta a la orden: lleva la **reserva** de la línea (fuente opaca
`production_order_line` + id) y su destino. Inventario ofrece un servicio
genérico (nuevo, `createIssueTasks(tx, …)`, dentro de la transacción de quien
libera) que aparta en el origen como hoy `TASK_HOLD`, y al entregar mueve y
vuelve a apartar en el destino para la misma fuente. Montacarguistas y
almacenistas ya pueden ejecutarla con `inventory.task.execute`. Ninguna regla
de surtido nueva: el origen lo elige `rankStockSources`.

**Qué valida.** Permiso y módulo; área de producción del almacén activo y
dentro del alcance de la persona (`assertLocationsInScope`); insumos activos;
la orden solo cambia en borrador (disparador, como las órdenes de compra).

**Rastro.** Bitácora de liberar, cancelar y cerrar; las reservas tienen su
fuente; las tareas, su historia.

**Cancelar.** Desde `DRAFT` o `RELEASED` sin reportes: libera las reservas
(`releaseReservations`) y cancela las tareas `ISSUE` abiertas (lo ya
entregado al área queda ahí, disponible y sin apartar, y aparece en «Sin
acomodar» para regresarlo). Con reportes ya registrados: no se cancela, se
**cierra con faltante** (los consumos ya hechos son un hecho; ver 5.6).

**Permisos (propuesta):** `production.order.read`, `production.order.create`
(borrador), `production.order.release`, `production.order.cancel`,
`production.order.close`.

**Listo cuando:** estados con disparador; liberar aparta exactamente lo de la
orden y dos órdenes a la vez no apartan más de lo disponible (**PC-2**, prueba
con `Promise.all`); cancelar libera todo; con `issue`, las tareas surten al
área y lo surtido sigue apartado para la orden; alcance por almacén y zona
(`tests/inventory/scope.int.test.ts`); `reconcileStock` vacío.

---

### 4.3 WMS-29 · Reporte de producción: consumo, producción, merma, turno y trabajador

Es el corazón de la propuesta.

**Quién y dónde.** Operario de producción o su supervisor, en teléfono o
tableta junto a la línea; puede ser una tableta compartida (ver D2 y WMS-38,
PIN).

**Flujo en pantalla (propuesta, KISS: «capturo y guardo»).**

1. «Mis órdenes» muestra las órdenes liberadas o en curso de su área. Toca
   una.
2. «Reportar producción»:
   - **Salió bien:** cantidad (en la unidad del producto o en una
     presentación). Si el producto es por lote, el lote se propone solo (D8)
     y, si sus lotes llevan caducidad obligatoria, la pide. Si es por serie,
     se escanean o escriben las series (una por renglón, como `SerialsField`).
   - **Piezas malas** (opcional): cantidad y motivo de una lista de la
     empresa. No entran a existencias; cuentan para la conciliación.
   - **Se usó** (prellenado): el sistema calcula lo que pide la receta para lo
     producido (bueno + malas) y lo muestra; el operario confirma o corrige
     cada renglón (D4). Para cada insumo por lote o serie, propone de dónde y
     de qué lote (lo apartado para la orden, lo que caduca antes primero) y se
     puede escanear otro lote.
   - **De lo usado, se tiró** (opcional): merma de insumo, cantidad y motivo
     (recortes, derrame).
   - **Quién y cuándo:** trabajador(es) (por omisión, quien captura), turno
     (propuesto por la hora y el horario del almacén), paso de la receta si
     tiene pasos.
3. «Guardar». Aviso verde con lo registrado.

**Qué escribe el sistema (propuesta).** En **una** transacción
(`LOCKING_TRANSACTION`), candados en el orden del proyecto: productos
(insumos y salidas, en una sola llamada a `lockRows`) → ubicaciones → orden →
contenedor (si aplica) → capacidad:

1. Busca la clave de confirmación (`idempotencyKey`); si ya existe y es lo
   mismo, responde `repeated` (INV-21/22).
2. Comprueba que la orden siga liberada o en curso.
3. Resuelve lotes (`lotForTake` para insumos, `lotForEntry` para lo
   producido) y series (`serialsForTake`, `serialsForEntry` y
   `writeSerialMoves` antes de las líneas).
4. Consume primero lo apartado para la orden (`consumeReservation`); si usa
   más de lo apartado, toma lo libre (`freeToTake`); si no hay, rechaza con el
   renglón y lo que falta. Un insumo que no está en la receta ni en sus
   sustitutos: solo con el ajuste `production.consumption.unlisted = allow` y
   motivo.
5. Escribe **un movimiento `PRODUCTION`** (tipo nuevo de
   `StockMovementType`) con:
   - líneas `OUT`: cada insumo usado, de su ubicación, estado `AVAILABLE` y
     lote (la merma de insumo es parte de estas líneas; se marca aparte en
     `production_report_scrap`, ligada a la línea);
   - líneas `IN`: lo que salió bien, en el área de producción de la orden, en
     estado `INSPECTION` si el producto pide inspección al producirse
     (sección 4.4) o `AVAILABLE` si no; coproductos y subproductos igual.
6. Costo (sección 5): `valueExit` por cada insumo al costo promedio; el valor
   total se reparte entre las salidas según su parte del costo y se aplica con
   `valueEntry` a cada una; cada línea guarda su `unitCost`.
7. `checkPlacement` una vez con todas las llegadas (modo `report`: no
   detiene una producción que ya ocurrió, lo dice en el resumen).
8. Escribe `production_report` (orden, movimiento, bueno, malas con motivo,
   trabajador, turno, paso, quién capturó) y pasa la orden a `IN_PROGRESS`.
9. Si lo producido entró disponible en el área de producción y el acomodo por
   tareas está encendido, crea su tarea de acomodo (`createPutawayTasks`; el
   área de producción se agrega a `WAITING_PLACE`).
10. Si algo entró en inspección, avisa a quien lo puede decidir en ese
    almacén (`notify`): con el tipo `production.output_to_inspect`, declarado
    por Producción (no por Calidad, para no depender de ella), a quien tenga
    `quality.inspection.create` o, sin Calidad, `inventory.status.release`.

**Rastro.** El movimiento (autor, fecha, líneas, lotes, series, costo); el
reporte (trabajador, turno, paso, piezas malas y merma con motivo). Nada se
edita: un error se corrige con una reversa del reporte (sección 5.7).

**Producción por turno y trabajador.** Sale de `production_report`
(cantidad buena, malas y merma por trabajador, turno, paso, producto y día del
calendario de la empresa, `dayWindow`). La especificación (sección 7) pide no
usar piezas como única medida: el reporte trae producto y paso para comparar
lo comparable; las gráficas son WMS-33 (Fase 4).

**Caso 5.5 de la especificación como prueba de aceptación (propuesta de
guion).**

1. Productos: «Triplay 12 mm 1.22×2.44» por lote (unidad hoja, presentación
   «Tarima de 50 hojas»), «Clavo 2"» (kg), «Patín» (pieza), «Crate tipo A» por
   lote con inspección al producirse, «Crate tipo B».
2. Se recibe una orden de compra: 2 tarimas de triplay (lote T-01), en
   inspección al recibir; Calidad aprueba 95 hojas y rechaza 5 (humedad), que
   se devuelven al proveedor.
3. Receta del crate A: para 1 crate, 2.5 hojas, 0.2 kg de clavo, 4 patines;
   merma esperada de triplay 4 %.
4. Orden OP-0001: 30 crates A. Liberar aparta 75 hojas, 6 kg, 120 patines.
5. Turno matutino, trabajadora «Ana» (sin cuenta): reporta 18 buenos, 1 malo
   (medida), usa 49 hojas (1.5 de recorte tirado, motivo «corte»), 3.8 kg,
   76 patines.
6. Turno vespertino, «Luis»: 10 buenos, usa 26 hojas, 2 kg, 40 patines.
7. Los 28 crates entran en inspección, lote OP-0001-1 y OP-0001-2. Calidad
   inspecciona 28: aprueba 26, rechaza 1 (para reproceso), pone 1 en
   cuarentena.
8. Lo aprobado crea tareas de acomodo a producto terminado; el montacarguista
   las entrega.
9. Cierre con faltante: objetivo 30, bueno 28, malo 1; motivo «faltó
   triplay». Se libera lo que quedaba apartado.
10. Comprobaciones: existencias y valor reconcilian (`reconcileStock`,
    `reconcileValue` vacíos); el costo de cada crate = valor de lo consumido en
    su reporte ÷ buenos; rastrear T-01 lleva a OP-0001-1 y OP-0001-2 y de
    ahí a su ubicación; rastrear OP-0001-1 lleva a T-01; producción por turno
    y trabajador da Ana 18 / 1 malo y Luis 10; aprobado + rechazado +
    cuarentena = inspeccionado (**PC-4**); el crate rechazado no aparece como
    disponible (**PC-5**).

**Permisos (propuesta):** `production.report.create` (reportar),
`production.report.reverse` (corregir), `production.worker.manage`
(trabajadores y turnos).

**Listo cuando:** el guion del caso 5.5 pasa completo como prueba de
integración; reintentar un reporte no duplica (**PC-3**); dos reportes a la
vez sobre los mismos insumos no consumen más de lo que hay (**PC-2**); un
producto por serie o lote queda trazado; `reconcileStock` y `reconcileValue`
vacíos.

---

### 4.4 Inspección al recibir (base, sin módulo de calidad) · WMS-30 parte 0

Hecho: la especificación pide «Enviar a inspección cuando aplique» al recibir
(5.1) y la recepción con inspección de calidad (instrucciones, 4.C). Hoy una
recepción entra disponible o dañada.

**Propuesta.** Una regla del producto (columna nueva en `product`, como
`tracking`): **«Inspeccionar al entrar»** con dos casillas, «al recibir de un
proveedor» y «al producirse». Por omisión ninguna (nada cambia para quien no
la usa). Ver D5 para reglas por proveedor o categoría.

**Flujo.** Quien recibe la orden de compra (teléfono o tableta) ve, junto al
producto, «Entra a inspección». Lo sano de esa línea se escribe con
`postReceiptEntry` en `INSPECTION` (en vez de `AVAILABLE`); lo dañado sigue
siendo su línea `DAMAGED`. No se reparte por cross-docking, no lleva tarea de
acomodo y no va en tarima hasta decidirse (igual que lo dañado hoy). La
orden de compra cuenta lo recibido igual: recibir no es aprobar.

**Quién decide sin Calidad.** Quien tenga `inventory.status.release` o
`inventory.status.change`, con «Cambiar estado» (como cualquier existencia
hoy). **Con Calidad**, ver 4.5 y D7.

**Listo cuando:** una recepción de un producto con la regla entra en
inspección; lo dañado sigue aparte; lo que espera no se surte ni se aparta;
`sameReceipt` compara también el estado; una devolución al proveedor puede
salir de inspección o de rechazado (4.6).

---

### 4.5 WMS-30 · Inspección y liberación por lote (módulo Calidad)

**Quién y dónde.** Inspector de calidad, en tableta junto al producto
(especificación 4.4); revisión en escritorio.

**Qué espera inspección (derivado, sin banderas).** Toda existencia en
`INSPECTION` del almacén activo y dentro del alcance de la persona, agrupada
por producto, lote, ubicación y **origen**, que se lee del movimiento que la
metió: `RECEIPT` (recepción de compra), `PRODUCTION` (reporte de producción),
`CUSTOMER_RETURN` (devolución), `STATUS_CHANGE` (alguien la mandó a
inspección a mano). Menos lo que ya cubre una inspección abierta.

**Flujo (propuesta).**

1. Bandeja «Por inspeccionar» (Inicio del inspector). Toca un grupo, o escanea
   la etiqueta del lote o la ubicación.
2. «Iniciar inspección»: crea `IN-0001` con producto, lote, ubicación,
   origen (texto y referencia opaca: `purchase_receipt_line:<id>`,
   `production_report:<id>`, `customer_return_line:<id>`), y **cantidad
   recibida para inspección** = lo que hay en inspección de ese grupo. Esa
   cantidad queda **retenida para la inspección** (ver «Retención» abajo).
3. Captura, en el orden que quiera:
   - **Cantidad inspeccionada** (con muestreo, el tamaño de la muestra; ver
     D6) y las respuestas del plan: sí/no, mediciones (fuera de rango se
     marca sola), notas.
   - **Defectos** de la lista de la empresa, con cantidad.
   - **Evidencia**: fotos, cuando exista WMS-37 (obligatorias si la empresa
     lo pide; la retroalimentación de campo lo pidió).
4. **Decisión:** cantidad aprobada, rechazada y en cuarentena, con motivo
   para rechazo y cuarentena. Regla: aprobada + rechazada + cuarentena =
   inspeccionada (inspección completa) o = recibida (muestreo con decisión
   sobre el lote, D6); y nunca más de lo recibido para inspección (**PC-4**).
5. «Confirmar decisión»: en una transacción, candados productos → ubicaciones
   → inspección, escribe un `STATUS_CHANGE` por destino con `writeStatusChange`
   (el núcleo de «Cambiar estado»): `INSPECTION → AVAILABLE`, `→ REJECTED`,
   `→ QUARANTINE`. Opcionalmente cada parte cambia de lugar (`toLocationId`,
   mismo almacén: p. ej. lo rechazado a la ubicación de cuarentena). La
   inspección queda `DECIDED` y es inmutable.
6. Lo aprobado que quedó en un lugar «de paso» (General, recepción, área de
   producción) crea su tarea de acomodo (lo mismo que hoy hace la decisión de
   una devolución). «Solicitar traslado» crea una tarea normal a otro lugar.
7. Avisos: a quien reportó la producción o recibió (`quality.decided`, «Calidad
   liberó 26 de OP-0001-1»).

**Devoluciones de clientes.** Aparecen en la misma bandeja; la decisión se
escribe **llamando a `decideCustomerReturn`** (Calidad importa Inventario),
así la devolución sigue cerrándose como hoy y no hay dos caminos.

**Cuarentena.** Lo que queda en `QUARANTINE` se vuelve a inspeccionar
(«Reinspeccionar», otra `IN-…` con origen = la inspección anterior) o se
libera con decisión autorizada: permiso `quality.lot.release` y, si la empresa
enciende la regla `quality.release` del motor de aprobaciones (apagada por
omisión), espera autorización (`pending_approval`) como un ajuste grande.
Hecho: la especificación 5.6 pide «no liberar producto en cuarentena sin una
decisión autorizada».

**Retención (propuesta).** Mientras una inspección está abierta, su cantidad
no se puede cambiar de estado a mano ni tomar por otra inspección. Hoy existe
`heldForReturns` solo para devoluciones; se propone que Inventario ofrezca una
retención genérica de existencias no disponibles con fuente opaca (como la de
las reservas, pero para estados distintos de `AVAILABLE`), que Calidad escribe
y libera con servicios de Inventario. Así Inventario no conoce a Calidad.

**Quién puede liberar a mano con Calidad contratada** (D7): propuesta, un
ajuste de Inventario `inventory.inspection.release` = `manual` (hoy) |
`inspection_only` (solo una inspección o una decisión de devolución saca
existencias de `INSPECTION`, `QUARANTINE` y `REJECTED`). Por omisión
`manual`; al contratar Calidad, la pantalla de Operación sugiere encenderlo. Si
la empresa deja de tener Calidad, se lee como `manual` para que nada quede
atrapado (Inventario pregunta a la plataforma si el módulo `quality` está
activo por su id, sin importarlo).

**Estados de la inspección.** `OPEN → DECIDED`, `OPEN → CANCELLED` (suelta la
retención; motivo). Tabla pura y disparador.

**Permisos (propuesta):** `quality.inspection.read`, `quality.inspection.create`
(iniciar y capturar), `quality.inspection.decide` (aprobar, rechazar, poner en
cuarentena), `quality.lot.release` (liberar de cuarentena),
`quality.plan.manage` (planes y defectos). Decidir pide además los permisos
de Inventario del cambio que escribe (`permissionForStatusChange`), igual que
las devoluciones: decidir nunca da más poder.

**Listo cuando:** no se aprueba más de lo inspeccionado ni se libera más de lo
aprobado (**PC-4**); lo rechazado nunca aparece disponible, tampoco por
«Cambiar estado» con `inspection_only` (**PC-5**); dos inspectores no deciden
la misma cantidad dos veces (concurrencia); reintento no duplica; alcance; la
decisión de una devolución pasa por `decideCustomerReturn`; `reconcileStock`
vacío.

---

### 4.6 Lo rechazado: devolver, desechar o reprocesar

| Destino | Cómo (propuesta) | Qué escribe |
| --- | --- | --- |
| Devolver al proveedor | `returnToSupplier` (Compras) acepta salir de `REJECTED` o `INSPECTION` además de `AVAILABLE` y `DAMAGED`, por la recepción de donde vino (lote y series de esa línea). Resuelve también el pendiente de ADR 0046 («devolver al proveedor lo que un cliente regresó y se rechazó» queda como siguiente). | Movimiento `RETURN` existente |
| Desechar | Operación nueva de Inventario «Desechar» desde `DAMAGED` o `REJECTED`, con motivo, permiso `inventory.status.change` (o uno nuevo `inventory.disposal.create`, D-E7). Sale al costo promedio (ADR 0033 ya lo prevé: «lo rechazado o dañado que se desecha sale con una salida normal»; hoy `registerExit` solo saca disponible). | Movimiento nuevo `DISPOSAL` |
| Reprocesar | Una orden de producción de tipo «Reproceso» cuyo insumo es el mismo producto en `REJECTED` (o `DAMAGED`) y cuya salida es el producto bueno, con insumos extra si hace falta. | Movimiento `PRODUCTION` que consume de un estado no disponible (D-E2) |

---

### 4.7 WMS-31 · Producto terminado a su ubicación y cierre de la orden

**Llevar a su lugar (propuesta).** No se programa un flujo nuevo:

- Lo que entra disponible al área de producción, o lo que Calidad libera ahí,
  crea su tarea `PUTAWAY` con `createPutawayTasks` (agregando el uso
  «Producción» a `WAITING_PLACE`); el lugar lo recomienda `putawayTarget`
  (junto a lo mismo, respeta capacidad y restricciones).
- Con el acomodo manual (`inventory.putaway.mode = manual`, por omisión), lo
  producido aparece en «Sin acomodar» y se reubica como hoy.
- Si se produce sobre tarima, «Armar tarima» con lo producido y una tarea por
  tarima (`createContainerPutawayTask`) cuando `inventory.containers.mode =
  on`.

**Cerrar la orden.** Supervisor, en escritorio o tableta. «Cerrar orden»
muestra la conciliación, derivada en la consulta:

```text
Objetivo                     30
Salió bien                   28   (reportes)
Piezas malas                  1   (reportes, por motivo)
Faltante                      1   (objetivo − bueno, si es positivo)
De lo bueno, con Calidad:
  Aprobado 26 · Rechazado 1 · Cuarentena 1 · Sin inspeccionar 0
Insumos: planeado / usado / merma / diferencia contra receta, por insumo
```

Hecho: el plan v2 pide «producido = liberado + rechazado + merma». Propuesta:
esa igualdad se comprueba como «bueno = aprobado + rechazado + cuarentena +
sin inspeccionar», y «bueno + malas + faltante = objetivo» cuando se produjo
menos. Cerrar con faltante pide motivo (y autorización si la regla
`production.close_short` está encendida, apagada por omisión). Cerrar libera
todo lo que siga apartado para la orden y deja la orden inmutable. Una orden
puede cerrarse con existencias aún en inspección: la inspección sigue su curso
aparte (D-E6).

**Listo cuando:** el cierre cuadra; cerrar libera reservas; lo liberado crea
su acomodo; la conciliación muestra lo de Calidad solo si Calidad está
contratada.

---

### 4.8 WMS-59 · Roles de producción y calidad

Hecho: la especificación 4.2 y 4.4 describe «Producción / Operario»,
«Supervisor de producción» y «Calidad / inspector»; el plan v3 los nombra
igual y pide ligarlos a sus módulos (`ROLE_MODULE`, hoy vacío).

**Propuesta.**

| Rol (pantalla) | Clave | Módulo (`ROLE_MODULE`) | Dispositivo dominante | Puede |
| --- | --- | --- | --- | --- |
| Operario de producción | `production_operator` | `production` | Teléfono o tableta (compartida) | Ver órdenes de su área, reportar producción, consumo, merma; reportar incidencias; ejecutar tareas `ISSUE` si lo necesita (`inventory.task.execute`); leer productos y existencias. **Sin** costos, ajustes ni cambios de estado. |
| Supervisor de producción | `production_supervisor` | `production` | Tableta y escritorio | Todo lo del operario; recetas; crear, liberar, cancelar y cerrar órdenes; corregir reportes; trabajadores y turnos; ver costos si además tiene `inventory.cost.read` (D1). |
| Inspector de calidad | `quality_inspector` | `quality` | Tableta | Ver lo que espera; iniciar, capturar y decidir inspecciones; mover lo decidido a su lugar (`inventory.transfer.create`) y pedir traslado (`inventory.task.create`); planes y defectos. Liberar de cuarentena (`quality.lot.release`) solo si la empresa lo deja a este rol (D-E8). |

- Titular y Administrador reciben todos los permisos nuevos; **Gerencia** todos
  los `*.read` (`catalog.test.ts` ya lo exige).
- Supervisor de almacén (`supervisor`) recibe lectura de órdenes e
  inspecciones y ejecuta tareas `ISSUE`; Almacenista y Montacarguista solo
  ejecutan tareas `ISSUE` (ya tienen `inventory.task.execute`).
- Sin el módulo, el rol no da nada del módulo (regla vigente de
  `ROLE_MODULE`); el equipo solo lo ofrece con el módulo activo.
- Cambio de roles = matriz `docs/MATRIZ_ROLES_PERMISOS.md` + catálogo +
  migración del `CHECK` de `membership_role` + `team-rules.test.ts` y
  `navigation.int.test.ts` (convención WMS-05).

**Listo cuando:** matriz y catálogo coinciden; cada rol ve solo su menú;
casos negativos (`NEG-xx` nuevos: el operario no ve costos ni decide calidad;
el inspector no reporta producción; un rol sin su módulo no hace nada).

---

## 5. Costo, merma y correcciones

Hecho: el costo es el promedio móvil por producto (ADR 0031), cubre todos los
estados, y una entrada **sin** costo entra al precio vigente (no a cero).

### 5.1 Costo del producto terminado (propuesta)

- Cada reporte es un movimiento con su propio costo: valor del reporte =
  suma de cantidad × costo promedio de cada insumo consumido (incluida la
  merma de insumo).
- Ese valor se reparte entre las salidas del reporte según la parte del costo
  de la receta (por omisión 100 % al producto principal) y se divide entre lo
  que salió bien: **costo por unidad = valor ÷ buenos**. Las piezas malas no
  entran a existencias, así que su costo queda absorbido en las buenas.
- Ese costo entra con `valueEntry` y mueve el promedio del producto
  terminado como cualquier entrada.
- Primera versión: **solo materiales** (D1). Mano de obra y gastos
  indirectos, si se deciden, serían una tarifa por hora o por unidad de la
  empresa que se suma al valor del reporte.
- Un insumo sin costo conocido: el reporte se registra (no detiene la
  operación) y el producto entra con el costo de los insumos que sí lo
  tienen; la pantalla lo advierte a quien puede ver costos. Si ningún insumo
  tiene costo, el producto entra sin costo (regla vigente de `valueEntry`).
- Subproducto con 0 % de costo: entra con costo explícito 0 (no «sin
  costo», que lo valuaría al precio vigente y crearía valor de la nada).
- Costos solo para quien tiene `inventory.cost.read` (regla vigente: el dato
  no existe en la respuesta para los demás).

### 5.2 Merma (propuesta)

| Tipo | Ejemplo | Qué pasa con existencias | Qué pasa con el costo |
| --- | --- | --- | --- |
| Merma de insumo | Recorte de triplay | Sale como parte del consumo | Absorbida en el costo de lo bueno |
| Piezas malas en la línea | Un crate con medida fuera | Nunca entran | Absorbida en lo bueno |
| Rechazo de Calidad | Crate rechazado en inspección | Entró, queda en `REJECTED` | Ya está en el valor; sale al desecharse (`DISPOSAL`) o se reprocesa |
| Consumo sin producción | Se tiró una mezcla entera | Sale con el reporte (bueno = 0) | Sale del valor como pérdida |

Cada merma guarda motivo de una lista de la empresa, para el reporte de merma
por material, producto, orden y causa (especificación 7, WMS-33).

### 5.3 Corregir un reporte (propuesta, D-E4)

Un reporte mal capturado se **reversa** entero (movimiento de reversa que
copia sus líneas, INV-25) y se captura otra vez. Solo se permite si lo
producido sigue donde entró, en el mismo estado y sin tomarse (ni
inspeccionado, ni movido, ni consumido): igual que hoy una reversa exige que
haya existencias. Si ya se movió, se corrige con un ajuste autorizado. La
reversa pide `production.report.reverse` y motivo; los insumos regresan a su
ubicación y lote al costo con que salieron.

---

## 6. Ajustes por empresa (propuesta)

Todos con valor por omisión que no cambia nada para quien no los toca (regla
11 de las instrucciones, ADR 0034). Claves `modulo.area.nombre`.

| Clave | Opciones (por omisión en negritas) | Qué decide |
| --- | --- | --- |
| `production.materials.mode` | **`direct`**, `issue` | Consumir de donde están (apartados) o surtir a la línea con tareas |
| `production.consumption.mode` | **`confirm`** (propone la receta, se confirma o corrige), `declared` (se escribe todo), `backflush` (se toma la receta sin preguntar) | Cómo se captura lo usado (D4) |
| `production.consumption.unlisted` | **`forbid`**, `allow` | Usar un insumo que no está en la receta (con motivo) |
| `production.release.short` | **`ask`** (dice lo que falta y deja apartar lo que hay), `block` | Liberar una orden sin insumos completos |
| `production.output.over` | **`warn`** (avisa y pide «Registrar de todos modos»), `block`, `allow` | Producir más del objetivo (D11) |
| `production.lot.code` | **`order`** (`OP-0001-1`, `-2`…), `typed` | Cómo se nombra el lote de lo producido (D8) |
| `production.serial.mode` | **`typed`** (se escanean) | Series de lo producido; generarlas queda fuera |
| `production.workers.mode` | **`users`** o `catalog` | Quién aparece como trabajador (D2) |
| `quality.sampling.default` | **`full`**, `sample` | Inspección completa o por muestra cuando el plan no lo dice (D6) |
| `quality.evidence.photo` | **`optional`**, `required` | Foto obligatoria al rechazar o poner en cuarentena (cuando exista WMS-37) |
| `inventory.inspection.release` | **`manual`**, `inspection_only` | Si con Calidad contratada se puede liberar a mano (D7) |

Reglas de aprobación nuevas (apagadas por omisión, en Configuración › Reglas
de aprobación): `quality.release` (liberar de cuarentena),
`production.close_short` (cerrar una orden con faltante sobre un umbral).

Iguales para todas las empresas (no son ajustes, por integridad): un reporte
es un movimiento atómico; lo que espera inspección no está disponible; lo
rechazado nunca vuelve a disponible sin una decisión; las versiones de receta
usadas no cambian; los costos solo los ve quien puede.

---

## 7. Dos módulos que se contratan por separado

Hecho: la plataforma nunca importa módulos (`AGENTS.md`, ADR 0007); un módulo
puede importar otro por su `index.ts`; el registro valida dependencias
declaradas (`dependsOn`).

**Propuesta.**

| | Producción | Calidad |
| --- | --- | --- |
| Contrato | `dependsOn: ["inventory"]` | `dependsOn: ["inventory"]` (no Producción; ver sección 10) |
| Importa | `@/modules/inventory` | `@/modules/inventory` (y `@/modules/purchasing` solo para mostrar la orden de compra de una recepción, si Compras está activo) |
| Nunca importa | Calidad | Producción |

**Qué funciona con cada combinación.**

| Contratado | Funciona |
| --- | --- |
| Solo Inventario (hoy) | La regla «inspeccionar al recibir» (si se hace en Inventario/Compras, sección 4.4) y «Cambiar estado» para liberar; devoluciones con su decisión. |
| Inventario + Calidad | Bandeja de inspección de recepciones, devoluciones y existencias mandadas a inspección; planes, defectos, decisión, cuarentena, rechazo, desecho y devolución al proveedor. |
| Inventario + Producción | Recetas, órdenes, reportes, merma, turnos y trabajadores; lo producido con la regla «al producirse» entra en inspección y se libera con «Cambiar estado». |
| Los dos | Todo, y la bandeja de Calidad incluye lo producido; el cierre de la orden muestra lo aprobado y rechazado. |

**Cómo se hablan sin importarse.**

- Calidad sabe qué viene de producción leyendo el **movimiento** que metió
  esa existencia en inspección (tipo `PRODUCTION` y su referencia `OP-…`): es
  de Inventario, no de Producción.
- Producción conoce los resultados de Calidad para el cierre leyendo **el
  estado actual y los cambios de estado** del lote que produjo (Inventario).
  Sin lote (producto que no se controla por lote) solo se puede mostrar el
  total del producto en el área, no por orden: por eso la propuesta recomienda
  que lo que se produce y se inspecciona se controle por lote (D8).
- Los avisos de cada módulo los declara ese módulo (`notificationTypes`).
- La retención de inspección y la liberación «solo por inspección» son
  servicios y ajustes de Inventario que Calidad usa.

**Plan vencido.** Hecho (MOD-11): todo queda en solo lectura; los permisos
`.read` siguen. Se puede ver recetas, órdenes, reportes, inspecciones y
rastreo; no se reporta, no se decide, no se libera.

**Quitar un módulo.** Hecho (CMP-17): nunca se borra nada; la consola avisa
del trabajo a medias (`moduleOpenWork`). Propuesta: Producción avisa de
órdenes liberadas o en curso y sus apartados; Calidad, de inspecciones
abiertas. Las reservas de órdenes de un módulo quitado siguen apartando hasta
que alguien las libere: la propuesta es que quitar Producción ofrezca
«Liberar lo apartado por órdenes abiertas» como parte de aceptar el trabajo a
medias (no automático), y que al quitar Calidad el ajuste
`inventory.inspection.release` se lea como `manual`.

**Varios almacenes y alcance.** Una orden es del almacén activo de quien la
crea y consume, surte y produce solo ahí (como los pedidos de salida, WMS-18).
Una inspección es del almacén de la existencia. Con alcance por zona
(WMS-20), una orden o inspección existe solo para quien alcanza su área de
producción o su ubicación (`assertLocationsInScope`, `locationScopeWhere`);
los mensajes nunca nombran algo de fuera del alcance. Mover producto
terminado a otro almacén es un traslado entre almacenes (WMS-19), no parte de
la orden.

---

## 8. Decisiones para el fundador

Cada una con la pregunta, opciones y la recomendación de esta propuesta.

### Hay que decidir antes de empezar

**D1. ¿Qué entra al costo de lo que se produce?**
- a) Solo materiales (lo que se consumió). Sencillo, exacto, sale del
  inventario que ya existe.
- b) Materiales + mano de obra y gastos con una tarifa de la empresa (por hora
  o por unidad). Requiere capturar tiempos o tarifas.
- **Recomendación: a)** en la primera versión; b) como paso posterior.

**D2. ¿Se registra producción de personas que no tienen cuenta en el
sistema?** La retroalimentación de campo habla de unas 100 personas de las que
unas 10 usarían el sistema.
- a) Solo usuarios con cuenta. Obliga a dar cuenta (y cupo de usuarios) a cada
  operario.
- b) Catálogo de trabajadores sin acceso (nombre y número de empleado); quien
  captura elige a uno o varios. El rastro dice quién capturó y a quién se le
  acredita.
- **Recomendación: b)**, como ajuste (`production.workers.mode`), con `users`
  por omisión para no mostrar nada nuevo a quien no lo necesite.

**D3. ¿Cómo salen los insumos del almacén?**
- a) Directo: se consumen de donde están, ya apartados para la orden.
- b) Surtidos a la línea con tareas «Surtir a producción».
- **Recomendación:** los dos como ajuste, **a) por omisión** (menos pasos).

**D4. ¿Cómo se captura lo que se usó?**
- a) La pantalla propone lo de la receta y el operario confirma o corrige.
- b) Se escribe todo a mano.
- c) Se descuenta la receta sin preguntar (backflush).
- **Recomendación: a)** por omisión; b) y c) como opciones del ajuste.

**D5. ¿Qué se inspecciona al recibir y al producir?**
- a) Una regla por producto («al recibir», «al producirse»).
- b) Además por categoría o por proveedor (p. ej. «todo de este proveedor
  nuevo»).
- **Recomendación: a)** primero; b) puede esperar.

**D6. Muestreo y «no liberar más de lo inspeccionado» (PC-4).** Si se revisan
10 piezas de un lote de 500 y salen bien, ¿se liberan las 500?
- a) Solo inspección completa: aprobado + rechazado + cuarentena =
  inspeccionado, siempre. Literal a PC-4; con lotes grandes es poco práctico.
- b) También por muestra: se guarda el tamaño de la muestra y sus resultados,
  y la decisión se toma sobre lo recibido para inspección (aprobar el lote,
  rechazarlo o ponerlo en cuarentena). PC-4 se lee como «nunca se libera más
  de lo decidido ni se decide más de lo recibido para inspección».
- **Recomendación: b)**, con inspección completa por omisión
  (`quality.sampling.default = full`) y la regla por plan.

**D7. Con Calidad contratada, ¿alguien más puede liberar a mano?**
- a) Sí, como hoy (quien tenga permiso de liberar en Inventario).
- b) No: solo una inspección (o la decisión de una devolución) saca algo de
  inspección, cuarentena o rechazado.
- **Recomendación: b)** como ajuste que la empresa enciende al contratar
  Calidad (`inventory.inspection.release`); a) sigue siendo lo que pasa sin
  Calidad. Es la única forma de cumplir PC-4 y PC-5 sin agujeros.

**D8. ¿Cómo se identifica lo producido?**
- a) Lote automático por orden y reporte (`OP-0001-1`).
- b) Lote que escribe el operario.
- c) Sin lote (el producto no se controla por lote).
- **Recomendación: a)** por omisión, b) como opción; y recomendar en pantalla
  que todo producto que se fabrica y se inspecciona se controle por lote (sin
  lote no hay trazabilidad por orden).

**D9. ¿Calidad puede contratarse sin Producción?** La especificación (3.2)
pone a Calidad como dependiente de Producción; el plan v3 dice que se
contratan por separado.
- a) Calidad depende de Producción.
- b) Calidad solo depende de Inventario (inspección al recibir y de
  devoluciones sin producir nada).
- **Recomendación: b)**.

**D10. ¿Cómo se manejan las etapas intermedias (corte, subensamble)?**
- a) Cada etapa es un producto con su receta y su orden; lo que sale de una
  es insumo de la siguiente.
- b) Un estado nuevo «en proceso» dentro de una sola orden con pasos.
- **Recomendación: a)**. No toca la llave del saldo, se rastrea con lo que ya
  existe y sirve igual a todos los giros. Los pasos de una receta quedan solo
  como etiqueta para productividad.

**D11. ¿Qué pasa si se produce más de lo planeado?**
- a) Se permite con aviso («Registrar de todos modos»).
- b) No se permite.
- c) Se permite sin decir nada.
- **Recomendación: a)** por omisión; b) y c) como opciones.

### Puede esperar

**D-E1. Mano de obra y gastos indirectos** en el costo (si D1 = a).

**D-E2. Reproceso:** una orden que consume lo rechazado o dañado para volverlo
bueno. Recomendación: segunda versión, con el mismo reporte.

**D-E3. Coproductos y subproductos:** cómo repartir el costo. Recomendación:
parte fija del costo en la receta (100 % al principal por omisión);
subproductos a costo 0.

**D-E4. Corregir reportes:** solo reversa mientras nada se movió (propuesta) o
también ajuste parcial.

**D-E5. Liberar órdenes sin insumos completos:** preguntar (por omisión) o
bloquear.

**D-E6. Cerrar una orden con producto aún en inspección:** permitir
(propuesta) o esperar a que Calidad decida.

**D-E7. Desechar:** con el permiso de cambiar estado o con uno propio.

**D-E8. Quién libera de cuarentena:** el inspector, solo el supervisor, o con
autorización (regla `quality.release`).

**D-E9. Foto obligatoria** al rechazar o poner en cuarentena (depende de
WMS-37).

**D-E10. Pausas y tiempos por operación** (especificación 4.2: «iniciar y
pausar una operación si está permitido»): fuera de la primera versión, salvo
que el fundador lo necesite para el primer cliente.

**D-E11. Producir para inventario según el historial** (retroalimentación de
campo): sugerencias de órdenes por mínimos, como las sugerencias de compra
(WMS-33/WMS-23, después).

---

## 9. Plan de implementación propuesto

Las letras dicen qué puede ir en paralelo. «Corazón» = toca saldos,
movimientos, reservas o tareas: va **uno tras otro**, nunca en paralelo con
otro paso de corazón.

| Sub-paso | Qué | Depende de | Corazón | Paralelo con |
| --- | --- | --- | --- | --- |
| **WMS-59** | Contratos `production` y `quality` (sin pantallas), permisos, roles, matriz, `ROLE_MODULE`, guardas de módulo | Decisiones D1–D11 | No | — (primero, para que los demás no choquen en `catalog.ts`) |
| **WMS-30-0** | Regla «inspeccionar al entrar» del producto; recepción en `INSPECTION`; devolver al proveedor desde `INSPECTION`/`REJECTED`; «Desechar» (`DISPOSAL`); ajuste `inventory.inspection.release`; retención genérica de inspección | WMS-59 (solo el ajuste) | **Sí** | WMS-27, WMS-30A |
| **WMS-27** | Recetas versionadas | WMS-59 | No | WMS-30-0, WMS-30A |
| **WMS-30A** | Planes de inspección, defectos, catálogo de motivos | WMS-59 | No | WMS-27, WMS-30-0 |
| **WMS-28** | Órdenes, liberar con reservas, tarea `ISSUE`, uso de ubicación «Producción», cancelar | WMS-27, WMS-30-0 | **Sí** | WMS-30A |
| **WMS-29** | Reporte de producción (`PRODUCTION`), costo, merma, trabajadores y turnos, rastreo hacia adelante y atrás, reversa del reporte | WMS-28 | **Sí** | WMS-30A |
| **WMS-30B** | Bandeja e inspección con decisión, cuarentena, devoluciones por `decideCustomerReturn`, avisos | WMS-30-0, WMS-30A (y WMS-29 para ver lo producido) | **Sí** | — |
| **WMS-31** | Uso «Producción» en `WAITING_PLACE`, cierre con conciliación, regla `production.close_short` | WMS-29 (y WMS-30B para la parte de Calidad) | **Sí** (pequeño) | — |
| Después | Reproceso, mano de obra, series generadas, pausas, campos personalizados en órdenes, indicadores (WMS-33) | — | — | — |

Si el fundador quiere Calidad antes que Producción (por ejemplo, para un
cliente que solo recibe), el orden WMS-59 → WMS-30-0 → WMS-30A → WMS-30B
funciona sin Producción.

**«Listo cuando» y pruebas por sub-paso** (además de `npm run check`,
`npm run build`, documentación de arquitectura, `CHANGELOG.md` y ADR):

- **WMS-59.** `catalog.test.ts` (matriz = catálogo, Gerencia con todas las
  lecturas, roles ligados a su módulo); `registry.int.test.ts` (dos módulos,
  dependencias); `navigation.int.test.ts`; `team-rules.test.ts`; guardas
  `tests/production/module-guard.int.test.ts` y
  `tests/quality/module-guard.int.test.ts`; casos `NEG-xx` nuevos.
- **WMS-30-0.** `tests/purchasing/receipts-inspection.int.test.ts` (entra en
  inspección; lo dañado aparte; no se reparte ni se acomoda; reintento);
  devolución al proveedor desde rechazado; «Desechar» con costo; con
  `inspection_only`, «Cambiar estado» rechaza sacar de inspección; alcance;
  `reconcileStock`/`reconcileValue` vacíos.
- **WMS-27.** Unitarias de reglas puras (cantidades por base, partes del
  costo, sin ciclos); `tests/production/recipes.int.test.ts` (versión usada
  inmutable, disparador; entre empresas).
- **WMS-30A.** `tests/quality/plans.int.test.ts` (tipos de pregunta, rangos,
  entre empresas).
- **WMS-28.** Estados con disparador y tabla pura; reservas con
  `Promise.all` (**PC-2**); `issue` con tareas y lo surtido apartado en el
  área; cancelar libera; alcance; `reconcileStock` vacío.
- **WMS-29.** Guion del caso 5.5 completo (`tests/production/case-5-5.int.test.ts`);
  reintento (**PC-3**); concurrencia; lotes y series; rastreo hacia adelante y
  atrás (`traceability.int.test.ts`); costo exacto contra datos conocidos;
  reversa permitida y rechazada; `reconcileStock`/`reconcileValue` vacíos.
- **WMS-30B.** **PC-4** y **PC-5**; dos inspectores a la vez; reinspección de
  cuarentena; regla `quality.release`; devolución decidida por Calidad igual
  que por Inventario; avisos (quién sí y quién no); alcance.
- **WMS-31.** Conciliación contra el caso 5.5; cierre con faltante libera
  reservas; lo liberado crea su acomodo; con el módulo de calidad apagado, la
  conciliación no muestra su parte.

---

## 10. Contradicciones y huecos encontrados

1. **Dependencia de Calidad.** La especificación (3.2) dice que Calidad
   depende de Producción e Inventario; el plan v3 («WMS-27..31») y este
   encargo dicen que se contratan por separado. Decisión D9.
2. **PC-4 y muestreo.** La especificación (5.6) dice «no se puede aprobar más
   de lo inspeccionado», pero el muestreo, que es práctica común, decide un
   lote entero con una muestra. Decisión D6.
3. **Hoy se puede liberar lo rechazado a mano.** `permissionForStatusChange`
   deja pasar `REJECTED` (o `INSPECTION`) a disponible con
   `inventory.status.release`. Lo rechazado no aparece disponible mientras
   está rechazado (PC-5 se cumple en las lecturas), pero una persona con ese
   permiso puede volverlo disponible sin inspección. Decisión D7 y ajuste
   `inventory.inspection.release`.
4. **«En producción / trabajo en proceso» de la especificación (6.2) no es un
   estado del saldo** (`StockStatus` no lo tiene; ADR 0033 no lo incluyó). La
   propuesta lo resuelve sin estado nuevo (insumos apartados o surtidos al
   área; etapas como productos, D10). Si el fundador quiere el estado, toca la
   llave del saldo y debe decidirse antes de WMS-28.
5. **WMS-59 depende de WMS-27 en el plan v3**, pero los permisos y roles
   tienen que existir antes de que haya pantallas de recetas; la propuesta lo
   pone primero (solo contratos, permisos y roles).
6. **Recepción con inspección.** ADR 0033 dice «recepción con inspección en
   WMS-17/30»; WMS-17 (devoluciones) se cerró sin tocar la recepción de
   compras, que hoy solo entra disponible o dañada. Queda en WMS-30-0.
7. **Devolver al proveedor lo rechazado** está pendiente desde ADR 0046
   (devoluciones de clientes) y hoy `returnToSupplier` solo sale de
   disponible o dañado. Queda en WMS-30-0.
8. **Desechar** está previsto en ADR 0033 («sale con una salida normal»), pero
   `registerExit` solo saca disponible, así que hoy no hay forma de sacar lo
   dañado o rechazado sin cambiarlo antes a disponible (lo que contradice
   PC-5 en espíritu). Queda en WMS-30-0.
9. **Precisión de 3 decimales** en cantidades: una receta por unidad puede
   necesitar más. La propuesta usa cantidad base; si no basta para algún
   cliente, ampliar la precisión es un cambio de la base que debe decidirse
   aparte.
10. **Trabajadores sin cuenta** no existen en el modelo actual (todo autor es
    una cuenta). La retroalimentación de campo (unas 100 personas, unas 10
    usuarias) lo hace necesario para «producción por trabajador». Decisión D2.

---

## 11. Lo que queda fuera de la primera versión

Dicho explícitamente, para que nadie lo programe sin decisión:

- Mano de obra, gastos indirectos y costeo estándar (solo materiales, D1).
- Planeación de capacidad, programación de la línea (MRP/APS), sugerencias de
  órdenes por mínimos o historial (D-E11, WMS-33).
- Rutas con centros de trabajo, tiempos, pausas y paros por operación (los
  pasos son solo etiqueta; los paros se reportan como incidencias).
- Estado «en proceso» en el saldo (D10).
- Reproceso (D-E2), salvo que el fundador lo pida en la primera versión.
- Generar series de lo producido (se escanean o escriben).
- Vida útil para calcular la caducidad del producto (se escribe si el
  producto la pide; el fundador ya descartó vida útil mínima y fecha de
  fabricación para el surtido, ver `AGENTS.md`).
- Certificados de análisis, control estadístico de procesos y planes de
  muestreo por tablas (AQL); el muestreo es solo «tamaño de muestra +
  decisión».
- Reglas de inspección por proveedor o categoría (D5 b).
- Fotos de evidencia hasta que exista WMS-37; PIN o tarjeta en terminales
  compartidas hasta WMS-38.
- Indicadores y gráficas de producción y calidad (WMS-33, Fase 4); solo
  listas con filtros.
- Campos personalizados en recetas, órdenes e inspecciones.
- Importar recetas u órdenes desde Excel; API y webhooks (WMS-60).
- Integración con básculas o equipos de medición.
- Producción entre almacenes (se produce en un almacén; lo demás es un
  traslado).
- Inventario de terceros (3PL).
