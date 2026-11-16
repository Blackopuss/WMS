# ADR 0064 — Historial de accesos y alertas de accesos sospechosos

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-68 (transversal) · Usa
ADR 0003 (autenticación), ADR 0006 (bitácora), ADR 0059 (sesiones del
equipo), ADR 0061 (terminales con PIN), PLT-06 (límite de intentos) y
PLT-16 (correos después de responder)

## Contexto

La especificación (sección de seguridad: «enviar correo ante inicios de
sesión sospechosos y eventos relevantes. Registrar historial de accesos») y
la decisión del fundador del 2026-11-16 piden:

- un **historial de accesos por persona**: entradas correctas, intentos
  fallidos relevantes, cierres de sesión a distancia y bloqueos por
  intentos, con fecha, dispositivo y navegador, IP y terminal si aplica;
- **alertas de acceso sospechoso** por **dispositivo o navegador nuevo** y
  por **muchos intentos fallidos**. **Sin país por IP en este paso**: sin
  base de países, sin servicio externo y sin dependencia nueva.

Lo que ya existía:

- `security_event` (PLT-14): eventos de seguridad **de una persona** (sin
  empresa), solo-agregar por disparadores, con `action`, `metadata`
  saneada e `ipAddress`. Ya registraba `sign_in.succeeded` (con o sin dos
  pasos), `mfa.backup_code_used`, `pin_sign_in.succeeded|failed`,
  `pin.locked`, `session.revoked`, `session.revoked_others`,
  `password.reset` y los cambios de dos pasos.
- `session` (Better Auth): solo las sesiones **abiertas**; se borra al
  cerrar. No sirve de historial.
- `audit_event`: bitácora **de empresa** (`team.session_revoked`,
  `team.sessions_revoked`), que ve quien tiene `platform.audit.read`.
- `auth_throttle`: contadores de intentos (PLT-06), sin persona.

No se guardaba: la contraseña equivocada de una cuenta que existe, el
código de dos pasos equivocado, el bloqueo de la cuenta, el cierre de
sesiones hecho por el equipo (solo en la bitácora de la empresa, no en la
de la persona), ni el dispositivo de cada entrada.

## Decisión

### 1. Se reutiliza `security_event`: nada de tabla nueva

El historial es una **lectura nueva** de `security_event`, que ya es el
registro de seguridad por persona, solo-agregar y sin llave foránea (el
historial sobrevive a la cuenta). Una migración **solo de expansión**
agrega tres columnas que admiten vacío y dos índices:

| Columna | Para qué |
| --- | --- |
| `eventOrganizationId` | Empresa del evento cuando ocurre dentro de una (entrada o PIN equivocado en una terminal, cierre por el equipo). Vacío en los eventos de la cuenta (contraseña, dos pasos, recuperación). Sin llave foránea, como `userId`. |
| `deviceKey` | Tipo de dispositivo, navegador y sistema que reconoce `describeUserAgent` (`phone|Chrome|Android`). **Nunca el texto crudo** del navegador: solo lo que ya se muestra en las sesiones. |
| `dedupeKey` | Llave para que algo pase **una sola vez** por persona (`@@unique([userId, dedupeKey])`; los vacíos no chocan). La usan las alertas y los bloqueos. |

La columna se llama `eventOrganizationId` y no `organizationId` a
propósito: `security_event` es una tabla de personas, que su dueño lee a
través de empresas; no es una tabla de empresa (`TENANT_MODELS`, PLT-13) y
no se lee con `forOrganization`. Cada lectura filtra por persona y decide
qué empresas le tocan (§3).

Índice: `(userId, dedupeKey)` único. También sirve para leer los
dispositivos conocidos (`device:<deviceKey>`), así esa lectura nunca
recorre los fallos de la persona; el índice `(userId, deviceKey)` de la
primera migración se quitó en la segunda (revisión). Las filas viejas
quedan con las columnas vacías (no se reescriben: la tabla no admite
cambios).

Filas internas, que no se listan: `access.device_known` (un dispositivo
que la persona conoce), `access.mail_slot` (cada correo de alerta del
día) y `access.claim` (quién atiende una alerta ese día).

