# ADR 0093 — Producto a su lugar y cierre de la orden de producción

Fecha: 2026-11-20 · Estado: aceptada · Paso: WMS-31 (Fase 3, producción) ·
Usa ADR 0012 (movimientos y saldos), 0031 (costo promedio), 0038 (alcance),
0042 (acomodo), 0053 (aprobaciones), 0057 (avisos), 0061 (PIN), 0062 (roles
de producción y calidad), 0069 y 0071 (procesos), 0073 (órdenes de
producción), 0074 (orden de candados), 0075 (solicitudes de producción),
0077 (almacén archivado), 0087 (reporte de producción), 0089 (empresa de
demostración) y 0091 (verificación de Calidad) · Flujo:
`docs/flujos/PRODUCCION_CALIDAD.md` (sexta versión), D5, D11, P7d, P10,
P10b y secciones 5.5, 5.8, 6.2, 7 y 10

## Contexto

Con WMS-29 lo producido entra en `INSPECTION` en el área de producción y con
WMS-30B la verificación deja lo aprobado `AVAILABLE` **en el área** (o en el
lugar que elija quien verifica). Falta lo último del flujo (5.8): que lo
aprobado salga del área a un lugar donde se guarde, que la etapa «Se
guardó» del lote se marque sola, y que la orden se **cierre con lo hecho**,
también con faltante (fundador, 2026-11-16: «la orden se cierra con lo
producido»). Hoy `CLOSED` existe en la tabla de estados y en la base
(`IN_PROGRESS → CLOSED`, columnas `closedAt`, `closedByUserId`,
`closeReason`) pero nadie lo escribe, y una orden con reportes no se
cancela: queda abierta para siempre, con su material apartado.

## Flujo operativo

### 1. Producto a su lugar

1. Quien verifica aprueba lo producido (WMS-30B). Lo aprobado queda
   `AVAILABLE` donde se decidió (el área, o el lugar que se eligió).
2. **Con acomodo por tareas** (`inventory.putaway.mode = tasks`), lo
   aprobado que quedó **en una ubicación de uso «Producción»** crea su tarea
   de acomodo en la misma transacción de la decisión
   (`createPutawayTasks`, la recomendación de siempre con `putawayTarget`,
   apartado con `TASK_HOLD`). La tarea lleva el lote producido del que viene
   (`warehouse_task.productionReportId`, nuevo, inmutable).
3. **Sin acomodo por tareas**, lo aprobado se queda en el área y se mueve a
   mano («Cambiar de lugar»), como hoy.
4. El área **no** entra a `WAITING_PLACE` (ver «Decisión: el área no es un
   lugar de paso»). Lo que la convierte en origen de un acomodo es que la
   llegada venga de un lote producido (`PutawayArrival.productionReportId`):
   solo la verificación de lo producido lo pasa.
5. Entregar el acomodo es como cualquier acomodo (pide el código del lugar,
   capacidad, foto según el ajuste). **Una tarea de acomodo nunca se entrega
   en un área de producción** (vale para todas: el área no es un lugar donde
   se guarde).
6. Un área dentro de «Cuarentena» o «Restauración» no puede dejar disponibles
   ahí: WMS-30B ya exige otro lugar al aprobar (sin cambio).

### Decisión: el área no es un lugar de paso

El ADR 0091 proponía agregar `PRODUCTION` a `WAITING_PLACE`. No se hace,
porque el área guarda también **material apartado para órdenes** (lo que ya
estaba ahí y lo que entregan las tareas «Surtir a producción»), y
`WAITING_PLACE` decide además:

- «Sin acomodar» y su aviso de Inicio: listarían el material de las órdenes
  como si esperara acomodo.
- «Crear tareas de acomodo»: crearía tareas para ese material (y para lo
  libre del área que la empresa guarda ahí a propósito con
  `production.materials.mode = direct`).
- La entrada manual, la recepción, la devolución de cliente y el cambio de
  estado hacia el área: crearían acomodos y repartirían por cross-docking.

La regla más fina: **solo lo que una verificación aprueba de un lote
producido** sale del área con tarea. Lo demás del área sigue como hoy.

### 2. «Se guardó»

El documento de proceso del lote (`production.batch`) gana la operación
**«Se guardó»** (`stored`, hito `REPORTED`, `leadsTo: null`, declarada después
de «Verificación»). Se completa sola cuando **lo aprobado del lote llegó a
su lugar** y no queda ninguna tarea de acomodo abierta del lote:

