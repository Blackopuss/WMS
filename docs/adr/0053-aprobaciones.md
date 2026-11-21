# ADR 0053 — Flujos de aprobación y ajustes con autorización

Fecha: 2026-11-14 · Estado: aceptada · Pasos: WMS-56 (motor de aprobaciones)
y WMS-41 (ajustes con autorización) · Completa ADR 0034 (ajustes de
operación), ADR 0006 (bitácora), ADR 0038 (alcance) y ADR 0050 (revisión de
conteos) · Prepara WMS-57 (solicitudes de compra) y la liberación de calidad

## Contexto

La especificación (6.3) pide que **los ajustes por encima de un umbral
requieran autorización** y que quede **quién solicitó y quién autorizó**; su
prueba crítica **PC-7** dice: «Un ajuste queda auditado y requiere
autorización según reglas». El plan v3 abre la Fase 3 con un **motor de
aprobaciones** reutilizable (WMS-56): la empresa define qué requiere
aprobación y quién aprueba; quien aprueba ve sus pendientes y decide con
motivo. Lo usarán los ajustes (WMS-41), las solicitudes de compra (WMS-57) y
la liberación de calidad (WMS-30).

Hasta hoy un ajuste se aplica al confirmarlo (INV-24) y un conteo con
diferencias grandes solo pide marcar «Revisé las diferencias» (WMS-55,
ADR 0050).

## Flujo operativo

1. **La empresa decide** (Configuración › Aprobaciones, quien tiene
   `platform.organization.update`: titular y administración): para cada
   tipo de aprobación que ofrecen sus módulos, si **pide autorización**
   (apagado por omisión: sin encenderlo nada cambia), **quién autoriza** (uno
   o varios roles; el titular siempre puede) y si **quien lo pide puede
   autorizarlo él mismo** (por omisión no). En la misma tarjeta están los
   ajustes que dicen *cuándo* aplica (el umbral). Cada cambio deja bitácora
   (`approval.rule_changed`).
2. **Alguien pide algo que requiere autorización** (p. ej. «Corregir
   existencias» por encima del umbral). Nada se aplica: queda una
   **solicitud** con un resumen legible fijado en ese momento y los datos
   que el módulo necesita para aplicarla después. La persona lee «Quedó
   pendiente de autorización» y la ve en Aprobaciones › Mis solicitudes;
   puede retirarla mientras nadie la decida.
3. **Quien puede autorizar** la ve en Aprobaciones › Por decidir (y en
   Inicio, «Aprobaciones pendientes», solo cuando hay) y abre su detalle:
   qué se pide, quién y cuándo, y **Autorizar** o **Rechazar** (el rechazo
   exige motivo; la autorización lo admite).
4. **Al autorizar**, el módulo aplica lo pedido **en la misma transacción**
   y contra lo que hay en ese momento. Si el mundo cambió y ya no aplica, la
   solicitud queda **vencida** con el motivo y no se escribe nada más.
5. Todo queda en la bitácora: pedida, autorizada (por quién), rechazada,
   retirada, vencida; y el movimiento que resulta queda a nombre de quien lo
   pidió, con quién lo autorizó.

## El motor es de plataforma y no sabe de inventario

`src/platform/approvals` (nunca importa módulos). Un módulo **declara sus
tipos de aprobación** (`ApprovalType`) y `src/modules/registry/approvals.ts`
los junta (`approvalTypes`, validado al arrancar con
`assertValidApprovalTypes`), igual que ajustes, trabajos y rondas. Un tipo
dice:

- `key` (`modulo.cosa`, p. ej. `inventory.adjustment`), `module`, `label` y
  `description` en español;
- `requestPermissions`: qué hace falta para pedirlo (el servicio del módulo
  lo comprueba antes de pedir; la pantalla lo muestra);
- `decidePermissions`: qué debe tener **además** quien autoriza (aprobar no
  da más poder que el que ya se tiene: para autorizar un ajuste hay que
  poder ajustar);
- `settings`: los ajustes de operación que dicen cuándo aplica (se muestran
  en su tarjeta de Aprobaciones y no se repiten en Operación);
- `approve(tx, contexto)`: aplica lo pedido dentro de la transacción de la
  decisión y devuelve su resultado en una frase; lanza `ApprovalExpired` si
  ya no aplica;
- `reject` (opcional) y `href` (dónde ver el documento).

El módulo pide con `openApprovalRequest(tx, tipo, actor, …)` **dentro de su
propia transacción**, después de sus candados: así «comprobar y pedir» es
atómico y una solicitud no nace a medias.

## Datos