**Retención:** igual que el resto de la bitácora (ADR 0006): no se borra
nada (los disparadores lo impiden y borrar un registro de seguridad sería
lo que buscaría un intruso). **Pendiente: no hay purga.** Lo que alguien
sin la contraseña puede escribir contra una cuenta que existe es, como
máximo, unos 480 `sign_in.failed` al día (5 por ventana de 15 minutos,
96 ventanas) y 96 `sign_in.locked`, más una alerta de intentos y una de
PIN; una purga de lo viejo (con su decisión de cuánto guardar) queda para
cuando haya servidor y datos reales. **Tope de filas:** la pantalla pagina en la
base (25 por página, orden `createdAt` y `id` descendentes, sobre el
índice `(userId, createdAt)`). Lo que puede escribir alguien sin la
contraseña está acotado por los límites de intentos que ya existen: una
contraseña equivocada por intento permitido (5 por cuenta cada 15
minutos), un bloqueo por ventana de 15 minutos y una alerta por día; un
correo que no tiene cuenta no escribe nada.

### 2. Qué entra al historial

| Evento (`action`) | Cuándo | Empresa |
| --- | --- | --- |
| `sign_in.succeeded` | Contraseña aceptada sin dos pasos, o código de la app aceptado | — |
| `mfa.backup_code_used` | Entrada con código de recuperación | — |
| `sign_in.failed` | Contraseña equivocada **de una cuenta que existe** | — |
| `mfa_code.failed` | Código de la app o de recuperación equivocado | — |
| `sign_in.locked` | La cuenta quedó bloqueada por contraseñas equivocadas (una vez por ventana) o Better Auth la bloqueó por códigos equivocados | — |
| `pin_sign_in.succeeded` / `pin_sign_in.failed` | Entrada o PIN equivocado en una terminal (con su `terminalId`) | La de la terminal |
| `pin.locked` | El PIN de la persona quedó bloqueado | La de la terminal |
| `session.revoked` / `session.revoked_others` | La persona cerró una u otras de sus sesiones | — |
| `session.closed_by_team` | El titular o un administrador cerró una o todas sus sesiones, o la desactivó | La que cerró |
| `password.reset` | Restableció la contraseña con el enlace del correo | — |
| `access.alert_new_device`, `access.alert_password_new_device`, `access.alert_failed_attempts`, `access.alert_pin_locked` | Una alerta (abajo); `metadata.mail` dice si salió el correo (`sent`) o por qué no (`daily_limit`, `unverified`, `no_pin`) | — |

Cada fila guarda fecha, IP (la de `clientIp`, reglas de ADR 0003) y
dispositivo cuando hay petición. Los demás eventos de `security_event`
(activar dos pasos, generar códigos) siguen ahí pero no son accesos y no
se listan.

El código de dos pasos equivocado no trae la persona: Better Auth la
guarda en su reto (`verification`), apuntado por la cookie firmada
`two_factor`. `challengeUserId` comprueba esa firma (HMAC-SHA256 con el
secreto de la app, el mismo formato de `better-call`) y lee el reto; sin
firma válida o sin reto no se registra nada. Una prueba hace el recorrido
real, así que si Better Auth cambia el formato la prueba falla.

### 3. Quién ve qué

- **Cada persona, el suyo completo**, en Configuración › Seguridad ›
  «Historial de accesos» (`/configuracion/accesos`). Una sesión de PIN no
  lo ve (en la terminal no se toca la seguridad de la cuenta, ADR 0061;
  `assertNotTerminalSession`).
- **Titular, administración y Gerencia** (`platform.session.read`, el mismo
  permiso de las sesiones del equipo: el historial es el pasado de esas
  sesiones; no se agrega permiso) ven el de una persona de su empresa en
  `/configuracion/equipo/[persona]/accesos`, enlazado desde el detalle de
  la persona. **Lo de otra empresa no existe** (regla de ADR 0059):
  - los eventos con `eventOrganizationId` de esta empresa, siempre;
  - los eventos de la cuenta (`eventOrganizationId` vacío) **solo si la persona
    no tiene membresía en ninguna otra empresa** y solo mientras perteneció
    a esta: desde que entró, sin el tiempo en que estuvo desactivada (los
    periodos salen de la bitácora de la empresa, `team.member_disabled` y
    `team.member_reactivated`), y nada después de desactivarla si sigue
    así. Si trabaja también para otra, no se puede saber para cuál entró
    con su contraseña, así que su administrador ve únicamente lo que pasó
    dentro de su empresa (terminales y cierres);
  - los eventos con `eventOrganizationId` de otra empresa, nunca.
  Una persona que no es de la empresa no existe (`null` → 404).
