# Módulo Producción (`production`)

Carpeta `src/modules/production`. Contrato `productionModule` (`contract.ts`):
opcional (`required: false`), depende de `inventory` (lo que se produce y se
consume son existencias), usa `catalog`, dueño de los permisos
`production.*`, sin límites propios. **Anunciado** (`availability:
"unavailable"`) hasta WMS-27: nada puede activarlo todavía (ADR 0062).

## Responsabilidad

Recetas en la ficha del producto, órdenes de producción, solicitudes del
piso y reportes de lo producido (propuesta `docs/flujos/PRODUCCION_CALIDAD.md`,
pasos WMS-27, WMS-28, WMS-28B, WMS-29 y WMS-31). Hoy solo existe su contrato
y su catálogo de permisos (WMS-59).

## Servicios públicos (`index.ts`)

| Qué | Para qué |
| --- | --- |
| `productionModule` | Contrato, para `src/modules/registry` |

## Permisos

`production.recipe.read|manage`, `production.order.read|create|release|cancel|close`,
`production.request.read|create|decide`, `production.report.create|reverse`,
`production.scrap.create`, `production.shift.manage`,
`production.output.verify`. Quién recibe cada uno: `docs/MATRIZ_ROLES_PERMISOS.md`
(sección «Producción») y ADR 0062.

Roles ligados (`ROLE_MODULE`): `production_operator` (Operario de
producción) y `production_supervisor` (Encargado de producción). Sin el
módulo no dan nada.

## Tablas, ajustes y trabajos

Ninguno todavía.

## ADR

0062 (roles y permisos de producción y calidad).
