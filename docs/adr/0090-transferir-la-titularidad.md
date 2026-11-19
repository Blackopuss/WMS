# ADR 0090 — Pantalla para transferir la titularidad

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-90 · Completa USR-03B
(servicio de transferencia) · Usa ADR 0005 (empresas), ADR 0006
(bitácora), ADR 0029 (acceso de soporte), ADR 0038 (alcance), ADR 0057
(avisos), ADR 0058 (API), ADR 0059 (sesiones del equipo), ADR 0061
(terminales con PIN), ADR 0062 (roles ligados a un módulo), PLT-06
(límite de intentos) y PLT-08/09 (dos pasos)

## Contexto

Desde USR-03B existe el servicio `ownership.ts` (`offerOwnershipTransfer`,
`cancelOwnershipTransfer`, `acceptOwnershipTransfer`,
`getPendingOwnershipTransfer`), con su prueba (NEG-26), pero ninguna
pantalla ni Server Action lo usa: el titular de una empresa no puede pasarle
la titularidad a otra persona. La revisión de los manuales (WMS-46) lo
señaló como hueco y el fundador dijo que sí el 2026-11-19.

Lo que el servicio ya decide (no cambia):

- Solo el titular ofrece (se lee `organization.ownerUserId` bajo el candado
  de la fila de la empresa, el mismo que usan los cambios de equipo).
- A una persona **activa** de la misma empresa, distinta del titular.
- El titular elige los roles que conserva después; Consulta por omisión,
  nunca Administrador si no lo elige (respuesta 8 del fundador en la
  matriz). Un rol ligado a un módulo solo si el módulo está activo o el
  titular ya lo tenía (WMS-59).
- Una sola oferta pendiente por empresa: una oferta nueva cancela la
  anterior. Vence a los **7 días** (`OWNERSHIP_OFFER_DAYS`).
- Al aceptar, en una transacción bajo el mismo candado: cambia
  `ownerUserId`, el nuevo titular pierde sus roles y su alcance por almacén
  (el titular no tiene roles ni se limita), el anterior queda solo con los
  roles elegidos, la oferta pasa a `ACCEPTED` y queda la bitácora
  `ownership.transferred`. Quien acepta debe tener los dos pasos activos.
  De dos aceptaciones a la vez gana una; si quien ofreció ya no es el
  titular, la oferta «ya no está disponible».

## Flujo operativo

### Dónde vive

Una sola pantalla, **Configuración › «Titularidad de la empresa»**
(`/configuracion/titularidad`). La ven solo dos personas:

- **el titular**: el enlace aparece en Configuración, en el grupo de la
  empresa;
- **quien tiene una oferta pendiente para él** en esa empresa: el enlace
  aparece en Configuración y el aviso de la campana lleva ahí.

Cualquier otra persona ve `NoAccessState`. No hay botón en la ficha de cada
persona ni en la lista del equipo: una sola forma de hacerlo.

### El titular ofrece

1. Sin oferta pendiente, la pantalla muestra un formulario: **a quién**
   (lista de las personas activas del equipo distintas del titular, con su
   correo; si no hay ninguna, la pantalla dice que primero hay que invitar a
   alguien y enlaza a Equipo), **qué roles conservas tú** (casillas, con
   Consulta marcada; solo los roles que el titular puede asignar con los
   módulos de la empresa), **tu contraseña** y **el código de tu app de
   dos pasos** (o un código de recuperación). Botón «Ofrecer la empresa».
   La pantalla avisa, sin bloquear, si la persona elegida aún no tiene los
   dos pasos: los necesitará para aceptar.
2. Con oferta pendiente, la pantalla dice a quién se ofreció, qué roles
   conservará el titular y hasta cuándo vale, con el botón «Cancelar la
   oferta». Para ofrecer a otra persona primero se cancela (la pantalla no
   ofrece reemplazarla en un paso; el servicio sí lo admite y se queda
   así).

### Quien recibe acepta o rechaza

La persona recibe el aviso «X te ofrece la titularidad de <empresa>» en la
app y un correo sin enlaces. En la pantalla ve quién se la ofrece, hasta
cuándo vale y qué conservará el titular actual, y dos acciones:

- **«Aceptar la empresa»**, con su contraseña y el código de su app de dos
  pasos (o de recuperación). Si no tiene los dos pasos activos, la pantalla
  lo dice y enlaza a Configuración › Seguridad en vez de pedir el código.
- **«Rechazar»**, sin contraseña (rechazar no da poder a nadie). La oferta
  queda `CANCELLED` y la bitácora dice `ownership.transfer_declined`
  (no se agrega un estado nuevo a la tabla; la bitácora distingue quién la
  cerró).

