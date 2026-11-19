# Plataforma: cuentas y sesiones (`platform/auth`)

## Responsabilidad

Identidad de las personas, no de las empresas: registro con confirmación de
correo (enlace + contraseña), inicio y cierre de sesión, recuperación de
contraseña, MFA con TOTP y códigos de recuperación, sesiones activas y límite
de intentos. Usa Better Auth 1.7.7 (`auth.ts`), con la telemetría apagada; la
ruta HTTP es `src/app/api/auth/[...all]` y solo deja pasar los enlaces de
correo (`http.ts`, lista de permitidos).

## Servicios públicos (`index.ts`)

| Grupo | Archivos | Qué ofrece |
| --- | --- | --- |
| Sesión | `session.ts` | `requireSession()` (valida contra la base; manda a MFA o a aceptar términos si falta), `getCurrentSession`, `signIn`, `signOut` |
| Registro | `register.ts` | `registerUser`, `resendVerification` |
| Recuperación | `recovery.ts` | `requestPasswordReset`, `resetPassword` |
| MFA | `mfa.ts`, `mfa-recovery.ts`, `mfa-policy.ts`, `backup-codes.ts` | alta de TOTP, `verifySignInCode`, `isMfaRequired`, `regenerateBackupCodes`, `disableMfa` |
| Sesiones | `sessions.ts` | `listActiveSessions`, `revokeSession`, `revokeOtherSessions` |
| Actividad | `activity.ts` | `noteSessionActivity` (la llama `requireOrganizationContext` con lo que ya leyó; escribe `session.lastActiveAt` como mucho cada `SESSION_ACTIVITY_INTERVAL_MS`, 5 minutos, después de responder), `recordSessionActivity`, `activityIsStale` (WMS-40) |
| Terminales compartidas | `terminal-session.ts`, `pin-hash.ts` | WMS-38 (ADR 0061): cookie de la terminal (`terminalOfDevice`, `hashTerminalSecret`; rotación con detección de reúso en `terminalBySecret`/`rotateTerminalSecret`, tabla `shared_terminal_secret`), quién puede usar PIN (`pinCandidates`, `PIN_ROLE_SETS`), `openTerminalSession` (sesión de Better Auth de la persona marcada con `terminalId`, firmada igual), `checkTerminalSession` (en cada petición: misma terminal en el navegador, inactividad, 12 horas, y que la persona aún pueda usar PIN), `terminalUserOfRequest`, `assertNotTerminalSession` (dos pasos y sesiones propias la llaman), `touchTerminalSession`; `hashPin`/`verifyPin`/`verifyNoPin`. `requireSession` devuelve `terminal` y, sin sesión en una terminal, manda a `/terminal`. Límites `pinUserTerminal`, `pinUser`, `pinTerminal`, `pinSetup` y el contador sin bloqueo `countInWindow` en `throttle.ts`; un inicio de sesión con contraseña borra `pinUser`. Ver [terminals.md](terminals.md) |
| Historial de accesos | `access-history.ts` | WMS-68 (ADR 0064): `noteSignIn` (entrada correcta con su dispositivo; con contraseña, alerta por dispositivo o navegador nuevo salvo en el primer acceso; con PIN, con su terminal y empresa, sin alerta), `noteFailedSignIn` (todo después de responder), `noteFailedCode` (con alerta por código equivocado desde un dispositivo nuevo y por el código que bloquea la cuenta) y `noteCodeLock` (la persona del segundo paso sale del reto firmado de Better Auth, `challengeUserId`), `alertFailedAttempts` y `alertPinLocked` (una por persona por día cada una), tope atómico `ACCESS_ALERTS_PER_DAY` de correos; correo a la persona con correo confirmado con `afterResponse` (función que corre después de responder). Lecturas: `listMyAccessHistory` (la propia, nunca en una sesión de PIN) y `readAccessHistory` (la usa `listMemberAccessHistory` de [authorization](authorization.md)), paginadas en la base. WMS-88 (ADR 0084): el correo de cada alerta es un renglón de `access_alert_email` que se escribe junto con la alerta; `deliverAccessAlertEmail` lo reclama con `claimToken`, lo manda después de responder y, si falla, lo deja esperando su siguiente intento (1, 5, 15 y 60 minutos; `FAILED` al quinto); `retryAccessAlertEmails` (el worker, cada minuto) reintenta; el historial dice programado, enviado o falló. Los reintentos no toman turnos del tope. La alerta también va a la campana (`writeBellAlert`, aviso `platform.access_alert` de `access-notices.ts`, solo en la app). Retención: `purgeExpiredSecurityEvents` (ronda de cuenta `platform.security_events_cleanup`) borra los eventos de acceso y las filas internas del día con más de `SECURITY_EVENT_KEEP_DAYS` (365) y los correos de alerta terminados de más de 90 días; nunca `access.device_known` ni los eventos que no son accesos (el disparador de la base repite la regla) |
| Intentos | `throttle.ts` | `reserveAttempt` → `settleFailure` / `refundAttempt`, `clientIp`; `noticeUnsubscribeIp` (WMS-88: enlaces de baja de avisos por correo, 30 cada 15 minutos por IP) |
| Cuentas invitadas | `invited-account.ts` | `prepareInvitedAccount`, `insertInvitedAccount` (dentro de la transacción de quien acepta una invitación) |
| HTTP | `http.ts` | `handleAuthRequest`, `isAllowedAuthRequest` |
| Varios | `password.ts`, `redirect.ts`, `account-password.ts` | límites de contraseña, `safeRedirectPath`, `verifyAccountPassword` |

## Permisos

Ninguno: actúa sobre la cuenta propia. MFA es obligatoria para titulares,
administradores y personal de plataforma (`isMfaRequired`).

## Tablas

`user`, `session`, `account`, `verification`, `twoFactor` (de Better Auth),
`auth_throttle` (intentos propios) y `rateLimit` (de Better Auth). `session`
lleva además `lastActiveAt` (WMS-40, ADR 0059). Ninguna es
de empresa. Los eventos de cuenta van a `security_event` ([audit](audit.md)),
que también es el historial de accesos y guarda las alertas (WMS-68), y
`access_alert_email` (WMS-88), el correo de cada alerta con su estado.

## Ajustes y trabajos

Sin ajustes. Trabajo del worker sin empresa (WMS-88): `retryAccessAlertEmails`
cada minuto y la ronda de cuenta `platform.security_events_cleanup`
(`accountRounds` de `src/modules/registry/rounds.ts`) cada hora.

## ADR

0003 (autenticación), 0064 (historial de accesos y alertas), 0084 (correo de alertas con reintento, retención y campana), 0059 (sesiones del equipo: lo que ve y cierra la
empresa vive en [authorization](authorization.md)). Revisiones de seguridad en `docs/seguridad/`.
