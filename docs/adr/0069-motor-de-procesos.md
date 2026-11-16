# ADR 0069 — Motor de procesos de la empresa: etapas, candado y relevo

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-74 · Completa ADR 0053
(aprobaciones, como modelo de motor de plataforma), ADR 0057 (avisos),
ADR 0062 (roles de producción y calidad), ADR 0063 (fotos de evidencia) y
ADR 0038 (alcance) · Prepara WMS-28 (orden de producción), WMS-29 (lote
producido), WMS-30B (verificación) y WMS-74B (embarques)

## Contexto

El fundador pidió (D10, P9, P10, P10b, P11; propuesta
`docs/flujos/PRODUCCION_CALIDAD.md`, sección 6) que cada empresa defina sus
**procesos**: etapas y subetapas por documento, encima de los estados fijos
que protegen las existencias, con **candado** (una etapa no avanza si la
anterior no está hecha, dentro del mismo documento) y **relevo** (al terminar
una etapa, el trabajo le cae solo a la siguiente área). Lo empezado termina
con su versión; lo nuevo usa la nueva.

Hoy ningún módulo tiene un documento que lo use: la orden de producción y el
lote producido llegan con WMS-28 y WMS-29. Este paso deja el motor, su
configuración, sus pantallas y su contrato, probados con un documento de
prueba.

## Flujo operativo

1. **La empresa configura** (Configuración › Procesos; titular y
   administración, `platform.organization.update`, con el módulo del
   documento activo). Por cada documento que declaran sus módulos ve los
   **hitos** fijos del documento (renglones grises, en su orden) y escribe su
   borrador: etapas en orden, cada una ligada a un hito, **manual** (se
   completa con un botón) o **de operación** (se marca sola cuando ocurre una
   operación que el módulo ofrece), con **subetapas** opcionales (en orden o
   en cualquier orden), **área** (roles del catálogo; «solo en su zona»
   opcional), **evidencia** (nota, foto y cantidad, cada una nada, opcional u
   obligatoria), si se puede **saltar** con motivo y si se puede **regresar**
   a la anterior con motivo. «Guardar borrador» no cambia nada para nadie;
   **«Publicar»** convierte el borrador en la versión vigente (la anterior
   queda retirada, nunca se borra). Publicar sin etapas apaga el proceso para
   los documentos nuevos. Cada publicación deja bitácora
   (`process.published`).
2. **Nace un documento** (una orden, un lote): su módulo llama
   `startProcess` dentro de su transacción. Si hay versión publicada con
   etapas, el documento queda ligado **a esa versión para siempre** (P11) y
   las etapas que ya pueden hacerse se vuelven pendientes. Sin proceso, nada
   cambia.
3. **El relevo.** Cuando una etapa **manual** queda lista (las anteriores
   hechas o saltadas y el documento ya en su hito), es un **pendiente de
   proceso** para su área: avisa (`notify`) a quien puede hacerla y aparece
   en «Mis tareas › Disponibles» junto a las tareas de almacén, sin ser una
   (`warehouse_task` mueve existencias; un pendiente no). Una etapa de
   operación no crea pendiente: espera a la operación del módulo.
4. **Tomar, asignar, liberar.** Alguien del área la **toma** (solo uno, bajo
   candado) y la ve en «Mis tareas»; quien manda (`platform.process.assign`)
   la **asigna** a una persona del área; quien la tiene (o quien asigna) la
   **libera** y regresa a Disponibles.
5. **Completar** (teléfono o tableta, botón grande «Terminar: Lijado»): pide
   la evidencia que la etapa exija (nota, hasta 5 fotos, cantidad). Si nadie
   la había tomado, completarla la toma. Al quedar hecha, la siguiente se
   vuelve pendiente y avisa a su área.
6. **Saltar** (si la etapa lo permite, solo manuales, motivo obligatorio):
   cuenta como hecha para el candado. **Regresar** (si la etapa lo permite,
   motivo obligatorio): la etapa manual anterior vuelve a quedar pendiente
   para su área, con aviso; una etapa de operación no se regresa (la
   operación ya pasó).
7. **Candado de operaciones** (P10, P10b): antes de una operación ligada a
   una etapa (la verificación de Calidad, WMS-30B), el módulo llama
   `assertStagesDone`; si falta una etapa anterior **del mismo documento**,
   la operación se rechaza con «Esperando: Secado (Producción)». Nunca
   compara documentos entre sí: un lote listo no espera a otro.