### Confirmación fuerte

Ofrecer y aceptar son las dos acciones que pueden hacer que alguien se
quede con la empresa, así que piden **contraseña otra vez y un código de
dos pasos actual** (app o recuperación; el de recuperación se gasta). El
titular siempre tiene los dos pasos (son obligatorios para titulares) y
quien acepta también (el servicio lo exige). Cancelar y rechazar no piden
nada más: solo quitan una oferta.

La verificación es un servicio nuevo de plataforma,
`confirmIdentity(userId, { password, code }, headers)` en
`src/platform/auth/step-up.ts`, con el orden de `throttle.ts`:

1. `assertNotTerminalSession(userId)`: nunca desde una sesión de PIN.
2. Forma de lo escrito (contraseña no vacía; código de 6 números o de
   recuperación) antes de apartar un intento.
3. `reserveAttempt([stepUp(userId)])` (5 intentos en 15 minutos, bloqueo de
   15 minutos; llave propia, no comparte cupo con el inicio de sesión).
4. `verifyPassword` y después `verifyTOTP`/`verifyBackupCode` de Better
   Auth con la sesión de la petición.
5. Contraseña o código equivocado: `settleFailure`. Bien: `refundAttempt`
   (el intento correcto no cuenta, los fallos previos se quedan). Un error
   inesperado: `refundAttempt` y se lanza.

Las funciones nuevas que usan las Server Actions son
`offerOwnershipWithConfirmation` y `acceptOwnershipWithConfirmation`
(`ownership.ts`): comprueban primero lo barato y lo que no revela nada
(oferta: `assertOwnerAction("platform.ownership.transfer")`, que exige
titular con membresía activa, sin PIN ni soporte; aceptación: que exista
una oferta vigente para esa persona), luego `confirmIdentity`, y al final
llaman al servicio de siempre, que vuelve a decidir todo bajo el candado.
Las funciones sin confirmación siguen exportadas para pruebas y para el
servicio; **ninguna Server Action ni ruta las llama directo**.

Nunca: desde una sesión de PIN (`assertNotTerminalSession` y el recorte de
la política, que quita todo `platform.*` en terminal), por soporte de
plataforma (no tiene membresía: no es titular ni destinatario) ni por la
API (no hay ruta, y una llave nunca recibe permisos `platform.*`).

## Qué cambia al aceptar

| Qué | Qué pasa |
| --- | --- |
| Roles del titular anterior | Solo los que eligió al ofrecer (Consulta por omisión). Si eligió un rol ligado a un módulo que la empresa ya no tiene activo y que no tenía antes, **la aceptación se rechaza** con `module_missing` y hay que volver a ofrecer (hueco del servicio corregido en este paso). |
| Roles y alcance del nuevo titular | Se borran (ya lo hacía el servicio): el titular no tiene roles ni se limita a almacenes o zonas. |
| Sesiones | No se cierra ninguna. Los permisos se leen de la base en cada petición, así que el titular anterior pierde sus facultades en su siguiente clic y el nuevo las gana igual. |
| Llaves de la API | Actúan por quien las creó, recortadas por sus capacidades (ADR 0058). Las del titular anterior pasan a tener solo lo que permiten sus roles nuevos; las del nuevo titular, lo que ya tenían (su capacidad no crece). El nuevo titular puede revocarlas en «API y webhooks». No se revoca ninguna automáticamente. |
| Acceso de soporte abierto | **Se cierra** en la misma transacción (lo abrió el titular anterior; el nuevo decide si lo vuelve a abrir), con bitácora `support.revoked` a nombre de quien acepta y el motivo «transferencia de titularidad». |
| Aprobaciones pendientes | No cambian: la regla vigente y los roles se leen al decidir (ADR 0053). |
| Dos pasos del nuevo titular | Ya los tiene (requisito para aceptar) y desde ese momento no puede desactivarlos (`isMfaRequired`). |
| PIN | Quien tiene dos pasos no entra con PIN (ADR 0061); ninguno de los dos podía. |
| Ofertas | La aceptada queda `ACCEPTED`; no puede haber otra pendiente. |

## Avisos y rastro

- Tipo de aviso nuevo `team.ownership` («Transferencia de la empresa»,
  activo por omisión, sin módulo), con `to.userIds` y `href`
  `/configuracion/titularidad` o `/configuracion`:
  - al ofrecer, a quien recibe;
  - al cancelar, a quien tenía la oferta;
  - al rechazar, al titular;
  - al aceptar, al titular anterior.
