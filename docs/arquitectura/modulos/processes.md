# Plataforma: procesos (`platform/processes`)

## Responsabilidad

El motor de procesos de la empresa (WMS-74, ADR 0069): por cada tipo de
documento que declara un módulo, la empresa define etapas y subetapas
**encima de los estados fijos** del documento, con candado entre etapas del
mismo documento (P10, P10b) y relevo automático entre áreas. Avanzar una etapa
**nunca mueve existencias ni cambia el estado fijo del documento**. La
plataforma recibe los documentos como lista (`processDocuments` de
`src/modules/registry/processes.ts`; hoy el embarque de Inventario,
WMS-74B, ADR 0071) y no conoce a los módulos.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Definiciones | `definitions.ts` | tipo `ProcessDocument` (`key` `modulo.cosa`, `module`, `label`, `milestones` en orden con `closes`, `operations` con su hito, `readPermission`, `href`), `PROCESS_LIMITS`, `assertValidProcessDocuments`, `milestoneIndex`, `worksProcessStages` (si «Tareas» e Inicio muestran etapas: trabaja etapas y lee algún documento de un módulo activo; WMS-74B) |
| Reglas (puras) | `rules.ts` | `settleStates` (qué etapa se puede hacer: candado, hito y subetapas en orden o en cualquier orden), `waitingFor` («Esperando: …»), `previousStage` (a dónde regresa «Regresar»), `checkDraft` y `draftSchema` (forma de un borrador); prueba unitaria `rules.test.ts` |
| Estados | `states.ts` | `PROCESS_VERSION_TRANSITIONS` (`DRAFT → PUBLISHED → RETIRED`; la repite el disparador `process_version_transition`), etiquetas de estados y acciones |
| Para los módulos | `engine.ts` | `startProcess` (lee la versión vigente con candado compartido de la definición), `reachMilestone`, `setProcessPlace`, `assertStagesDone`, `completeOperationStage` (con el `tx` del módulo), `ProcessStagesPending`; `doneStagesAt` (etapas manuales del hito actual ya hechas, con candado o sin él; WMS-74B); `operationWaits` (lo mismo que `assertStagesDone` sin candado, para que una pantalla diga por qué no ofrece la operación; WMS-74B) |
| Para las personas | `work.ts` | `takeStage`, `releaseStage`, `assignStage`, `completeStage` (nota, cantidad y fotos), `skipStage`, `backStage` (motivo); `uploadProcessPhoto`, `discardProcessPhoto`; `processStepReach` (dueño de las fotos) |
| Leer | `work.ts` | `getProcessView` (línea de etapas, siguiente paso, a quién asignar, rastro con fotos), `listProcessWork` y `countProcessWork` («Mis tareas» y «Disponibles») |
| Configurar | `config.ts` | `getProcessSettings`, `getProcessDefinition`, `saveProcessDraft` (bitácora `process.draft_saved`), `publishProcess` (`process.published`), `hasProcessDocuments` (para el menú de Configuración) |

### Contrato para un módulo

Todo con el cliente `tx` de la transacción del módulo, que el módulo abre
con `LOCKING_TRANSACTION`:

1. Al crear el documento, después de insertarlo: `startProcess(tx, doc,
   actor, { documentId, facilityId, locationId?, label, milestone })`.
2. Al cambiar su estado fijo, después de escribirlo: `reachMilestone(tx, doc,
   actor, documentId, hito)`. Un hito con `closes` cierra el proceso.
3. Si cambia de lugar: `setProcessPlace(tx, doc, documentId, lugar)`.
4. Antes de una operación que puede ser etapa, después de sus candados:
   `assertStagesDone(tx, doc, documentId, operación)`; si responde `ok:
   false`, el módulo rechaza con su `message`.
5. Después de escribir la operación: `completeOperationStage(tx, doc,
   actor, documentId, operación)`. Si la operación cambia el estado fijo,
   `reachMilestone` va **antes** en la misma transacción: si el documento
   no llegó al hito de la etapa, `completeOperationStage` lanza
   `ProcessStagesPending` y todo se revierte.

Orden de candados: documento del módulo → progreso → archivos de las fotos.
Las acciones de las personas bloquean solo el progreso.

