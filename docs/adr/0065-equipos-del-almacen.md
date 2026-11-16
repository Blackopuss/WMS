# ADR 0065 — Equipos del almacén: registro, mantenimiento, incidencias y tareas

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-42 (transversal, «corazón»
porque toca tareas) · Usa ADR 0057 (avisos e incidencias), ADR 0038
(alcance por almacén y zona), ADR 0034 (ajustes de operación), ADR 0047
(etiquetas) · Toca las tareas de traslado (WMS-06/07) sin cambiar cómo
mueven existencias, sus reservas ni su tabla de estados.

## Contexto

La especificación (5.3, roles) habla de tareas de montacargas, y el
fundador pidió el 2026-11-16 una primera entrega de equipos con **registro y
tareas**: registro de equipos (el tipo lo pone cada empresa), mantenimiento
e incidencias, y que una tarea pueda pedir un tipo de equipo y quien la toma
diga cuál usa.

Hoy un montacargas descompuesto se reporta como incidencia «Equipo
descompuesto» sin saber cuál es, nadie sabe cuándo le toca mantenimiento y
una tarea de traslado no puede decir «esta va con montacargas». Tampoco
queda rastro de qué equipo movió qué.

## Flujo operativo

### Registro (Configuración › Equipos del almacén, escritorio)

1. Quien administra el almacén (titular, Administración, Almacén,
   Supervisión: `inventory.equipment.manage`) define los **tipos** de su
   empresa en «Tipos de equipo» (nombre libre: «Montacargas», «Patín
   eléctrico», «Báscula de piso»…; nada viene sembrado). Un tipo no se
   borra: se archiva y deja de ofrecerse; los equipos que ya lo tienen lo
   conservan.
2. Registra cada **equipo** en el almacén activo: código (lo que se escanea,
   único en la empresa, en mayúsculas: `MC-01`), nombre, tipo y, si se sabe,
   la fecha del próximo mantenimiento. Nace «en servicio». La etiqueta se
   imprime desde su ficha con el mecanismo de WMS-26 (tipo `equipo`: Code 128
   y QR del código).
3. Desde la ficha se edita (código, nombre, tipo, próximo mantenimiento;
   el tipo solo si no está en una tarea abierta; **el almacén no cambia**:
   trasladar un equipo entre almacenes queda pendiente), se
   deja **fuera de servicio** con motivo, se vuelve a poner **en servicio**,
   se registra un mantenimiento y se **da de baja** con motivo (no se borra;
   no si está en una tarea abierta). Todo deja bitácora.

### Mantenimiento

1. Quien administra registra un mantenimiento hecho: día, qué se hizo,
   quién lo hizo (texto libre opcional: un taller externo; si no, la persona
   que lo registra) y, opcional, el siguiente día de mantenimiento. El
   registro es inmutable (disparador) y actualiza `maintenanceDueOn` del
   equipo en la misma transacción.
2. **Aviso.** La ronda horaria `inventory.equipment_maintenance` avisa
   dentro de la app (WMS-39) a quien administra equipos en ese almacén
   cuando el mantenimiento entra en la ventana de la empresa (ajuste
   `inventory.equipment.maintenance_notice`: 3, 7 por omisión, 15 o 30 días
   antes) y otra vez cuando se pasó; una vez por equipo, día y fase (llave
   de deduplicación). Los equipos dados de baja no avisan.
3. Inicio muestra «N equipos piden atención» (mantenimiento vencido o por
   vencer, o fuera de servicio) solo a quien administra equipos y solo si
   hay alguno.
4. **Por uso (horas o kilómetros) queda pendiente:** exige capturar o leer
   un horómetro, que hoy no existe en el flujo; se decidirá con un caso real.

### Incidencias del equipo

1. Al reportar una incidencia (WMS-39) se puede escanear o escribir el
   código de un equipo del almacén activo que no esté dado de baja. El campo
   aparece solo si el almacén tiene equipos. La ficha del equipo lista sus
   incidencias y la de la incidencia enlaza al equipo.
2. **Si la incidencia es «Equipo descompuesto»** y nombra un equipo en
   servicio, el ajuste `inventory.equipment.on_broken_report` decide:
   - `stop` (por omisión): el equipo queda **fuera de servicio** en la misma
     transacción, con el motivo «INC-0007: …», y quien lo tiene en una tarea
     abierta recibe el aviso. Lo reporta cualquiera que pueda reportar
     incidencias, también el Montacarguista: **reportar no es administrar**;
     solo detiene una máquina que alguien del piso considera insegura, que es
     lo que pide la seguridad, y volverla a poner en servicio sigue siendo de
     quien administra, con rastro.
   - `notify`: el equipo sigue en servicio y quien atiende incidencias
     decide (aviso de siempre de la incidencia).
   El ajuste vale igual para quien administra equipos (una sola regla);
   quien administra puede además dejarlo fuera de servicio desde su ficha.
3. Resolver la incidencia no pone el equipo en servicio: eso se hace desde
   la ficha del equipo (una sola forma de hacerlo).

