# Módulo Producción (`production`)

Carpeta `src/modules/production`. Contrato `productionModule` (`contract.ts`):
opcional (`required: false`), depende de `inventory` (lo que se produce y se
consume son existencias), usa `catalog`, dueño de los permisos
`production.*`, sin límites propios. **Disponible desde WMS-27** (ADR 0066):
el personal de plataforma ya puede activarlo; antes estaba anunciado (ADR
0062). Precio, nombre comercial y textos del sitio son del fundador.

## Responsabilidad

Recetas en la ficha del producto (WMS-27) y órdenes de producción
(WMS-28, ADR 0073); después, solicitudes del piso y reportes de lo
producido (propuesta `docs/flujos/PRODUCCION_CALIDAD.md`, pasos WMS-28B,
WMS-29 y WMS-31). Desde WMS-28 **aparta** existencias (reservas de los
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
| `productionOpenWork` | Trabajo a medias al quitar el módulo (borradores sin activar, órdenes abiertas) |
| `recipe-rules.ts`, `recipe-states.ts` | Reglas puras: porcentajes, partes del costo, qué impide activar, ciclos (`findRecipeCycle`), estados (`RECIPE_VERSION_TRANSITIONS`) |
| `order-rules.ts`, `order-states.ts` | Reglas puras de la orden: escalar la receta (materiales hacia arriba, salidas hacia abajo), estados (`PRODUCTION_ORDER_TRANSITIONS`), `formatProductionNumber` |

Cada servicio empieza con `assertModulePermission` (`production.recipe.*`
o `production.order.*`). Candados: un cambio del borrador bloquea su
`recipe`; activar bloquea primero `recipe_lock` (una fila por empresa, que
no se borra; activar exige haberla bloqueado) y después la receta, así dos
activaciones no forman un ciclo. `listRecipeVersions` se pagina en la base
(20 por página). En una terminal compartida con PIN la receta se lee y no se
cambia (`TERMINAL_DESK_ONLY` de `platform/authorization`).

**Órdenes (WMS-28, ADR 0073).** Candados: **la fila del almacén de la
orden, compartida y por el índice `(organizationId, id)`** (`lockRows(tx,
"facility", [id], { mode: "share", byTenantKey: true })`; toda escritura de
una orden la toma primero, también WMS-29 y WMS-31, porque cambiar
ubicaciones bloquea los almacenes por ese índice antes que una ubicación)
→ productos de los materiales (de una vez) → el área → la orden
(`lockRows(tx, "productionOrder", …)`) → capacidad → progreso del proceso.
Un área con órdenes abiertas no cambia de uso ni se archiva
(`hierarchy.ts` lo lee de la tabla). Una tarea `ISSUE` la ejecuta Inventario:
cada paso bloquea producto → ubicaciones → orden de producción → tarea,
como el surtido bloquea su pedido. Una orden existe solo para quien alcanza
su área. Liberar vuelve a comprobar bajo candado que la versión copiada
siga vigente y que producto y materiales sigan activos con la misma unidad;
si la receta cambió, no se libera hasta «Usar la receta vigente» (guardar
el borrador). Las reservas llevan la fuente `production_order_line` + id de
la línea (`PRODUCTION_ORDER_LINE_SOURCE` de Inventario).

## Permisos

`production.recipe.read|manage`, `production.order.read|create|release|cancel|close`,
`production.request.read|create|decide`, `production.report.create|reverse`,
`production.scrap.create`, `production.shift.manage`,
`production.output.verify`. Quién recibe cada uno: `docs/MATRIZ_ROLES_PERMISOS.md`
(sección «Producción») y ADR 0062. WMS-27 usa los de recetas; WMS-28,
`production.order.read|create|release|cancel` (`close` llega con WMS-31) y
`production.report.create` solo para saber a quién se puede asignar.

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
`/produccion/[id]/editar` (borrador).

## Ajustes y trabajos

Ajustes (Operación › Producción): `production.materials.mode` (`direct` por
omisión, `issue`) y `production.release.short` (`ask` por omisión,
`block`). Sin trabajos en segundo plano.

## Bitácora

`production.recipe_created`, `production.recipe_activated`,
`production.recipe_discarded`, `production.recipe_area_changed`,
`production.order_created`, `production.order_changed`,
`production.order_released`, `production.order_cancelled`.

## ADR

0062 (roles y permisos de producción y calidad), 0066 (recetas), 0073
(órdenes de producción).

## Pruebas

`src/modules/production/*.test.ts` (reglas y estados),
`tests/production/recipes.int.test.ts` (servicio, base, ciclos y
activaciones simultáneas, roles, solo lectura, entre empresas) y
`tests/production/module-guard.int.test.ts` (guarda del módulo) y
`tests/production/orders.int.test.ts` (órdenes: escalar la receta,
disparadores, liberar con faltante, PC-2 con liberaciones simultáneas,
lotes y series, surtir al área de punta a punta, cancelar, receta cambiada,
proceso, roles, solo lectura, alcance y entre empresas).