- al entregar la **última** tarea de acomodo abierta del lote; o
- al decidir una verificación que aprueba **directo a un lugar donde se
  guarda** (ni de uso «Producción», ni de paso, ni preparación) sin crear
  tareas de acomodo del lote.

La completa `settleProductionStored(tx, actor, reportId)` de Inventario (que
no importa Producción: el documento de proceso del lote vive ahora en
`src/modules/inventory/production-batch.ts`, sin dependencias, y Producción
lo vuelve a exportar). Primero toma el progreso con `assertStagesDone` (así
dos entregas a la vez de las dos últimas tareas se forman: la segunda ya ve
la primera entregada); si hay etapas previas pendientes **no detiene la
entrega ni la decisión**: no la marca y la etapa se queda por hacer (el
montacarguista no tiene por qué esperar a otra área). Sin proceso publicado
nada cambia.

Sin acomodo por tareas y con lo aprobado en el área, «Se guardó» no se marca
sola (nada dice cuándo llegó a su lugar): la empresa usa una etapa manual o
aprueba directo al lugar donde se guarda.

### 3. Cierre de la orden

**Quién:** `production.order.close` (titular, Administración y Encargado de
producción; ya existe en la matriz, nadie lo usaba) y alcanzar el área de
la orden (si no, la orden «no existe»). Se conserva en una terminal con PIN
(como liberar y cancelar, decisión del fundador del 2026-11-16).

**Pantalla:** la ficha de la orden en proceso ofrece «Cerrar orden», que
lleva a `/produccion/[id]/cerrar` con la **conciliación** (derivada, nada
guardado) y el formulario. Una orden liberada sin reportes no se cierra: se
cancela (no hay `RELEASED → CLOSED`); la ficha lo dice.

**Conciliación** (`getProductionOrderClosing`):

```text
Pedido 120 · Bueno 100 · Malas 2 · Faltan 20
Lo producido (por salida): reportado, aprobado, rechazado, dañado,
  cuarentena, restauración, merma, reporte de más, otra causa,
  en verificación, sin verificar
Materiales: previsto · consumido · merma de material · apartado sin usar
Pendiente: tareas de surtir abiertas, mermas por autorizar, verificaciones abiertas
Costos (solo con inventory.cost.read): valor de los materiales consumidos,
  valor de la merma de material, costo por unidad buena
```

- Lo producido sale de `production_report_line` (`OUTPUT`) de los reportes
  que siguen (no revertidos); lo verificado, de `quality_inspection_result`
  de las verificaciones `DECIDED` de esas líneas; «en verificación» es el
  esperado de las `OPEN`; **«sin verificar» = producido − decidido −
  abierto**. «Reporte de más» **no se vuelve a pedir** a la orden (D11, ADR
  0091): el faltante es pedido − bueno de los reportes.
- Producción lee esas tablas de Calidad directo (sin importar Calidad): la
  verificación sin Calidad también las escribe.

**Qué se exige para cerrar** (todo leído bajo el candado de la orden):

| Situación | Qué pasa |
| --- | --- |
| Orden `IN_PROGRESS` | Se cierra. |
| `CLOSED` | `repeated` («La orden ya estaba cerrada.»). |
| `DRAFT` / `RELEASED` | No: «se cancela, no se cierra». |
| `CANCELLED` | No. |
| Faltante (bueno < pedido) | **Motivo obligatorio** (3 a 300). Sin faltante, opcional. |
| Tarea «Surtir a producción» con la carga en camino (recogida, o con problema después de recogerla) | No: que se entregue o se reporte antes (como cancelar). |
| Tareas «Surtir a producción» sin recoger | Se **cancelan** con el cierre. |
| Merma de material esperando autorización (`production.scrap`, pendiente) | No: que se decida o se retire antes (abrirla toma productos y orden, así que no se cuela). |
| Etapas de proceso de la orden antes de «Orden cerrada» | No, si la empresa pone «Orden cerrada» como etapa (`assertStagesDone`); sin ella, no esperan. |
| Verificaciones abiertas o lotes sin verificar | **Se permite** (propuesta del ADR 0091): siguen después del cierre, la conciliación las cuenta y se actualiza sola. |
| Pérdidas de verificación esperando autorización | Se permite (son de la verificación, no de la orden). |
| Tareas de acomodo de lotes de la orden | Se permite (siguen). |