8. **Rastro**: cada paso (completó, saltó, regresó, tomó, liberó, asignó,
   operación) queda inmutable con quién, cuándo, dispositivo
   (`describeUserAgent`, nunca el texto crudo), nota, cantidad y fotos.
9. **Avanzar una etapa nunca mueve existencias ni cambia el estado fijo del
   documento.**

## Modelo de datos

Todas las tablas son de empresa (`organizationId`, llaves compuestas,
`TENANT_MODELS`).

- `process_definition`: una por documento y empresa (`documentKey`, único).
- `process_version`: número consecutivo por definición y estado `DRAFT →
  PUBLISHED → RETIRED` (tabla `PROCESS_VERSION_TRANSITIONS` y disparador
  `process_version_transition`, que cambian juntos). Una sola en borrador y
  una sola publicada por definición (`draftKey` y `currentKey`, únicos y
  llenados por el servicio; `CHECK` que los liga al estado).
- `process_stage`: etapa o subetapa de una versión (`parentStageId`, dos
  niveles), posición, nombre (60), clase, operación, hito, orden de
  subetapas, evidencia, saltar, regresar, «solo en su zona».
  `process_stage_role`: los roles de su área. **Solo se escriben mientras su
  versión es borrador** (disparadores de alta, cambio y baja): una versión
  publicada no cambia nunca. Guardar el borrador reemplaza sus etapas.
- `process_progress`: el proceso de un documento (`documentKey` +
  `documentId`, único), su versión, su almacén y ubicación (para alcance y
  zona), su hito actual, su texto («LP-0001») y su estado `ACTIVE → DONE |
  CLOSED`. La versión y el documento no cambian (disparador).
- `process_stage_state`: una fila por **etapa de trabajo** (las que no
  tienen subetapas; una etapa con subetapas queda hecha cuando todas lo
  están): `WAITING`, `READY`, `DONE`, `SKIPPED`, quién la tiene y quién la
  asignó. Los estados los deriva una sola función pura (`settleStates`,
  `rules.ts`) cada vez que algo cambia; nunca se escriben a mano. Sus
  transiciones son `STAGE_STATE_TRANSITIONS` (`states.ts`: `WAITING ↔
  READY`, `READY → DONE | SKIPPED`, `DONE | SKIPPED → WAITING` al regresar)
  y el disparador `process_stage_state_keep` las repite; una fila nace en
  `WAITING`, solo una etapa manual se salta y nada cambia ni se registra
  con el proceso terminado o cerrado.
- `process_step`: rastro inmutable (disparadores sin cambio ni baja), con
  clave de confirmación única por empresa y, al asignar o liberar, quién
  la tenía antes (`previousUserId`).
- `evidence_photo.processStepId` (nuevo dueño de fotos, propósito
  `process_step_photo`, con su `CHECK` de un solo dueño y de propósito).

Topes: 30 etapas por proceso, 10 subetapas por etapa, 60 caracteres por
nombre, nota de 500, 5 fotos por paso, 50 avisos.

## Registro: cómo un módulo declara sus documentos

`src/modules/registry/processes.ts` exporta `processDocuments`, validado al
arrancar con `assertValidProcessDocuments`. **Hoy está vacío.** Un módulo
declara un `ProcessDocument`:

```ts
{
  key: "production.batch",          // modulo.cosa
  module: "production",            // debe estar activo para trabajar
  label: "Lote producido",
  milestones: [                     // estados fijos, en orden
    { key: "INSPECTION", label: "En inspección" },
    { key: "CLOSED", label: "Cerrado" },
    { key: "CANCELLED", label: "Cancelado", closes: true },
  ],
  operations: [                     // lo que puede ser etapa de operación
    { key: "quality.decided", label: "Calidad decidió", milestone: "INSPECTION" },
  ],
  readPermission: "production.order.read",
  href: (documentId) => `/produccion/lotes/${documentId}`,
}
```

El almacén y la ubicación los da el módulo al empezar el proceso y cuando
cambian (`setProcessPlace`): el motor no lee tablas de módulos.

## Contrato para WMS-28, WMS-29 y WMS-30B

Todos reciben el cliente `tx` de la transacción del módulo y el
`ProcessDocument` del módulo. **El módulo abre esa transacción con
`LOCKING_TRANSACTION`** (READ COMMITTED): el motor bloquea el progreso y
decide con lo que lee después del candado.

