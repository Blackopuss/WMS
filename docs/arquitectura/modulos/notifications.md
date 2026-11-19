# Plataforma: avisos (`platform/notifications`)

## Responsabilidad

Los avisos dentro de la app (WMS-39, ADR 0057): el sistema le dice a **una
persona** que hay algo que le toca o que algo que pidió cambió. Los módulos
(y el motor de aprobaciones) declaran sus **tipos de aviso** y llaman
`notify` dentro de la transacción del hecho; la plataforma decide quién lo
recibe, lo guarda y lo muestra. No importa módulos: la pantalla de
preferencias recibe la lista `notificationTypes` de
`src/modules/registry/notifications.ts`.

Desde WMS-39B (ADR 0060) un aviso también puede salir **por correo** a quien
lo pidió para ese tipo (apagado por omisión), agrupado por persona y
mandado por el worker; y un tipo puede ser **solo por correo**
(`channels: "email"`, como el resumen diario de Inventario).

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Definiciones | `definitions.ts` | tipo `NotificationType` (`key` `modulo.cosa`, `module`, `label`, `description`, `defaultEnabled`, `channels` `app`/`email`/`app_only`, `visibleWith`), `assertValidNotificationTypes` (un tipo solo por correo debe venir apagado), `isEmailOnly`, `isAppOnly` (WMS-88: nunca se ofrece ni se manda por correo), `noticeText` (una línea, máximo 300 caracteres) |
| Avisar | `notify.ts` | `notify(tx, tipo, { organizationId, actorUserId, to, text, href, key })` dentro de la transacción del hecho (y, para quien lo pidió por correo, renglón `notification_email` + trabajo `notifications.send_email` en la misma transacción); `memberName(tx, userId)` para escribir «Olivia reportó…»; `nextMailAt` (agrupar `NOTICE_EMAIL_GROUP_MS`, espaciar `NOTICE_EMAIL_GAP_MS`) |
| Correo | `emails.ts` | `sendNoticeEmails` (el worker: reclama lo que espera de la persona, vuelve a comprobar membresía, correo confirmado, preferencia, canal, plan, permisos y alcance, y manda un solo correo), `failNoticeEmails`, `noticeEmailJobHandlers(tipos)` (lo registra `src/modules/registry/jobs.ts`), `wantsEmail`, `emailSubscribers`, `memberAddress`, `isEmailChannelOn`/`companySendsNoticeEmails`, `appLink`, `purgeFinishedNoticeEmails` |
| Ajuste | `settings.ts` | `NOTICE_EMAIL_CHANNEL` (`platform.notices.email`: `on` por omisión, `off` apaga el canal en toda la empresa), en `NOTIFICATION_SETTINGS` y `operationSettings` |
| Leer y marcar | `notifications.ts` | `countUnreadNotifications` (una consulta sobre el índice; la usa el layout), `listRecentNotifications` (la campana), `listNotifications` (paginada, `/avisos`), `openNotification` (marca leído y dice a dónde lleva), `markAllNotificationsRead` |
| Preferencias | `notifications.ts` | `getNotificationPreferences(actor, tipos, módulos)` (en la app, por correo, solo correo), `setNotificationPreference(actor, tipos, clave, valor, canal)` (`app` o `email`; apagar en la app apaga el correo, pedir correo enciende la app; una fila solo cuando algo difiere del valor por omisión) |
| Baja sin entrar | `unsubscribe.ts` | `createUnsubscribeLink(organizationId, userId)` (el worker, al armar cada correo: página y dirección de un clic; solo guarda el `sha256` del secreto, vence a los `UNSUBSCRIBE_LINK_DAYS` 60 días), `unsubscribeFromNoticeEmails(token, headers)` (límite por IP con `reserveAttempt` antes de verificar; apaga el correo de todos los tipos de esa persona en esa empresa y deja `SKIPPED` lo que esperaba), `purgeExpiredUnsubscribeLinks` |
| Limpieza | `notifications.ts`, `emails.ts`, `unsubscribe.ts` | `purgeReadNotifications(organizationId)`: borra los leídos hace más de `READ_NOTICE_DAYS` (90); `purgeFinishedNoticeEmails`: los correos terminados de esa antigüedad; `purgeExpiredUnsubscribeLinks`: los enlaces de baja vencidos; en la ronda `platform.notifications_cleanup` de `scheduledRounds`, **para toda empresa** (`allOrganizations`, WMS-88), junto con los resúmenes diarios terminados (`purgeEndedDigests` de Inventario) |

### Quién recibe un aviso (`to`)

- `userIds`: solo esas personas (quien pidió, a quien se asignó).
- `permissions` (todos, o `match: "any"`): quien los tenga en la empresa.
  Obligatorio si no hay `userIds`: nunca «a todos».
- `roles`: además, solo esos roles o el titular (las reglas de aprobación).
- `facilityId` o `locationId`: solo quien alcance ese almacén o esa
  ubicación (WMS-20, decidido con `inScope` y la ruta de la ubicación de
  `placeOfLocation`).
- `locationIds` (WMS-88): varias ubicaciones que debe alcanzar **todas** (una
  tarea: origen y destino). `wholeCompany` (WMS-88): solo quien ve toda la
  empresa (titular o sin límite de almacén o zona).

