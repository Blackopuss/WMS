# Revisión de amenazas — motor de procesos (WMS-74)

Fecha: 2026-11-16. Complementa el ADR 0069, `REVISION_FOTOS.md` (fotos de
evidencia) y la revisión de aprobaciones (ADR 0053). Hecha por la misma IA
que implementó el paso y corregida tras la revisión independiente (ver abajo).

## Qué se agregó

- Tablas `process_*` por empresa, con disparadores: una versión publicada
  no cambia, las etapas solo cambian en borrador, un documento queda ligado
  a su versión, el rastro (`process_step`) no cambia ni se borra.
- Servicios de plataforma para los módulos (con su transacción) y para las
  personas (tomar, terminar, liberar, asignar, saltar, regresar) bajo el
  candado del progreso.
- Dos permisos: `platform.process.work` y `platform.process.assign`.
- Fotos de un paso (propósito `process_step_photo`) con dueño
  `evidence_photo.processStepId` y su función en `EvidenceOwners`.
- Avisos `processes.ready` y `processes.assigned`.
- Cambio transversal: `memberReaches` filtra `to.roles` por los **roles
  vigentes** (`activeRoles`), y `notify` acepta `ownerByRole: false`.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Avanzar una etapa de otra empresa adivinando su id | El cliente de empresa filtra toda lectura; el candado (`lockRows`) solo encuentra filas de la empresa; sin fila, «no existe» | `processes.int.test.ts` («another company never sees nor touches a process»), `two-companies.int.test.ts` |
| Ver o hacer etapas de un documento que la persona no puede leer o de un almacén fuera de su alcance | `readsDocument` (permiso de lectura del documento + almacén en alcance) antes de todo; si falla, «no existe»; las listas filtran por almacén y, en etapas de zona, por zona | `processes.int.test.ts` («only who reaches the warehouse or the zone…») |
| Que alguien fuera del área haga la etapa (o un rol ligado sin su módulo) | `mayWork`: `platform.process.work` + titular o rol **vigente** del área + alcance; se lee bajo el candado con el `tx` y los módulos de la empresa | `processes.int.test.ts` («only the area works a stage…», «a tied role without its module neither hears nor works») |
| Saltarse el candado de etapas (completar una etapa o registrar la operación ligada antes de tiempo) | El estado lo deriva `settleStates` bajo el candado del progreso en cada acción; `assertStagesDone` en la transacción del módulo; `completeOperationStage` lanza si faltan etapas y todo se revierte | `rules.test.ts`, `processes.int.test.ts` («the lock…», «operations wait for earlier stages of the same document only») |
| Dos personas toman o terminan la misma etapa a la vez | Candado del progreso (`SELECT … FOR UPDATE`, READ COMMITTED) y lectura después del candado | `processes.int.test.ts` (`Promise.all` sobre `takeStage`) |
| Reintento que duplica un paso o reutiliza una clave para otra cosa | Clave de confirmación única por empresa en `process_step`; misma persona, etapa y acción = `repeated`; otra = `key_reused` | `processes.int.test.ts` («a retry answers repeated…») |
| Borrar o alterar el rastro, o cambiar una versión publicada | Disparadores sin cambio ni baja en `process_step`; etapas y roles solo en borrador; versión publicada solo pasa a retirada | `processes.int.test.ts` (intentos directos con el cliente de la base) |
| Cambiar el proceso de lo que ya empezó | `process_progress.versionId` inmutable (disparador); publicar no toca progresos | `processes.int.test.ts` («a new version is for new documents…») |
| Asignar una etapa a alguien que no puede hacerla, o desde una terminal | `assignStage` exige `platform.process.assign` (que una sesión de PIN pierde) y comprueba a la persona elegida con `mayWork` | `processes.int.test.ts` («who leads assigns…», «at a shared terminal…»), `policy.test.ts` |
| Soporte de plataforma o una llave de la API actúan | Soporte no tiene membresía (`memberIn` devuelve null) y solo tiene lecturas; `platform.*` no está en `API_CAPABILITIES` | `policy.test.ts`, `capabilities.test.ts` |
| Trabajar con el plan vencido | El módulo del documento debe estar activo para actuar y configurar (los permisos de plataforma no dependen del plan) | `processes.int.test.ts` («with the plan expired…») |
| Aviso del relevo a quien no debe (otra área, otro almacén, rol ligado sin módulo, titular en cada relevo) | `notify` por permisos + roles vigentes + lugar, `ownerByRole: false` | `processes.int.test.ts` (destinatarios exactos en cada caso) |
| Foto de un paso vista por quien no lee el documento | `process_step` en `EvidenceOwners` con `processStepReach` (permiso de lectura del documento + almacén); sin la función, la foto no existe | `processes.int.test.ts` («a photo of a step is evidence…») |
| JSON enorme o malformado en el editor | Tope de 100 000 caracteres en la acción, Zod con topes (30 etapas, 10 subetapas, 60 caracteres) y `checkDraft` contra el documento | `processes.int.test.ts` («checks the draft…»), `rules.test.ts` |
| Texto del navegador guardado tal cual (dispositivo) | Solo se guarda la descripción de `describeUserAgent`, nunca el texto crudo | `processes.int.test.ts` (dispositivo del rastro) |

