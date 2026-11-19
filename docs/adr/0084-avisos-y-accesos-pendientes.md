# ADR 0084 — Pendientes de avisos por correo y del historial de accesos

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-88 · Completa ADR 0057
(avisos), ADR 0060 (avisos por correo y resumen diario) y ADR 0064
(historial de accesos y alertas) · Usa ADR 0006 (bitácora), ADR 0013
(cola y rondas), ADR 0020 (correo a terceros), ADR 0038 (alcance), PLT-06
(límite de intentos) y PLT-15 (enlaces de correo)

## Contexto

WMS-39B y WMS-68 dejaron pendientes que este paso cierra, en este orden
de prioridad:

1. Los avisos dirigidos a personas (`userIds`) no llevan almacén ni
   ubicación, así que su correo no revalida el alcance al enviarse.
2. El historial de accesos dice «Se envió el correo de alerta» cuando el
   correo solo quedó programado, aunque luego falle el servidor de correo,
   y un fallo no se reintenta.
3. `security_event` no tiene política de retención.
4. La limpieza de avisos y correos viejos corre solo en empresas con
   Inventario vigente.
5. El resumen diario calcula `listLowStock` una vez por persona suscrita.
6. Falta un enlace de baja sin entrar a la app, el correo en HTML y elegir
   los días del resumen.
7. Las alertas de accesos no llegan a la campana.

No entra: país por IP, alertas por SMS u otros canales, y cambios al
motor de avisos que no pida uno de estos puntos.

## 1. Alcance de los avisos dirigidos a personas

**Regla.** Un aviso dirigido a una persona lleva el mismo requisito que
decide si esa persona puede ver el documento: el permiso de lectura del
documento y su lugar. `notify` lo evalúa al crear el aviso y el worker lo
vuelve a evaluar al mandar el correo, con la misma función
(`memberReaches`). Si la persona perdió el rol o el alcance entre el hecho
y el correo, el correo queda `SKIPPED` («ya no tiene permiso o alcance»).
Si lo perdió antes del hecho, no recibe ni el aviso de la app: su enlace le
respondería «no existe».

**Cambios al motor (los mínimos que pide el punto):**

- `NotifyRecipients.locationIds`: varias ubicaciones que la persona debe
  alcanzar **todas** (una tarea existe para quien alcanza su origen y su
  destino, `taskScope`). `locationId` y `facilityId` siguen igual.
- `NotifyRecipients.wholeCompany`: solo quien ve toda la empresa (titular o
  sin límite de almacén). Lo usa el aviso de webhooks en pausa, que ya
  exigía `seesWholeCompany` al administrarlos.
- Los dos se guardan en el requisito del renglón de correo y se revalidan
  al mandar. Una ubicación que ya no existe deja el correo `SKIPPED`.

**Qué lleva cada aviso:**

| Aviso | Permiso | Lugar |
| --- | --- | --- |
| Tarea asignada (crear, asignar, asignar varias) | `inventory.task.read` | origen y destino (`locationIds`) |
| Equipo fuera de servicio (a quien lo usa) | `inventory.task.read` | origen y destino de su tarea |
| Traslado con diferencias (a quien lo envió) | `inventory.facility_transfer.read` | almacén de origen |
| Incidencia atendida, resuelta o con nota (a quien la reportó) | `inventory.incident.read` | su ubicación o, sin ella, su almacén |
| Solicitud de compra respondida | `purchasing.request.read` | su almacén |
| Solicitud de producción respondida | `production.request.read` | su área |
| Aprobación decidida o vencida (a quien la pidió) | — | el almacén o la ubicación de la solicitud |
| Etapa de proceso asignada, reasignada o liberada | permiso de lectura del documento | almacén del proceso |
| Webhook en pausa | `platform.api.manage` (ya) | `wholeCompany` |
| Sesiones cerradas por el equipo | — | — (es de la cuenta en esa empresa, sin lugar) |

