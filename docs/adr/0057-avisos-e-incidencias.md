# ADR 0057 — Avisos e incidencias dentro de la app

Fecha: 2026-11-15 · Estado: aceptada · Paso: WMS-39 (transversal) · Cierra
el pendiente «avisar a quien autoriza» de ADR 0053 y «avisar a Compras» de
ADR 0055 (dentro de la app; el correo sigue pendiente) · Usa ADR 0038
(alcance por almacén y zona), ADR 0013 (rondas del worker)

## Contexto

La retroalimentación de campo pidió «avisos entre áreas»: cuando un área
termina algo, la siguiente se entera sin que alguien vaya a decírselo
(«calidad ya liberó», «hay una solicitud por autorizar», «te asignaron una
tarea»). Hoy Inicio muestra números derivados del estado («Aprobaciones
pendientes», «Tareas con problema»), pero nadie sabe que algo cambió hasta
que entra a mirar, y quien pidió algo no se entera de la respuesta.

Además el piso no tiene dónde dejar un problema que no es una operación de
existencias: mercancía dañada que alguien encontró, una ubicación bloqueada
o insegura, algo que no cuadra, un equipo descompuesto. Se dice de palabra
y no queda rastro de quién lo atendió ni cómo.

Son dos cosas relacionadas pero distintas:

- **Aviso:** el sistema le dice a **una persona**, dentro de la app, que hay
  algo que le toca o que algo que pidió cambió.
- **Incidencia:** una persona reporta un problema del almacén; alguien
  responsable la atiende y la cierra; queda rastro.

## Flujo operativo

### Avisos

1. **Un hecho ocurre** en un servicio (se pide una autorización, se asigna
   una tarea, se envía un traslado…). Dentro de **la misma transacción**, el
   servicio llama `notify(tx, tipo, …)` con el texto del aviso, a dónde lleva
   y a quién va. Si la operación se revierte, no hay aviso.
2. **A quién va.** Una persona concreta (quien pidió, a quien se asignó) o
   «quienes tengan estos permisos» en la empresa y alcancen ese almacén o esa
   ubicación (WMS-20), y si el tipo lo pide, solo ciertos roles (las reglas
   de aprobación). **Nunca quien originó el hecho.** Hasta 50 personas por
   aviso; a cada una una sola vez por hecho (llave de deduplicación).
3. **La persona ve la campana.** En la barra lateral (escritorio) y en el
   encabezado (teléfono) aparece «Avisos» con el número de no leídos. Al
   tocarla se abre la lista de los últimos ocho; tocar uno lo marca leído y
   lleva a su pantalla. «Marcar todos como leídos» y «Ver todos» (pantalla
   `/avisos`, paginada) completan el flujo.
4. **Lo que no le interesa lo apaga.** Configuración › Avisos lista los
   tipos con un interruptor cada uno (todos encendidos por omisión: hoy cada
   tipo pide algo a quien lo recibe o le responde algo que pidió).
5. **Limpieza.** Los avisos leídos hace más de 90 días se borran en una
   ronda del worker; los no leídos se quedan.

Qué avisa desde este paso:

| Tipo | A quién | Cuándo |
| --- | --- | --- |
| `approvals.pending` | Quien puede decidir esa solicitud (roles de la regla vigente o titular, con los permisos del tipo, dentro del alcance), menos quien la pidió | Se pide una autorización |
| `approvals.decided` | Quien la pidió | Se autoriza, se rechaza o vence |
| `purchasing.request_to_attend` | `purchasing.order.create` que alcance el almacén de la solicitud | Una solicitud de compra llega a «Por atender» (directo o al autorizarse) |
| `purchasing.request_answered` | Quien la pidió | Se convierte en orden o Compras la rechaza |
| `inventory.task_assigned` | A quien se le asigna | Asignar una tarea o un grupo |
| `inventory.task_blocked` | `inventory.task.create` que alcance su origen | Alguien reporta un problema en una tarea |
| `inventory.customer_return` | Quien puede decidirla (`inventory.status.release` o `inventory.status.change`) en su ubicación | Se registra una devolución de cliente |
| `inventory.transfer_incoming` | `inventory.facility_transfer.receive` del almacén de destino | Se envía un traslado |
| `inventory.transfer_differences` | Quien lo envió | Se recibe con mercancía dañada o el destino lo da por perdido |
| `inventory.incident_reported` | `inventory.incident.manage` que alcance su almacén o ubicación | Se reporta una incidencia |
| `inventory.incident_changed` | Quien la reportó | Se toma, se resuelve, se descarta o se le agrega una nota |

### Incidencias

1. **Reportar** (`inventory.incident.create`: titular, administración,
   Almacén, supervisión, Almacenista y Montacarguista). Desde Inicio
   («Reportar un problema») o desde Incidencias, en el teléfono: elige qué
   pasó (lista fija y genérica: «Mercancía dañada», «No está donde debería»,
   «Ubicación bloqueada o insegura», «Equipo descompuesto», «Otro»), escribe
   qué vio y, si quiere, escanea la ubicación y el producto. Queda
   **abierta** `INC-0001` del almacén activo, y avisa a quienes la atienden.
2. **Atender** (`inventory.incident.manage`: titular, administración,
   Almacén y supervisión). En su ficha, «Atender» la pasa a **en atención**
   (queda a nombre de quien la tomó). Cualquiera que la vea puede agregar
   **notas** de seguimiento (inmutables).
3. **Cerrar.** «Resolver» pide qué se hizo; «Descartar» pide el motivo.
   También se puede cerrar sin pasar por «en atención». Cada cambio avisa a
   quien la reportó.