- `startProcess(tx, doc, actor, { documentId, facilityId, locationId?,
  label, milestone })` → `{ started: boolean; progressId: string | null }`.
  **Después de insertar el documento** y de sus candados. Repetido no
  duplica.
- `reachMilestone(tx, doc, actor, documentId, milestone)` → después de
  escribir el cambio de estado fijo. Sin proceso, no hace nada. Un hito
  `closes` cierra el proceso (sus pendientes desaparecen). Avisa lo que
  quedó listo.
- `setProcessPlace(tx, doc, documentId, { facilityId, locationId })` cuando
  el documento cambia de lugar.
- `assertStagesDone(tx, doc, documentId, operationKey)` → `{ ok: true } |
  { ok: false, reason: "stages_pending", message }`. **Antes de escribir la
  operación** y después de los candados del módulo; bloquea el progreso.
  Si el proceso no tiene esa operación como etapa, responde `ok: true`.
- `completeOperationStage(tx, doc, actor, documentId, operationKey)` →
  `{ applied: boolean }`, **después de las escrituras de la operación**.
  Lanza `ProcessStagesPending` si faltan etapas anteriores **o si el
  documento todavía no llega al hito de esa etapa**: si la operación cambia
  el estado fijo del documento, el módulo llama `reachMilestone` **antes**,
  en la misma transacción. Es un error de programación: todo se revierte.

Orden en la transacción del módulo: candados del módulo (productos →
ubicaciones → documento) → `assertStagesDone` → escrituras de la operación →
`reachMilestone` (si cambió el estado) → `completeOperationStage`. Los avisos
del motor van al final, dentro de la misma transacción.

## Orden de candados

**Documento del módulo → progreso → archivos de las fotos.** El motor solo
bloquea la fila de `process_progress` (con `lockRows`) y, al ligar fotos,
las de `stored_file`. Las acciones de las personas (completar, tomar,
saltar…) bloquean solo el progreso: nunca toman un candado de un documento de
módulo, así que no hay ciclo con las transacciones de los módulos. Configurar
bloquea la fila de la definición; publicar no toca progresos (lo empezado
sigue con su versión).

## Decisiones

- **Permisos nuevos** (matriz y catálogo):
  - `platform.process.work` «Hacer etapas de procesos»: tomar, completar,
    liberar la propia, saltar y regresar (si la etapa lo permite) y subir sus
    fotos. Titular, Administrador, Almacén, Supervisor de almacén,
    Almacenista, Operario de producción, Encargado de producción e Inspector
    de calidad. **No** Consulta ni Gerencia (solo leen), **ni Montacarguista
    ni Comprador** en esta entrega (el Montacarguista solo lee, hace sus
    tareas y reporta incidencias por decisión del fundador; las etapas de
    embarques y compras llegan con WMS-74B y después: el fundador puede
    cambiarlo).
  - `platform.process.assign` «Asignar etapas de procesos»: titular,
    Administrador, Almacén, Supervisor de almacén y Encargado de producción.
- **Actuar sobre una etapa** exige, todo leído bajo el candado del progreso:
  membresía activa; `platform.process.work`; ser titular o tener uno de los
  roles del área **vigente** (un rol ligado a un módulo cuenta solo con su
  módulo activo); el permiso de lectura del documento; alcanzar su almacén
  (o su ubicación, si la etapa es «solo en su zona»); y el módulo del
  documento **activo**. Para quien no lee el documento o no lo alcanza, el
  proceso «no existe».
- **Asignar** exige `platform.process.assign`, leer y alcanzar el documento y
  el módulo activo; la persona elegida debe cumplir todo lo de «actuar».
  Liberar una etapa tomada por otra persona también lo exige.
- **Terminal compartida con PIN**: `platform.process.work` entra en
  `TERMINAL_PLATFORM_KEEP` (es trabajo de piso); `platform.process.assign` y
  configurar no.
- **Soporte de plataforma**: solo lecturas (PIL-12), así que ve la línea de
  etapas y el rastro del documento que alcanza, y no actúa.
- **API**: nada nuevo (`API_CAPABILITIES` no admite `platform.*`).
- **Plan vencido o módulo quitado** (módulo del documento en solo lectura):
  todo se puede ver y nada se puede hacer ni configurar; el motor lo
  comprueba con el estado del módulo (los permisos de plataforma no dependen
  del plan).
