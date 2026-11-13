# Plataforma: avisos (`platform/notifications`)

## Responsabilidad

Los avisos dentro de la app (WMS-39, ADR 0057): el sistema le dice a **una
persona** que hay algo que le toca o que algo que pidió cambió. Los módulos
(y el motor de aprobaciones) declaran sus **tipos de aviso** y llaman
`notify` dentro de la transacción del hecho; la plataforma decide quién lo
recibe, lo guarda y lo muestra. No importa módulos: la pantalla de
preferencias recibe la lista `notificationTypes` de
`src/modules/registry/notifications.ts`.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Definiciones | `definitions.ts` | tipo `NotificationType` (`key` `modulo.cosa`, `module`, `label`, `description`, `defaultEnabled`), `assertValidNotificationTypes`, `noticeText` (una línea, máximo 300 caracteres) |
| Avisar | `notify.ts` | `notify(tx, tipo, { organizationId, actorUserId, to, text, href, key })` dentro de la transacción del hecho; `memberName(tx, userId)` para escribir «Olivia reportó…» |
| Leer y marcar | `notifications.ts` | `countUnreadNotifications` (una consulta sobre el índice; la usa el layout), `listRecentNotifications` (la campana), `listNotifications` (paginada, `/avisos`), `openNotification` (marca leído y dice a dónde lleva), `markAllNotificationsRead` |
| Preferencias | `notifications.ts` | `getNotificationPreferences(actor, tipos, módulos)`, `setNotificationPreference` (una fila solo cuando cambia el valor por omisión) |
| Limpieza | `notifications.ts` | `purgeReadNotifications(organizationId)`: borra los leídos hace más de `READ_NOTICE_DAYS` (90); ronda `platform.notifications_cleanup` de `scheduledRounds` |

### Quién recibe un aviso (`to`)

- `userIds`: solo esas personas (quien pidió, a quien se asignó).
- `permissions` (todos, o `match: "any"`): quien los tenga en la empresa.
  Obligatorio si no hay `userIds`: nunca «a todos».
- `roles`: además, solo esos roles o el titular (las reglas de aprobación).
- `facilityId` o `locationId`: solo quien alcance ese almacén o esa
  ubicación (WMS-20, decidido con `inScope` y la ruta de la ubicación de
  `placeOfLocation`).

Siempre: solo membresías activas, nunca `actorUserId`, sin quien apagó el
tipo (o, si el tipo viene apagado, solo quien lo encendió), como mucho
`NOTIFY_MAX_RECIPIENTS` (50) personas y una vez por persona y `key`. Sin
destinatarios no es error. Un `href` que no sea ruta interna (`isInternalHref`
de `@/lib`) lanza: es un error de programación; la base lo rechaza también.

## Permisos

Ninguno propio: cada persona ve, abre y marca solo sus avisos, y elige solo
los suyos. Lo que dice un aviso ya pasó por los permisos y el alcance del
destinatario al crearse.

## Tablas

`notification` (texto, destino y llave fijos; solo `readAt` cambia, una vez;
solo se borran los leídos) y `notification_preference` (persona + tipo +
`enabled`).

## Tipos declarados

- Plataforma (aprobaciones): `approvals.pending`, `approvals.decided`.
- [inventory](inventory.md#avisos): `inventory.task_assigned`,
  `inventory.task_blocked`, `inventory.customer_return`,
  `inventory.transfer_incoming`, `inventory.transfer_differences`,
  `inventory.incident_reported`, `inventory.incident_changed`.
- [purchasing](purchasing.md#avisos): `purchasing.request_to_attend`,
  `purchasing.request_answered`.

## Pantallas

La campana «Avisos» de `AppShell` (barra lateral y encabezado móvil;
`notification-bell.tsx`, recibe el número y las acciones del layout),
`/avisos` (todos, paginados; no es sección del menú) y Configuración › Avisos
que recibo (`/configuracion/avisos`). El service worker no guarda nada de
esto.

## Pendientes

Correo como segundo canal; resumen diario de lotes por caducar y existencias
bajas.

## ADR

0057 (avisos e incidencias).