## Hallazgos de la revisión independiente (2026-11-16) y corrección

| Hallazgo | Corrección | Prueba |
| --- | --- | --- |
| M1: un área con roles que no pueden hacer etapas detenía el documento | Solo roles con `platform.process.work` y la lectura del documento; publicar revalida; la pantalla avisa «Nadie de tu equipo puede hacer esta etapa» | `processes.int.test.ts` («an area takes only roles…») |
| M2: Inspector y Encargado no veían sus etapas | «Tareas», su menú e Inicio con `platform.process.work` (solo mientras haya documentos con procesos), sin dar nada de tareas de almacén | `navigation.int.test.ts` |
| B1: reasignar no dejaba rastro de quién la tenía | `process_step.previousUserId` y aviso a esa persona | «reassigning keeps who had it…» |
| B2: misma clave en dos procesos a la vez terminaba en error | Choque de la llave única capturado como `key_reused` | «the same confirmation on two processes…» |
| B3: quien asigna no respetaba la zona | `mayAssign` aplica la zona; fuera de ella la etapa no existe | «who assigns is limited by zone too» |
| B4: guardar y publicar en dos transacciones | Una sola transacción | — (mismo servicio) |
| B5: `mayDecide` de aprobaciones con roles conocidos y el aviso con roles vigentes | Las dos con `activeRoles` | `approvals.int.test.ts` («a tied role without its module…») |
| B6: historial sin aviso de truncado y una consulta por foto | Cuenta de pasos anteriores; fotos en una consulta (`evidencePhotoLinksOf`) tras decidir el alcance una vez | «the trail says when it shows only the latest steps» |
| B7: módulo ausente mostraba el proceso | `NoModuleState` (con el módulo quitado queda en solo lectura) | «without the module of the document…» |
| N3: estados de etapa sin regla en la base | `STAGE_STATE_TRANSITIONS` y disparador; nada cambia con el proceso terminado | «the base keeps the states of a stage…» |
| N4: cualquiera con el permiso subía fotos | Solo para una etapa por hacer que la persona puede hacer y que pide foto | «a photo of a step is evidence…» |
| N5: terminal leída dentro de la transacción | Se lee antes de abrirla | — |
| N6: un administrador limitado a un almacén configuraba procesos | Exige `seesWholeCompany` | «who is limited to a warehouse…» |

Segunda vuelta (2026-11-16): `process_progress` con transiciones en la
base (nace activo, termina una vez, no se reabre); regresar solo etapas
manuales también en el disparador; `evidencePhotoLinksOf` firma solo lo
que el dueño confirma (`ReachesMany`, falla cerrado); el choque de clave
responde `key_reused` solo si chocó el índice de la clave. Pruebas en
`processes.int.test.ts` y `rules.test.ts`.

## Riesgos aceptados y pendientes

- «App instalada» del rastro lo dice el navegador: es informativo.
- Si el único rol de un área deja de existir para la empresa o nadie alcanza
  la etapa, el pendiente espera; el titular siempre puede hacerlo.
- Autorización por etapa, avisos a otros roles y procesos en embarques,
  compras y traslados llegan en pasos posteriores.