### Tareas que piden un tipo de equipo (piso, teléfono o terminal)

1. **Al crear** una tarea de traslado (`/tareas/nueva`) quien supervisa puede
   elegir «Pide equipo» entre los tipos con al menos un equipo (no dado de
   baja) en el almacén. El campo no aparece si no hay. El tipo pedido no
   cambia después (disparador). **Pedir por regla** (por ubicación, por tipo
   de tarea, en surtido, acomodo o reposición automáticos) **queda
   pendiente**: hoy solo la tarea creada a mano lo pide.
2. **En «Disponibles» y «Mis tareas»** la fila dice «Pide: Montacargas» y,
   una vez tomada, «Con MC-01». La tarea se ve para todos los que hoy la ven:
   tener un equipo no es un permiso.
3. **Al tomarla** («Tomar tarea») la pantalla pide el equipo: se escanea su
   etiqueta o se elige de la lista de los disponibles (del tipo pedido, del
   almacén de la tarea, en servicio y libres). Bajo el candado del equipo se
   comprueba todo otra vez. Si no hay uno disponible, no se toma: el mensaje
   lo dice («No hay un Montacargas libre en servicio»). Asignar una tarea a
   alguien no exige equipo: lo dice quien la toma.
4. **Un equipo con una persona a la vez:** puede estar en varias tareas
   abiertas (tomada, recogida o con problema) **de la misma persona** (un
   montacarguista hace varias seguidas), nunca en las de dos personas. Dos
   personas que lo intentan a la vez: el candado del equipo hace que la
   segunda lo encuentre ocupado («MC-01 lo está usando Ana en T-0012»).
5. **Fuera de servicio con tareas abiertas:** las tareas conservan su equipo
   y quien las tiene recibe un aviso. Mientras no se recoja la carga, «Ya
   recogí la carga» se rechaza y la persona **cambia de equipo** («Cambiar de
   equipo», mismo control que al tomarla). Una carga ya recogida se entrega o
   se reporta como siempre (nadie sabría dónde quedó la mercancía).
6. **Liberar** una tarea con problema le quita el equipo (quien la vuelva a
   tomar dice el suyo); **cancelarla** o **entregarla** lo deja fijo como
   rastro. Tomar varias a la vez (olas, `takeTasks`) salta las que piden
   equipo: se toman una por una; hoy ninguna tarea de surtido lo pide.
7. **Rastro:** `warehouse_task.equipmentId` queda fijo cuando la tarea se
   cierra; la reubicación que escribe la entrega ya enlaza la tarea (llave
   `task:<id>`). La ficha del equipo lista sus últimas tareas y la de la
   tarea dice con qué equipo se hizo. No se duplica en la bitácora.

### Una empresa que no registra equipos

No ve nada nuevo en tareas ni en incidencias: el campo de tipo al crear, el
de equipo al tomar y el de equipo al reportar solo existen si su almacén
tiene equipos. Lo único nuevo es el enlace «Equipos del almacén» en
Configuración para quien puede verlo, y sus dos ajustes, que viven en esa
pantalla y no en Operación.

## Decisiones

- **Tablas** (de empresa, en `TENANT_MODELS`, relaciones compuestas):
  `equipment_type` (nombre único en la empresa; `archivedAt`),
  `equipment` (almacén, tipo, código único en la empresa, nombre, estado
  `IN_SERVICE`/`OUT_OF_SERVICE` con motivo, quién y cuándo; baja con
  `retiredAt`, motivo y quién; `maintenanceDueOn` DATE),
  `equipment_maintenance` (inmutable). `warehouse_task` gana
  `equipmentTypeId` (inmutable) y `equipmentId`; `incident` gana
  `equipmentId`. Migración solo de expansión.
- **Disparadores:** `warehouse_task_equipment` (al insertar, sin equipo;
  el tipo pedido nunca cambia; el equipo solo cambia al pasar a `ACCEPTED`
  o mientras sigue `ACCEPTED`, o queda en blanco al volver a `PENDING`; si
  hay equipo, es del tipo pedido y del almacén del origen; una tarea que
  pide tipo y está tomada, recogida o entregada tiene equipo),
  `equipment_maintenance` sin cambios ni borrados, `equipment` y
  `equipment_type` sin borrados; un equipo no cambia de almacén ni cambia
  nada después de su baja (`equipment_fixed`). La incidencia apunta a su
  equipo con la llave compuesta empresa + almacén + equipo: siempre es uno
  de su almacén. La tabla de estados de la tarea
  (`WAREHOUSE_TASK_TRANSITIONS` y su disparador) **no cambia**.
- **Servicios** solo en `src/modules/inventory/equipment.ts` (registro,
  estado, baja, tipos, mantenimiento, lecturas, ronda) y en `tasks.ts` lo de
  la tarea (`acceptTask` con `equipmentCode`, `changeTaskEquipment`,
  comprobación en `pickUpTask`). Reglas puras (código, en uso) en
  `equipment-rules.ts`.
