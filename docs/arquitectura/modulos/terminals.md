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
| Ajustes | `settings.ts` | `TERMINAL_SETTINGS`: `platform.terminal.pin_roles`, `.pin_length`, `.idle_minutes` (en `operationSettings`, mostrados en la pantalla de terminales y no en Operación) |
| Avisos | `notices.ts` | `platform.terminal_locked` (a quien tiene `platform.terminal.manage` en el almacén) |

En `platform/auth` (`terminal-session.ts`, `pin-hash.ts`):
`terminalOfDevice`, `pinCandidates` (§5 del ADR), `openTerminalSession`,
`checkTerminalSession` (la llama `requireSession`), `terminalUserOfRequest`
(lo usa `loadSubject` para marcar `Subject.terminal`),
`assertNotTerminalSession` (seguridad de la cuenta), `touchTerminalSession`,
`hashPin`/`verifyPin`/`verifyNoPin`, `PIN_ROLE_SETS`.

## Permisos

`platform.terminal.read` (titular, administración, Gerencia) y
`platform.terminal.manage` (titular, administración). Poner el PIN propio no
es un permiso: lo decide `pinCandidates`.

Una sesión de PIN lleva `Subject.terminal`: la política le quita todo
`platform.*` salvo `TERMINAL_PLATFORM_KEEP` (leer empresa, módulos y
capacidad). La seguridad de la cuenta (dos pasos, sesiones, PIN) la rechaza
cada servicio con `assertNotTerminalSession`.

## Tablas

`shared_terminal` (almacén, nombre, SHA-256 del secreto, quién la registró,
último uso, `removedAt`; no se borra ni cambia de empresa, almacén o
secreto: disparadores) y `member_pin` (persona + empresa, hash scrypt sobre
un HMAC del PIN con el secreto del servidor, la empresa y la persona; se
borra al quitarlo o al desactivar a la persona). En `session`:
`terminalId` y `terminalIdleSeconds`.

## Intentos

`pinUser` (5 fallos en 15 minutos → 30 minutos; se borra al entrar con
contraseña) y `pinTerminal` (20 en 15 minutos → 15 minutos para todos,
bitácora `terminal.locked` y aviso). Bitácora de empresa: `terminal.registered`,
`terminal.removed`, `terminal.locked`, `pin.set`, `pin.changed`,
`pin.removed`. Eventos de seguridad: `pin_sign_in.succeeded`,
`pin_sign_in.failed`, `pin.locked`.

## Pantallas

`/terminal` («¿Quién eres?» y teclado; pública, sin sesión),
`/configuracion/terminales`, `/configuracion/terminales/[id]` y
`/configuracion/pin`. La barra de la terminal (`(app)/terminal-bar.tsx`) va
arriba de cada pantalla en una sesión de PIN.

## Pruebas

`tests/platform/terminals.int.test.ts`, `src/platform/terminals/pin-rules.test.ts`
y el caso de terminal de `src/platform/authorization/policy.test.ts`.