- La IP se muestra como en las sesiones del equipo (`formatIp`). Nunca el
  texto crudo del navegador, tokens ni secretos.

### 4. Cuándo sale una alerta

**Dispositivo o navegador nuevo.** En cada entrada correcta **con
contraseña** (con o sin dos pasos, o con código de recuperación), después
de registrarla:

1. Si la persona no conoce todavía ningún dispositivo, es su **primer
   acceso** (o el primero desde este paso): se aprende el dispositivo y
   **no hay alerta**. Así una cuenta recién creada, o todas las cuentas al
   desplegar este paso, no reciben un correo por entrar.
2. Si conoce otros y no este, es nuevo: alerta `new_device:<deviceKey>`,
   una sola vez por dispositivo y persona (la llave única impide que dos
   entradas al mismo tiempo manden dos correos). **El dispositivo se
   aprende solo cuando el correo salió**: si no salió (tope del día), su
   siguiente entrada vuelve a avisar.

**Contraseña correcta desde un dispositivo nuevo y código equivocado**
(revisión): quien escribe un código equivocado ya pasó la contraseña. Si
lo hace desde un dispositivo que la persona no conoce (y conoce alguno),
alerta `password_new_device:<deviceKey>`, una vez por dispositivo. Es la
señal más fuerte de que alguien tiene la contraseña.

«Dispositivo» = tipo, navegador y sistema que ya reconoce
`describeUserAgent`. Es deliberadamente grueso: **sin huella del
navegador, sin cookie de dispositivo y sin dependencias**. Detecta un
teléfono o un navegador distintos, no otra computadora con el mismo
navegador y sistema. Una cookie de dispositivo lo afinaría, pero sería un
identificador persistente nuevo en el navegador de cada persona; queda
como mejora posible si el fundador la pide.

Las entradas con **PIN** no alertan por dispositivo: la terminal es un
dispositivo de la empresa ya registrado y su copia se detecta aparte (ADR
0061). Tampoco cuentan como dispositivo conocido para la contraseña.

**Muchos intentos fallidos.** Cuando la cuenta queda bloqueada:

- por contraseñas equivocadas (el contador de la cuenta de PLT-06 llegó a
  su límite: 5 en 15 minutos);
- por códigos de dos pasos equivocados (Better Auth bloquea la cuenta tras
  10 seguidos: alguien tiene la contraseña). Better Auth pone el bloqueo
  en el código que llega al límite y todavía responde «código
  equivocado», así que tras cada código equivocado se lee
  `twoFactor.lockedUntil` y se alerta ahí mismo, sin esperar otro intento.

Alerta `failed_attempts:<día UTC>`: **una por persona por día**, aunque
el ataque siga.

**PIN bloqueado** en una terminal (`pin.locked`): alerta propia
`pin_locked:<día UTC>` con su propio texto (se bloqueó el PIN, no la
cuenta) y su propia llave (no gasta la de la cuenta). **Sin correo para
quien no tiene PIN**: cualquiera frente a una terminal puede elegir el
nombre de un compañero; la alerta queda en su historial.

**Tope:** como mucho `ACCESS_ALERTS_PER_DAY` (5) correos de alerta por
persona por día UTC, de cualquier tipo. Cada correo toma un turno
numerado (`alert_mail:<día>:<n>`, único por persona), así el tope se
respeta aunque lleguen muchas alertas a la vez; y antes de tomar un turno
una alerta se aparta para un solo pedido ese día (`claim:<llave>:<día>`),
así peticiones simultáneas de la misma alerta no gastan turnos. Lo que
pasa del tope **queda en el historial con `metadata.mail = daily_limit`**,
una vez al día por alerta.

### 5. A quién y cómo