Un traslado existe para quien alcanza su origen **o** su destino; el aviso
pide el origen (quien lo envió lo alcanzaba). Si después solo alcanza el
destino, ya no recibe ese correo: se prefiere de menos a de más.

## 2. El correo de una alerta de accesos dice la verdad y se reintenta

**Flujo.**

1. Una alerta se decide como antes (ADR 0064 §4: llave única, apartado del
   día, turno del tope diario) y se escribe su fila en `security_event` con
   `metadata.mail = "queued"`.
2. En la misma petición se escribe un renglón en **`access_alert_email`**
   (tabla nueva, de la persona, como `security_event`; fuera de
   `TENANT_MODELS`): la fila de la alerta (`securityEventId`, único), qué
   alerta, dispositivo, IP y hora del hecho; **nunca la dirección de
   correo**, que se lee de la cuenta al mandar. Estado `QUEUED`.
3. Después de responder (`afterResponse`) se intenta mandar. El intento se
   reclama con una actualización condicionada (`status = QUEUED`, que se
   pueda reintentar ya y sin otro reclamo vivo) que anota `claimToken`,
   `claimedAt` y suma `attempts`: dos procesos nunca mandan el mismo
   renglón a la vez.
4. Antes de mandar se vuelve a leer la cuenta: sin correo confirmado,
   `FAILED` («El correo de la cuenta no está confirmado»).
5. Si sale: `SENT` con `sentAt`. Si falla: vuelve a esperar con
   `nextAttemptAt` creciente (1, 5, 15 y 60 minutos) y, al quinto intento,
   `FAILED`. Un mensaje que no puede salir como está (`InvalidEmailError`)
   termina `FAILED` sin reintentar.
6. El worker corre `retryAccessAlertEmails` cada minuto: toma hasta 50
   renglones que toca reintentar (o cuyo reclamo lleva más de 5 minutos:
   el proceso murió) y repite el paso 3.

**El historial lee el estado del renglón:** «El correo de alerta está
programado», «Se envió el correo de alerta» o «No se pudo enviar el correo
de alerta». Las filas anteriores a este paso (`mail = "sent"` sin renglón)
dicen «Se programó el correo de alerta» (es lo único que se sabe).

**Garantías.**

- **Sin duplicar:** el reclamo con `claimToken` impide dos envíos
  simultáneos; cerrar exige el mismo `claimToken`. Como en CMP-06B, si el
  proceso muere entre mandar y cerrar, el siguiente intento lo vuelve a
  mandar: se prefiere un correo repetido a uno que se cree enviado.
- **Sin pasar del tope:** el turno del día se toma una sola vez, al crear
  la alerta; los reintentos no toman turnos. Un correo que falla no libera
  su turno.
- **Sin distinguir cuentas:** nada cambia antes de responder; lo de una
  contraseña equivocada sigue entero después de responder. No cambia el
  orden `reserveAttempt` → verificar → `settleFailure`/`refundAttempt` de
  ningún flujo.
- **Sin la dirección guardada:** el renglón no la lleva y el log de un
  fallo solo nombra el renglón (el error del servidor de correo puede
  traerla).
- **Aprender el dispositivo:** como antes, al programar el correo (riesgo
  aceptado en ADR 0064; con reintentos es menor).
- Los renglones terminados se borran a los 90 días (ronda de §3).

## 3. Retención de `security_event`

**Plazo: 365 días** para los eventos de acceso (los que lista el historial,
incluidos `password.reset` y las alertas) y las filas internas por día
(`access.mail_slot`, `access.claim`). **Decisión conservadora que el fundador puede cambiar**
(cambiarla es una migración nueva y la constante del código).

**Qué nunca se borra por antigüedad:** `access.device_known` (si se
borrara, un dispositivo conocido volvería a alertar o, peor, si se borraran
todos, el siguiente se aprendería en silencio) y los demás eventos de la
cuenta que no son accesos (activar o desactivar dos pasos, generar códigos
de recuperación, cambiar la contraseña desde la cuenta): siguen como la
bitácora (ADR 0006), sin purga.

