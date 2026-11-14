# Plataforma: terminales compartidas (`platform/terminals`)

## Responsabilidad

Terminales compartidas con PIN (WMS-38, ADR 0061): un dispositivo del piso
registrado por la empresa, donde muchas personas **con cuenta** entran con
un PIN corto a **su propia** sesión, recortada y de pocos minutos. Aquí
viven registrar, listar y quitar terminales, el PIN de cada persona, la
pantalla «¿Quién eres?» y la entrada con PIN. Lo que corre en cada petición
(leer la cookie de la terminal, validar la sesión de PIN, quién puede usar
PIN) vive en `platform/auth` (`terminal-session.ts`), porque `requireSession`
lo necesita y `auth` no puede depender de esta área.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Terminales | `terminals.ts` | `terminalFacilities`, `registerTerminal` (devuelve el valor de la cookie; la acción la pone y cierra la sesión del administrador en ese dispositivo), `listTerminals`, `getTerminal`, `removeTerminal` (invalida el secreto y borra sus sesiones) |
| PIN propio | `pins.ts` | `getMyPinStatus`, `setMyPin` y `removeMyPin` (contraseña de la cuenta con límite `pinSetup`; cierran las sesiones de terminal de la persona en la empresa) |
| Entrar | `sign-in.ts` | `getTerminalScreen` (terminal del navegador y personas que pueden usar PIN, sin decir quién tiene), `pinSignIn` (intento apartado antes de verificar, por persona y por terminal) |
| Reglas | `pin-rules.ts` | `pinProblem`, `isTrivialPin`, `isPinShape` (puras, con prueba unitaria) |
| Ajustes | `settings.ts` | `TERMINAL_SETTINGS`: `platform.terminal.pin_roles`, `.pin_length` (5 o 6), `.idle_minutes` (en `operationSettings`, mostrados en la pantalla de terminales y no en Operación) |
| Avisos | `notices.ts` | `platform.terminal_locked` (terminal o PIN de una persona bloqueados) y `platform.terminal_cloned` (terminal quitada por copia de su cookie), a quien tiene `platform.terminal.manage` en el almacén; definidos en `platform/auth` |

En `platform/auth` (`terminal-session.ts`, `pin-hash.ts`):
`terminalOfDevice`, `pinCandidates` (§5 del ADR), `openTerminalSession`,
`checkTerminalSession` (la llama `requireSession`), `terminalUserOfRequest`
(lo usa `loadSubject` para marcar `Subject.terminal`),
`assertNotTerminalSession` (seguridad de la cuenta), `touchTerminalSession`,
`hashPin`/`verifyPin`/`verifyNoPin`, `PIN_ROLE_SETS`, `rotateTerminalSecret`
(el secreto rota en cada entrada con PIN; un secreto ya rotado pasados
`TERMINAL_SECRET_GRACE_MS` quita la terminal), `refuseOnTerminal` y
`TERMINAL_PASSWORD_PATH` (en una terminal no se entra con contraseña:
`signIn` y `verifySignInCode` responden `terminal`, y `requireSession`
cierra una sesión sin terminal que llegue con cookie de terminal).
`usersWhoMustUseMfa` (en `mfa-policy.ts`) es la regla de dos pasos para
una persona o una lista.

## Permisos

`platform.terminal.read` (titular, administración, Gerencia) y
`platform.terminal.manage` (titular, administración). Poner el PIN propio no
es un permiso: lo decide `pinCandidates`.

Una sesión de PIN lleva `Subject.terminal`: la política (`keptAtTerminal`)
le quita todo `platform.*` salvo `TERMINAL_PLATFORM_KEEP` (leer empresa,
módulos y capacidad), toda exportación y todo costo
(`TERMINAL_COST_PERMISSIONS`); el motor de aprobaciones no la deja
decidir. Aceptar una invitación también la rechaza. La seguridad de la cuenta (dos pasos, sesiones, PIN) la rechaza
cada servicio con `assertNotTerminalSession`.

## Tablas

`shared_terminal` (almacén, nombre, SHA-256 del secreto, quién la registró,
último uso, `removedAt`, secreto anterior y hora de la rotación; no se
borra ni cambia de empresa o almacén, y el secreto solo cambia rotando:
disparadores) y `member_pin` (persona + empresa, hash scrypt sobre
un HMAC del PIN con el secreto del servidor, la empresa y la persona; se
borra al quitarlo o al desactivar a la persona). En `session`:
`terminalId` y `terminalIdleSeconds`.

## Intentos

`pinUserTerminal` (persona en esa terminal: 5 en 15 minutos → 15 minutos),
`pinUser` (persona en todas: 15 en 1 hora → 1 hora) y `pinTerminal` (20 en
15 minutos → 15 minutos para todos). Cada bloqueo deja bitácora
(`pin.locked`, `terminal.locked`) y avisa; entrar con contraseña borra los
de la persona (`clearPinAttempts`). Solo los toques de la persona
(`keepTerminalSessionAction`) mueven la actividad de una sesión de PIN. Bitácora de empresa: `terminal.registered`,
`terminal.removed`, `terminal.locked`, `terminal.cloned`, `pin.locked`,
`pin.set`, `pin.changed`, `pin.removed`. Eventos de seguridad: `pin_sign_in.succeeded`,
`pin_sign_in.failed`, `pin.locked`.

## Pantallas

`/terminal` («¿Quién eres?» y teclado; pública, sin sesión),
`/configuracion/terminales`, `/configuracion/terminales/[id]` y
`/configuracion/pin`. La barra de la terminal (`(app)/terminal-bar.tsx`) va
arriba de cada pantalla en una sesión de PIN.

## Pruebas

`tests/platform/terminals.int.test.ts`, `src/platform/terminals/pin-rules.test.ts`
y el caso de terminal de `src/platform/authorization/policy.test.ts`.
