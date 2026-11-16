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
| Saber si un correo tiene cuenta por el tiempo | La búsqueda de la persona se hace en los dos casos (una consulta por índice único); el correo de alerta sale **después** de responder (`after()`, como los de Better Auth, PLT-16) | Revisión de código (`noteFailedSignIn`, `raiseAlert`) |
| Inundar de correos a una persona | Sin la contraseña solo se provoca la alerta de intentos fallidos: una por persona por día (`failed_attempts:<día UTC>`); la de dispositivo nuevo exige entrar; además, tope de 5 alertas por persona en 24 horas | «alerts once a day…», «keeps to the daily cap of alerts» |
| Correos a un buzón que no es de la persona | Solo a cuentas con correo confirmado | «never emails an account whose email is not confirmed» |
| Dos alertas por peticiones simultáneas | La alerta es una fila con `dedupeKey` única por persona: solo una petición la escribe y solo esa manda correo; igual el bloqueo (`locked:<paso>:<ventana de 15 min>`) | «alerts once for a device never seen, even with simultaneous entries», «takes the attempt before checking» en `terminals.int.test.ts` |
| Alerta falsa al desplegar (todas las cuentas «en un dispositivo nuevo») | Si la persona no tiene ninguna entrada anterior **con dispositivo**, se aprende y no se alerta; también en el primer acceso de una cuenta nueva | «records each entry with its device and never alerts on the first one», «learns the first device of accounts that only had entries without one» |
| Ver el historial de otra persona | La propia lectura solo filtra por la persona de la sesión; la del equipo exige `platform.session.read` (titular, administración, Gerencia) y que la persona sea de la empresa (si no, `null` → 404) | «a person outside the company does not exist, and the floor may not look» |
| Fuga entre empresas | Los eventos de otra empresa nunca se listan; los de la cuenta, solo mientras la persona no pertenezca a otra empresa y desde que entró a esta | «once the person also works for another company…» |
| Atribuir a alguien fallos ajenos en el segundo paso | La persona del reto sale de la cookie `two_factor` solo si su firma HMAC con el secreto de la app es válida y el reto existe y no ha vencido; una cookie inventada no escribe nada | «records a wrong code for the person of the challenge, and nothing for a forged cookie» |
| Inflar el historial para esconder algo o llenar la base | Lo que alguien sin la contraseña puede escribir está acotado por los límites de intentos existentes (5 contraseñas por cuenta cada 15 min, más los de IP); un correo sin cuenta no escribe nada; la pantalla pagina en la base | «records a wrong password of an account that exists and nothing for one that does not», «pages in the database…» |
| Datos sensibles guardados o mostrados | Ni contraseña, ni código, ni PIN, ni token, ni texto del navegador; `metadata` sigue pasando por `sanitizeMetadata`; el correo no lleva enlaces de acceso (solo la dirección de «Recuperar contraseña», sin token) y el de intentos fallidos no lleva IP | Pruebas que revisan filas y correos |
| Borrar huellas | `security_event` sigue siendo solo-agregar por disparadores; la migración solo agrega columnas | Disparadores de PLT-14 |
| Ver la seguridad de la cuenta desde una terminal compartida | `listMyAccessHistory` llama `assertNotTerminalSession`; la pantalla lo dice | Revisión de código |

## Riesgos que quedan

- «Dispositivo» es tipo, navegador y sistema: otra computadora con el mismo
  navegador y sistema no se detecta como nueva. Una cookie de dispositivo lo
  afinaría a costa de un identificador persistente (ADR 0064 §4).
- Quien trabaja en varias empresas: su administrador no ve sus entradas con
  contraseña (no se sabe para qué empresa fueron).
- El correo de alerta se manda una vez, después de responder, sin cola ni
  reintento: si el servidor de correo falla en ese momento, la alerta queda
  en el historial pero el correo no llega (se registra el error).
- Sin país por IP (decisión del fundador); entrará solo desde una cabecera
  de un proxy de confianza (ADR 0064 §6).
