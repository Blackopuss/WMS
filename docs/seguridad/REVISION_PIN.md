# Revisión de amenazas — terminales compartidas con PIN (WMS-38)

Fecha: 2026-11-14. Complementa `REVISION_PLT.md` (autenticación) y el
ADR 0061. Hecha por la misma IA que implementó el paso y corregida tras una
revisión independiente (2026-11-14; segunda ronda en «Hallazgos»).

## Qué se agregó

- Registro de un dispositivo como terminal compartida de un almacén
  (`shared_terminal`), con un secreto de 256 bits en una cookie `HttpOnly`,
  `SameSite=Strict`, `Secure` y prefijo `__Host-` fuera de desarrollo; la
  base guarda solo el SHA-256 de cada secreto emitido
  (`shared_terminal_secret`), para detectar una cookie copiada.
- PIN de 5 o 6 dígitos (6 por omisión) por persona y empresa (`member_pin`), con scrypt
  sobre un HMAC del PIN con `BETTER_AUTH_SECRET`, la empresa y la persona.
- Entrada con PIN en `/terminal`: una sesión de Better Auth propia de la
  persona, marcada con su terminal, de la empresa de la terminal, de hasta
  12 horas y que se cierra sola tras 2 a 15 minutos sin actividad.
- Recorte de la sesión de PIN: sin permisos de plataforma (salvo leer la
  empresa, módulos y capacidad) y sin seguridad de la cuenta.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Fuerza bruta del PIN desde internet o desde otro dispositivo | El PIN solo existe con la cookie de una terminal activa: sin ella, la pantalla, la lista y la acción responden «no es una terminal»; una cookie inventada es igual que ninguna | `terminals.int.test.ts` («does not exist on a browser that is not a terminal») |
