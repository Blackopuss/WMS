# ADR 0073 — Órdenes de producción

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-28 (Fase 3, producción) ·
Usa ADR 0012 (movimientos y saldos), ADR 0033 (estado y lote del saldo),
ADR 0036 y 0039 (usos y capacidad de ubicaciones), ADR 0038 (alcance),
ADR 0040 y 0041 (lotes y series), ADR 0062 (roles de producción), ADR 0066
(recetas), ADR 0069 y 0071 (motor de procesos), ADR 0072 (restauración) ·
Flujo: `docs/flujos/PRODUCCION_CALIDAD.md` (sexta versión), D3, D11, P2,
P7d, P8 y secciones 5.2, 6, 9, 10 y 12

## Contexto

El fundador decidió que las órdenes de producción las genera el encargado
del área, que responde por ellas (P8); que no se produce más de lo que pide
la orden (D11); que los materiales se consumen directo de donde están o se
surten desde el almacén de insumos, según la empresa, y por omisión directo
(D3, P2); y que la orden guarda quién la creó o aprobó y quién la ejecutó
(P7d). La receta (WMS-27, ADR 0066) ya existe; el motor de procesos (WMS-74)
y el estado «En restauración» (WMS-75) también.

Este paso deja **la orden y lo que aparta**: crearla, armarla, liberarla
(aparta materiales y, si la empresa surte desde el almacén de insumos, crea
las tareas «Surtir a producción») y cancelarla. **No** reporta producción,
no consume materiales, no escribe el movimiento `PRODUCTION`, no calcula
costo y no cierra la orden: eso es WMS-29 (reporte), WMS-31 (cierre) y
WMS-28B (solicitudes desde el piso).

## Flujo operativo

1. **Quién y dónde.** El Encargado de producción, Administración o el
   titular (`production.order.create`), en escritorio o tableta, en la
   sección **«Producción»** del menú (`/produccion`). Almacén, el Supervisor
   de almacén, el Operario, el Inspector, Consulta y Gerencia solo leen
   (`production.order.read`).
2. **Nueva orden** (`/produccion/nueva`): producto (clave, código de barras
   o nombre) **con receta vigente**, cantidad (en la unidad del producto,
   `parseQuantity`), área de producción (ubicación de uso «Producción» del
   almacén activo, dentro del alcance; por omisión la de la receta si es de
   ese almacén), día compromiso y prioridad (opcionales), personas
   asignadas (opcional) y notas. Número `OP-0001`. Nace en **borrador** y
   copia la versión vigente de la receta multiplicada por la cantidad
   (ver «Cantidades»): materiales (`production_order_line`) y lo que sale
   (`production_order_output`). Guarda la versión que usó.
3. **Borrador.** Se cambian cantidad, área, día, prioridad, notas y
   personas. Guardar **vuelve a copiar la receta vigente** con la cantidad
   nueva: un borrador siempre refleja la receta del momento en que se
   guardó por última vez.
4. **Liberar orden.** Vuelve a comprobar bajo candado (ver «Receta que
   cambió»), y aparta cada material (`reserveStock`, fuente
   `production_order_line` + id de la línea) en las ubicaciones de donde
   saldrá, **lo que caduca antes primero** (`pickSources`, el mismo orden del
   surtido). Si algo no alcanza, no aparta nada y dice qué falta («Triplay:
   se necesitan 30 hojas, hay 25 libres»); la pantalla ofrece «Liberar con
   lo que hay» (aparta lo libre de cada material) o no liberar. Con el ajuste
   `production.release.short = block` no se ofrece y la orden no se libera
   incompleta. Si no hay nada que apartar de ningún material, no se libera.
5. **Materiales** (`production.materials.mode`):
   - `direct` (por omisión): lo apartado se queda donde está; el reporte
     (WMS-29) lo consumirá de ahí.
   - `issue`: además, por cada ubicación de origen fuera del área se crea
     una tarea **«Surtir a producción»** (`warehouse_task.kind = ISSUE`)
     hacia el área, con su lote. La toma cualquiera con
     `inventory.task.execute`, la recoge (series si aplica) y la entrega como
     un traslado. **Lo entregado queda apartado en el área para la misma
     línea de la orden.** Lo que ya estaba en el área (o dentro de ella) se
     aparta sin tarea.
