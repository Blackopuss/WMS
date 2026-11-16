# Módulo Producción (`production`)

Carpeta `src/modules/production`. Contrato `productionModule` (`contract.ts`):
opcional (`required: false`), depende de `inventory` (lo que se produce y se
consume son existencias), usa `catalog`, dueño de los permisos
`production.*`, sin límites propios. **Disponible desde WMS-27** (ADR 0066):
el personal de plataforma ya puede activarlo; antes estaba anunciado (ADR
0062). Precio, nombre comercial y textos del sitio son del fundador.

## Responsabilidad

Recetas en la ficha del producto (WMS-27); después, órdenes de producción,
solicitudes del piso y reportes de lo producido (propuesta
`docs/flujos/PRODUCCION_CALIDAD.md`, pasos WMS-28, WMS-28B, WMS-29 y
WMS-31). Hoy no mueve existencias: no escribe movimientos, saldos ni
reservas.

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
| `activeRecipeOf(tx, productId)` | La versión vigente dentro de la transacción de otro servicio (WMS-28) |
| `productionOpenWork` | Trabajo a medias al quitar el módulo (borradores sin activar) |
| `recipe-rules.ts`, `recipe-states.ts` | Reglas puras: porcentajes, partes del costo, qué impide activar, ciclos (`findRecipeCycle`), estados (`RECIPE_VERSION_TRANSITIONS`) |

Cada servicio empieza con `assertModulePermission` (`production.recipe.read`
o `production.recipe.manage`). Candados: un cambio del borrador bloquea su
`recipe`; activar bloquea primero `recipe_lock` (una fila por empresa, que
no se borra; activar exige haberla bloqueado) y después la receta, así dos
activaciones no forman un ciclo. `listRecipeVersions` se pagina en la base
(20 por página). En una terminal compartida con PIN la receta se lee y no se
cambia (`TERMINAL_DESK_ONLY` de `platform/authorization`).

## Permisos

`production.recipe.read|manage`, `production.order.read|create|release|cancel|close`,
`production.request.read|create|decide`, `production.report.create|reverse`,
`production.scrap.create`, `production.shift.manage`,
`production.output.verify`. Quién recibe cada uno: `docs/MATRIZ_ROLES_PERMISOS.md`
(sección «Producción») y ADR 0062. WMS-27 usa solo los de recetas.

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

Materiales y salidas solo cambian mientras su versión es borrador
(disparadores); nada se borra.

## Pantallas

Bloque «Receta» de la ficha del producto (`/inventario/[id]`, componente
`receta/recipe-section.tsx`: Inventario no importa Producción),
`/inventario/[id]/receta` (borrador) y `/inventario/[id]/receta/versiones`
(historial). Sin entrada en el menú.

## Ajustes y trabajos

Ninguno todavía.

## Bitácora

`production.recipe_created`, `production.recipe_activated`,
`production.recipe_discarded`.

## ADR

0062 (roles y permisos de producción y calidad), 0066 (recetas).

## Pruebas

`src/modules/production/*.test.ts` (reglas y estados),
`tests/production/recipes.int.test.ts` (servicio, base, ciclos y
activaciones simultáneas, roles, solo lectura, entre empresas) y
`tests/production/module-guard.int.test.ts` (guarda del módulo).