**Qué hace el cierre** (una transacción):

1. Cancela las tareas «Surtir a producción» sin recoger (motivo «Se cerró
   la orden OP-0001»).
2. **Libera todo lo apartado de las líneas de la orden** con
   `releaseReservations` (fuente `PRODUCTION_ORDER_LINE_SOURCE`). No mueve
   existencias: lo que ya estaba en el área (o se entregó ahí) **queda libre
   en el área**; no se crea tarea de regreso (decisión que el fundador puede
   cambiar).
3. Escribe `CLOSED`, `closedAt`, `closedByUserId` y `closeReason`.
4. Proceso de la orden: `assertStagesDone` antes de escribir;
   `completeOperationStage` de «Orden cerrada» y después
   `reachMilestone(CLOSED)`, que cierra el proceso (las etapas manuales que
   quedaron sin hacer se quedan así: el motor no reabre). Los procesos de
   los lotes producidos siguen (verificación y «Se guardó» pueden pasar
   después del cierre).
5. Bitácora `production.order_closed` (orden, pedido, bueno, malas,
   faltante, reservas liberadas, tareas canceladas; nunca costos).
6. Aviso `production.order_closed` a quien pidió la solicitud de la que nació
   (WMS-28B) y a las personas asignadas, por `production.order.read` con el
   área como lugar; nunca a quien cerró, sin cifras de costo.

**Una orden cerrada** no admite reportes, mermas ni reversas (los tres ya
exigen `RELEASED`/`IN_PROGRESS` bajo el candado de la orden), ni tareas
`ISSUE` (disparador), ni cambios de personas (disparador de asignados).

### 4. Orden empezada que ya no se va a terminar

No se cancela (la tabla no lo admite): **se cierra con lo hecho**. La ficha
de una orden en proceso dice «¿Ya no se va a terminar? Ciérrala con lo
producido» junto a «Cerrar orden», y la pantalla de cierre pide el motivo
del faltante.

### 5. Solicitudes de producción

La solicitud aceptada no cambia de estado (`ACCEPTED` es final). Su ficha ya
muestra la orden con su estado («Cerrada»); además, quien pidió recibe el
aviso del cierre («Se cerró OP-0002: se hicieron 18 de 20 piezas.»).

### 6. Quitar el módulo

`productionOpenWork` cuenta órdenes `DRAFT`/`RELEASED`/`IN_PROGRESS`: una
cerrada ya no cuenta y no deja nada apartado. Sin cambio de código.

## Tabla de estados

Sin cambio: `IN_PROGRESS → CLOSED` ya estaba en `PRODUCTION_ORDER_TRANSITIONS`
y en el disparador `production_order_transition` (WMS-28).

## Movimientos y reservas

| Operación | Movimientos | Reservas |
| --- | --- | --- |
| Aprobar lo producido en el área (WMS-30B) | El `STATUS_CHANGE` de siempre | `TASK_HOLD` de la tarea de acomodo nueva |
| Entregar el acomodo | `TRANSFER` de la tarea (`task:<id>`) | consume su `TASK_HOLD` |
| Cerrar la orden | ninguno | cierra las `PRODUCTION_ORDER_LINE_SOURCE` activas; cancelar las `ISSUE` sin recoger no deja reservas propias (aparta la línea) |

`reconcileStock` y `reconcileValue` no cambian: el cierre no mueve nada.

## Candados

Orden global: productos → almacén → ubicaciones → documento → contenedor →
tareas → capacidad → progreso del proceso → archivos.

| Operación | Candados |
| --- | --- |
| Cerrar la orden | **todos los productos de la orden** (materiales y salidas, una `lockRows`) → la orden → tareas `ISSUE` abiertas → progreso del proceso de la orden. No toma almacén ni ubicaciones (cambiar el estado de un documento con `facilityId` en un índice nunca va después de una ubicación). |
| Decidir una verificación (WMS-30B) | sin cambio; crear el acomodo no toma candados nuevos (filas nuevas); `settleProductionStored` toma el progreso del lote al final (ya lo tenía la etapa «Verificación»). |
| Entregar un acomodo de un lote | producto → ubicaciones → tarea → capacidad → **progreso del lote** (nuevo, al final). |

Carreras en `tests/server/lock-order.int.test.ts`: cerrar contra un reporte
nuevo, la reversa de un reporte, una merma, la entrega de una tarea `ISSUE`,
decidir una verificación de un lote de la orden, la entrega del acomodo de
ese lote, y dos cierres a la vez.