Cada operación declara `leadsTo` (obligatorio, validado al arrancar): el
hito al que lleva el documento, después de `milestone`, o `null` si no cambia
su estado; `milestone` nunca es un hito `closes`. Una acción de etapa
devuelve `documentHref` (lo calcula el motor) para que la pantalla del
documento se refresque.

Un hito con `closes` borra los pendientes: el estado final «bueno» de un
documento que tiene etapas después (el embarque despachado) **no** lleva
`closes`; solo la cancelación. Una operación que cambia el estado fijo se
declara en el hito **anterior** al cambio (la salida del embarque es de «Por
confirmar»), porque `assertStagesDone` se pregunta antes de escribirla.

### Documentos de hoy

| Documento | Módulo | Hitos | Operaciones | ADR |
| --- | --- | --- | --- | --- |
| `inventory.shipment` «Embarque» | Inventario | `DRAFT`, `SHIPPED`, `CANCELLED` (cierra) | `inventory.shipment.dispatched` «Salida confirmada» (en `DRAFT`, `leadsTo` `SHIPPED`) | 0071 |

## Quién hace qué

- Configurar: `platform.organization.update`, ver toda la empresa
  (`seesWholeCompany`) y el módulo del documento activo. Un área solo
  admite roles que hacen etapas y leen el documento (se revisa otra vez al
  publicar).
- Hacer una etapa: membresía activa, `platform.process.work`, ser titular o
  tener un rol **vigente** del área (`activeRoles`: un rol ligado a un
  módulo cuenta solo con su módulo activo), leer el documento
  (`readPermission`), alcanzar su almacén (o su zona si la etapa es «solo en
  su zona») y el módulo activo. Para quien no lee el documento o no alcanza
  su almacén, el proceso «no existe».
- Asignar y liberar lo de otra persona: `platform.process.assign`, con el
  alcance de zona de la etapa; queda en el rastro quién la tenía y se le
  avisa.
- Terminal con PIN: conserva `platform.process.work`, nunca asigna.
  Soporte de plataforma solo ve. La API no ofrece nada.
- Plan vencido: todo se ve y nada se hace ni se configura.

## Tablas

`process_definition`, `process_version` (una en borrador y una publicada por
definición; publicada no cambia), `process_stage` y `process_stage_role`
(solo cambian en borrador, disparadores), `process_progress` (documento y
versión fijos), `process_stage_state` (derivado por `settleStates`, nunca a
mano; transiciones en `STAGE_STATE_TRANSITIONS` y su disparador) y
`process_step` (rastro inmutable, con `previousUserId` al reasignar). Las fotos de un paso son
`evidence_photo.processStepId` (propósito `process_step_photo`).

## Avisos

`processes.ready`: la etapa siguiente quedó lista para su área (por
permisos, roles vigentes con `ownerByRole: false` y lugar).
`processes.assigned`: a la persona a quien se asignó una etapa.

## Pantallas

Configuración › Procesos (`/configuracion/procesos`, solo si un módulo
activo declara documentos), el editor `/configuracion/procesos/[clave]`, la
pantalla del proceso `/procesos/[id]` (componente `ProcessPanel`, que cada
documento puede poner en su ficha) y el bloque de etapas en `/tareas`.

## Pendientes

Autorización por etapa, avisos a otros roles además del área, tiempos por
etapa (WMS-33), vista de toda la cadena, «Seguimiento» con filtro por etapa,
órdenes de compra, pedidos y traslados.

De la segunda revisión (2026-11-16): la vista lee el equipo en cada visita
con etapas pendientes (costo); quien solo hace etapas ve en `/tareas` los
textos vacíos de traslados y el aviso de solo lectura de Inventario; quien
está limitado a otra zona ve la etapa pero recibe «no existe» al actuar; el
aviso de reasignación va por `userIds` y no revalida el alcance (pendiente
de WMS-39B); el motor no comprueba que el módulo use `LOCKING_TRANSACTION`.

Transiciones en la base: `PROGRESS_TRANSITIONS` (`ACTIVE → DONE | CLOSED`,
nace `ACTIVE`, nunca se reabre) y `STAGE_STATE_TRANSITIONS` (regresar solo
en etapas manuales), cada una con su disparador.

## ADR

0069 (motor de procesos), 0071 (procesos en embarques), 0057 (avisos), 0062 (roles ligados a módulos),
0063 (fotos de evidencia).
