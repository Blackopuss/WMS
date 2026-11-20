# Revisión de amenazas — etapa USR (USR-01 a USR-11)

Fecha: 2026-10-04. Complementa `REVISION_PLT.md`. Hecha por la misma IA que implementó la etapa; falta una revisión independiente (Codex) antes del piloto.

## Qué se agregó

- Roles y permisos (`src/platform/authorization`): catálogo, decisión central `can`, guardas de servidor, acciones reservadas al titular.
- Transferencia de titularidad en dos pasos.
- Invitaciones por correo con token de un solo uso y aceptación como cuenta nueva o existente (`/invitacion`).
- Gestión de equipo: asignar roles, desactivar, reactivar; pantalla `/configuracion/equipo`.
- Menú y pantallas según permisos; bitácora visible en `/configuracion/bitacora`.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Un rol obtiene más de lo aprobado (permiso nuevo, comodín, rol desconocido) | Denegar por defecto; el catálogo debe coincidir con la matriz aprobada; `CHECK` en la base para roles | `catalog.test.ts`, `policy.test.ts`, `roles.int.test.ts` |
| Elevación por el administrador (nombrarse o nombrar administradores, tocar al titular, cambiar su propio acceso) | `checkTeamChange` / `checkInvitationRoles`, releídos dentro de la transacción con la empresa bloqueada | `team-rules.test.ts`, `team.int.test.ts`, `negative-by-role.int.test.ts` |
| Dos titulares o ninguno tras una transferencia concurrente | Una sola escritura de `ownerUserId`, bajo `FOR UPDATE` de la empresa | `ownership.int.test.ts` |
| Robo o adivinación del enlace de invitación | Token de 256 bits; solo se guarda su SHA-256; un uso; vence en 7 días; `no-referrer` | `invitations.int.test.ts`, `invitation-accept.int.test.ts` |
| Usar una invitación ajena con otra cuenta | El correo de la cuenta debe ser el invitado y estar confirmado; el correo de la membresía sale de la invitación | `invitation-accept.int.test.ts` |
| Secuestro de cuenta existente mediante «crear cuenta» desde la invitación | Si el correo ya tiene cuenta se exige iniciar sesión; no se cambia ninguna contraseña | `invitation-accept.int.test.ts` |
| Spam de invitaciones desde una empresa | 20 por empresa por hora; 30 intentos de aceptación por IP cada 15 min | `invitations.int.test.ts`, `invitation-accept.int.test.ts` |
| Persona desactivada que conserva acceso por una sesión abierta | Se borran sus sesiones en la misma transacción y cada petición revalida la membresía | `team-disable.int.test.ts` |
| Llamar la acción o la URL aunque el botón esté oculto | Cada pantalla y cada servicio comprueba el permiso en servidor | `navigation.int.test.ts`, `server-actions.int.test.ts` |
| Acciones de equipo sobre otra empresa cambiando ids | Persona y empresa salen de la sesión; consultas con `forOrganization` | `two-companies.int.test.ts`, pruebas de cada servicio |
| Borrar el rastro de un cambio de equipo | Bitácora solo-agregar en la misma transacción del cambio | `team-audit.int.test.ts`, `audit.int.test.ts` |

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| USR-S01 | Media | Ofrecer la titularidad no pide otra vez la contraseña del titular (la matriz propone reautenticación). El servicio existe, pero todavía no hay pantalla que lo llame. | Corregido en WMS-90 (ADR 0090): ofrecer y aceptar piden contraseña y código de dos pasos actual (`confirmIdentity`: `reserveAttempt` antes de verificar, `settleFailure`/`refundAttempt` después, 5 intentos en 15 minutos por persona), nunca desde una sesión de PIN ni por soporte; no hay ruta en la API. Prueba: `ownership-screen.int.test.ts`. |
| USR-S07 | Baja | (WMS-90) Al aceptar la titularidad seguía vigente el acceso de soporte que abrió el titular anterior, y un rol a conservar ligado a un módulo quitado después de la oferta se asignaba igual. | Corregido en WMS-90: aceptar cierra el acceso de soporte abierto (bitácora `support.revoked`) y responde `module_missing` si un rol elegido necesita un módulo que ya no está activo y el titular anterior no lo tenía. |
| USR-S10 | Media | (WMS-90, revisor) El código de la app de dos pasos se podía repetir al confirmar la identidad (también al desactivar los dos pasos): Better Auth no impide la repetición con sesión. | Corregido: se aparta `totpUsed` después de un código válido; repetido se rechaza y cuenta como fallo. Prueba en `ownership-screen.int.test.ts`. |
| USR-S11 | Media | (WMS-90, revisor) Abrir soporte a la vez que se aceptaba la titularidad dejaba abierta una ventana autorizada por el titular anterior: `grantSupportAccess` revisaba al titular fuera de la transacción. | Corregido: abrir y cerrar soporte vuelven a leer al titular bajo el candado de la empresa. Prueba con el candado retenido en `ownership-screen.int.test.ts`. |
| USR-S08 | Informativa | (WMS-90) Las llaves de la API y las sesiones del titular anterior no se revocan al transferir. | Aceptado: actúan con los permisos de quien las creó, leídos en cada llamada, así que pierden lo que el titular anterior perdió; el nuevo titular puede revocarlas. Decisión que el fundador puede cambiar (ADR 0090). |
| USR-S09 | Informativa | (WMS-90) Rechazar una oferta no pide contraseña, y el código de recuperación sirve como segundo factor al ofrecer o aceptar. | Aceptado: rechazar no da poder a nadie; el código de recuperación se gasta al usarse, como al desactivar los dos pasos. |
| USR-S02 | Baja | La pantalla de invitación dice si el correo invitado ya tiene cuenta. Solo lo ve quien tiene el token, que llegó a ese mismo buzón. | Aceptado. |
| USR-S03 | Baja | Al desactivar a alguien se cierran todas sus sesiones, también las que usa en otras empresas. | Aceptado: prefiere cerrar de más; vuelve a entrar y conserva sus otras empresas. |
| USR-S04 | Baja | Reactivar usa el permiso `platform.team.disable`; la matriz no define uno propio. | Pregunta abierta para el fundador (ver `MEMORY.md`). |
| USR-S05 | Informativa | Un administrador recién nombrado debe activar MFA; mientras no lo haga no puede usar la app (`requireSession` lo envía a activarla), pero su membresía ya tiene el rol. | Correcto por diseño; sin acceso operativo hasta activar MFA. |
| USR-S06 | Informativa | La decisión de permisos se lee de la base en cada petición, sin caché entre peticiones. | Correcto hoy (revocación inmediata). Si MOD-04 agrega caché, debe invalidarse al cambiar roles, desactivar o transferir. |

## Siguiente revisión

Al cerrar la etapa MOD (derechos, cupos y consola interna).
