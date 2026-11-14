# ADR 0061 — Terminales compartidas: cambio rápido de persona con PIN

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-38 (transversal) · Usa
ADR 0003 (autenticación), ADR 0005 (empresas), ADR 0034 (ajustes de
operación), ADR 0035 (varios almacenes), ADR 0038 (alcance), ADR 0049 (app
instalable), ADR 0057 (avisos), ADR 0059 (sesiones del equipo)

## Contexto

La especificación (terminales compartidas y pantallas táctiles,
identificación rápida con PIN, cierre de sesión y trazabilidad individual) y
el plan v3 («WMS-38 · Terminales compartidas: cambio rápido de persona con
PIN, cierre automático y rastro individual») piden que en el piso muchas
personas usen pocos dispositivos sin escribir correo y contraseña cada vez.
El fundador decidió el 2026-11-14 que **toda persona que opera tiene su
cuenta con rol**: el PIN no crea trabajadores sin usuario, es otra forma de
que una persona con cuenta abra **su propia** sesión en un dispositivo
compartido.

Un PIN de 5 o 6 dígitos es un secreto débil (97,450 o 893,660 válidos
tras quitar los fáciles de adivinar). Todo el diseño parte de eso: el PIN solo sirve en un
dispositivo que la empresa registró, para pocas personas, con pocos intentos
y para sesiones cortas que no pueden tocar nada de seguridad ni de
administración.

La identificación con tarjeta NFC que menciona la especificación queda
fuera de este paso (ver «Lo que queda previsto»).

## Flujo operativo

### 1. Registrar una terminal (una vez por dispositivo)

- **Quién:** el titular o un administrador (permiso nuevo
  `platform.terminal.manage`), con su sesión completa (contraseña y, por ser
  quien es, verificación en dos pasos).
- **Dónde:** en el **mismo dispositivo** que será la terminal (una tableta o
  computadora de piso, de preferencia con la app instalada, ADR 0049):
  Configuración › Terminales compartidas › «Registrar este dispositivo».
- **Qué captura:** nombre de la terminal («Andén 2», hasta 60 caracteres,
  único entre las terminales activas de la empresa) y almacén (uno activo,
  dentro de su alcance).
- **Qué pasa:** se crea la terminal con un secreto propio de 256 bits. El
  dispositivo lo guarda en una cookie `HttpOnly`, `Secure` (fuera de
  desarrollo, con prefijo `__Host-`), `SameSite=Strict`, `Path=/`, de 400
  días; la base guarda solo su SHA-256 (un secreto aleatorio de 256 bits no
  necesita hash lento). **La sesión del administrador se cierra en ese
  dispositivo** en el mismo paso: un dispositivo compartido no se queda con
  una sesión de administración abierta. La pantalla pasa a «¿Quién eres?».
- **Rastro:** bitácora de la empresa `terminal.registered` (nombre y
  almacén; nunca el secreto).
- **El secreto rota en cada entrada con PIN** (`rotateTerminalSecret`), con
  **detección de reúso** (como los tokens de refresco). La cookie se
  reescribe con un secreto nuevo (eso también la renueva, así que una
  terminal en uso no vence a los 400 días) y la base guarda **cada** secreto
  emitido (`shared_terminal_secret`: solo su SHA-256, cuándo se emitió y
  cuándo lo presentó por primera vez una petición). Reglas
  (`terminalBySecret`):
  1. El vigente es el más nuevo.
  2. Uno más viejo sigue sirviendo, y puede volver a rotar, **mientras
     ningún secreto más nuevo se haya presentado**: si la respuesta con el
     secreto nuevo se pierde (wifi del almacén), el nuevo nunca llegó a
     nadie y la terminal sigue funcionando con el viejo, pase el tiempo que
     pase.
  3. Si se presenta uno más viejo **después** de que uno más nuevo ya se
     presentó, y fuera de `TERMINAL_SECRET_GRACE_MS` (2 minutos para
     peticiones en camino), hay dos dispositivos con la cookie: el sistema
     quita la terminal (`removedByUserId` vacío), cierra sus sesiones, deja
     bitácora `terminal.cloned` y avisa a quien administra terminales del
     almacén (`platform.terminal_cloned`). Vale para cualquier generación
     anterior, no solo la inmediata: una copia que entra con PIN varias
     veces deja a la terminal real atrás, y cuando la real vuelve se
     detecta.
  4. Un secreto que nunca se emitió para esa terminal no hace nada:
     forjar `id.secreto` no la tumba.
  Rotar bloquea la terminal: dos entradas a la vez rotan una sola vez (la
  segunda ve un secreto emitido hace menos de la gracia y no rota otra vez).
  De un secreto solo cambia `presentedAt`, una vez y nunca antes de
  emitido; hash, terminal y fechas no cambian, y solo se borran los de más
  de 30 días (limpieza al rotar; un secreto borrado ya no abre nada):
  disparadores y `CHECK`.