- `approval_rule` (empresa + tipo, única): `enabled`, `approverRoles`
  (roles de la matriz separados por coma; los desconocidos se ignoran al
  leer) y `allowSelfApproval`. Sin fila: apagado, sin roles, sin
  autoaprobación. Es configuración (se edita), con bitácora.
- `approval_request`: tipo, a qué se refiere (`sourceType` + `sourceId`),
  almacén y ubicación opcionales (alcance), resumen fijado (`summary`, sin
  costos), `payload` (JSON que valida el módulo, nunca secretos), quién y
  cuándo, estado y decisión (`decidedByUserId`, `decidedAt`,
  `decisionReason`, `outcome`). `idempotencyKey` (única por empresa) hace
  que un reintento del formulario no pida dos veces; `openKey` (única por
  empresa, solo mientras está pendiente) impide dos solicitudes abiertas
  sobre lo mismo (un conteo; un producto en una ubicación y lote).
- **Estados:** `PENDING → APPROVED | REJECTED | CANCELLED | EXPIRED`, y nada
  más. La tabla pura es `APPROVAL_TRANSITIONS` (con prueba unitaria) y el
  disparador `approval_request_transition` la repite: además, una solicitud
  no cambia nada salvo su estado y su decisión, y no se borra.

## Decidir

`decideApproval` es una transacción (`LOCKING_TRANSACTION`):

1. Bloquea la solicitud (`lockRows(tx, "approvalRequest", …)`) y la lee. Si
   ya no está pendiente responde `repeated` si fue la misma decisión, o dice
   cómo terminó: **no se aprueba dos veces**, tampoco con dos personas a la
   vez (la segunda espera el candado y la encuentra decidida).
2. Con la persona leída de la base **bajo ese candado** (roles, titular y
   alcance de su membresía activa) y la **regla vigente**: tiene uno de los
   roles de la regla o es titular; tiene `decidePermissions` (con el módulo
   activo y no en solo lectura); alcanza el almacén o la ubicación de la
   solicitud; y no es quien la pidió, salvo que la regla lo permita (también
   el titular: la regla de cuatro ojos vale para todos). Apagar la regla no
   deja huérfanas las pendientes: se deciden con sus roles vigentes; solo ya
   no se crean nuevas.
3. Autorizar llama `approve(tx, …)` del tipo **en la misma transacción**.
   Si lanza `ApprovalExpired`, se revierte todo lo que el efecto alcanzó a
   escribir y una segunda transacción (otra vez bajo el candado, si sigue
   pendiente) la marca **vencida** con ese motivo. Cualquier otro error
   revierte todo y la solicitud sigue pendiente.
4. **Orden de candados:** solicitud → lo que bloquee el efecto (productos →
   ubicaciones → documento). Nadie bloquea una solicitud después de un
   producto o un conteo: pedir **inserta** la solicitud (no bloquea filas
   existentes) y retirar o vencer bloquean solo la solicitud. Por eso no hay
   ciclo; `approvals.int.test.ts` lo ejercita con decisiones simultáneas.

Una solicitud de un almacén o una zona fuera del alcance de la persona «no
existe» para ella (`not_found`, y no aparece en sus listas).

## Ajustes con autorización (WMS-41)

Tipo `inventory.adjustment` («Corregir existencias»). Cuándo aplica: ajuste
de operación `inventory.adjustment.approval_threshold` — cualquier ajuste
(por omisión, al encender la regla), o si la diferencia pasa del 10, 25 o
50 % de lo que el sistema tiene en esa ubicación (y lote); si el sistema no
tenía nada, cuenta como grande. Para un producto por serie la diferencia es
el número de series que faltan más las que aparecen. **No hay umbral por
valor**: la regla de ajustes solo admite opciones fijas y un monto por
empresa necesita un ajuste numérico; queda pendiente (sería un criterio
interno que nunca se muestra).

`registerAdjustment` hace todo lo de siempre bajo sus candados (producto →
ubicación), y **justo antes de escribir**: si la regla está encendida y la
diferencia pasa del umbral, no escribe nada y pide la autorización con el
producto, la ubicación, el lote (o el código y caducidad de uno nuevo, que
**no** se crea todavía), las series, lo contado en la unidad del producto,
lo que el sistema tenía, el motivo, la referencia y la clave de
confirmación. Responde `reason: "pending_approval"` con la solicitud (no
`ok: true`: quien espera un movimiento nunca cree que lo hubo). Un reintento
con la misma clave responde lo mismo (`repeated`); otra corrección del mismo
producto, ubicación y lote mientras haya una pendiente se rechaza.