- **Candados.** Tomar, cambiar de equipo y recoger: (productos →) pedido →
  tarea → **equipo** (`lockRows(tx, "equipment", …)`, `LOCKING_TRANSACTION`).
  Lo que cambia un equipo (estado, baja, edición, mantenimiento) bloquea
  **solo el equipo** y después **lee** sus tareas abiertas sin bloquearlas.
  Reportar una incidencia bloquea solo el equipo. Nadie bloquea una tarea
  después de un equipo, así que no hay ciclo con el orden de `AGENTS.md`
  (productos → ubicaciones → documento → contenedor → tarea → capacidad):
  el equipo entra después de la tarea y antes de la capacidad, y la toma de
  una tarea no escribe existencias ni toca capacidad.
- **Permisos** (matriz y catálogo): `inventory.equipment.read` (titular,
  Administración, Almacén, Consulta, Supervisión, Gerencia) e
  `inventory.equipment.manage` (titular, Administración, Almacén,
  Supervisión). El Almacenista y el Montacarguista no reciben permisos
  nuevos: eligen equipo con `inventory.task.execute` y reportan fallas con
  `inventory.incident.create`. Compras no ve equipos.
- **Alcance:** un equipo es de un almacén. Lo ve quien alcanza ese almacén
  (`isFacilityInScope`); lo administra quien tiene el almacén entero
  (`assertWholeFacilityInScope`), como los niveles: un montacargas recorre
  todas las zonas. Fuera del alcance «no existe». Las listas son del
  almacén activo.
- **Ajustes** (`EQUIPMENT_SETTINGS`, en la pantalla de equipos):
  `inventory.equipment.maintenance_notice` (`7`) e
  `inventory.equipment.on_broken_report` (`stop`).
- **Avisos:** `inventory.equipment_maintenance` (a `inventory.equipment.manage`
  del almacén) e `inventory.equipment_out_of_service` (a quien tiene el
  equipo en una tarea abierta).
- **API:** sin cambios (las respuestas de tareas pasan por su esquema y no
  agregan campos).

## Revisión (2026-11-16)

Lo que cambió tras la revisión independiente:

- **Ficha dentro del alcance.** Quien está limitado a zonas ve en la ficha
  de un equipo solo las incidencias sin ubicación o de su zona, y solo las
  tareas cuyo origen y destino alcanza; si el equipo está ocupado en una
  tarea de fuera, la ficha y la lista dicen «Otra persona», sin nombre ni
  número. Lo mismo al tomar una tarea con un equipo ocupado fuera de su
  zona: «lo está usando otra persona».
- **Los tipos son de toda la empresa.** Agregarlos, renombrarlos o
  archivarlos exige ver toda la empresa (`seesWholeCompany`); quien está
  limitado a almacenes los lee y su conteo de equipos es solo de los
  almacenes que alcanza. Los cambios de tipos van uno tras otro bajo el
  candado de la fila del almacén principal (es el candado de empresa de esta
  tabla; ahí se cuenta el tope de 50 tipos en uso). Nada bloquea un tipo y
  después un almacén.
- **Tareas que se quedarían sin equipo.** Dar de baja o cambiar de tipo el
  último equipo de un tipo en su almacén, con tareas pendientes (disponibles
  o asignadas) que piden ese tipo, se detiene con un aviso («2 tareas
  pendientes piden…») y solo sigue con la aceptación explícita
  (`acceptPendingTasks`, botón «… de todos modos»), como el aviso de entrada
  repetida (WMS-71). La ficha de una tarea así dice que nadie puede tomarla y
  ofrece cancelarla y crearla sin equipo.
- **Mantenimiento con clave de confirmación** (`equipment_maintenance.
  idempotencyKey`, única por empresa; migración aparte): un doble envío
  responde `repeated`. El próximo mantenimiento del equipo solo lo cambia el
  registro más reciente; uno más viejo capturado tarde no lo toca.
- **La ronda de mantenimiento va por páginas** (500 equipos por
  transacción, en orden de id): ninguno se queda sin aviso por haber muchos
  vencidos.
- **Persona desactivada.** Si quien tiene una tarea con el equipo se
  desactiva, la ficha del equipo lo dice («Ocupado por la tarea … de una
  persona desactivada») con el enlace a la tarea; liberarla o cancelarla
  sigue siendo de supervisión.

## Pendientes

- Mantenimiento por uso (horas, kilómetros).
- Pedir equipo por regla (ubicación, tipo de tarea) y en tareas creadas por
  el sistema (surtido, acomodo, reposición, olas).
- Decir el equipo en una tarea que no lo pide.
- Licencias o capacitación por persona y tipo de equipo (quién puede manejar
  qué).
- Fotos en el mantenimiento y en la incidencia (WMS-37).
- Capacidad de carga del equipo frente al peso de lo que se mueve.
- Liberar sola la tarea (y su equipo) de una persona que se desactiva:
  hoy solo se ve en la ficha del equipo.
- Trasladar un equipo a otro almacén (hoy su almacén no cambia: disparador
  y llave compuesta de la incidencia).