- Pendiente (no se hizo): una lista de redes permitidas por terminal.
- Si el dispositivo ya era terminal de la misma empresa, la pantalla lo dice
  y no ofrece registrarlo otra vez (se quita primero). Si era terminal de
  otra empresa, registrarlo reemplaza la cookie; la otra empresa la sigue
  viendo en su lista hasta que la quite (no se toca nada de otra empresa).

### 1 bis. En una terminal no se entra con contraseña (regla fija)

En un navegador con cookie de terminal válida **no se inicia sesión con
correo y contraseña**: `signIn` y `verifySignInCode` responden `terminal`,
y las pantallas `/ingresar`, `/registro`, `/verificar-codigo` e
`/invitacion` (y sus acciones) mandan a `/terminal?aviso=contrasena`, que
explica que ahí se entra con PIN y que para la contraseña se use otro
dispositivo (`refuseOnTerminal`). Además `requireSession` **cierra
cualquier sesión sin `terminalId` que llegue con cookie de terminal
válida**: nadie deja una sesión completa (de 7 días, sin recorte ni cierre
por inactividad) en un dispositivo compartido. Por eso quitar una terminal
se hace desde otro dispositivo.

Alternativa para el fundador (no se hizo): permitir la contraseña en la
terminal, con la misma barra y el mismo cierre por inactividad que una
sesión de PIN.

### 2. Lista y quitar

- Configuración › Terminales compartidas lista las terminales activas:
  nombre, almacén, quién la registró y cuándo, último uso. Ver la lista pide
  `platform.terminal.read` (titular, administración y Gerencia); quien está
  limitado a almacenes (WMS-20) solo ve las de su alcance.
- La fila abre el detalle; ahí está «Quitar terminal» (con confirmación y
  motivo opcional, `platform.terminal.manage`).
- **Quitar** marca la terminal como quitada (no se borra: la bitácora y los
  eventos de seguridad la nombran), invalida su secreto (ninguna cookie
  vuelve a servir) y **borra todas sus sesiones** en la misma transacción.
  Bitácora `terminal.removed`.
- Archivar un almacén con terminales activas se rechaza (hay que quitarlas
  antes), como con los traslados abiertos.

### 3. Poner mi PIN

- **Quién:** cada persona, para sí misma, con su sesión completa (nunca desde
  una sesión de PIN), en Configuración › «Mi PIN».
- **Cuándo aparece:** solo si la persona puede usar PIN en esa empresa (ver
  §5); si no, la tarjeta no se muestra.
- **Qué pide:** su contraseña actual (con límite de intentos por persona,
  como al activar dos pasos), el PIN y el PIN otra vez.