**Al autorizar** (la semántica central): el ajuste se aplica con el mismo
servicio, a nombre de quien lo pidió, llevando el saldo **a lo contado**,
**solo si el saldo no se movió desde que se pidió**: si el saldo de ese
producto en esa ubicación y lote ya no es el que había, o hubo cualquier
movimiento del producto en esa ubicación después de pedirlo, la solicitud
**vence** («Hubo movimientos… cuenta de nuevo y vuelve a pedirlo»). Es la
misma idea que INV-32 con los conteos: nunca se aplica a ciegas una
diferencia vieja, y «lo contado» solo vale contra lo que había cuando se
contó. Todas las demás reglas del ajuste se revisan otra vez (producto
activo, ubicación no archivada, alcance de quien lo pidió, tarimas, series,
lote); la que falle también vence la solicitud con su mensaje. La bitácora
del ajuste (`inventory.adjusted`) lleva `autorizadoPor` y la solicitud; la
de la solicitud (`approval.approved`) lleva el movimiento.

Pide autorización quien puede ajustar (`inventory.adjustment.create`:
titular, administración, Almacén y supervisión); el Almacenista no ajusta
hoy y sigue sin hacerlo (un permiso «pedir un ajuste» para el piso queda
como decisión del fundador).

## Conteos con diferencias grandes

Tipo `inventory.count_apply` («Aplicar conteos con diferencias grandes»),
con el umbral de siempre (`inventory.count.review_threshold`, ahora en su
tarjeta de Aprobaciones). Con la regla apagada se queda la revisión de
WMS-55 (casilla y motivo). Encendida, aplicar un conteo con líneas que
pasan del umbral **no aplica**: pide la autorización (una por conteo,
`openKey = count:<id>`) con el motivo y una huella de lo capturado. Mientras
está pendiente el conteo sigue abierto pero **no admite capturas, quitar
capturas, cancelarse ni aplicarse otra vez** (la pantalla dice «Esperando
autorización» y enlaza la solicitud); así lo autorizado es exactamente lo
que se pidió. Al autorizar se aplica con `applyCount` (lo mismo de INV-32/33,
diferencias contra `systemQuantity`, a nombre de quien lo pidió); si la
huella ya no coincide o el conteo ya no puede aplicarse, la solicitud vence.
Quien autoriza necesita `inventory.count.apply` y
`inventory.adjustment.create`.

## Quien pidió sigue pudiendo (WMS-97, 2026-11-21)

Al autorizar un ajuste (`inventory.adjustment`) o la aplicación de un conteo
(`inventory.count_apply`), el efecto vuelve a leer con la transacción de la
decisión la membresía activa de quien pidió y sus permisos vigentes
(`inventory.adjustment.create`, y para el conteo también
`inventory.count.apply`); si ya no los tiene, la solicitud vence con su
motivo (`requesterNoLongerMay`, NEG-20), como el desecho desde WMS-83.

## Pendientes

- **Aviso por correo** a quien puede autorizar (con `enqueueJob` y la regla
  de «Correo a terceros»). Dentro de la app ya avisa (WMS-39, ADR 0057):
  pedir avisa a quien puede decidir (roles de la regla vigente o titular, con
  los permisos del tipo, dentro del alcance) y decidir o vencer avisa a quien
  pidió.
- **Evidencia** (WMS-37, fotos): la solicitud tendrá sus archivos con
  `storeFile`; el resumen ya deja el lugar.
- Umbral por valor (cantidad × costo promedio), como criterio interno.
- Que Gerencia vea el historial de todas las solicitudes (hoy lo lee en la
  bitácora).
- Vencer solas las solicitudes viejas (hoy vencen al intentar autorizarlas).
- Solicitudes de compra (WMS-57) y liberación de calidad: declararán sus
  tipos; el motor no cambia.

## Alternativas descartadas

- **Un permiso «aprobar» por tipo en la matriz:** obliga a tocar la matriz
  por cada tipo y no deja que cada empresa elija quién; la regla por roles
  más el permiso de la operación cubre las dos cosas.
- **Guardar la diferencia y aplicarla después:** con movimientos de por
  medio daría un saldo que nadie contó.
- **Crear la solicitud fuera de la transacción del módulo:** entre comprobar
  y pedir podría cambiar el saldo; dentro, bajo sus candados, no.
- **Que la plataforma conozca los ajustes:** rompe la arquitectura; el
  efecto lo registra el módulo.

## Decisión del fundador (2026-11-13)

El Almacenista de piso no pide correcciones de existencias: no se agrega un permiso de «pedir ajuste» para ese rol.
