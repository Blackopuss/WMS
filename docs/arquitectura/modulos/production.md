# Módulo Producción (`production`)

Carpeta `src/modules/production`. Contrato `productionModule` (`contract.ts`):
opcional (`required: false`), depende de `inventory` (lo que se produce y se
consume son existencias), usa `catalog`, dueño de los permisos
`production.*`, sin límites propios. **Disponible desde WMS-27** (ADR 0066):
el personal de plataforma ya puede activarlo; antes estaba anunciado (ADR
0062). Precio, nombre comercial y textos del sitio son del fundador.

## Responsabilidad

Recetas en la ficha del producto (WMS-27), órdenes de producción
(WMS-28, ADR 0073) y solicitudes de producción desde el piso (WMS-28B,
ADR 0075); después, reportes de lo producido y cierre (propuesta
`docs/flujos/PRODUCCION_CALIDAD.md`, pasos WMS-29 y WMS-31). Desde WMS-28 **aparta** existencias (reservas de los
materiales de una orden liberada) y crea tareas «Surtir a producción»; no
escribe movimientos ni saldos por sí mismo (las tareas los escribe
Inventario al entregarse).

## Servicios públicos (`index.ts`)

| Qué | Para qué |
| --- | --- |
| `productionModule` | Contrato, para `src/modules/registry` |
| `createRecipe` | «Agregar receta»: la receta con su versión 1 en borrador (sale el producto, 100 % del costo) |
| `startRecipeChange` | «Cambiar receta»: la siguiente versión en borrador, copiada de la vigente; si ya hay borrador, ese |
| `updateRecipeDraft` | «Para cuánto» del borrador |
| `setRecipeInput`, `removeRecipeInput` | Materiales del borrador (`resolveConversion`, merma esperada) |
| `setRecipeOutput`, `removeRecipeOutput` | Lo que sale del borrador (cantidad y parte del costo) |
| `activateRecipeVersion` | Revalida bajo candado, retira la vigente y activa el borrador |
| `discardRecipeDraft` | Deja el borrador descartado |
| `getProductRecipe`, `getRecipeVersion`, `listRecipeVersions` | Lecturas (ficha, borrador, historial; «Se usa en») |
| `activeRecipeOf(tx, productId)` | La versión vigente dentro de la transacción de otro servicio |
| `setRecipeArea` | Área de producción que la receta propone a sus órdenes (WMS-28) |
| `createProductionOrder`, `updateProductionOrder` | Borrador de una orden: copia la receta vigente escalada a su cantidad; guardar la vuelve a copiar (WMS-28) |
| `releaseProductionOrder` | Aparta cada material (`pickSources`, lo que caduca antes primero, solo del alcance de quien libera); `short`/`takeWhatThereIs`; con `production.materials.mode = issue` crea las tareas `ISSUE` (`setAsideForProduction` de Inventario) |
| `cancelProductionOrder` | Libera lo apartado y cancela sus tareas sin recoger (una recogida se entrega antes) |
| `setProductionOrderAssignees` | Personas de una orden abierta (miembros que pueden reportar producción y alcanzan el área) |
| `getProductionOrder`, `listProductionOrders`, `listProductionAreas`, `listProductionPeople`, `listProducibleProducts` | Lecturas (ficha con lo apartado por material, lista paginada del almacén activo, áreas, personas, productos con receta vigente) |
| `PRODUCTION_ORDER_PROCESS` | La orden como documento del motor de procesos (operación «Orden liberada») |
| `listRequestableProducts` | «Queda poco»: lo que la persona puede pedir (solo id, nombre y unidad; nunca existencias), o por qué no puede (algo a su nombre) (WMS-28B) |
| `submitProductionRequest` | «Pedir producción»: revisa las tres condiciones bajo el candado de su membresía y guarda la solicitud; avisa a quien decide (WMS-28B) |
| `acceptProductionRequest` | Nace la orden a nombre de quien acepta y queda liberada (o en borrador); `short`/`take`/`draft`; `repeated` (WMS-28B) |
| `rejectProductionRequest`, `cancelProductionRequest` | Rechazar con motivo; cancelar (solo quien pidió) (WMS-28B) |
| `getProductionRequest`, `listProductionRequests`, `countProductionRequestsToDecide` | Lecturas: la solicitud con la pantalla de decisión (existencias del producto y de sus materiales dentro del alcance de quien decide), lista paginada, cuántas esperan (WMS-28B) |
| `productionOpenWork` | Trabajo a medias al quitar el módulo (borradores sin activar, órdenes abiertas, solicitudes por atender) |
| `recipe-rules.ts`, `recipe-states.ts` | Reglas puras: porcentajes, partes del costo, qué impide activar, ciclos (`findRecipeCycle`), estados (`RECIPE_VERSION_TRANSITIONS`) |
| `order-rules.ts`, `order-states.ts` | Reglas puras de la orden: escalar la receta (materiales hacia arriba, salidas hacia abajo), estados (`PRODUCTION_ORDER_TRANSITIONS`), `formatProductionNumber` |
| `request-rules.ts`, `request-states.ts` | Reglas puras de la solicitud: cerca del mínimo (`isNearMinimum`), para cuánto alcanza el material (`reachableQuantity`), estados (`PRODUCTION_REQUEST_TRANSITIONS`), `formatProductionRequestNumber` |

