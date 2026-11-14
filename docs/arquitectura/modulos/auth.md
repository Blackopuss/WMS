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
| Intentos | `throttle.ts` | `reserveAttempt` → `settleFailure` / `refundAttempt`, `clientIp` |
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
de empresa. Los eventos de cuenta van a `security_event` ([audit](audit.md)).

## Ajustes y trabajos

Ninguno.

## ADR

0003 (autenticación), 0059 (sesiones del equipo: lo que ve y cierra la
empresa vive en [authorization](authorization.md)). Revisiones de seguridad en `docs/seguridad/`.