- **Reglas del PIN:** solo dígitos, con la longitud del ajuste de la empresa
  (5 o 6; por omisión 6; 4 se quitó en la revisión: con el ritmo real de
  intentos aguanta días, y con PIN elegidos por personas, horas). Se
  rechazan los triviales: todos iguales (`000000`), escaleras hacia arriba
  o abajo (`123456`, `654321`, también dando la vuelta: `890123`), patrones
  repetidos de dos o tres dígitos (`121212`, `123123`), los que empiezan o
  terminan con un año de 1930 a 2039 (`198712`, `042019`) y los de seis
  que se leen como fecha (DDMMAA, MMDDAA, AAMMDD), cada dígito doble o
  triple en escalera (`112233`, `111222`) y las figuras del teclado: dos
  líneas de tres teclas seguidas, en filas, columnas o diagonales (`147258`,
  `159753`, `789456`) o sus primeras cinco. Quedan 893,660 combinaciones de
  seis dígitos y 97,450 de cinco. Las reglas son puras (`pinProblem`, con
  prueba unitaria).
- **Cómo se guarda:** con el mismo hash lento de las contraseñas (scrypt,
  `hashPassword`) sobre un HMAC del PIN con el secreto del servidor, la
  empresa y la persona (`pinMaterial`). Así una copia de la base sin el
  secreto no basta para probar PINs fuera de línea, y el hash de una persona
  no sirve en otra fila. Nunca en claro, ni en logs, ni en la bitácora, ni en
  eventos.
- **Es de la persona en esa empresa** (`member_pin`, única por empresa y
  persona). En otra empresa pone otro.
- **Cambiarlo o quitarlo** cierra sus sesiones de terminal en esa empresa.
  Bitácora `pin.set`, `pin.changed` o `pin.removed` (sin el PIN).
- **Cambiar la longitud del ajuste** no invalida los PINs que ya existen: el
  teclado acepta 5 o 6 dígitos y la nueva longitud se exige al ponerlo o
  cambiarlo. Bajar la longitud no debilita los existentes; subirla se aplica
  a cada persona cuando lo cambie (se dice junto al ajuste).

### 4. Entrar con PIN («¿Quién eres?»)

- **Dónde:** solo en una terminal registrada, en `/terminal`. La pantalla lee
  la cookie de la terminal; si no hay una terminal activa que coincida, dice
  «Este dispositivo no es una terminal compartida» y ofrece «Ingresar» con
  correo. Desde cualquier otro dispositivo o desde internet **el PIN no
  existe**: ni la lista de personas, ni el teclado, ni la acción responden
  algo distinto a eso.
- **Elegir persona:** botones grandes con el nombre de las personas del
  almacén de la terminal que **pueden** usar PIN (§5), en orden alfabético,
  con un cuadro «Busca tu nombre» que filtra la lista. La lista **no dice
  quién tiene PIN**: aparece todo el que podría usarlo. Solo el nombre (sin
  correo, roles ni nada más). Tope 300 personas.
- **Teclado numérico:** en pantalla, de botones grandes (≥ 64 px), con
  «Borrar» y «Entrar» con texto; sin teclado físico funciona igual. Los
  dígitos se muestran como puntos.
- **Qué valida el servidor**, en este orden:
  1. La terminal (cookie → secreto → terminal activa de una empresa).
  2. El intento se aparta **antes** de verificar (`reserveAttempt`) en dos
     llaves: la persona y la terminal (§6).
  3. Que la persona aparezca en la lista de esa terminal (§5) y que su PIN
     coincida. Si no tiene PIN, o no puede usarlo, se calcula de todas
     formas un hash con un PIN falso (mismo tiempo) y la respuesta es la
     misma: «PIN incorrecto.»
  4. Si a la cuenta le falta algo (correo sin confirmar o documentos
     legales vigentes sin aceptar), no entra: «Entra con tu correo y
     contraseña para terminar de configurar tu cuenta.» Se decide **antes**
     de mirar el PIN y sin gastar intento, así la respuesta nunca confirma
     que un PIN era correcto (antes, solo el PIN correcto daba esta
     respuesta y servía de oráculo).