6. **La orden queda liberada** y, si la empresa definió un proceso para la
   orden, sus etapas le caen al área (motor de procesos).
7. **Cancelar** (borrador o liberada, motivo obligatorio,
   `production.order.cancel`): libera todo lo apartado por sus líneas,
   cancela sus tareas `ISSUE` sin recoger y cierra su proceso. Si una tarea
   de surtir ya se recogió (la carga va en camino), no se cancela: se
   entrega o se reporta primero. Lo que ya se entregó en el área queda ahí,
   libre. Una orden con reportes (`IN_PROGRESS`) no se cancela: se cierra
   con faltante (WMS-31).

## Estados

```text
DRAFT ──▶ RELEASED ──▶ IN_PROGRESS ──▶ CLOSED
  │          │
  └──────────┴──▶ CANCELLED
```

Tabla pura `PRODUCTION_ORDER_TRANSITIONS` (`order-states.ts`) y disparador
`production_order_transition`, que cambian juntos (también una prueba que
compara la tabla con la base).

- **Dónde corta este paso:** solo existen servicios para `DRAFT → RELEASED`
  y `DRAFT | RELEASED → CANCELLED`. **`RELEASED → IN_PROGRESS` lo hará el
  primer reporte de producción (WMS-29)** en su transacción, y
  **`IN_PROGRESS → CLOSED`** (también con faltante y motivo) el cierre
  (WMS-31). La base ya los admite; las columnas de esos pasos (`startedAt`,
  `closedAt`, `closedByUserId`, `closeReason`) existen desde aquí.
- No hay `RELEASED → CLOSED`: una orden sin reportes se cancela.
- No hay producir de más (D11): lo comprobará WMS-29 bajo el candado de la
  orden contra su cantidad.

## Modelo

- `production_order` (`CHECK`: `startedAt` presente en `IN_PROGRESS` y
  `CLOSED` y ausente en los demás; `closedAt` y `closedByUserId` en
  `CLOSED`; liberada con quién y cuándo; cancelada con motivo): número por empresa, almacén (`facilityId`, el del
  área; nunca cambia), área (`areaLocationId`), producto, versión de la
  receta (`recipeVersionId`), cantidad y su unidad, día compromiso
  (`DATE`), prioridad (`NORMAL`/`URGENT`, la de las tareas), notas, estado,
  quién y cuándo la creó, liberó, canceló (con motivo), empezó y cerró.
  **Quién la creó o aprobó** es `createdByUserId` (WMS-28B agregará la
  solicitud de la que nació y quién la aprobó); **quién la ejecutó** saldrá
  de los reportes de WMS-29 (pueden ser varias personas), no se guarda aquí.
  Disparadores: número, almacén, producto, autor y fecha nunca cambian;
  cantidad, unidad, versión, área, día, prioridad y notas solo cambian
  mientras sigue en borrador; no se borra.
- `production_order_line` (materiales): producto, cantidad para la orden en
  la unidad del producto, la unidad, la merma esperada copiada (informativa)
  y la cantidad de la receta para su base. Un producto una vez por orden.
  Solo se escriben o borran en borrador.
- `production_order_output` (lo que sale): producto, cantidad esperada, su
  unidad y su parte del costo copiada. Solo en borrador.
- `production_order_assignee`: personas asignadas. Se cambian mientras la
  orden no está cerrada ni cancelada (disparador). Deben ser miembros
  activos con `production.report.create` (quien producirá) que alcanzan el
  área.
- `warehouse_task.productionOrderLineId`: la línea que surte una tarea
  `ISSUE` (exactamente las `ISSUE` la tienen, `CHECK`; nunca cambia,
  disparador; una `ISSUE` nace solo de una orden `RELEASED` o
  `IN_PROGRESS`, disparador).
- `recipe.areaLocationId`: área de producción de la receta (opcional, de
  uso «Producción»): la propone la orden y la usará WMS-28B para «de su
  área». Se cambia con `setRecipeArea` (`production.recipe.manage`).