| Fuerza bruta desde la terminal (una persona) | Intento apartado antes de verificar (`reserveAttempt`); 5 fallos en 15 min bloquean a la persona 15 min en esa terminal y 15 en 1 hora la bloquean 1 hora en todas; solo su contraseña lo levanta antes; peticiones simultáneas no pasan del límite; tiempos en la tabla de abajo | `terminals.int.test.ts` («simultaneous guesses never pass the limit») |
| Sabotaje: un compañero bloquea a otra persona a propósito tecleando PIN malos | El bloqueo bajo es por persona **y** terminal (15 min, en las demás terminales sigue entrando); el global (30 en 1 hora) está por encima de lo que una sola terminal produce (a lo más 20 por hora), así que exige intentos desde más de una terminal; cada bloqueo avisa a quien administra terminales nombrando a la persona; la persona lo levanta entrando con su contraseña desde su dispositivo (la pantalla lo dice). Riesgo residual: con 20 fallos se detiene la terminal 15 min para todos, con aviso | `terminals.int.test.ts` («wrong PINs block the person on that terminal only…») |
| Adivinar despacio, por debajo de los límites (4 por persona y 19 por terminal cada 15 minutos) | Se cuentan los PIN incorrectos de cada terminal en 24 horas y al llegar a 30 se avisa una vez a quien administra terminales | `terminals.int.test.ts` («many wrong PINs in a day warn…») |
| Respuesta que confirma un PIN | Una cuenta sin correo confirmado o con documentos pendientes recibe «entra con tu correo y contraseña» **antes** de mirar el PIN y sin gastar intento, así esa respuesta no distingue un PIN correcto | `terminals.int.test.ts` («an account that is not finished asks for the password, whatever the PIN») |
| Fuerza bruta desde la terminal (muchas personas) | 20 fallos en 15 min bloquean la terminal 15 min para todos, dejan bitácora `terminal.locked` y avisan a quien administra terminales del almacén | `terminals.int.test.ts` («lock the terminal for everyone and warn») |
| Saber quién tiene PIN | La lista muestra a todo el que podría usarlo; sin PIN, sin permiso para usarlo o con PIN equivocado la respuesta y el tiempo son los mismos (`verifyNoPin`); el bloqueo cuenta igual | `terminals.int.test.ts` («says the same for a wrong PIN, someone without PIN…») |
| PIN visto por encima del hombro | El teclado muestra puntos; el PIN solo sirve en las terminales de esa empresa y solo para personas de piso; la sesión es corta, ligada a la terminal y sin seguridad de la cuenta ni administración. Riesgo residual: quien vio el PIN puede entrar como esa persona en una terminal mientras no lo cambie (ver hallazgos) | — |
| Compañero que usa el PIN de otro | Cada entrada deja evento de seguridad `pin_sign_in.succeeded` con la terminal y todo lo hecho queda a nombre de esa persona; «Mi PIN» permite cambiarlo y cierra sus sesiones de terminal. No se puede impedir del todo sin un segundo factor físico (NFC, fuera de este paso) | `terminals.int.test.ts` («changing the PIN closes it») |
| Terminal robada | Quitarla en Configuración invalida su secreto y borra sus sesiones en la misma operación; la sesión abierta caduca sola por inactividad (2 a 15 min) y a las 12 horas; con la terminal robada solo se puede intentar PIN con los límites de arriba | `terminals.int.test.ts` («removing the terminal closes its sessions…») |
| Cookie de terminal copiada (acceso físico a las herramientas del navegador: `HttpOnly` no lo impide) | Rotación con detección de reúso: se guarda cada secreto emitido y cuándo se presentó por primera vez; uno más viejo sigue sirviendo mientras ningún secreto más nuevo se haya presentado (una respuesta perdida no rompe nada) y, presentado después de uno más nuevo y fuera de 2 minutos de gracia, quita la terminal, cierra sus sesiones, deja bitácora `terminal.cloned` y avisa, sea cual sea la generación. Un secreto nunca emitido para esa terminal no hace nada. **Lo que una copia puede hacer antes de detectarse:** ver la lista de nombres de «¿Quién eres?», gastar el cupo de intentos de PIN (y bloquear a personas o a la terminal un rato, con aviso) y, con un PIN conocido, entrar desde fuera como esa persona. Se detecta hasta que los dos dispositivos presentan secretos: **de noche, o mientras nadie use la terminal real, no se detecta**. Pendiente: lista de redes permitidas por terminal | `terminals.int.test.ts` («an old copy presented after a newer one…», «a copy that rotates twice…», «a lost answer breaks nothing…», «two sign-ins at once rotate once», «a forged or foreign secret…») |
| Sesión completa abandonada en la terminal (un administrador entra con contraseña y se va) | En un navegador con cookie de terminal no se entra con contraseña (`signIn`, código de dos pasos, registro, invitación) y `requireSession` cierra cualquier sesión sin terminal que llegue ahí | `terminals.int.test.ts` («no password on a terminal») |
| Cookie de sesión de PIN copiada a otro navegador | La sesión de PIN exige en cada petición la cookie de **su** terminal y la terminal activa; si no, se borra la sesión | `terminals.int.test.ts` («does not work on another browser with a copied session cookie») |
| Saltarse la verificación en dos pasos con un PIN | Nunca entra con PIN quien tiene dos pasos obligatorios (titular de cualquier empresa, administrador, personal de plataforma) ni quien la activó; se revisa al listar, al entrar y en cada petición | `terminals.int.test.ts` («is not for who must use two steps», «stops working when the person may no longer use a PIN») |
| Elevación desde una sesión de PIN (equipo, sesiones, configuración, plan, terminales, soporte, exportaciones, costos, aprobaciones, invitaciones) | La política recorta para `Subject.terminal` en una sola función (`permissionsOf` con `keptAtTerminal`): todo `platform.*` salvo leer la empresa, toda exportación y todo costo, en cada comprobación de la petición (también `assertAllowed` en servicios y rutas); el motor de aprobaciones no deja decidir; la seguridad de la cuenta y aceptar invitaciones los rechaza cada servicio con `assertNotTerminalSession`; si leer la sesión falla dentro de una petición, el error se propaga (no falla abierto) | `policy.test.ts`, `terminals.int.test.ts` («is cut down…», «no exports from a terminal» por la ruta real) |
| Cambiar de empresa desde la terminal | `switchOrganization` lo rechaza; `requireOrganizationContext` solo acepta la empresa de la terminal y no cae a otra | `terminals.int.test.ts` |
| Persona desactivada | Desactivar borra su PIN y sus sesiones en la empresa en la misma transacción; cada petición revalida la membresía | `terminals.int.test.ts` («disabling the person…»), `team-disable.int.test.ts` |
| Sesión abandonada | Cierre por inactividad: solo los toques de la persona mueven `lastActiveAt` (ni la campana ni los refrescos periódicos); la barra cierra al vencer y, si el cierre falla, saca a la persona igual; 12 horas como máximo; la siguiente persona que entra cierra la anterior; una lectura que Better Auth alargue vuelve a su fin fijo | `terminals.int.test.ts` («automatic queries do not keep a PIN session alive», «ends after its idle time…», «one person at a time») |
| Copia de la base de datos | El secreto de la terminal se guarda como SHA-256; el PIN como scrypt sobre un HMAC con `BETTER_AUTH_SECRET`, la empresa y la persona: sin el secreto del servidor no se pueden probar PINs fuera de línea, y un hash no sirve en otra fila | `terminals.int.test.ts` («That hash is bound to the other person») |
| PIN en registros | El PIN nunca se escribe en bitácora, eventos ni logs; las acciones de bitácora no llevan metadatos del PIN | `terminals.int.test.ts` («never in the trail») |
| Usar la terminal de otra empresa o quitarla | Todo se busca con la empresa de la sesión; una terminal de otra empresa no existe | `terminals.int.test.ts`, `two-companies.int.test.ts` |
| Una sesión de PIN que administra la API, o una llamada de la API tomada como terminal (WMS-60) | `platform.api.manage` queda fuera del recorte de terminal; el recorte de terminal se aplica encima del de la llave en `permissionsOf`; dentro de `runDelegated`, `terminalUserOfRequest` responde «sin terminal» antes de leer cookies, así que una llamada con cookies de terminal y de PIN no se recorta como terminal ni dispara la detección de copia | `policy.test.ts` («applies on top of an API key's cut», «never manages API keys»), `terminals.int.test.ts` («never manages API keys nor webhooks», «is never the API…») |
| Fijación de sesión al registrar | Registrar cierra la sesión del administrador en ese dispositivo; la sesión de PIN es nueva (token aleatorio) en cada entrada | — (lo hace la acción `registerTerminalAction`) |

## Tiempo para adivinar un PIN al azar

Espacio real tras quitar los fáciles de adivinar (repetidos, escaleras,
bloques, años, fechas y figuras del teclado): **893,660** PIN de 6 dígitos
y **97,450** de 5. Un PIN elegido por una persona cae mucho antes que uno al
azar; por eso las reglas rechazan esos patrones.

| Ataque | Ritmo real | 6 dígitos | 5 dígitos |
| --- | --- | --- | --- |
| Contra una persona desde una terminal | ≈14 intentos por hora | ≈3.6 años en promedio; 1 % en ≈27 días | ≈4.8 meses; 1 % en ≈3 días |
| Contra una persona desde varias terminales | hasta 30 por hora (límite global) | ≈1.7 años; 1 % en ≈12 días | ≈2.2 meses; 1 % en ≈1.4 días |
| Contra cualquiera de N personas desde una terminal | ≈76 por hora (límite de la terminal) | ≈24 días con 20 personas, ≈10 con 50 | ≈2.7 días con 20, ≈1 día con 50 |

Cada bloqueo avisa y los fallos sostenidos también (30 en un día). Con estos
números, **6 dígitos es el único valor por omisión**; la pantalla del ajuste
dice que 5 es diez veces más fácil de adivinar.

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| PIN-S01 | Media | Un PIN visto por otra persona sirve hasta que su dueño lo cambie; no hay caducidad obligatoria del PIN. | Aceptado para este paso: la persona puede cambiarlo; la tarjeta NFC (pendiente) daría un segundo factor. Decisión del fundador si se quiere caducidad. |
| PIN-S02 | Media | La revisión mostró que un PIN de 4 dígitos aguanta días con el ritmo real de intentos, y horas si la persona eligió un año o fecha. | Corregido: se quitó la opción de 4 (quedan 5 y 6, por omisión 6) y se rechazan años y fechas. |
| PIN-S07 | Media | Entrar con contraseña en una terminal dejaba una sesión completa, sin recorte ni cierre por inactividad. | Corregido: no se entra con contraseña en una terminal y `requireSession` cierra esas sesiones. |
| PIN-S08 | Media | Una copia de la cookie de terminal hacía que el PIN sirviera desde cualquier lado. | Corregido: rotación del secreto en cada entrada y detección de copia (la terminal se quita). Pendiente: redes permitidas por terminal. |
| PIN-S09 | Media | La campana y los refrescos periódicos escribían la actividad: una sesión abandonada seguía viva. | Corregido: solo los toques cuentan; la barra saca a la persona aunque el cierre falle. |
| PIN-S10 | Media | Con 5 PIN malos un compañero dejaba a otra persona sin PIN 30 minutos en todas las terminales, sin aviso. | Corregido: límite bajo por persona y terminal, global más alto, aviso al bloquear. |
| PIN-S03 | Baja | La lista «¿Quién eres?» muestra los nombres del personal de piso del almacén a quien esté frente a una terminal registrada. | Aceptado: está dentro del almacén y no dice roles, correos ni quién tiene PIN. |
| PIN-S04 | Baja | El almacén activo de la persona pasa al de la terminal al entrar; afecta también lo que ve en su teléfono. | Aceptado (ADR 0061 §4); puede cambiarlo. |
| PIN-S05 | Informativa | Una sesión de PIN puede cambiar de almacén con el selector si su alcance lo permite. | Correcto por diseño: el selector ya respeta el alcance; si se quiere fijar al de la terminal, es un cambio de `switchFacility`. |
| PIN-S11 | Media | (2.ª revisión) La rotación solo recordaba el secreto anterior: una copia que entraba dos veces dejaba a la terminal real «no es terminal» sin detección, y una respuesta perdida quitaba la terminal legítima a los 2 minutos. | Corregido: rotación con detección de reúso (`shared_terminal_secret`). |
| PIN-S12 | Media | (2.ª revisión) La actividad guardada podía ir un minuto atrás del último toque: con 2 minutos, salir a los 66 s de tocar. | Corregido: el servidor escribe cada aviso; la barra avisa al final de cada racha y al cambiar de pantalla. |
| PIN-S13 | Media | (2.ª revisión) El bloqueo global (15 en 1 h) lo alcanzaba un compañero desde una sola terminal; por debajo de los umbrales no había aviso; cifras de la tabla imprecisas. | Corregido: global 30 en 1 h (exige más de una terminal), aviso por 30 fallos en un día, cifras con el espacio real, figuras del teclado rechazadas, 6 dígitos por omisión. |
| PIN-S14 | Baja | (2.ª revisión) Un PIN correcto de una cuenta sin terminar respondía distinto de «PIN incorrecto» (oráculo). | Corregido: esa respuesta se da antes de mirar el PIN. |
| PIN-S15 | Baja | (2.ª revisión) El recorte quitaba la hoja de embarque y la de traslado, y registrar el último costo; los cambios de equipo armaban el sujeto sin la marca de terminal; el `CHECK` de la sesión dejaba pasar una terminal sin tiempo de inactividad. | Corregido: lista explícita de documentos que se conservan, solo se corta leer costos, la marca viaja en `withTeamChange` y en las opciones de alcance, `CHECK` sin «desconocido». |
| PIN-S06 | Informativa | Un trabajo del worker pedido desde una sesión de PIN se revisa con los permisos completos de la persona (fuera de una petición no hay terminal). | Aceptado: el piso no tiene trabajos de plataforma. Las llaves de la API (WMS-60) no se crean desde una sesión de PIN y sus llamadas llevan su propio recorte (`Subject.limit`). |

## Siguiente revisión

Al agregar la tarjeta NFC o al llegar la API (WMS-60).