## Modelo

- `warehouse_task.productionReportId` (nuevo, opcional): el lote producido
  de una tarea de acomodo. Llave foránea compuesta a `production_report`,
  `CHECK` (solo `PUTAWAY`), índice, y disparador que la deja inmutable.
  Ningún disparador lee otra tabla (ADR 0077).
- Sin tablas nuevas: el cierre usa columnas que existen desde WMS-28.

## Permisos y contexto

- `production.order.close`: cerrar. `production.order.read`: ver la
  conciliación. Sin permisos nuevos.
- Costos de la conciliación solo con `inventory.cost.read` (el campo no
  existe para los demás).
- **Alcance:** la orden existe para quien alcanza su área; la conciliación
  cuenta lo de la orden (no depende de ubicaciones, salvo «apartado sin
  usar», que suma todas las reservas de la orden: es un dato de la orden,
  no nombra ubicaciones).
- **PIN:** cerrar se conserva en una terminal (como cancelar).
- **Plan vencido / módulo en solo lectura:** `assertModulePermission`
  rechaza (`.close` es escritura); la conciliación se lee.
- **Soporte:** solo lee.
- **Empresa de demostración:** sin diferencia (no sale nada a terceros).
- **API:** no ofrece cerrar.

## Lo que WMS-79 necesita

- Lo aprobado de un lote queda `AVAILABLE`; con acomodo por tareas, apartado
  (`TASK_HOLD`) hasta entregarse. Para apartarlo para un pedido, WMS-79 debe
  decidir si lo aparta **antes** del acomodo (en la decisión, en lugar de la
  tarea de acomodo) o después; `createPutawayTasks` solo aparta lo libre.
- Al cerrar, la orden suelta todo lo apartado de sus **materiales**; no toca
  reservas de pedidos. Una orden ligada a una línea de pedido debe decir en
  su ADR qué pasa con la reserva del pedido si la orden se cierra con
  faltante (el pedido sigue esperando lo que falta).
- La conciliación (`getProductionOrderClosing`) es la cifra de «cuánto
  quedó aprobado» de una orden.

## Lo que no entra

WMS-79 (ligar pedidos), WMS-29B (reproceso), regla de autorización para
cerrar con faltante (`production.close_short`, propuesta del flujo: no se
hace, ver decisiones), tareas de regreso del material sobrante, «Sin
acomodar» para lo aprobado que quedó en el área sin tareas, cerrar desde la
API, webhook del cierre.

## Riesgos y migración

- Migración `20261120160000_wms31_production_putaway` de expansión (columna
  nueva, índice, llave, `CHECK`, disparador). El código anterior ignora la
  columna.
- Una orden cerrada con verificaciones abiertas sigue mostrando «en
  verificación» hasta que se decidan; la conciliación es derivada.
- Una tarea de acomodo de un lote cuyo reporte se revierte: la reversa exige
  que todo lo producido siga en `INSPECTION` y sin salidas, así que nunca
  hay acomodo de un lote revertido.

## Decisiones que el fundador puede cambiar

1. El área de producción no es un lugar de paso: solo lo aprobado de un lote
   sale con tarea de acomodo (lo demás del área se queda como hoy).
2. «Se guardó» se marca sola al entregar la última tarea de acomodo del lote
   o al aprobar directo a un lugar donde se guarda; sin acomodo por tareas y
   con lo aprobado en el área, no se marca sola.
3. Si hay etapas previas pendientes, entregar el acomodo no se detiene y «Se
   guardó» queda por hacer.
4. Se cierra con verificaciones abiertas y lotes sin verificar.
5. Cerrar con faltante pide motivo, sin autorización
   (`production.close_short` no se hace).
6. El material apartado que no se usó queda libre donde está (también en el
   área), sin tarea de regreso.
7. No se cierra con una merma esperando autorización ni con material en
   camino.
8. Una orden liberada sin reportes no se cierra: se cancela.
9. Cierran titular, Administración y Encargado (`production.order.close`),
   también desde una terminal con PIN; Almacén y Supervisor no.
10. El aviso del cierre va a quien pidió la solicitud y a las personas
    asignadas.

## Consecuencias

La orden de producción tiene su ciclo completo. El sitio deja de decir
«Próximamente» en «Cierre de la orden» y «Producto a su lugar».