Cada servicio empieza con `assertModulePermission` (`production.recipe.*`
o `production.order.*`). Candados: un cambio del borrador bloquea su
`recipe`; activar bloquea primero `recipe_lock` (una fila por empresa, que
no se borra; activar exige haberla bloqueado) y después la receta, así dos
activaciones no forman un ciclo. `listRecipeVersions` se pagina en la base
(20 por página). En una terminal compartida con PIN la receta se lee y no se
cambia (`TERMINAL_DESK_ONLY` de `platform/authorization`).

**Órdenes (WMS-28, ADR 0073).** Candados: liberar y cancelar, productos
de los materiales (de una vez) → la orden (`lockRows(tx,
"productionOrder", …)`) → capacidad → progreso del proceso; **una
operación que bloquea productos nunca toma el almacén antes que ellos**
(también WMS-29 y WMS-31). Crear, guardar y cambiar personas no bloquean
productos y toman primero el almacén en compartido (`lockRows` con `mode:
"share"`, por la llave primaria, como todo candado: ADR 0074), y chocan con
`changeTree`, que lo tiene en exclusivo. El área no se
bloquea: con órdenes abiertas no cambia de uso, no se archiva ni queda bajo
Cuarentena o Restauración (`hierarchy.ts` lo lee de la tabla), y liberar la
vuelve a leer. Una tarea `ISSUE` la ejecuta Inventario:
cada paso bloquea producto → ubicaciones → orden de producción → tarea,
como el surtido bloquea su pedido. Una orden existe solo para quien alcanza
su área. Liberar vuelve a comprobar bajo candado que la versión copiada
siga vigente y que producto y materiales sigan activos con la misma unidad;
si la receta cambió, no se libera hasta «Usar la receta vigente» (guardar
el borrador). Las reservas llevan la fuente `production_order_line` + id de
la línea (`PRODUCTION_ORDER_LINE_SOURCE` de Inventario).

**Solicitudes (WMS-28B, ADR 0075).** Pedir exige no tener nada a su nombre
(órdenes `RELEASED`/`IN_PROGRESS` asignadas, etapas de proceso tomadas,
tareas de almacén asignadas y abiertas; lo disponible sin tomar no cuenta),
un producto con receta vigente cuya área está en su alcance y en su almacén
activo, y su disponible de toda la empresa en o debajo de mínimo × (1 +
margen) (`productsNearMinimum` de Inventario, que no devuelve cantidades).
Decide quien tiene `production.request.decide` y alcanza el área. **Aceptar
no da permisos sobre órdenes**: corre los núcleos internos de `orders.ts`
(`createOrderUnderLock`, `releaseUnderLock`, no exportados en `index.ts`)
solo para la orden de esa solicitud. Candados al aceptar: productos de los
materiales → la solicitud (actualización condicionada `status =
'SUBMITTED'`, que decide entre dos personas a la vez) → almacén compartido
(`shareFacility`) → la orden nueva → progreso. `production_order.requestId`
(único, inmutable) liga la orden a su solicitud; quien aprobó es quien
decidió la solicitud.

## Permisos

`production.recipe.read|manage`, `production.order.read|create|release|cancel|close`,
`production.request.read|create|decide`, `production.report.create|reverse`,
`production.scrap.create`, `production.shift.manage`,
`production.output.verify`. Quién recibe cada uno: `docs/MATRIZ_ROLES_PERMISOS.md`
(sección «Producción») y ADR 0062. WMS-27 usa los de recetas; WMS-28,
`production.order.read|create|release|cancel` (`close` llega con WMS-31) y
`production.report.create` solo para saber a quién se puede asignar;
WMS-28B, `production.request.read|create|decide`.

Roles ligados (`ROLE_MODULE`): `production_operator` (Operario de
producción) y `production_supervisor` (Encargado de producción). Sin el
módulo no dan nada.

## Tablas