- **Aviso del relevo**: tipo `processes.ready`, por `permissions`
  (`platform.process.work` y la lectura del documento) **más** `roles` del
  área y el lugar (almacén, o ubicación si es «solo en su zona»). Para que un
  rol ligado a un módulo sin ese módulo activo no reciba avisos por su rol
  (regla de WMS-59), `memberReaches` compara `to.roles` con los **roles
  vigentes** (`activeRoles` de la política), y se prueba. **El titular**
  puede hacer cualquier etapa (desde la pantalla del documento), pero el
  relevo y «Disponibles» le llegan solo por sus propios roles (opción nueva
  `ownerByRole: false` de `notify`): si no, recibiría cada relevo de la
  empresa. Asignar avisa a la persona (`processes.assigned`).
- **Roles de un área** (hallazgo M1 de la revisión): el editor ofrece y el
  servicio acepta solo roles que en esa empresa tienen
  `platform.process.work` **y** el permiso de lectura del documento (un rol
  ligado, solo con su módulo activo); publicar los vuelve a comprobar.
- **Si un rol del área deja de existir para la empresa o nadie alcanza la
  etapa**: el pendiente sigue ahí (no se pierde ni se salta solo); el
  titular siempre puede hacerlo, la pantalla del documento dice «Nadie de
  tu equipo puede hacer esta etapa» (sin contar al titular) y quien
  configura puede publicar otra versión para los documentos nuevos. Lo
  empezado no cambia de versión.
- **Quien asigna** también está limitado por zona en las etapas «solo en
  su zona»: fuera de su alcance la etapa no existe para él. Asignar a otra
  persona o liberar lo de alguien deja en el rastro quién la tenía y le
  avisa (`processes.assigned`).
- **Configurar procesos es de toda la empresa**: además de
  `platform.organization.update`, exige no estar limitado a almacenes
  (`seesWholeCompany`), como los tipos de equipo y los webhooks. Guardar y
  publicar desde la pantalla es una sola transacción.
- **Tareas e Inicio**: quien tiene `platform.process.work` ve «Tareas»
  (solo sus etapas si no tiene permiso de tareas de almacén) y los números
  de «Para hoy», mientras algún módulo activo declare documentos.
- **Fotos de un paso**: se suben solo para una etapa por hacer que la
  persona puede hacer y que pide foto.
- **Etapas de operación**: no se saltan ni se regresan; no crean pendiente.
  Su operación se rechaza mientras falten anteriores (`assertStagesDone`).
- **Fuera de esta entrega** (6.8): autorización por etapa, avisos a otros
  roles además del área, embarques (WMS-74B), órdenes de compra, pedidos,
  traslados, tiempos por etapa (WMS-33) y la vista de toda la cadena.

## Pantallas

- Configuración › **Procesos** (`/configuracion/procesos`): aparece solo si
  algún módulo activo declara documentos; hoy no aparece.
- Componente `ProcessLine` (línea de etapas, botón grande del siguiente paso,
  «Esperando: <etapa> (<área>)» y el rastro), que cada documento pone en su
  pantalla; la pantalla genérica `/procesos/[id]` lo muestra para un
  pendiente.
- En `/tareas`, «Mis tareas» y «Disponibles» suman los pendientes de proceso
  (bloque propio, mismo patrón de fila) solo si la persona tiene alguno.

## Consecuencias

- Un módulo nuevo con proceso declara su documento y llama los cinco
  servicios en los puntos de arriba; no escribe tablas del motor.
- Toda fila de `process_*` se escribe solo desde `src/platform/processes`.
- Pendiente: autorización por etapa, avisos a otros roles, tiempos, vista
  de cadena, «Seguimiento» con filtro por etapa, un ajuste por empresa para
  que el Montacarguista o el Comprador hagan etapas.
- Pendiente (segunda revisión, 2026-11-16): `getProcessView` lee el equipo
  (`eligiblePeople`) en cada vista con etapas pendientes, un costo que
  crece con el equipo; quien solo hace etapas ve en `/tareas` los textos
  vacíos de traslados y el aviso de solo lectura de Inventario; quien está
  limitado a otra zona ve la etapa en la vista pero recibe «no existe» al
  actuar; el aviso de reasignación va por `userIds` y no revalida el
  alcance (el mismo pendiente de WMS-39B); el aislamiento del contrato
  (transacción con `LOCKING_TRANSACTION`) está escrito pero el motor no lo
  impone.