**Cómo se borra sin abrir un hueco.**

- El disparador `security_event_no_delete` se reemplaza por uno que solo
  deja borrar una fila cuya acción está en la lista de purgables **y** cuyo
  `createdAt` tiene más de 365 días según el reloj de la base
  (`UTC_TIMESTAMP(3)`). Ni la app ni quien tenga sus credenciales puede
  borrar algo reciente o de otra clase: la base lo rechaza. Las
  actualizaciones siguen prohibidas.
- Solo borra la ronda `platform.security_events_cleanup` del worker
  (`purgeExpiredSecurityEvents`), por lotes de 1,000 por id con tope de
  20 lotes por corrida, sobre un índice nuevo `(createdAt)`.
- No es una ronda por empresa (la tabla es por persona): el registro de
  rondas aprende rondas de cuenta (`accountRounds`), que el worker corre en
  la misma vuelta horaria.

**Aviso de privacidad:** hoy no dice ningún plazo de conservación (está en
la lista para el abogado, WMS-81). Agregar uno solo dejaría a los demás más
a la vista y obligaría a todas las cuentas a aceptar otra vez; no se sube
la versión en este paso. Queda para la revisión legal junto con los demás
plazos (bitácora, avisos, respaldos, webhooks).

## 4. Limpieza de avisos y correos para toda empresa

La ronda `platform.notifications_cleanup` corre para **toda empresa**
(`allOrganizations`, como la de fotos), tenga o no plan: avisos leídos de
más de 90 días, correos de avisos terminados de más de 90 días, resúmenes
diarios terminados de más de 90 días (se mueve aquí desde la ronda del
resumen, que solo corre con Inventario) y enlaces de baja vencidos (§6).
Son borrados por índice que no hacen nada cuando no hay qué borrar.

## 5. Resumen diario más barato

`listLowStock` es una cifra de toda la empresa, igual para toda persona que
puede leerla (permiso `inventory.minimum.read` y sin límite de almacén o
zona) y sin costos. El trabajo del resumen guarda en memoria del proceso,
por empresa, la primera página ya armada (renglones y total) durante 10
minutos. **Cada persona se sigue revisando por separado** (permiso y
`seesWholeCompany`) antes de usar la copia; quien está limitado sigue sin
recibir nada. Varios workers tienen cada uno su copia; nada se guarda en
la base.

## 6. Baja sin entrar, correo en HTML y días del resumen

**Baja sin entrar a la app.**

- Cada correo de avisos y cada resumen lleva un enlace de baja propio:
  `<app>/baja-de-avisos?t=<empresa>.<secreto>`. El secreto son 32 bytes al
  azar; en la base solo se guarda su `sha256` (`notice_unsubscribe`, de la
  empresa, con persona, vencimiento a 60 días y `usedAt`). El id de empresa
  en el enlace no es secreto: solo dice en qué empresa buscar.
- La pantalla `/baja-de-avisos` es pública y **no cambia nada al abrirse**
  (los antivirus de correo abren los enlaces): muestra «¿Dejar de recibir
  avisos por correo?» y un botón. No dice el correo, la persona ni la
  empresa.
