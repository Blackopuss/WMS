# ADR 0092 — Automatizaciones configurables por empresa

Fecha: 2026-11-20 · Estado: aceptada (la acción «Bloquear» se programó tras
la respuesta de quien coordina, el mismo día) · Paso: WMS-64 · Se apoya
en WMS-56 (aprobaciones, ADR 0053), WMS-39/39B/88 (avisos, ADR 0057, 0060 y
0084), WMS-60 (API y webhooks, ADR 0058), WMS-49 (ajustes de operación,
ADR 0034), IMP-01 (cola de trabajos y rondas, ADR 0013), WMS-20 (alcance por
almacén, ADR 0038), WMS-76 (orden de candados, ADR 0074) y WMS-44 (empresa de
demostración, ADR 0089)

## Contexto

El plan v3 (Fase 4) pide «automatizaciones configurables por empresa: si pasa
X, hacer Y (avisar, crear tarea, bloquear)». Las instrucciones del fundador
(sección 11) piden que lo que varía entre empresas sea configuración y no
código, y que nada se construya sin definir antes su flujo operativo.

El sistema ya tiene casi todas las piezas:

- **Hechos publicados dentro de la transacción del hecho:**
  `emitWebhookEvent` (ADR 0058) se llama en cada servicio después de sus
  escrituras, con ids y cantidades como texto, sin costos ni nombres. Hoy
  publica cinco hechos: embarque despachado, ajuste aplicado, cambio de estado
  de existencias, recepción confirmada y recepción rechazada.
- **Estados derivados en cada consulta:** existencias bajas (`listLowStock`),
  lotes por caducar (`listExpiringLots`), tareas y pedidos con sus estados y
  fechas.
- **Actuar a nombre de una persona, recortada:** la delegación de una llave de
  la API (`runDelegated`, `Subject.limit`, ADR 0058) hace que los servicios de
  siempre actúen por quien la creó, limitados a ciertos permisos y a un
  almacén, y que pierdan lo que esa persona pierda.
- **Avisos** con tipos por módulo, alcance, preferencias y correo
  (`notify`); **cola de trabajos** idempotente con `onFailed`; **rondas**
  horarias (`scheduledRounds`).

Regla de fondo: **una automatización no es un camino nuevo para hacer cosas**.
Cada acción llama al mismo servicio que usa la pantalla, con sus validaciones,
candados y bitácora, a nombre de una persona y nunca con más poder que el de
esa persona.

## Flujo operativo

1. **Quién configura:** titular y Administración (`platform.organization.update`
   y ver toda la empresa, `seesWholeCompany`), desde el escritorio. Gerencia
   solo lee las reglas y su historial (permiso nuevo
   `platform.automation.read`). El piso no ve nada nuevo: recibe avisos,
   incidencias o conteos como siempre.
2. **Dónde:** Configuración › «Automatizaciones»
   (`/configuracion/automatizaciones`, `/nueva` y `/[id]`). No es sección del
   menú.
3. **Qué es una regla:** se lee como una frase.

   > **Cuando** un lote está por caducar, **en** Almacén Norte, **si** ya
   > caducó, **entonces** avisar a Supervisor de almacén y abrir una
   > incidencia «Producto caducado».

   Un **disparador** (del catálogo de abajo), un almacén o todos, de cero a
   tres **condiciones** del catálogo de ese disparador y de una a tres
   **acciones**. Nada de fórmulas, expresiones ni plantillas que se ejecuten:
   cada condición es un campo con opciones fijas o un número validado, y el
   único texto libre es una nota de hasta 200 caracteres que se copia tal cual
   (una línea, sin caracteres de control) al aviso o a la incidencia.
4. **Encender, apagar, archivar:** una regla nace encendida. Se apaga y se
   enciende con un botón; se archiva (no se borra) y una archivada no vuelve.
   Tope de 20 reglas sin archivar por empresa (`AUTOMATION_RULES_MAX`). Cada
   cambio (crear, editar, encender, apagar, archivar) deja bitácora.
5. **Qué pasa cuando ocurre algo:** el hecho solo deja un trabajo en la cola
   (si alguna regla encendida lo escucha); el worker evalúa las reglas, anota
   una **ejecución** por regla y hecho y corre sus acciones, cada una en su
   propia transacción, fuera de los candados de la operación que la originó.
