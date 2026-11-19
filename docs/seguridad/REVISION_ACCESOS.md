# Revisión de amenazas — historial de accesos y alertas (WMS-68)

Fecha: 2026-11-16. Complementa `REVISION_PLT.md` (autenticación),
`REVISION_PIN.md` (terminales) y el ADR 0064. Hecha por la misma IA que
implementó el paso; la leerá un revisor independiente antes de unir.

## Qué se agregó

- El historial de accesos por persona es una lectura de `security_event`
  (solo-agregar, sin llave foránea), que gana tres columnas que admiten
  vacío: `eventOrganizationId` (empresa del evento cuando ocurre dentro de una),
  `deviceKey` (tipo, navegador y sistema descritos; nunca el texto del
  navegador) y `dedupeKey` (única por persona: lo que pasa una sola vez).
- Eventos nuevos: `sign_in.failed` (contraseña equivocada de una cuenta que
  existe), `mfa_code.failed`, `sign_in.locked`, `session.closed_by_team` y
  las dos alertas (`access.alert_new_device`,
  `access.alert_failed_attempts`). Los de PIN ganan empresa y dispositivo.
- Pantallas `/configuracion/accesos` (la propia) y
  `/configuracion/equipo/[persona]/accesos` (`platform.session.read`).
- Correo de alerta a la persona por dispositivo o navegador nuevo y por
  bloqueo por intentos.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Saber si un correo tiene cuenta por la respuesta | `signIn` responde igual (`invalid` y luego `throttled`) para una cuenta que existe y para un correo sin cuenta; los contadores de PLT-06 ya contaban el correo enviado, exista o no | `access-history.int.test.ts` («alerts once a day when the account gets blocked, without telling whether it exists») |
| Saber si un correo tiene cuenta por el tiempo | Todo lo de una contraseña equivocada (buscar a la persona, la fila, el bloqueo, la alerta y su correo) corre **después** de responder: `afterResponse` le pasa a `after()` una función, así nada empieza antes (revisión: antes se le pasaba una promesa ya empezada) | «records a wrong password…» (con `after()` retenido, nada existe hasta soltarlo) |
| Inundar de correos a una persona | Sin la contraseña solo se provoca la alerta de intentos fallidos (una por persona por día) o la de PIN (una por día, solo a quien tiene PIN, con llave aparte); la de dispositivo nuevo exige entrar y la de contraseña desde un dispositivo nuevo exige la contraseña; además, como mucho 5 correos por persona por día, con turnos de llave única (atómico) y una sola petición por alerta y día | «alerts once a day…», «past the daily cap…», «never mails more than the cap, even with many alerts at once», «a blocked PIN has its own alert…» |
| Un intruso con la contraseña que prueba códigos de dos pasos | Un código equivocado desde un dispositivo que la persona no conoce alerta (una vez al día por dispositivo); el código que bloquea la cuenta alerta al momento (se lee `lockedUntil`, porque Better Auth todavía responde «código equivocado») con su propia llave diaria y su texto | «a wrong code from a device the person does not know alerts once», «the wrong code that locks the account alerts, even after a password lock the same day» |
| Silenciar la alerta de códigos bloqueando antes la contraseña sin credenciales | El bloqueo por códigos tiene su llave (`code_locked:<día>`), aparte de la de contraseñas (`failed_attempts:<día>`) | «the wrong code that locks the account alerts, even after a password lock the same day» |
| Creer que una alerta llegó cuando no salió | El historial dice en cada alerta si se envió el correo o por qué no | «past the daily cap…» |
| Dispositivo nuevo que nadie supo | Solo se aprende cuando su correo salió; si no salió (tope), avisa en su siguiente entrada | «never mails more than the cap…» |
| Correos a un buzón que no es de la persona | Solo a cuentas con correo confirmado | «never emails an account whose email is not confirmed» |
| Dos alertas por peticiones simultáneas | La alerta es una fila con `dedupeKey` única por persona: solo una petición la escribe y solo esa manda correo; igual el bloqueo (`locked:<paso>:<ventana de 15 min>`) | «alerts once for a device never seen, even with simultaneous entries», «takes the attempt before checking» en `terminals.int.test.ts` |
| Alerta falsa al desplegar (todas las cuentas «en un dispositivo nuevo») | Si la persona no tiene ninguna entrada anterior **con dispositivo**, se aprende y no se alerta; también en el primer acceso de una cuenta nueva | «records each entry with its device and never alerts on the first one», «learns the first device of accounts that only had entries without one» |
| Ver el historial de otra persona | La propia lectura solo filtra por la persona de la sesión; la del equipo exige `platform.session.read` (titular, administración, Gerencia) y que la persona sea de la empresa (si no, `null` → 404) | «a person outside the company does not exist, and the floor may not look» |
| Fuga entre empresas | Los eventos de otra empresa nunca se listan; los de la cuenta, solo mientras la persona no pertenezca a otra empresa y solo en los periodos en que perteneció a esta (no mientras estuvo desactivada) | «once the person also works for another company…», «while disabled, the company stops seeing…» |
| Atribuir a alguien fallos ajenos en el segundo paso | La persona del reto sale de la cookie `two_factor` solo si su firma HMAC con el secreto de la app es válida y el reto existe y no ha vencido; una cookie inventada no escribe nada | «records a wrong code for the person of the challenge, and nothing for a forged cookie» |
| Inflar el historial para esconder algo o llenar la base | Lo que alguien sin la contraseña puede escribir está acotado por los límites de intentos existentes (5 contraseñas por cuenta cada 15 min, más los de IP); un correo sin cuenta no escribe nada; la pantalla pagina en la base | «records a wrong password of an account that exists and nothing for one that does not», «pages in the database…» |
| Datos sensibles guardados o mostrados | Ni contraseña, ni código, ni PIN, ni token, ni texto del navegador; `metadata` sigue pasando por `sanitizeMetadata`; el correo no lleva enlaces de acceso (solo la dirección de «Recuperar contraseña», sin token) y el de intentos fallidos no lleva IP | Pruebas que revisan filas y correos |
| Borrar huellas | `security_event` sigue siendo solo-agregar por disparadores; la migración solo agrega columnas | Disparadores de PLT-14 |
| Ver la seguridad de la cuenta desde una terminal compartida | `listMyAccessHistory` llama `assertNotTerminalSession`; la pantalla lo dice | Revisión de código |