- **Qué pasa al entrar:**
  - Se borra cualquier otra sesión de esa terminal (una terminal es un
    dispositivo: una persona a la vez).
  - Se crea una **sesión propia de esa persona** (`session` de Better Auth,
    con su token y cookie firmada de siempre) marcada con la terminal
    (`session.terminalId`), con la empresa de la terminal como empresa
    activa y el tiempo sin actividad del ajuste guardado en la misma fila
    (`terminalIdleSeconds`).
  - El almacén activo de la persona pasa a ser el de la terminal
    (`membership.activeFacilityId`), porque todo lo que hace en el piso es
    de ese almacén. Consecuencia aceptada: si después abre la app en su
    teléfono, la verá en ese almacén (puede cambiarlo, como hoy).
  - Último uso de la terminal (`lastUsedAt`), evento de seguridad
    `pin_sign_in.succeeded` con la terminal.
  - Va a Inicio. Todo lo que haga queda a su nombre, igual que con
    contraseña.

### 5. Quién puede entrar con PIN

Todas las condiciones, revisadas al listar, al entrar y en cada petición de
la sesión:

- Miembro **activo** de la empresa de la terminal, cuyo alcance (WMS-20)
  incluye el almacén de la terminal.
- **Nunca** quien tiene verificación en dos pasos obligatoria
  (`isMfaRequired`: titular de cualquier empresa, administrador, personal de
  plataforma), ni quien la activó por su cuenta: el PIN la saltaría.
- **Todos** sus roles están entre los que la empresa permite con PIN (ajuste
  `platform.terminal.pin_roles`):
  - `floor` (por omisión): Almacenista y Montacarguista.
  - `floor_supervision`: además Supervisor de almacén y Almacén.
  - `without_mfa`: todos los roles que no exigen dos pasos (además
    Comprador, Consulta y Gerencia).
  
  Nunca más que eso: Administrador no es opción en ningún valor. Una persona
  con un rol fuera del valor elegido no aparece (aunque tenga otro que sí).
- Correo confirmado y documentos legales vigentes aceptados (si falta, se le
  dice que entre con contraseña después de un PIN correcto, §4).

Si algo de esto deja de cumplirse con una sesión de PIN abierta (le dan un
rol de administrador, activa dos pasos, la desactivan, cambia el ajuste, le
quitan el almacén), la sesión deja de servir en la siguiente petición.

### 6. Intentos

Tres llaves, todas apartadas **antes** de verificar (`reserveAttempt`):

| Llave | Límite | Bloqueo | Para qué |
| --- | --- | --- | --- |
| `pinUserTerminal` (persona en esa terminal) | 5 en 15 min | 15 min | El bajo: un compañero que teclea PIN malos a propósito solo bloquea a esa persona en esa terminal, un rato |
| `pinUser` (persona en todas) | 30 en 1 hora | 1 hora | Por encima de lo que una sola terminal puede producir (con 5 cada 15 minutos y 15 de bloqueo, a lo más 20 por hora contra una persona): exige intentos desde más de una terminal, así un compañero en una terminal nunca deja a la persona fuera de las demás |
| `pinTerminal` (la terminal) | 20 en 15 min | 15 min | Quien prueba con muchas personas detiene la terminal para todos |

- **Fallos sostenidos sin bloqueo:** por debajo de los límites (4 por
  persona y 19 por terminal cada 15 minutos) no se bloquea nada, así que se
  cuentan los PIN incorrectos de cada terminal en 24 horas
  (`countInWindow`, `pin:terminal-day:<id>`); al llegar a
  `PIN_DAILY_FAILURES_NOTICE` (30) se avisa una vez a quien administra
  terminales del almacén.
- Cada bloqueo deja bitácora (`pin.locked` o `terminal.locked`) y avisa
  dentro de la app (`platform.terminal_locked`) a quien administra
  terminales del almacén; el de una persona la nombra. El evento de
  seguridad `pin.locked` queda en la cuenta.