6. **Historial:** la ficha de la regla muestra sus últimas 50 ejecuciones: qué
   pasó (una línea sin costos), qué hizo cada acción (con enlace a la
   incidencia o al conteo creado) o por qué no (plan vencido, sin permiso,
   tope por hora, el conteo ya estaba abierto…). Se conservan 90 días.

## Disparadores (catálogo inicial, 8)

Cada módulo declara los suyos en `automations.ts` (`AutomationTrigger`:
clave, módulo, etiqueta, ayuda, permiso de lectura de lo que describe,
condiciones, si es por almacén) y `src/modules/registry/automations.ts` los
junta. La plataforma no conoce módulos.

**Hechos** (reutilizan la clave del evento de webhook; el motor escucha la
misma emisión, no se agrega otra llamada en ningún servicio):

| Clave | Frase | Condiciones |
| --- | --- | --- |
| `inventory.stock_status.changed` | Cuando existencias cambian de estado | pasan a (estados), categoría del producto |
| `inventory.adjustment.applied` | Cuando se corrigen existencias | la diferencia es de al menos N (en la unidad del producto), categoría |
| `purchasing.receipt.confirmed` | Cuando llega mercancía de un proveedor | llega dañada, llega para inspeccionar |
| `purchasing.receipt.rejected` | Cuando se rechaza mercancía al recibir | — |

**Estados** (ronda `platform.automations` cada hora; leen con los servicios
que ya los derivan, como la persona de la regla):

| Clave | Frase | Condiciones | Se repite |
| --- | --- | --- | --- |
| `inventory.stock.low` | Cuando un producto queda en o bajo su mínimo | sin existencias (solo agotados), categoría | una vez al día por producto |
| `inventory.lot.expiring` | Cuando un lote está por caducar (según el aviso de caducidad de la empresa) | ya caducó | una vez por lote |
| `inventory.task.unclaimed` | Cuando una tarea sigue sin tomar | desde hace 2, 4, 8 o 24 horas; tipo de tarea | una vez por tarea |
| `inventory.outbound.late` | Cuando un pedido no salió en su día | — | una vez por pedido |

«Existencias bajas» es una cifra de toda la empresa (ADR 0038): ese disparador
solo admite «todos los almacenes». Los demás estados se revisan almacén por
almacén.

**Pendientes, a propósito:** calidad y producción (WMS-30B y WMS-92 están en
curso en otros chats: «inspección rechazada», «reporte con merma», «orden
atrasada»), «lleva N días en inspección», mantenimiento vencido (ya avisa su
ronda propia), incidencias y devoluciones (no publican hechos todavía). Un
disparador nuevo de un hecho necesita antes su evento (`emitWebhookEvent`).

## Acciones (catálogo inicial)

| Clave | Frase | Qué llama | Permiso que necesita la persona de la regla |
| --- | --- | --- | --- |
| `platform.notify` | Avisar a… (roles y hasta 5 personas) | `notify` con el tipo propio `automations.rule_fired` | ninguno extra (ver abajo) |
| `inventory.incident.open` | Abrir una incidencia (tipo) | `reportIncident` | `inventory.incident.create` |
| `inventory.count.open` | Abrir un conteo de la ubicación | `openCount` | `inventory.count.create` |
| `inventory.stock.block` | Bloquear el lote | `changeStockStatus` de «Disponible» a «Bloqueado» | `inventory.status.change` (y `inventory.stock.read`) |

- **Avisar:** el aviso dice el nombre de la regla, la línea del hecho y la
  nota. Se dirige con `permissions` = el permiso de lectura del disparador
  (más los roles elegidos) y el lugar del hecho (`facilityId`/`locationIds`),
  así que solo lo recibe quien podría ver eso en su pantalla y dentro de su
  alcance (ADR 0084); las personas elegidas pasan por el mismo filtro.
  Respeta preferencias y el correo opcional. Nunca avisa a la persona de la
  regla por haber «causado» el hecho: el tope `NOTIFY_MAX_RECIPIENTS` (50)
  sigue valiendo.
