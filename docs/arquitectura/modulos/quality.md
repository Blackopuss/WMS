# Módulo Calidad (`quality`)

Carpeta `src/modules/quality`. Contrato `qualityModule` (`contract.ts`):
opcional, depende de `production` (el fundador decidió que Calidad no se
contrata sin Producción, D9: no se activa sin ella y Producción no se quita
con Calidad activa), usa `catalog`, dueño de los permisos `quality.*`, sin
límites propios. **Disponible** desde WMS-30A (ADR 0067); precio, nombre
comercial y textos del sitio siguen pendientes del fundador.

## Responsabilidad

Verificación e inspección de lo producido, lo recibido y lo devuelto. Hoy:
**planes de inspección** de cada producto y **catálogo de defectos** de la
empresa (WMS-30A), lo que se configura antes de inspeccionar. Las
inspecciones (`IN-0001`, contadas, aprobadas, rechazadas, cuarentena,
diferencias por causa) son WMS-30B. Nada de este módulo toca existencias
todavía.

## Servicios públicos (`index.ts`)

| Qué | Para qué |
| --- | --- |
| `qualityModule` | Contrato, para `src/modules/registry` |
| `getProductInspection` | Plan de un producto para su ficha y su pantalla: vigente, borrador (solo para quien administra) y versiones anteriores paginadas (`quality.plan.read`) |
| `startPlanDraft`, `updatePlanDraft`, `addPlanPoint`, `removePlanPoint`, `publishPlanDraft`, `discardPlanDraft` | Borrador de la versión siguiente, sus puntos y su publicación (`quality.plan.manage`; candados producto → plan) |
| `listDefects`, `createDefect`, `updateDefect`, `setDefectArchived` | Catálogo de defectos (leer `quality.plan.read`; cambiar `quality.plan.manage`) |
| `inspectionPlanFor(tx, organizationId, productId, origin)` | Para WMS-30B, dentro de su transacción: versión vigente para ese origen (`produced`, `received`, `returned`) con sus puntos y la revisión ya resuelta con el ajuste, o `null`. No pide permiso |
| `samplingWithoutPlan(tx, organizationId)` | Revisión cuando no hay plan para ese origen |
| `sampleSize`, `resolveSampling`, `judgeAnswer` | Reglas puras (`plan-rules.ts`): tamaño de la muestra, revisión con el ajuste, si una respuesta cumple |
| `qualityOpenWork` | Trabajo a medias al quitar el módulo (borradores sin publicar), para la consola |
| `QUALITY_SETTINGS`, `SAMPLING_DEFAULT`, `EVIDENCE_PHOTO` | Ajustes de operación |

## Permisos

`quality.inspection.read|create|decide`, `quality.lot.release`,
`quality.plan.read|manage`. Quién recibe cada uno: `docs/MATRIZ_ROLES_PERMISOS.md`
(sección «Calidad») y ADR 0062. Los planes y defectos los leen el Inspector,
Gerencia, Consulta, titular y Administración; los cambian titular y
Administración.

Rol ligado (`ROLE_MODULE`): `quality_inspector` (Inspector de calidad). Sin
Calidad no da nada.

## Tablas

| Tabla | Qué guarda |
| --- | --- |
| `quality_plan` | Uno por producto; no se borra |
| `quality_plan_version` | Versiones: `DRAFT → ACTIVE → RETIRED`, `DRAFT → DISCARDED`; revisión (`DEFAULT`, `FULL`, `SAMPLE`), regla de muestra y a qué aplica. Fuera de borrador no cambia (disparador); `draftPlanId`/`activePlanId` únicos los fija un disparador |
| `quality_plan_point` | Puntos de revisión (sí o no, número con rango, opción de una lista, texto), obligatorio, pide foto; solo cambian en borrador |
| `quality_plan_point_option` | Opciones de un punto de lista y si cumplen; solo cambian en borrador |
| `quality_defect` | Defectos de la empresa con gravedad (Menor, Mayor, Crítica); se archivan, no se borran |
| `quality_defect_catalog` | Una fila por empresa: candado común de agregar o volver a usar un defecto (tope de 100 en uso) |

## Ajustes, trabajos y pantallas

- Ajustes (Configuración › Operación, área «Calidad»):
  `quality.sampling.default` (`full` por omisión, `sample`) y
  `quality.evidence.photo` (`optional` por omisión, `required`; lo aplica
  WMS-30B).
- Sin trabajos ni rondas.
- Pantallas: bloque «Inspección» en la ficha del producto
  (`/inventario/[id]`), plan en `/inventario/[id]/inspeccion` y
  Configuración › «Defectos» (`/configuracion/defectos`). Nada en el menú
  principal.
- Bitácora: `quality.plan_published`, `quality.plan_discarded`,
  `quality.defect_created|changed|archived|restored`.

## ADR

0062 (roles y permisos de producción y calidad) y 0067 (planes de inspección
y defectos).

## Pruebas

`src/modules/quality/plan-rules.test.ts` (reglas puras),
`tests/quality/plans.int.test.ts` (versiones, inmutabilidad en servicio y
base, publicar a la vez, permisos por rol, entre empresas, solo lectura, lo
que lee WMS-30B), `tests/quality/defects.int.test.ts` y
`tests/quality/module-guard.int.test.ts` (guarda del módulo, dependencia de
Producción y los dos ajustes).