Un aviso dirigido a personas (`userIds`) lleva además el permiso de lectura
de su documento y su lugar (WMS-88, ADR 0084: tabla en el ADR), así quien
perdió el rol o el alcance no lo recibe, ni por correo después.

Siempre: solo membresías activas, nunca `actorUserId`, sin quien apagó el
tipo (o, si el tipo viene apagado, solo quien lo encendió), como mucho
`NOTIFY_MAX_RECIPIENTS` (50) personas y una vez por persona y `key`. Sin
destinatarios no es error. Un `href` que no sea ruta interna (`isInternalHref`
de `@/lib`) lanza: es un error de programación; la base lo rechaza también.

`notify` nombra la empresa en cada filtro además del cliente de empresa:
así lo puede llamar un cambio de equipo con el cliente normal de su
transacción (sesiones del equipo, WMS-40), siempre sin `facilityId` ni
`locationId`.

Roles ligados a un módulo (WMS-59, ADR 0062): `memberReaches` recibe los
módulos de la empresa (`modulesFor`, que los lee con el cliente de la
transacción solo si algún candidato tiene un rol ligado); sin ellos esos
roles no reciben avisos por permiso.

## Permisos

Ninguno propio: cada persona ve, abre y marca solo sus avisos, y elige solo
los suyos. Lo que dice un aviso ya pasó por los permisos y el alcance del
destinatario al crearse.

## Por correo (WMS-39B, ADR 0060)

- Cada persona lo pide por tipo en «Avisos que recibo»; nadie empieza a
  recibir correos sin pedirlo. La empresa puede apagar el canal entero.
- `notify` escribe el renglón y el trabajo en la transacción del hecho; si
  se revierte, no hay correo. El aviso dentro de la app nunca depende del
  correo.
- El worker junta en un correo todo lo que espera de esa persona (10
  renglones a la vista y «y N más» con enlace a `/avisos`); entre dos
  correos a la misma persona pasan al menos 15 minutos. Un renglón se
  reclama con `claimedBy` (atómico): un aviso, un correo.
- Al mandar se vuelve a evaluar lo que pidió el aviso (permisos, roles,
  almacén o ubicación; `memberReaches`, la misma regla de `notify`). Lo que
  ya no aplica queda `SKIPPED` con su motivo.
- Destinatario: el correo confirmado de la cuenta. Enlace:
  `BETTER_AUTH_URL` + la ruta interna. Con el plan vencido no sale.
- Desde WMS-88 sale con texto y HTML (`htmlEmail` de `platform/email`, todo
  escapado) y con su propio enlace de baja: en el cuerpo, la página
  pública `/baja-de-avisos` (abrirla no cambia nada; el botón sí); en la
  cabecera `List-Unsubscribe`, `POST /api/baja-de-avisos` (RFC 8058).

## Tablas

`notification` (texto, destino y llave fijos; solo `readAt` cambia, una vez;
solo se borran los leídos), `notification_preference` (persona + tipo +
`enabled` + `email`), `notification_email` (copia del texto y destino del
aviso, lo que exigía, estado `QUEUED`/`SENT`/`SKIPPED`/`FAILED`, `claimedBy`),
`daily_digest` (resumen diario por persona y día; lo escribe Inventario) y
`notice_unsubscribe` (WMS-88: enlace de baja, solo el hash del secreto,
vencimiento y `usedAt`).

## Tipos declarados

- Plataforma (aprobaciones): `approvals.pending`, `approvals.decided`.
- Plataforma (procesos, WMS-74): `processes.ready` (relevo a la siguiente
  área) y `processes.assigned`.
- Plataforma (accesos, WMS-88): `platform.access_alert`, solo en la app
  (`app_only`): la alerta de accesos de la propia cuenta, en cada empresa
  donde la persona es miembro activo; la escribe `access-history.ts`.

Desde WMS-74, `memberReaches` compara `to.roles` con los roles **vigentes**
(`activeRoles`: un rol ligado a un módulo cuenta solo con su módulo activo),
y `ownerByRole: false` hace que el titular pase el filtro de roles solo con
uno de ellos (la misma condición vuelve a leerse al enviar el correo).
- [inventory](inventory.md#avisos): `inventory.task_assigned`,
  `inventory.task_blocked`, `inventory.customer_return`,
  `inventory.transfer_incoming`, `inventory.transfer_differences`,
  `inventory.incident_reported`, `inventory.incident_changed` y, solo por
  correo, `inventory.daily_digest`.
- [purchasing](purchasing.md#avisos): `purchasing.request_to_attend`,
  `purchasing.request_answered`.

## Pantallas

La campana «Avisos» de `AppShell` (barra lateral y encabezado móvil;
`notification-bell.tsx`, recibe el número y las acciones del layout),
`/avisos` (todos, paginados; no es sección del menú) y Configuración › Avisos
que recibo (`/configuracion/avisos`: por tipo, en la app y por correo; los
tipos con `visibleWith` solo para quien tiene uno de esos permisos). El
service worker no guarda nada de esto.

## Pendientes

Elegir los días del resumen por persona (hoy por empresa, ajuste
`inventory.digest.days`); bajarse de un solo tipo desde el correo.

## ADR

0057 (avisos e incidencias), 0060 (avisos por correo y resumen diario), 0084
(pendientes de avisos y accesos).