- **Crear tarea = abrir una incidencia o un conteo.** Una incidencia es el
  trabajo asignable genérico del sistema (se ve en «Incidencias», se toma, se
  resuelve, admite notas y fotos) y queda ligada al producto, la ubicación, la
  tarea o el pedido del hecho. Un conteo es la tarea de revisar existencias
  (ajuste grande, recepción con daño). Se descartó crear traslados (no hay de
  dónde sacar un destino sin inventarlo) y solicitudes de compra (las
  sugerencias de compra ya existen y una solicitud pide revisar cantidades).
  Ninguna acción mueve existencias de lugar. Una incidencia necesita un
  almacén: la del hecho. No hizo falta tocar `reportIncident`: dentro de la
  delegación (`facilityOnly`) su «almacén activo» es el del hecho, y la
  ubicación y el producto se le pasan como los teclearía una persona (código
  de la ubicación, clave del producto), dentro del alcance de la persona de
  la regla. Una incidencia de algo de toda la empresa (existencias bajas) no
  se abre: «No se hizo: una incidencia necesita un almacén».
- **Abrir un conteo** de una ubicación que ya tiene uno abierto (a mano o de
  un programa de conteo cíclico, que entonces no genera el del día, como
  siempre) termina «No se hizo: la ubicación ya tenía un conteo abierto» y
  **no cuenta como falla**. Un producto por serie no detiene el conteo: el
  conteo es de la ubicación y los productos por serie se rechazan al
  capturarlos, como en cualquier conteo.
- **Idempotencia:** la incidencia lleva `idempotencyKey` derivada de la
  ejecución y la acción (`auto-<ejecución>-<n>`; las claves de confirmación
  solo admiten letras, números, `-` y `_`); un conteo es uno por ubicación;
  el aviso, `key` por ejecución y acción.
- **Avisos:** respetan el tope de 50 destinatarios de `notify`, las
  preferencias y el correo opcional; el tipo `automations.rule_fired` se
  apaga por persona en «Avisos que recibo» como cualquier otro. La nota es
  una línea sin caracteres de control y viaja como texto: en la campana es
  texto, en el correo pasa por el HTML escapado de los avisos (ADR 0084) y
  en la incidencia es parte de la descripción.

### Bloquear (decidido por quien coordina el 2026-11-20 y programado)

- **Solo** con «Cuando un lote está por caducar» (`onlyTriggers`): la casilla
  es producto + lote dentro del almacén del hecho, y solo productos
  controlados por lote (un producto por serie no se bloquea así).
- Por cada ubicación del almacén, dentro del alcance de la persona de la
  regla, con existencias disponibles de ese lote (hasta 20 ubicaciones),
  calcula **lo libre** con `freeToTake` (nunca lo apartado para un pedido o
  una tarea ni lo que está en una tarima de almacenamiento) y llama
  `changeStockStatus` de `AVAILABLE` a `BLOCKED` por esa cantidad, con motivo
  «Automatización: <nombre de la regla>», a nombre de la persona de la regla
  con `inventory.status.change`, clave
  `auto-<ejecución>-<n>-<12 caracteres de la ubicación>` (un reintento no
  bloquea dos veces aunque lea las ubicaciones en otro orden); cada una en
  su propia transacción con los candados de siempre (producto → ubicación).
  Si otra operación apartó entre la lectura y el candado, `changeStockStatus`
  lo rechaza bajo su candado y esa ubicación se salta.
- **Sin autorización** del motor de aprobaciones: no saca existencias ni
  cambia el valor, se revierte a mano («Cambiar estado» a disponible con
  `inventory.status.release`) y un cambio de estado manual tampoco la pide.
- **En una empresa de demostración sí** se ejecuta (nada sale a terceros).
- Sin nada libre: «No se hizo: no había existencias libres de ese lote», y
  **no cuenta como falla**.
- Queda dicho dónde y cuánto en el historial («Se bloqueó 10 piezas en
  A-01-2»), la bitácora del cambio de estado lleva `automatizacion: <id>` y
  la regla puede sumar «Avisar» a quien puede liberar.
- **«Una vez por lote»:** la regla se activa una vez por lote y almacén. Si
  después entran más existencias de ese mismo lote, **no se bloquean
  solas**: quien recibe un lote por caducar lo ve en «Por caducar» y lo
  bloquea a mano, o se archiva y se crea otra regla. Bloquear cada entrada
  posterior exigiría escuchar las entradas, que hoy no publican un hecho.

