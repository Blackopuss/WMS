# ADR 0095 — Dispositivo conocido al iniciar sesión

Fecha: 2026-11-21 · Estado: aceptada · Paso: WMS-95 (auditoría de
seguridad, hallazgo WMS-SEC-03) · Cambia ADR 0003 (autenticación), sección
del límite de intentos · Usa ADR 0064 (historial de accesos)

## Contexto

Desde PLT-06 los intentos fallidos de inicio de sesión se cuentan por el
correo escrito (5 en 15 minutos, bloqueo de 15) y por IP (20 en 15
minutos). Mientras el correo está bloqueado se rechaza también la contraseña
correcta, para no revelar qué cuentas existen. La auditoría de seguridad del
2026-11-21 (`docs/seguridad/AUDITORIA_6.md`) señaló que eso deja a
cualquiera, sin cuenta, mantener fuera a una persona cuyo correo conoce:
5 contraseñas equivocadas cada 15 minutos desde una sola IP alcanzan para
unas cuatro cuentas, y restablecer la contraseña limpia el bloqueo pero el
tercero lo vuelve a poner enseguida. El fundador pidió corregir los
hallazgos de prioridad alta y media (2026-11-21).

## Decisión

1. **Después de entrar completo** (contraseña, y el segundo paso si la
   cuenta lo tiene), el navegador recibe una cookie de dispositivo conocido
   (`__Host-wms-device` fuera de desarrollo; `HttpOnly`, `SameSite=Lax`,
   `Secure`, 400 días). Guarda hasta 5 entradas `<nonce>.<firma>`, una por
   cuenta usada en ese navegador. La firma es un HMAC del nonce y del correo
   con una llave propia derivada de `BETTER_AUTH_SECRET`
   (`almacen:known-device:v1`): no se puede fabricar para otro correo y no
   contiene el correo.
2. **Al iniciar sesión**, si el navegador trae una entrada válida para el
   correo escrito, los intentos de ese correo se cuentan **por dispositivo**
   (`signin:device:<sha256(nonce|correo)>`, mismo presupuesto: 5 en 15
   minutos) en lugar de por correo. Sin entrada válida, todo sigue igual: el
   bloqueo por correo detiene a quien adivina contraseñas desde otro lado.
   El límite por IP aplica siempre.
3. El orden de PLT-06 no cambia: `reserveAttempt` antes de verificar,
   `settleFailure` en una contraseña equivocada, `refundAttempt` en lo que no
   es un intento de adivinar. Entrar bien limpia la llave del correo y la del
   dispositivo.
4. La cookie solo cambia **cómo se cuentan los intentos**; nunca permite
   entrar sin contraseña ni salta el segundo paso. Cerrar sesión no la borra.
5. El aviso de privacidad la nombra y su versión sube a `2026-11-21`.

## Consecuencias

- Un tercero que conoce el correo ya no saca a su dueño de los dispositivos
  donde este ya entró. En un dispositivo nuevo la persona sigue bloqueada
  mientras dure el bloqueo (lo mismo que antes).
- Quien robe la cookie de un navegador solo obtiene el presupuesto de
  intentos de ese navegador (5 en 15 minutos), el mismo que tenía el correo.
- La cookie no se invalida al cambiar la contraseña: no da acceso, solo
  cambia el conteo.

## Alternativas descartadas

- **Desafío por correo en vez de rechazo** (con la cuenta bloqueada y la
  contraseña correcta, pedir un código enviado al correo): cubre también los
  dispositivos nuevos, pero agrega un flujo de correo con su propio límite,
  plantilla y pantalla. Queda como mejora si un dispositivo nuevo bloqueado
  resulta un problema real.
- **Quitar el bloqueo por correo y dejar solo el de IP**: abre la adivinación
  distribuida desde muchas IP.

## Pruebas

`tests/platform/throttle.int.test.ts`, bloque «known devices»: con el correo
bloqueado, sin cookie (o con una de otro correo, o falsificada) se rechaza y
con la del dueño entra; en un dispositivo conocido las contraseñas
equivocadas siguen limitadas; la cookie guarda una entrada por cuenta, hasta
cinco.