- **Correo a la persona dueña de la cuenta**, solo si su correo está
  confirmado. Se manda **después de responder** (`afterResponse`, que le
  pasa a `after()` una función: nada empieza antes de la respuesta). Todo
  lo de una contraseña equivocada (buscar a la persona, la fila, el
  bloqueo y la alerta) también corre después de responder: un intento
  contra una cuenta que existe tarda lo mismo que contra un correo sin
  cuenta, y la respuesta nunca revela si la cuenta existe. (Los correos
  propios de Better Auth le llegan a `after()` como una promesa ya
  empezada: así los entrega Better Auth y no se cambió aquí.)
- El correo dice qué pasó, cuándo (en la zona horaria de su primera
  empresa, o la de México), en qué dispositivo y, en el de dispositivo
  nuevo, desde qué IP (es la entrada a **su** cuenta). El de intentos
  fallidos y el de PIN no llevan IP. Sin enlaces de acceso: solo la dirección de
  «Recuperar contraseña» (sin token) y dónde ver el historial.
- **Sin aviso en la campana.** Una entrada a la cuenta no es de ninguna
  empresa y la campana es por empresa; además, el primero en verla sería
  quien acaba de entrar, que puede ser el intruso. El correo al buzón
  confirmado es el canal que importa. Queda la marca «Sospechoso» en el
  historial.
- **Titular y administración no reciben alertas por persona** (serían
  ruido y, si la persona trabaja en varias empresas, hablarían de otra).
  Ven las marcas en el historial de su gente con las reglas de §3, y
  siguen recibiendo los avisos de terminales que ya existen (ADR 0061).
- **Nada se configura** en este paso, ni por empresa ni por persona: las
  alertas de seguridad de la propia cuenta no se apagan.

### 6. País por IP: cómo entrará (no se construye)

Cuando haya servidor detrás de Cloudflare, este manda el país en la
cabecera `CF-IPCountry`. Entrará así:

- un ajuste de despliegue apagado por omisión (`TRUST_COUNTRY_HEADER`) y
  solo con el sitio servido **exclusivamente** a través de Cloudflare
  (Caddy acepta conexiones solo de sus rangos o por túnel); si no, un
  cliente podría mandar la cabecera y elegir su país;
- se lee en el mismo lugar que `clientIp`, se guarda como código ISO de
  dos letras en una columna nueva de `security_event` y suma a
  «dispositivo nuevo» un «país nuevo» con la misma regla de primer acceso;
- nunca se usa para decidir permisos, solo para alertar.

No se construye ahora: sin el proxy delante no hay forma de probarlo con
una cabecera de confianza.

## Modelo de amenazas (resumen; detalle en `docs/seguridad/REVISION_ACCESOS.md`)

- **Enumeración de cuentas:** misma respuesta, misma búsqueda y correo
  después de responder; el historial y las alertas solo los ve la cuenta y
  su empresa.
- **Inundar de correos a alguien:** sin la contraseña solo se puede
  provocar la alerta de intentos fallidos, una por día; con todo, cinco
  alertas por día como máximo.
- **Inflar el historial:** acotado por los límites de intentos (§1).
- **Fuga entre empresas:** regla de §3, probada.
- **Duplicados por peticiones simultáneas:** llave única por persona.
- **Datos sensibles guardados:** ni contraseñas, ni códigos, ni PIN, ni
  tokens, ni el texto del navegador; `metadata` sigue saneada.
- **Borrar huellas:** solo-agregar por disparadores.

## Consecuencias

- `recordSecurityEvent` acepta empresa, dispositivo y un cliente de
  transacción (para escribir junto con el cierre de sesiones del equipo);
  `claimSecurityEvent` escribe algo que debe pasar una sola vez.
- Todo camino nuevo de entrada o de intento llama a las funciones de
  `src/platform/auth/access-history.ts` (`noteSignIn`, `noteFailedSignIn`,
  `noteFailedCode`, `noteCodeLock`, `alertFailedAttempts`, `alertPinLocked`) y agrega su
  caso a `tests/platform/access-history.int.test.ts`.
- Pendiente: atribuir a una empresa la entrada con contraseña de quien
  trabaja en varias; cookie de dispositivo (si se pide); país por IP (§6);
  aviso en la campana si el fundador lo quiere.