## A nombre de quién actúa

**De la persona que guardó o encendió la regla por última vez**
(`automation_rule.actorUserId`), con el criterio de las llaves de la API y de
NEG-20: cada acción corre dentro de `runDelegated` con esa persona, recortada
a **solo el permiso de esa acción** y, si la regla es de un almacén o el hecho
es de un lugar, a ese almacén (`facilityOnly`). Así los servicios de siempre
deciden: membresía activa, roles vigentes, módulo activo y no en solo lectura,
alcance. La bitácora del servicio la escribe a nombre de esa persona y agrega
`automatizacion: <id de la regla>` (como `llaveApi`).

- Si la persona deja la empresa, pierde el permiso o el alcance, la ejecución
  queda «No se hizo: la persona de la regla ya no puede …» y **la regla se
  apaga sola** (`pauseReason = ACTOR`), con aviso a quien administra. Volver a
  encenderla la pone a nombre de quien la enciende.
- Se descartó actuar como el titular (como las rondas de reposición): daría
  a quien configura una regla poder que quizá no tiene.
- Avisar no escribe nada de negocio, pero también exige que la persona de la
  regla siga con membresía activa y con el permiso de lectura del disparador.

## Que no se dispare en círculo

- **Profundidad:** una acción que causa un hecho lleva en la delegación la
  cadena de reglas que la originó; un hecho causado dentro de una
  automatización de profundidad `AUTOMATION_MAX_DEPTH` (2) ya no dispara
  nada, y **una regla nunca se dispara por un hecho que ella misma causó**
  (aunque sea de forma indirecta).
- **Topes:** `AUTOMATION_RUNS_PER_HOUR` (30) ejecuciones por regla por hora y
  `AUTOMATION_COMPANY_RUNS_PER_HOUR` (300) por empresa; lo que pasa del tope
  no se ejecuta y queda una sola ejecución «Se alcanzó el tope por hora» por
  regla y hora. Una ronda revisa como mucho 50 sujetos por regla.
- **Falla siempre:** una ejecución que falla (error inesperado tras 3
  intentos, o un servicio que responde que no) cuenta una falla seguida; con
  `AUTOMATION_PAUSE_AFTER` (5) seguidas la regla se apaga sola
  (`pauseReason = FAILURES`) y se avisa a quien administra
  (`automations.rule_paused`), como los destinos de webhook. Una ejecución que
  termina bien vuelve el contador a cero.

## Tablas

- `automation_rule` (de empresa): nombre, disparador, almacén (opcional),
  condiciones y acciones (JSON validado contra el catálogo al guardar y otra
  vez al ejecutar), estado `ACTIVE | PAUSED | ARCHIVED`, motivo de la pausa
  (`MANUAL | ACTOR | FAILURES | MODULE`), persona de la regla, quién la creó,
  versión (sube en cada cambio), fallas seguidas, fechas.
- `automation_run` (de empresa): regla, versión de la regla, disparador,
  `eventKey` (única con la regla: `evt:<trabajo>` para un hecho,
  `state:<sujeto>:<día>` o `state:<sujeto>` para un estado, `limit:<hora>`),
  profundidad, una línea del hecho, estado
  `PENDING | RUNNING | DONE | SKIPPED | FAILED`, motivo, resultado por acción,
  intentos, fechas. Disparador: regla, `eventKey`, empresa y versión no
  cambian, y una ejecución terminada no cambia. Se borra a los 90 días
  (ronda `platform.automations_cleanup`).

Sin cambios a tablas existentes. Migración de expansión
`20261120150000_wms64_automations`.

## Costo en la transacción del hecho

`emitWebhookEvent` ya leía los destinos de webhooks dentro de la
transacción del hecho; el motor agrega **una sola lectura** por el índice
`(organizationId, status, triggerKey)` de `automation_rule`, sin candados
(`queueAutomationEvent`, llamada al principio de `emitWebhookEvent`). Sin
ninguna regla encendida que escuche ese hecho no escribe nada: una
operación común (una recepción, un cambio de estado) cuesta **una sentencia
más**. Con una regla que escucha, además el `INSERT` del trabajo (dos
sentencias del cliente). Se descartó colgarse del trabajo de reparto de
webhooks: solo existe cuando hay un destino que escucha, así que habría que
encolarlo siempre y eso sí agregaría escrituras al camino de todas las
operaciones. Medido en `tests/platform/automations.int.test.ts` contando las
sentencias del adaptador de su propio proceso.