## WMS-88 (2026-11-19, ADR 0084)

| Amenaza | Control | Prueba |
| --- | --- | --- |
| El historial dice «se envió» de un correo que no salió | El correo de cada alerta es un renglón de `access_alert_email` (estado `QUEUED`, `SENT` o `FAILED`) que se escribe en la misma transacción que la alerta; el historial lee ese estado | «a mail that fails is tried again and the history tells the truth», «gives up after its tries, says so…» |
| Dos procesos mandan el mismo correo de alerta | Cada intento reclama el renglón con una actualización condicionada que anota `claimToken`; solo quien lo tiene lo cierra; un reclamo de más de 5 minutos se da por muerto | «tries at once send it only once» |
| Los reintentos pasan el tope diario | El turno del día se toma una sola vez, al crear la alerta; reintentar no toma turnos; un fallo no libera el suyo | «…takes no more slots» |
| El reintento revela si la cuenta existe | Nada cambia antes de responder; el primer intento corre después de responder y los demás en el worker | Pruebas de WMS-68 sin cambios |
| El correo sale a un buzón que dejó de estar confirmado | Al mandar se lee la cuenta otra vez; sin correo confirmado, `FAILED` | «an address no longer confirmed…» |
| La dirección queda en un registro | El renglón no guarda la dirección; el log del fallo lleva solo el id del renglón y el intento (el error del servidor de correo puede traer la dirección) | Revisión de código |
| Borrar huellas con la retención | El disparador `security_event_no_delete` solo deja borrar eventos de acceso (y filas internas del día) con más de 365 días según el reloj de la base; nunca `access.device_known` ni los eventos que no son accesos; las actualizaciones siguen prohibidas. La app pide un día de margen | «removes only access events older than the limit; the database refuses the rest» |
| Que un dispositivo conocido vuelva a alertar o se aprenda en silencio por la purga | `access.device_known` nunca se purga | La misma prueba |
| La alerta en la campana revela algo de otra empresa | El texto es fijo por clase de alerta, de la cuenta de la persona, sin IP; un aviso por empresa donde es miembro activo; nunca por correo como aviso (`app_only`), también en el servidor | «reaches each company of the person once, and never as a second mail» |
| La campana avisa del PIN de quien no tiene PIN | Igual que el correo: no se escribe | «not for the PIN of someone who has none» |

Riesgo aceptado: quien acaba de entrar puede ser el intruso y marcar como
leído el aviso de la campana; el correo al buzón confirmado sigue siendo el
canal que importa.

## Riesgos que quedan

- **Retención:** 365 días para eventos de acceso (decisión conservadora de
  WMS-88 que el fundador puede cambiar con una migración). Los eventos que
  no son accesos y los dispositivos conocidos no se purgan. El aviso de
  privacidad todavía no dice plazos de conservación (revisión legal).

- «Dispositivo» es tipo, navegador y sistema: otra computadora con el mismo
  navegador y sistema no se detecta como nueva. Una cookie de dispositivo lo
  afinaría a costa de un identificador persistente (ADR 0064 §4).
- Quien trabaja en varias empresas: su administrador no ve sus entradas con
  contraseña (no se sabe para qué empresa fueron).
- El dispositivo nuevo se aprende cuando su alerta programa el correo; desde
  WMS-88 el correo se reintenta cinco veces en unas horas, y si nunca sale
  el historial dice «No se pudo enviar el correo de alerta». Si el proceso
  muere entre mandar y cerrar, el correo puede salir dos veces (se prefiere
  a uno que se cree enviado).
- Los correos propios de Better Auth (confirmación, recuperación) le llegan
  a `after()` como una promesa ya empezada; así los entrega Better Auth.
- Sin país por IP (decisión del fundador); entrará solo desde una cabecera
  de un proxy de confianza (ADR 0064 §6).