- Uso de ubicación nuevo **«Producción»** (`LocationType PRODUCTION`): se
  elige donde se editan los usos. No es un lugar «de paso» ni de
  almacenamiento para acomodo; WMS-31 lo agregará a `WAITING_PLACE`. No
  tiene más reglas de capacidad que las de cualquier ubicación.

## Cantidades

Cada línea = (cantidad de la receta × cantidad de la orden) ÷ «para
cuánto» de la versión: **primero se multiplica y se divide una sola vez**,
así un resultado que es exacto sale exacto (dividir primero arrastraba el
error del último dígito al redondeo: una receta para 6 con 6 piezas
apartaba 8 para una orden de 7; revisión independiente). Cada material se
**redondea hacia arriba al paso de ese material** (no se aparta un tercio
de pija); cada salida **hacia abajo** a su paso (lo esperado nunca promete
de más). **No se crea una orden de la que no sale nada**: si el producto de
la orden está entre lo que sale y queda en 0 (receta para 3 que hace 1,
orden de 1), o si ninguna salida pasa de 0, se rechaza («produce más»). Es la única excepción a «nunca se
redondea» (INV-06), porque no es una captura: la orden muestra lo que
aparta. Un material que redondeado pasa del máximo se rechaza. Regla pura
`scaleRecipe` (`order-rules.ts`).

## Receta que cambió, material archivado

La receta no bloquea productos (ADR 0066), así que la orden vuelve a
comprobar:

- **Al crear y al guardar el borrador:** receta vigente; producto de la
  orden, materiales y salidas activos; la unidad guardada en cada línea de
  la receta igual a la del producto hoy.
- **Al liberar**, bajo el candado de los productos y de la orden: que **la
  versión que copió siga vigente**, y las mismas comprobaciones sobre sus
  líneas. **Decisión:** si la receta cambió desde que se guardó el borrador,
  no se libera («La receta cambió (ahora v3): usa la receta vigente antes
  de liberar»); la ficha ofrece «Usar la receta vigente», que vuelve a
  copiarla. Nunca se cambia sola: quien libera ve lo que va a apartar. Una
  orden ya liberada sigue con su versión aunque la receta cambie (P11).
- Un material archivado o con otra unidad también detiene la liberación,
  con su nombre.

## Candados

Orden global: productos → ubicaciones → documento → contenedor → tareas →
capacidad → progreso del proceso. El almacén de la orden se toma
compartido en dos formas, según la operación:

- **Regla: una operación que bloquea productos nunca toma el almacén
  antes que ellos** (también WMS-29 y WMS-31). Liberar y cancelar bloquean
  productos → orden y dejan que la llave foránea de la orden tome el
  almacén en compartido al escribir su estado, igual que un pedido de
  salida. Tomarlo primero cerraba un ciclo a tres bandas (segunda
  revisión): la orden con el almacén esperaba un producto; otro documento
  con ese producto pedía el almacén (su llave foránea, por ejemplo al
  crear «Preparación» al liberar el primer pedido del almacén) y quedaba
  en fila detrás de `changeTree`, que esperaba el almacén en exclusivo
  detenido por la orden.
- **Crear, guardar el borrador y cambiar personas** no bloquean productos:
  toman **primero** el almacén en compartido por el índice único
  `(organizationId, id)` (`lockRows(tx, "facility", [id], { mode:
  "share", byTenantKey: true })`, el mismo índice y orden que `changeTree`:
  por la llave primaria se interbloqueaba, la lección de WMS-75). Así una
  orden nunca se crea ni se guarda con un área que en ese momento se
  archiva o cambia de uso: `changeTree` tiene todos los almacenes en
  exclusivo cuando cuenta las órdenes abiertas del área, y la orden espera
  (o al revés: si la orden se guardó primero, `changeTree` la ve y
  rechaza; si el área cambió primero, `areaOf` lo ve y rechaza).
- **El área no se bloquea.** Mientras tenga órdenes abiertas (borradores
  incluidos) no cambia de uso, no se archiva ni queda bajo un uso que no
  admite existencias disponibles (`refuseOpenProductionOrders` en
  `hierarchy.ts`), y liberar la vuelve a leer con `areaOf`. Bloquearla era
  lo que cerraba el primer ciclo (liberar: área → orden → almacén por la
  llave foránea, contra `changeTree`: almacén → área).