## Trabajos y rondas

- `platform.automation_event`: lo encola `emitWebhookEvent` (mismo lugar,
  misma transacción) solo si una regla encendida escucha ese hecho; lleva el
  tipo, el módulo, los datos del evento, la profundidad y la cadena. Evalúa
  condiciones y crea las ejecuciones (única regla + evento) y sus trabajos.
- `platform.automation_run`: corre las acciones de una ejecución. Reclama la
  ejecución con una actualización condicionada (`PENDING → RUNNING` con
  `claimToken`), así dos workers no la corren a la vez; guarda el resultado de
  cada acción al terminarla y un reintento salta las ya hechas. 3 intentos;
  `onFailed` la deja `FAILED` y cuenta la falla.
- Ronda `platform.automations` (cada hora, solo empresas con reglas
  encendidas): apaga las reglas cuyo módulo ya no está contratado
  (`pauseReason = MODULE`; no se borran y no vuelven solas), y revisa los
  disparadores de estado, almacén por almacén, creando ejecuciones con su
  llave de repetición.

## Casos borde

- **Plan vencido o módulo en solo lectura:** no se ejecuta ninguna acción que
  escriba y tampoco se avisa (todo queda «No se hizo: el plan está
  vencido»); la regla no se apaga. Ver y apagar reglas sí se puede; crear y
  editar no.
- **Módulo quitado:** sus disparadores y acciones dejan de ofrecerse y sus
  reglas se apagan solas en la siguiente ronda, sin borrarse.
- **Alcance:** configurar **y leer** (reglas e historial) exige ver toda la
  empresa: el historial nombra productos, ubicaciones y documentos de
  cualquier almacén, así que para quien está limitado a almacenes o zonas la
  pantalla dice por qué no los ve y la ficha de una regla «no existe». Una
  regla puede ser de cualquier almacén activo; un almacén archivado detiene
  sus reglas (la ejecución queda «No se hizo»).
- **Módulo quitado contra plan vencido:** las dos cosas dejan el módulo en
  solo lectura. La ronda distingue: si algún módulo sigue en uso pleno, el
  plan sigue vigente y el módulo se quitó → la regla se apaga
  (`MODULE`); si ninguno sigue en uso, el plan terminó → la regla se queda
  encendida y no hace nada hasta que vuelva.
- **Sesión de PIN:** no configura (`platform.*` se recorta en una terminal) ni
  lee (no está en `TERMINAL_PLATFORM_KEEP`).
- **Soporte:** solo lee (`platform.automation.read` termina en `.read`).
- **Empresa de demostración:** ejecuta normalmente. Ninguna acción sale a
  terceros (avisos y correos van a miembros, que la regla de WMS-44 permite).
- **Dos workers:** ejecución única por regla y evento, y reclamo
  condicionado.
- **Qué se registra:** líneas sin costos, sin precios y sin nombres de
  personas ajenas al lector (el lector ya ve toda la empresa); nunca el
  contenido de un archivo ni secretos.
- **API:** no ofrece automatizaciones.

## Decisiones que el fundador puede cambiar

1. El catálogo inicial de ocho disparadores y tres acciones.
2. Que «crear tarea» sea abrir una incidencia o un conteo (no traslados ni
   solicitudes de compra).
3. Que la regla actúe por quien la guardó o encendió por última vez y se
   apague si esa persona pierde el permiso.
4. Topes: 20 reglas, 3 acciones, 30 ejecuciones por regla por hora, 300 por
   empresa, profundidad 2, pausa tras 5 fallas, 90 días de historial.
5. Que Gerencia lea las reglas y su historial.
6. Que con el plan vencido tampoco se avise.
7. Bloquear sin autorización del motor de aprobaciones, también en
   demostraciones, y solo con lotes por caducar.
8. Que «una vez por lote» no bloquee lo que entra después del mismo lote.
9. Que leer las reglas exija ver toda la empresa (Gerencia limitada a un
   almacén no las ve).