- Entrar con su contraseña **desde su propio dispositivo** borra los
  bloqueos de su PIN (`clearPinAttempts`): probó quién es. La pantalla lo
  dice al bloquear: «Si es tu PIN, entra con tu contraseña desde tu propio
  dispositivo para desbloquearlo.»
- Un PIN correcto devuelve el intento a la terminal y borra los de la
  persona. Un error del servidor devuelve el intento **solo si ocurrió antes
  de terminar de comprobar el PIN**; después, el intento queda contado.
- Las respuestas no dicen si la persona tiene PIN: fallar con o sin PIN
  cuenta igual y dice lo mismo; el bloqueo dice lo mismo sea de quien sea.
- Tiempo para adivinar al azar (ver la tabla de
  `docs/seguridad/REVISION_PIN.md`): contra una persona desde una terminal,
  ≈14 intentos por hora: PIN de 6 dígitos ≈3.6 años en promedio (1 % en
  ≈27 días); de 5 dígitos ≈4.8 meses (1 % en ≈3 días). Contra cualquiera de
  N personas desde una terminal, ≈76 por hora: 6 dígitos ≈24 días con 20
  personas; 5 dígitos ≈2.7 días. Por eso **6 dígitos es el único valor por
  omisión** y la pantalla del ajuste dice que 5 es diez veces más fácil de
  adivinar. Las reglas rechazan además repetidos, escaleras, bloques,
  años, fechas y figuras del teclado (`147258`, `159753`, `112233`).

### 7. La sesión de PIN: corta y de una sola empresa

- **Sin actividad:** se cierra sola tras el tiempo del ajuste
  `platform.terminal.idle_minutes` (2, 5 por omisión, 10 o 15 minutos).
  Cómo se mide sin escribir en cada petición:
  - El servidor compara `session.lastActiveAt` (o `createdAt`) con el tiempo
    guardado en la sesión. `lastActiveAt` es la columna de WMS-40; en una
    sesión de terminal **ninguna petición la escribe** (la campana de avisos
    y los refrescos periódicos mantendrían viva una sesión abandonada): solo
    la entrada, los toques y las navegaciones de la persona.
  - En la terminal, una barra cliente cuenta el tiempo desde el último toque
    o tecla. Mientras la persona toca la pantalla avisa al servidor como
    mucho cada 15 segundos y siempre al final de cada racha de toques (2
    segundos después del último), y también al cambiar de pantalla (una
    navegación de la persona; los refrescos automáticos no cambian de
    pantalla). `keepTerminalSessionAction` escribe `lastActiveAt` en cada
    aviso, nunca hacia atrás: lo guardado va como mucho una racha detrás
    del último toque, así nadie sale a media operación (antes podía ir un
    minuto atrás y, con 2 minutos, sacar a alguien 66 segundos después de
    tocar). Un Server Action de la persona empieza siempre con un toque o
    una tecla, que la barra avisa; si pasa
    el tiempo sin toques, cierra la sesión y vuelve a «¿Quién eres?». Si el
    cierre falla o tarda más de 8 segundos, saca a la persona de todos modos
    (el servidor ya la considera inactiva). Si el navegador estaba dormido,
    el servidor la rechaza igual en la siguiente petición.
  - Costo: unas cuatro escrituras de una fila por minuto **por terminal
    en uso** (hay una sesión por terminal), fuera del tiempo de respuesta.
- **Límite absoluto:** 12 horas desde que entró (un turno largo), sin
  importar la actividad: la fila vence a esa hora (`expiresAt`). Better Auth
  no la extiende: la sesión se lee sin renovación cuando el navegador trae
  cookie de terminal, y si una página la lee sin esa cookie y Better Auth la
  alarga, `getCurrentSession` le devuelve su fin fijo.
- **«Cambiar de persona»:** botón grande con texto, siempre a la vista en la
  barra de la terminal (también en teléfono). Borra la sesión y vuelve a
  «¿Quién eres?».