- **Liberar:** productos de los materiales (de una vez, ordenados) →
  orden → capacidad del área (con tareas) → progreso (`assertStagesDone`)
  → escrituras (estado, reservas y tareas nuevas, que no esperan a nadie)
  → `reachMilestone` y `completeOperationStage` sobre el mismo progreso.
- **Cancelar:** productos de los materiales → orden → tareas `ISSUE` →
  progreso.
- **Crear y guardar el borrador:** almacén (compartido) → orden (nueva o
  bloqueada) → progreso. **Personas:** almacén (compartido) → orden.
- **Tarea `ISSUE`** (Inventario): cada paso bloquea producto (si mueve) →
  ubicaciones → **orden de producción** → tarea, como el surtido bloquea su
  pedido. La entrega comprueba bajo el candado de la orden que siga liberada
  o en curso.
- **PC-2:** dos liberaciones a la vez del mismo material se ordenan por el
  candado del producto; la segunda lee lo que la primera ya apartó y nunca
  aparta más de lo libre.

## Alcance

- Una orden existe solo para quien alcanza su área (`locationsOutOfScope`);
  las listas filtran por el almacén activo y `locationScopeWhere`.
- **Liberar aparta solo de ubicaciones que alcanza quien libera** (dentro
  del almacén de la orden), para que el aviso de faltante no cuente
  existencias de zonas que no ve. Por eso conviene limitar al Encargado al
  almacén, o a su zona de producción más las zonas de sus materiales
  (5.3).
- La ficha muestra lo apartado por material como total, sin ubicaciones;
  las tareas `ISSUE` se ven en «Tareas» con las reglas de siempre.

## El área mientras haya órdenes abiertas

- Liberar vuelve a exigir, bajo candado, que el área siga siendo de uso
  «Producción», del almacén de la orden, sin archivar y dentro del alcance
  (un borrador guardado antes de que el área cambiara no se libera).
- Mientras un área tenga órdenes `DRAFT`, `RELEASED` o `IN_PROGRESS`, no
  se le cambia el uso, no se archiva, no se mueve debajo de una ubicación
  de Cuarentena o Restauración ni la ubicación que la contiene pasa a uno
  de esos usos: `editLocation` y `archiveLocation`
  responden cuántas órdenes abiertas la usan (quien la edita la alcanza,
  así que no cuenta nada de otra zona). Lo leen de la tabla, como ya
  leían las tarimas: plataforma no importa el módulo. Mover el área dentro
  de su almacén sí se permite (entre almacenes no se mueve una ubicación).
- Con tareas al área, liberar pregunta antes, con `checkPlacement` en modo
  `report` y todas las llegadas, si el área admite cada material (sus
  restricciones de producto o categoría); si no, no libera y dice cuál.
  La capacidad no detiene: la entrega la dice.
- Una tarea `ISSUE` reportada después de recogerse (`BLOCKED` con
  `pickedUpAt`) cuenta como carga en manos de alguien: cancelar la orden
  la espera, igual que a una recogida.

## Proceso de la orden

`PRODUCTION_ORDER_PROCESS` (`order-process.ts`, clave `production.order`,
módulo `production`, lectura `production.order.read`, dirección
`/produccion/<id>`), en `processDocuments`:

| Hito | Etiqueta | Cierra |
| --- | --- | --- |
| `DRAFT` | Borrador | No |
| `RELEASED` | Liberada | No |
| `IN_PROGRESS` | En proceso | No |
| `CLOSED` | Cerrada | Sí |
| `CANCELLED` | Cancelada | Sí |

Operación: **«Orden liberada»** (`production.order.released`, hito `DRAFT`,
`leadsTo: "RELEASED"`): la empresa puede poner etapas antes de liberar (por
ejemplo, una revisión) y la liberación las espera. Crear llama
`startProcess` (lugar: almacén y área); guardar el borrador con otra área,
`setProcessPlace`; liberar, `assertStagesDone` después de sus candados y,
tras escribir `RELEASED`, `reachMilestone` y `completeOperationStage`;
cancelar, `reachMilestone(CANCELLED)`. Sin proceso publicado nada cambia.
Las operaciones del reporte, la verificación y el cierre las declaran WMS-29,
WMS-30B y WMS-31 (una operación que nada completa bloquearía la orden para
siempre, por eso no se declaran antes). «Materiales surtidos» como etapa de
operación queda pendiente: la entrega de la tarea es de Inventario, que no
conoce Producción.

