# Módulo Calidad (`quality`)

Carpeta `src/modules/quality`. Contrato `qualityModule` (`contract.ts`):
opcional, depende de `production` (el fundador decidió que Calidad no se
contrata sin Producción, D9: no se activa sin ella y Producción no se quita
con Calidad activa), usa `catalog`, dueño de los permisos `quality.*`, sin
límites propios. **Anunciado** (`availability: "unavailable"`) hasta
WMS-30A (ADR 0062).

## Responsabilidad

Verificación e inspección de lo producido, lo recibido y lo devuelto: planes
de inspección y defectos (WMS-30A) e inspecciones (WMS-30B). Hoy solo existe
su contrato y su catálogo de permisos (WMS-59).

## Servicios públicos (`index.ts`)

| Qué | Para qué |
| --- | --- |
| `qualityModule` | Contrato, para `src/modules/registry` |

## Permisos

`quality.inspection.read|create|decide`, `quality.lot.release`,
`quality.plan.read|manage`. Quién recibe cada uno: `docs/MATRIZ_ROLES_PERMISOS.md`
(sección «Calidad») y ADR 0062.

Rol ligado (`ROLE_MODULE`): `quality_inspector` (Inspector de calidad). Sin
Calidad no da nada.

## Tablas, ajustes y trabajos

Ninguno todavía.

## ADR

0062 (roles y permisos de producción y calidad).