- **Al cerrarse por cualquier motivo** (tiempo, cambio de persona, terminal
  quitada, persona desactivada, sesión cerrada desde Equipo) vuelve a
  «¿Quién eres?», no a «Ingresar».
- **Ligada al dispositivo:** en cada petición la sesión de PIN exige la
  cookie de **su** terminal en ese navegador y la terminal activa. Copiar
  solo la cookie de sesión a otro navegador no sirve.
- **Una sola empresa:** la empresa activa es siempre la de la terminal; no se
  puede cambiar de empresa ni cae a otra (`switchOrganization` lo rechaza y
  el selector no aparece). Si la membresía deja de servir, la sesión se
  borra.

### 8. Qué no puede una sesión de PIN

La decisión vive en el servidor, en dos lugares de una sola regla
(«una sesión de terminal es una sesión recortada»):

- **Permisos:** el sujeto de una petición hecha con sesión de terminal lleva
  `terminal: true` y la política (`permissionsOf`, la misma que recorta a
  soporte, con `keptAtTerminal`) le quita **todo permiso de plataforma**
  salvo leer la empresa, los módulos y la capacidad
  (`TERMINAL_PLATFORM_KEEP`), **toda exportación masiva**
  (`*.export.create` y los reportes como `purchasing.report.export`: el
  archivo quedaría en la tableta) y **leer costos**
  (`TERMINAL_COST_PERMISSIONS`: `inventory.cost.read`,
  `purchasing.cost.read`). Conserva, en una lista explícita
  (`TERMINAL_EXPORT_KEEP`), los documentos de una operación que no llevan
  costos y que el piso necesita: la hoja de embarque
  (`inventory.shipment.export`) y la hoja de traslado
  (`inventory.facility_transfer.export`). Conserva también registrar el
  último costo (`purchasing.cost.record`): no deja ver nada y, cortado, una
  recepción hecha en la terminal dejaría de actualizar el último costo sin
  decirlo. Los cambios de equipo (`withTeamChange`) y las opciones de
  alcance arman su sujeto con la misma marca de terminal (una sola
  decisión). Además **nunca decide una aprobación**:
  el motor (`mayDecide`) la rechaza como a soporte. Así no hay equipo,
  invitaciones, sesiones del equipo, bitácora, plan, configuración del
  negocio, reglas, terminales, soporte ni titularidad, aunque su rol los
  tuviera, y aunque alguien llame la acción o la dirección sin enlace. Los
  permisos de inventario y compras de sus roles se quedan: para eso está en
  la terminal. `loadSubject` lo sabe por la sesión de la petición
  (`terminalUserOfRequest`, en caché por petición); fuera de una petición
  (el worker) no hay terminal. Dentro de una petición, si leer la sesión
  falla, el error se propaga: el recorte nunca falla abierto.
- **Seguridad de la cuenta** (no depende de un permiso): activar,
  desactivar o regenerar dos pasos, ver o cerrar sus sesiones, poner o
  quitar su PIN, aceptar una invitación a otra empresa. Cada servicio llama
  `assertNotTerminalSession` y responde
  «Desde una terminal compartida no se cambia la seguridad de tu cuenta.»
  Hoy no hay cambio de contraseña ni de correo con sesión (se hace por
  recuperación, sin sesión).
- **API (WMS-60, ADR 0058):** las llaves y los webhooks se administran con
  `platform.api.manage`, que una sesión de PIN no tiene (permisos de
  plataforma recortados). WMS-60 agregó a `Subject` su propio recorte
  (`limit`: lo que la llave permite y, si es de un almacén, ese almacén);
  `permissionsOf` aplica el de terminal **encima** del de la llave (la
  intersección), y el alcance sigue saliendo solo de `scopeOf`. Además, una
  llamada de la API **nunca es una sesión de terminal**: dentro de
  `runDelegated`, `terminalUserOfRequest` responde «sin terminal» antes de
  mirar cookies, así que una llamada que llegue con la cookie de una
  terminal y la de una sesión de PIN (alguien que prueba la API desde el
  navegador de la tableta) no se recorta como terminal, no falla y no
  dispara la detección de copia. Nada de `/api/v1` ni de `platform/api` lee
  la sesión (`requireSession`, `getCurrentSession`) ni la terminal del
  dispositivo.