## Permisos

Los de la matriz (WMS-59), sin nuevos: `production.order.read` (titular,
Administración, Almacén, Consulta, Supervisor de almacén, Gerencia,
Operario, Encargado e Inspector), `production.order.create`, `.release` y
`.cancel` (titular, Administración y Encargado). `production.order.close`
lo usará WMS-31. Las tareas `ISSUE` usan los permisos de tareas
(`inventory.task.*`). Nadie ve costos aquí: la parte del costo es un
porcentaje. Con Producción en solo lectura todo se ve y nada se hace.

## Ajustes (Operación › Producción)

- `production.materials.mode`: `direct` (por omisión), `issue`.
- `production.release.short`: `ask` (por omisión: ofrece liberar con lo que
  hay), `block`.

Se leen con `readSetting` dentro de la transacción de liberar.

## Pantallas

Sección **«Producción»** del menú (`module: "production"`, permiso
`production.order.read`), después de Pedidos: el Encargado crea y libera
órdenes cada día y el Operario consulta las suyas; en teléfono va en «Más».
`/produccion` (lista paginada en la base, filtro por estado, «Mías» para
quien está asignado), `/produccion/nueva` y `/produccion/[id]` (materiales
con lo apartado, lo que sale, personas, «Liberar orden», «Cancelar orden»,
«Usar la receta vigente», proceso con `ProcessPanel`). El bloque «Receta»
de la ficha del producto agrega el área de producción.

## Quitar el módulo

`productionOpenWork` agrega «N órdenes de producción abiertas» y cuántas de
ellas tienen materiales apartados, que seguirán apartados. Nada se cancela:
queda en solo lectura, y lo apartado sigue bloqueando salidas y surtido sin
que nadie pueda cancelar esas órdenes (pregunta abierta, abajo).

## Preguntas abiertas al fundador

Anotadas en la revisión; no cambian nada de este paso:

1. Lo libre en un área de producción, ¿debe poder surtir pedidos de
   salida, reponerse o contarse como cualquier existencia? Hoy sí.
2. Quitar Producción, ¿debe liberar lo apartado por órdenes abiertas? Hoy
   no: queda apartado y en solo lectura.
3. ¿Puede el Encargado liberar y cancelar órdenes desde una terminal
   compartida con PIN? Hoy sí (solo recetas y planes son de escritorio).
4. ¿Hacen falta etapas de proceso después de cerrar la orden? Hoy
   «Cerrada» cierra el proceso.
5. El redondeo hacia arriba de los materiales, ¿debe ser un ajuste de la
   empresa? Hoy es fijo.

## Fuera de este paso

Reporte y consumo (WMS-29), costo (WMS-29), cierre (WMS-31), solicitudes
desde el piso y avisos al Encargado (WMS-28B), avisos a las personas
asignadas, «Materiales surtidos» como etapa de operación, órdenes entre
almacenes, campos personalizados, API y webhooks, armar y desarmar el mismo
kit (sigue pendiente del fundador).

## Consecuencias

- Tablas `production_order`, `production_order_line`,
  `production_order_output`, `production_order_assignee` en
  `TENANT_MODELS`; `productionOrder` en `LOCKABLE`.
- Servicios en `src/modules/production/orders.ts`; reglas puras en
  `order-rules.ts` y `order-states.ts`; tareas `ISSUE` en
  `src/modules/inventory/issue.ts` (Inventario las ejecuta; Producción las
  crea al liberar).
- Bitácora: `production.order_created`, `production.order_changed`,
  `production.order_released`, `production.order_cancelled`,
  `production.recipe_area_changed`.
- Decisiones que el fundador puede cambiar: redondeo de materiales hacia
  arriba; liberar con la receta cambiada exige actualizarla a mano; liberar
  aparta solo de lo que alcanza quien libera; cancelar una tarea de surtir
  suelta lo que apartaba (como el surtido de pedidos); las personas
  asignadas se cambian hasta cerrar la orden.