- El botón (Server Action) y `POST /api/baja-de-avisos` (la baja de un clic
  de RFC 8058, cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post`)
  llaman al mismo servicio `unsubscribeFromNoticeEmails`:
  1. `reserveAttempt` por IP (30 cada 15 minutos) **antes** de verificar;
  2. busca el hash en la empresa del enlace; vencido o inexistente:
     `settleFailure` y «El enlace no es válido o ya venció»;
  3. válido: apaga el correo de **todos** los tipos de esa persona en esa
     empresa (incluido el resumen), deja la app como estaba, marca
     `usedAt` (la primera vez) y `refundAttempt`.
  Repetirlo responde igual («Listo»). No da sesión, no revela si la
  persona sigue en la empresa y no escribe nada fuera de sus preferencias.
- Nunca se registra el enlace ni el secreto (logs, bitácora). No pasa por
  `/api/auth/*`, así que no entra a la lista de Better Auth; tiene su
  propia prueba. Un GET a `/api/baja-de-avisos` solo redirige a la página.
- Los correos que esperaban de esa persona quedan `SKIPPED`; uno que el
  worker ya tomó puede salir todavía.

**Correo en HTML.** Los correos de avisos y el resumen salen con texto y
HTML. El HTML se arma con una plantilla fija (`htmlEmail`) que **escapa todo
el texto** (`escapeHtml`) y los atributos, sin imágenes remotas, scripts ni
estilos externos; los textos de clientes ya pasaron por `oneLine`/
`noticeText`. Los enlaces son solo los que arma `appLink` (ruta interna
validada). `sendEmail` acepta `html` y `unsubscribeUrl` (validada: http o
https, sin espacios ni caracteres de control, hasta 500 caracteres) y sigue
rechazando cabeceras con saltos de línea.

**Días del resumen.** Ajuste de empresa `inventory.digest.days`: «Todos los
días» (por omisión), «De lunes a viernes» o «De lunes a sábado», en el
calendario de la empresa. La ronda no aparta resúmenes en los otros días.
Por empresa y no por persona: es la semana de trabajo del almacén. **El
fundador puede cambiarlo** a una elección por persona.

## 7. Alertas de accesos en la campana

Cuando se levanta una alerta de accesos (cualquier resultado del correo),
después de responder se escribe además un aviso del tipo
`platform.access_alert` («Alertas de seguridad de tu cuenta») en cada
empresa donde la persona tiene membresía activa (hasta 20), con
`actorUserId` vacío, texto fijo por clase de alerta (sin IP), enlace a
`/configuracion/accesos` y la llave de la alerta (una vez).

- **Nunca por correo como aviso:** la alerta ya tiene su propio correo. El
  tipo se declara `channels: "app_only"` (nuevo): la pantalla no ofrece
  «Recibir por correo» y el servidor lo rechaza.
- La persona puede apagarlo en la app (el correo de la alerta no se apaga).
  **El fundador puede cambiarlo.**
- El PIN bloqueado de quien no tiene PIN no avisa (como no manda correo).
- El texto es de la cuenta de la persona: no dice nada de otra empresa.

**Riesgo aceptado:** quien acaba de entrar puede ser el intruso y marcar el
aviso como leído. El canal que importa sigue siendo el correo al buzón
confirmado (ADR 0064 §5).

## Amenazas (resumen; detalle en `docs/seguridad/REVISION_ACCESOS.md` y `docs/seguridad/REVISION_AVISOS_CORREO.md`)

- **Correo a quien ya no debe verlo:** revalidación de permiso y lugar al
  mandar (§1), probada.
- **Enumeración de cuentas:** nada nuevo antes de responder; la baja no
  dice correo, persona ni empresa.
- **Adivinar enlaces de baja:** 256 bits, solo el hash guardado, límite de
  intentos por IP antes de verificar.
- **Baja por un escáner de correo:** abrir la página no cambia nada; solo
  el botón o el POST de RFC 8058.
- **Inyección en el HTML:** todo texto y atributo escapado; prueba con un
  nombre de empresa y un texto hostiles.
- **Inyección de cabeceras:** `unsubscribeUrl` validada; `sendEmail` sigue
  rechazando saltos de línea.
- **Borrar huellas de accesos:** el disparador solo deja borrar lo purgable
  con más de 365 días por el reloj de la base.
- **Inundar de correos:** el tope diario no cambia; los reintentos no toman
  turnos.

## Pendientes

- Elegir los días del resumen por persona (hoy por empresa).
- Plazos de conservación en el aviso de privacidad (revisión legal).
- La baja apaga todos los avisos por correo de la empresa; bajarse de un
  solo tipo sigue en «Avisos que recibo».