### 9. Con WMS-40 (sesiones del equipo)

- Una sesión de PIN tiene la empresa de la terminal como empresa activa, así
  que aparece sola en la lista de sesiones de la persona; la lista agrega
  «Terminal: <nombre>» y se cierra igual.
- Respeta `membership.sessionsRevokedAt` (`usableMembership`): una sesión de
  terminal anterior al corte no entra. Después del corte la persona puede
  volver a entrar con PIN, igual que con contraseña.
- **Desactivar a una persona le quita el PIN** (se borra su `member_pin` en
  la misma transacción) además de cerrar sus sesiones. Al reactivarla tiene
  que poner otro.

### 10. Qué se configura por empresa

Tres ajustes (`TERMINAL_SETTINGS`, `module: null`), mostrados en la pantalla
de terminales (no en Operación: una sola forma de cambiar cada cosa) y
cambiados con `updateOperationSetting` (`platform.organization.update`,
bitácora `settings.changed`):

| Clave | Opciones | Por omisión |
| --- | --- | --- |
| `platform.terminal.pin_roles` | `floor`, `floor_supervision`, `without_mfa` | `floor` |
| `platform.terminal.pin_length` | `5`, `6` | `6` |
| `platform.terminal.idle_minutes` | `2`, `5`, `10`, `15` | `5` |

Fijo en el código (no admite otra forma razonable, o es seguridad): el
límite absoluto de 12 horas, los límites de intentos, las reglas de PIN
trivial y que administradores y titulares nunca usan PIN.

## Permisos

| Permiso | T | A | AL | CO | CN | SU | AS | MO | GE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `platform.terminal.read` | Sí | Sí | No | No | No | No | No | No | Sí |
| `platform.terminal.manage` | Sí | Sí | No | No | No | No | No | No | No |

Poner el PIN propio no es un permiso: lo decide §5.

## Tablas

- `shared_terminal` (de empresa): almacén, nombre, `secretHash` (SHA-256,
  único), `previousSecretHash` y `secretRotatedAt` (rotación), quién la
  registró y cuándo, `lastUsedAt`, `removedAt` y quién la quitó (vacío si la
  quitó el sistema por copia). No se borra; el secreto solo cambia rotando
  (disparador).
- `member_pin` (de empresa): persona, `pinHash`, quién y cuándo lo puso.
  Única por empresa y persona. Se borra al quitarlo o al desactivar a la
  persona (un PIN no se archiva: no hay nada que rastrear de un hash viejo;
  el rastro está en la bitácora).
- `session.terminalId` y `session.terminalIdleSeconds` (opcionales, juntos:
  `CHECK`). Sin llave foránea: la fila de una persona no apunta a una tabla
  de empresa (PLT-13); quitar una terminal borra sus sesiones y una terminal
  nunca se borra (disparador).

## Lo que queda previsto

- **Tarjeta NFC o gafete:** la especificación la pide «cuando el hardware lo
  permita». Encaja como otro método de §4 sobre la misma terminal y la misma
  sesión recortada: la tarjeta reemplaza al PIN (o lo acompaña) y lo demás
  no cambia. Necesita decidir el lector (Web NFC solo existe en Chrome para
  Android) y cómo se da de alta una tarjeta. Fuera de este paso.
- **Enlace de correo abierto en la terminal:** la cookie de la terminal es
  `SameSite=Strict` y no viaja al llegar desde un enlace externo, así que
  la sesión de PIN se cierra (falta su terminal). Pendiente de decidir.