4. **No toca existencias.** Una incidencia de mercancía dañada no cambia el
   estado de nada: su ficha ofrece «Cambiar estado» (con el producto) y
   «Corregir existencias» para quien tiene esos permisos, y lo que se hizo
   queda en su movimiento de siempre.

Estados: `OPEN → IN_PROGRESS → RESOLVED | DISMISSED`, y `OPEN → RESOLVED |
DISMISSED`; la tabla pura `INCIDENT_TRANSITIONS` y el disparador
`incident_transition` la repiten. No se borra; lo que se reportó (número,
almacén, tipo, descripción, a qué se refiere, quién) no cambia.

## Decisiones

- **Avisos en plataforma; incidencias en Inventario.** `src/platform/
  notifications` no importa módulos (como `approvals`): cada módulo declara
  sus tipos (`NotificationType`: clave `modulo.cosa`, nombre visible,
  descripción, `defaultEnabled`) y los registra en
  `src/modules/registry/notifications.ts`; la plataforma recibe esa lista
  para la pantalla de preferencias. Las incidencias se refieren a
  ubicaciones, productos, tareas y pedidos, así que son de Inventario
  (`src/modules/inventory/incidents.ts`).
- **El texto se fija al crearse** (máximo 300 caracteres, una línea; lo que
  sobra se recorta con «…»). Lo escribe el módulo, que sabe qué puede ver
  quien lo recibe: nunca costos; con alcance, nombres solo de lo que el
  destinatario alcanza (por eso los avisos por permiso llevan el almacén o
  la ubicación del hecho y se filtran por alcance).
- **Destino validado.** `href` es una ruta interna: empieza con «/», no con
  «//» ni «/\», sin espacios, esquemas ni caracteres de control (también un
  `CHECK` en la base). Una dirección externa es un error de programación:
  `notify` lanza. Al pintar, un destino que no pasa la misma revisión lleva a
  `/avisos`.
- **Avisar no tumba la operación** por un detalle: sin destinatarios no es
  error, el texto se recorta, el tope y las preferencias solo filtran; la
  deduplicación se revisa antes de insertar y el `INSERT` ignora un
  duplicado concurrente (ninguna transacción actualiza después esas filas,
  así que no aplica el riesgo de IMP-S13).
- **Permisos sin derechos del plan.** `notify` corre dentro de la
  transacción y no puede leer los derechos (MOD-08); el módulo del hecho ya
  está activo porque el servicio lo comprobó. Si después se quita un
  módulo, el aviso sigue ahí y su pantalla dice lo de siempre.
- **El contador es una consulta** sobre el índice `(organizationId,
  recipientUserId, readAt)`; el layout la hace al pintarse. Como el layout
  no se vuelve a pintar al navegar, la campana pide el número con una Server
  Action de lectura cuando cambia la pantalla y cada 60 segundos mientras la
  pestaña está visible, con tope de 30 minutos sin navegar (convención
  «Pantalla que espera al worker»); sin conexiones abiertas.
- **Tocar un aviso** es una Server Action que lo marca leído (solo los
  propios: el de otra persona «no existe») y redirige a su destino. Leer no
  deja bitácora (es de la persona, no de la empresa).
- **Preferencias**: una fila solo cuando la persona cambia el valor por
  omisión (`notification_preference`); sin canales: hoy el único canal es la
  app.
- **Tarea con problema e incidencia no se duplican.** `blockTask` sigue
  siendo el problema de una tarea (avisa a supervisión); una incidencia es
  un problema del almacén que no depende de una tarea. Una incidencia puede
  señalar una tarea (`?tarea=` en «Reportar un problema»), pero reportar un
  problema en una tarea no abre una incidencia sola.
- **Incidencias en el menú.** «Incidencias» es una sección (va a «Más» en el
  teléfono): el piso reporta cualquier día y supervisión las atiende todos
  los días. Inicio muestra «Reportar un problema» a quien puede y
  «Incidencias abiertas» solo a quien atiende y solo si hay.
- **Alcance.** Una incidencia sin ubicación es de todo su almacén; con
  ubicación, existe solo para quien la alcanza (`not_found` para los demás),
  como las aprobaciones.

## Pendientes

- **Correo** como segundo canal (renglón propio + `enqueueJob` + worker,
  como «Correo a terceros y envíos»), con su preferencia por tipo.
- **Resumen diario** de lotes por caducar y existencias bajas (una ronda,
  un aviso por persona y día, solo para quien ve esas listas).
- **Evidencia con fotos** (WMS-37): la incidencia tendrá sus archivos con
  `storeFile`; la ficha deja el lugar.
- Avisar a calidad o a quien libera cuando exista ese módulo («calidad ya
  liberó»): declarará sus tipos; el motor no cambia.
- Tipos de incidencia configurables por empresa (hoy la lista es fija y
  genérica).

## Alternativas descartadas

- **Derivar los avisos del estado, como Inicio:** no dice «esto cambió» ni
  responde a quien pidió algo.
- **Conexión abierta (SSE o WebSocket) para el contador:** otra pieza de
  infraestructura sin necesidad; el número se refresca al navegar.
- **Que la plataforma resuelva destinatarios por tipo leyendo un registro
  de módulos:** acoplaría la plataforma a reglas de cada módulo; cada
  servicio sabe a quién le toca su hecho.
- **Guardar avisos con el texto en plantillas por tipo:** el texto fijo al
  crearse no cambia si después cambia el nombre de algo, igual que la
  bitácora.

## Decisión del fundador (2026-11-13)

El Montacarguista sí reporta incidencias: `inventory.incident.create` se queda en ese rol.