- Correos de seguridad, sin enlaces (ni con token ni sin él), mandados
  después de confirmar la transacción; si fallan se registra en el log y la
  operación ya hecha no se deshace:
  - al ofrecer, al titular («Ofreciste la titularidad a X; si no fuiste tú,
    cancela la oferta y cambia tu contraseña») y a quien recibe («X te
    ofrece la titularidad; entra a WMS y ve a Configuración»);
  - al aceptar, a los dos.
- Bitácora de la empresa: `ownership.transfer_offered`,
  `ownership.transfer_cancelled`, `ownership.transfer_declined` (nueva) y
  `ownership.transferred`, con sus etiquetas en `AUDIT_ACTION_LABELS`, más
  `support.revoked` si se cerró soporte. La bitácora de la empresa la ve el
  titular, y quien tenga `platform.audit.read`.
- Historial de accesos: no aplica (no es un acceso a la cuenta). Los
  intentos fallidos de contraseña o código cuentan en el límite de
  intentos.

## Carreras

Todas las escrituras toman primero la fila de la empresa (`SELECT … FOR
UPDATE` por llave primaria, el mismo candado de `withTeamChange` y de
`lockOrganization`) y las transacciones se abren con `LOCKING_TRANSACTION`
(antes usaban el nivel por omisión; se corrige aquí).

- **Aceptar y cancelar a la vez:** una gana; la otra encuentra la oferta
  cerrada (`not_found`).
- **Dos ofertas a la vez:** la segunda cancela la primera; queda una sola
  pendiente.
- **Desactivar a la persona con oferta pendiente:** `disableMember` cancela
  en la misma transacción las ofertas pendientes para esa persona (antes la
  oferta quedaba pendiente pero sin poder aceptarse; ahora el titular la ve
  cerrada). Desactivar y aceptar a la vez: si gana desactivar, aceptar
  responde «ya no está disponible»; si gana aceptar, la persona ya es
  titular y no se puede desactivar.
- **Quitar un módulo del que depende un rol elegido:** al aceptar se
  vuelven a revisar los módulos (ver la tabla).
- **Rechazar y aceptar a la vez** (la misma persona en dos pestañas): una
  gana.

## Otros casos

- **Plan vencido:** sí se puede transferir. Es un cambio de plataforma, no
  una escritura del negocio, y puede ser justo lo que hace falta para que
  otra persona renueve. (El fundador puede cambiarlo.)
- **Empresa con un solo miembro:** no hay a quién ofrecer; la pantalla lo
  dice y enlaza a Equipo para invitar.
- **Cuenta con varias empresas:** la pantalla trabaja con la empresa activa
  de la sesión; una oferta de otra empresa se ve al cambiar a ella. El
  aviso es de su empresa.
- **Quien recibe deja de cumplir algo entre ofrecer y aceptar** (se
  desactiva, el titular cambió, venció): «ya no está disponible» o «venció»,
  la misma respuesta para cualquiera que no sea el destinatario.

## No entra

Cambiar de titular por soporte o por la consola interna, titularidad
compartida, transferir a una cuenta que no es miembro, reemplazar una oferta
pendiente en un solo paso desde la pantalla, y cerrar sesiones o revocar
llaves automáticamente al aceptar.

## Decisiones que el fundador puede cambiar

1. Se puede transferir con el plan vencido.
2. Ofrecer y aceptar piden contraseña y código de dos pasos; cancelar y
   rechazar no.
3. Al aceptar se cierra el acceso de soporte abierto; no se cierran
   sesiones ni se revocan llaves de la API.
4. Desactivar a la persona cancela su oferta pendiente.
5. El código de recuperación sirve como segundo factor (se gasta).
6. Rechazar queda como `CANCELLED` con su bitácora propia, sin estado
   nuevo en la tabla.

## Pruebas

`tests/platform/ownership-screen.int.test.ts`: recorrido ofrecer → aceptar
con sesión real (contraseña y código), cancelar y rechazar, contraseña o
código equivocados (con el límite de intentos), sesión de PIN, soporte,
dos empresas, oferta vencida, destinatario sin dos pasos, módulo quitado,
plan vencido, cierre de soporte y carreras con `Promise.all` (aceptar y
cancelar, aceptar y desactivar, dos ofertas, aceptar y rechazar). Las
Server Actions nuevas van en `REVIEWED` de
`tests/isolation/server-actions.int.test.ts` y el archivo se agrega a
NEG-26 en `NEGATIVE_CASES`.
