# Revisión de amenazas — terminales compartidas con PIN (WMS-38)

Fecha: 2026-11-14. Complementa `REVISION_PLT.md` (autenticación) y el
ADR 0061. Hecha por la misma IA que implementó el paso; falta una revisión
independiente antes de producción.

## Qué se agregó

- Registro de un dispositivo como terminal compartida de un almacén
  (`shared_terminal`), con un secreto de 256 bits en una cookie `HttpOnly`,
  `SameSite=Strict`, `Secure` y prefijo `__Host-` fuera de desarrollo; la
  base guarda solo su SHA-256.
- PIN de 4 a 6 dígitos por persona y empresa (`member_pin`), con scrypt
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
| Sabotaje: un compañero bloquea a otra persona a propósito tecleando PIN malos | El bloqueo bajo es por persona **y** terminal (15 min, en las demás terminales sigue entrando); el global es más alto; cada bloqueo avisa a quien administra terminales nombrando a la persona; la persona lo levanta entrando con su contraseña desde su dispositivo (la pantalla lo dice). Riesgo residual: con 20 fallos se detiene la terminal 15 min para todos, con aviso | `terminals.int.test.ts` («wrong PINs block the person on that terminal only…») |
| Fuerza bruta desde la terminal (muchas personas) | 20 fallos en 15 min bloquean la terminal 15 min para todos, dejan bitácora `terminal.locked` y avisan a quien administra terminales del almacén | `terminals.int.test.ts` («lock the terminal for everyone and warn») |
| Saber quién tiene PIN | La lista muestra a todo el que podría usarlo; sin PIN, sin permiso para usarlo o con PIN equivocado la respuesta y el tiempo son los mismos (`verifyNoPin`); el bloqueo cuenta igual | `terminals.int.test.ts` («says the same for a wrong PIN, someone without PIN…») |
| PIN visto por encima del hombro | El teclado muestra puntos; el PIN solo sirve en las terminales de esa empresa y solo para personas de piso; la sesión es corta, ligada a la terminal y sin seguridad de la cuenta ni administración. Riesgo residual: quien vio el PIN puede entrar como esa persona en una terminal mientras no lo cambie (ver hallazgos) | — |
| Compañero que usa el PIN de otro | Cada entrada deja evento de seguridad `pin_sign_in.succeeded` con la terminal y todo lo hecho queda a nombre de esa persona; «Mi PIN» permite cambiarlo y cierra sus sesiones de terminal. No se puede impedir del todo sin un segundo factor físico (NFC, fuera de este paso) | `terminals.int.test.ts` («changing the PIN closes it») |
| Terminal robada | Quitarla en Configuración invalida su secreto y borra sus sesiones en la misma operación; la sesión abierta caduca sola por inactividad (2 a 15 min) y a las 12 horas; con la terminal robada solo se puede intentar PIN con los límites de arriba | `terminals.int.test.ts` («removing the terminal closes its sessions…») |
| Cookie de terminal copiada (acceso físico a las herramientas del navegador: `HttpOnly` no lo impide) | El secreto rota en cada entrada con PIN; el anterior sirve solo 2 minutos de gracia. Si después llega un secreto ya rotado, el sistema quita la terminal, cierra sus sesiones, deja bitácora `terminal.cloned` y avisa a quien administra. Quien usa la copia antes de que la terminal rote aún necesita un PIN válido con los límites de abajo. Pendiente: lista de redes permitidas por terminal | `terminals.int.test.ts` («an old copy after the grace removes the terminal») |
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

Con los límites de intentos (la mitad de las combinaciones válidas en
promedio). Un PIN elegido por una persona (años, fechas) cae mucho antes:
por eso las reglas rechazan años de 1930 a 2039 y fechas de seis dígitos.

| PIN | Válidos | Contra una persona (como mucho 15 por hora entre todas las terminales; en la práctica unos 9) | Una terminal probando muchas personas (como mucho 80 por hora, con aviso en cada bloqueo) |
| --- | --- | --- | --- |
| 6 dígitos | ≈895,000 | ≈3.4 años | meses para dar con el PIN de alguien, con decenas de avisos |
| 5 dígitos | ≈97,000 | ≈4.5 meses | semanas, con avisos |
| 4 dígitos (quitado) | ≈9,600 | ≈2 semanas | días |

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
| PIN-S06 | Informativa | Un trabajo del worker pedido desde una sesión de PIN se revisa con los permisos completos de la persona (fuera de una petición no hay terminal). | Aceptado: el piso no tiene trabajos de plataforma. Las llaves de la API (WMS-60) no se crean desde una sesión de PIN y sus llamadas llevan su propio recorte (`Subject.limit`). |

## Siguiente revisión

Al agregar la tarjeta NFC o al llegar la API (WMS-60).