| Tabla | Qué guarda |
| --- | --- |
| `recipe` | Una por producto; no se borra y su producto no cambia |
| `recipe_version` | Número, estado (`DRAFT → ACTIVE → RETIRED`, `DRAFT → DISCARDED`, disparador `recipe_version_transition`), para cuánto y su unidad; una vigente y un borrador por receta (`activeRecipeId`/`draftRecipeId` únicos) |
| `recipe_input` | Material: capturado, presentación y versión, unidad capturada, factor, cantidad en la unidad del material (`unitCode` guardada) y merma esperada |
| `recipe_output` | Lo que sale: cantidad en su unidad y parte del costo (%) |
| `recipe_lock` | Candado de activaciones de la empresa (su id es el de la empresa) |
| `production_order` | Orden `OP-0001`: almacén, área (uso «Producción»), producto, versión de la receta, cantidad, día, prioridad, notas, estado (`DRAFT → RELEASED → IN_PROGRESS → CLOSED`, `DRAFT | RELEASED → CANCELLED`, disparador `production_order_transition`) y quién la creó, liberó, canceló, empezó y cerró |
| `production_order_line` | Material de la orden: cantidad escalada (hacia arriba al paso del material), su unidad, lo de la receta y la merma esperada |
| `production_order_output` | Lo que sale: cantidad esperada (hacia abajo) y parte del costo |
| `production_order_assignee` | Personas asignadas (cambian hasta cerrar o cancelar) |
| `production_request` | Solicitud `SP-0001`: almacén, área, producto, cantidad pedida y su unidad, motivo, estado (`SUBMITTED → ACCEPTED | REJECTED | CANCELLED`, disparador `production_request_transition`), quién pidió, decidió (con motivo si rechazó) o canceló. Lo pedido no cambia y no se borra |

Materiales y salidas de una receta solo cambian mientras su versión es
borrador; los de una orden, mientras la orden es borrador (disparadores);
nada se borra. `recipe.areaLocationId` es el área que propone la receta.
`warehouse_task.productionOrderLineId` liga una tarea `ISSUE` a su línea.

## Pantallas

Bloque «Receta» de la ficha del producto (`/inventario/[id]`, componente
`receta/recipe-section.tsx`: Inventario no importa Producción),
`/inventario/[id]/receta` (borrador y «Dónde se produce») y
`/inventario/[id]/receta/versiones` (historial). Sección **«Producción»**
del menú (WMS-28): `/produccion` (lista), `/produccion/nueva`,
`/produccion/[id]` (ficha, liberar, cancelar, personas, proceso) y
`/produccion/[id]/editar` (borrador). Solicitudes (WMS-28B): bloque «Queda
poco» en «Mis tareas» (`/tareas`), `/produccion/solicitudes` (lista),
`/produccion/solicitudes/nueva` (pedir) y `/produccion/solicitudes/[id]`
(ficha y pantalla de decisión).

## Ajustes y trabajos

Ajustes (Operación › Producción): `production.materials.mode` (`direct` por
omisión, `issue`) y `production.release.short` (`ask` por omisión,
`block`), y `production.request.low_margin` (`0`, `10`, `25` por omisión,
`50` %; WMS-28B). Sin trabajos en segundo plano. Avisos (WMS-28B,
`notices.ts`): `production.request_to_decide`,
`production.request_answered`, `production.order_from_request`.

## Bitácora

`production.recipe_created`, `production.recipe_activated`,
`production.recipe_discarded`, `production.recipe_area_changed`,
`production.order_created`, `production.order_changed`,
`production.order_released`, `production.order_cancelled`,
`production.request_created`, `production.request_accepted`,
`production.request_rejected`, `production.request_cancelled`.

## ADR

0062 (roles y permisos de producción y calidad), 0066 (recetas), 0073
(órdenes de producción), 0075 (solicitudes de producción).

## Pruebas

`src/modules/production/*.test.ts` (reglas y estados),
`tests/production/recipes.int.test.ts` (servicio, base, ciclos y
activaciones simultáneas, roles, solo lectura, entre empresas) y
`tests/production/module-guard.int.test.ts` (guarda del módulo) y
`tests/production/orders.int.test.ts` (órdenes: escalar la receta,
disparadores, liberar con faltante, PC-2 con liberaciones simultáneas,
lotes y series, surtir al área de punta a punta, cancelar, receta cambiada,
proceso, roles, solo lectura, alcance y entre empresas) y
`tests/production/requests.int.test.ts` (solicitudes: las tres
condiciones, margen, forma de la lista sin cantidades, quién decide,
pantalla de decisión dentro del alcance, aceptar con y sin material,
Almacén sin permisos de órdenes, decisiones simultáneas, avisos, solo
lectura, entre empresas, disparadores).