- **Navegador que fue terminal y conserva la cookie:** no alarga una sesión
  completa (pendiente de revisar si conviene borrar la cookie al quitar la
  terminal desde otro dispositivo).
- **Historial de accesos (WMS-68):** los eventos `pin_sign_in.*` y
  `pin.locked` ya quedan en los eventos de seguridad de la cuenta.

## Opciones descartadas

- **PIN válido en cualquier dispositivo** (como segunda contraseña corta):
  con 5 o 6 dígitos y la página en internet, solo los límites de intentos
  protegerían la cuenta. Se exige la terminal registrada.
- **Trabajadores sin cuenta, solo con PIN:** el fundador decidió que toda
  persona que opera tiene cuenta con rol.
- **PIN temporal puesto por un administrador** (que obliga a cambiarlo):
  quien lo dio podría entrar como esa persona hasta que lo cambie, y el
  rastro individual dejaría de ser de una sola persona. Si alguien olvida su
  PIN, entra con su contraseña y pone otro.
- **La misma sesión de la terminal para todos, con «quién es» guardado
  aparte:** rompería el rastro individual (todo lo hecho es de la sesión) y
  las sesiones del equipo de WMS-40.
- **Lista de solo quienes tienen PIN, o escribir el número de empleado:**
  la primera diría quién tiene PIN; no hay número de empleado en el sistema
  y agregarlo sería un dato nuevo para un solo uso. Se lista a todo el que
  puede usar PIN y se busca por nombre.
- **Bloquear solo por persona en todas las terminales con un umbral bajo:**
  un compañero en una sola terminal dejaba a la persona fuera de todas una
  hora. Se bloquea bajo por persona y terminal, y en todas solo con
  intentos de más de una terminal.
- **Medir la inactividad escribiendo en cada petición, o con una cookie
  firmada que se renueva en el proxy:** la primera es una escritura por
  pantalla; la segunda no se puede escribir desde un Server Component y
  repartiría la decisión entre el proxy y el servidor. Se usa
  `lastActiveAt` con intervalo corto solo para sesiones de terminal.
- **Leer el ajuste de inactividad en cada petición:** `platform/auth` no
  puede depender de `platform/settings` (que depende de billing y
  authorization). Se copia a la sesión al entrar; un cambio del ajuste vale
  desde la siguiente entrada (las sesiones duran minutos).
- **Ocultar los enlaces de administración en la terminal** como única
  defensa: se decide en la política y en los servicios.
- **Guardar el secreto de la terminal en `localStorage`:** lo leería
  cualquier script de la página; la cookie `HttpOnly` no.
- **Ajuste para el límite absoluto o los intentos:** son seguridad, no forma
  de trabajar.

## Consecuencias

- Área nueva `src/platform/terminals` (registrar, quitar, listar, PIN,
  personas de la terminal, entrar con PIN, ajustes y avisos). La parte que
  vive en cada petición (leer la cookie, validar la sesión de terminal,
  recortar) está en `src/platform/auth/terminal-session.ts`, porque
  `requireSession` la necesita y `platform/auth` no puede depender de otras
  áreas que dependen de él.
- `requireSession` devuelve `terminal` (`{ id, organizationId }` o `null`);
  `requireOrganizationContext` lo pasa y fija la empresa de la terminal.
- `getCurrentSession` lee la sesión sin renovarla cuando el navegador trae
  cookie de terminal.
- `loadSubject` agrega `terminal: true` para la persona de una sesión de
  terminal; `permissionsOf` recorta.
- Pantallas: `/terminal` («¿Quién eres?» y teclado, fuera del menú y sin
  sesión), Configuración › «Terminales compartidas»
  (`/configuracion/terminales`, `/configuracion/terminales/[id]`) y
  Configuración › «Mi PIN» (`/configuracion/pin`). La barra de la terminal
  («Terminal: Andén 2 · Olivia» y «Cambiar de persona») va arriba de cada
  pantalla de la app en una sesión de terminal.
