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
| Fuerza bruta desde la terminal (una persona) | Intento apartado antes de verificar (`reserveAttempt`); 5 fallos en 15 min dejan a la persona sin PIN 30 min en **todas** las terminales; solo la contraseña lo levanta antes; peticiones simultáneas no pasan del límite | `terminals.int.test.ts` («simultaneous guesses never pass the limit») |
| Fuerza bruta desde la terminal (muchas personas) | 20 fallos en 15 min bloquean la terminal 15 min para todos, dejan bitácora `terminal.locked` y avisan a quien administra terminales del almacén | `terminals.int.test.ts` («lock the terminal for everyone and warn») |
| Saber quién tiene PIN | La lista muestra a todo el que podría usarlo; sin PIN, sin permiso para usarlo o con PIN equivocado la respuesta y el tiempo son los mismos (`verifyNoPin`); el bloqueo cuenta igual | `terminals.int.test.ts` («says the same for a wrong PIN, someone without PIN…») |
| PIN visto por encima del hombro | El teclado muestra puntos; el PIN solo sirve en las terminales de esa empresa y solo para personas de piso; la sesión es corta, ligada a la terminal y sin seguridad de la cuenta ni administración. Riesgo residual: quien vio el PIN puede entrar como esa persona en una terminal mientras no lo cambie (ver hallazgos) | — |
| Compañero que usa el PIN de otro | Cada entrada deja evento de seguridad `pin_sign_in.succeeded` con la terminal y todo lo hecho queda a nombre de esa persona; «Mi PIN» permite cambiarlo y cierra sus sesiones de terminal. No se puede impedir del todo sin un segundo factor físico (NFC, fuera de este paso) | `terminals.int.test.ts` («changing the PIN closes it») |
| Terminal robada | Quitarla en Configuración invalida su secreto y borra sus sesiones en la misma operación; la sesión abierta caduca sola por inactividad (2 a 15 min) y a las 12 horas; con la terminal robada solo se puede intentar PIN con los límites de arriba | `terminals.int.test.ts` («removing the terminal closes its sessions…») |
| Cookie de terminal copiada | `HttpOnly` (sin acceso desde scripts), `Secure` y `SameSite=Strict`; quien la copie necesita además un PIN válido con los mismos límites; quitar la terminal la invalida | `terminals.int.test.ts` |
| Cookie de sesión de PIN copiada a otro navegador | La sesión de PIN exige en cada petición la cookie de **su** terminal y la terminal activa; si no, se borra la sesión | `terminals.int.test.ts` («does not work on another browser with a copied session cookie») |
| Saltarse la verificación en dos pasos con un PIN | Nunca entra con PIN quien tiene dos pasos obligatorios (titular de cualquier empresa, administrador, personal de plataforma) ni quien la activó; se revisa al listar, al entrar y en cada petición | `terminals.int.test.ts` («is not for who must use two steps», «stops working when the person may no longer use a PIN») |
| Elevación desde una sesión de PIN (equipo, sesiones, configuración, plan, terminales, soporte) | La política recorta `platform.*` para `Subject.terminal` en una sola función (`permissionsOf`), en cada comprobación de la petición, también la de los servicios (`assertAllowed`); la seguridad de la cuenta la rechaza cada servicio con `assertNotTerminalSession` | `policy.test.ts`, `terminals.int.test.ts` («is cut down…») |
| Cambiar de empresa desde la terminal | `switchOrganization` lo rechaza; `requireOrganizationContext` solo acepta la empresa de la terminal y no cae a otra | `terminals.int.test.ts` |
| Persona desactivada | Desactivar borra su PIN y sus sesiones en la empresa en la misma transacción; cada petición revalida la membresía | `terminals.int.test.ts` («disabling the person…»), `team-disable.int.test.ts` |
| Sesión abandonada | Cierre por inactividad medido en el servidor (`lastActiveAt` cada 30 s) y en el navegador (sin toques); 12 horas como máximo sin importar la actividad; la siguiente persona que entra cierra la anterior | `terminals.int.test.ts` («ends after its idle time…», «one person at a time») |
| Copia de la base de datos | El secreto de la terminal se guarda como SHA-256; el PIN como scrypt sobre un HMAC con `BETTER_AUTH_SECRET`, la empresa y la persona: sin el secreto del servidor no se pueden probar PINs fuera de línea, y un hash no sirve en otra fila | `terminals.int.test.ts` («That hash is bound to the other person») |
| PIN en registros | El PIN nunca se escribe en bitácora, eventos ni logs; las acciones de bitácora no llevan metadatos del PIN | `terminals.int.test.ts` («never in the trail») |
| Usar la terminal de otra empresa o quitarla | Todo se busca con la empresa de la sesión; una terminal de otra empresa no existe | `terminals.int.test.ts`, `two-companies.int.test.ts` |
| Fijación de sesión al registrar | Registrar cierra la sesión del administrador en ese dispositivo; la sesión de PIN es nueva (token aleatorio) en cada entrada | — (lo hace la acción `registerTerminalAction`) |

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| PIN-S01 | Media | Un PIN visto por otra persona sirve hasta que su dueño lo cambie; no hay caducidad obligatoria del PIN. | Aceptado para este paso: la persona puede cambiarlo; la tarjeta NFC (pendiente) daría un segundo factor. Decisión del fundador si se quiere caducidad. |
| PIN-S02 | Baja | Con PIN de 4 dígitos (opción del ajuste), un atacante con acceso físico continuo a la terminal tarda unas semanas de intentos al ritmo permitido, que además bloquean la terminal y avisan. | Aceptado: 6 dígitos por omisión; el aviso de bloqueo deja ver el ataque. |
| PIN-S03 | Baja | La lista «¿Quién eres?» muestra los nombres del personal de piso del almacén a quien esté frente a una terminal registrada. | Aceptado: está dentro del almacén y no dice roles, correos ni quién tiene PIN. |
| PIN-S04 | Baja | El almacén activo de la persona pasa al de la terminal al entrar; afecta también lo que ve en su teléfono. | Aceptado (ADR 0061 §4); puede cambiarlo. |
| PIN-S05 | Informativa | Una sesión de PIN puede cambiar de almacén con el selector si su alcance lo permite. | Correcto por diseño: el selector ya respeta el alcance; si se quiere fijar al de la terminal, es un cambio de `switchFacility`. |
| PIN-S06 | Informativa | Un trabajo del worker pedido desde una sesión de PIN se revisa con los permisos completos de la persona (fuera de una petición no hay terminal). | Aceptado: el piso no tiene trabajos de plataforma; ver WMS-60 si llegan tokens de API. |

## Siguiente revisión

Al agregar la tarjeta NFC o al llegar la API (WMS-60).
