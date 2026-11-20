# ADR 0094 — Pedido del cliente ligado a producción y embarque

Fecha: 2026-11-20 · Estado: aceptada · Paso: WMS-79 (Fase 3, producción) ·
Usa ADR 0012 (movimientos y saldos), 0033 (estado y lote del saldo), 0038
(alcance), 0045 (despacho y embarques), 0052 (cross-docking), 0054 (olas),
0057 (avisos), 0062 (roles de producción y calidad), 0073 (órdenes de
producción), 0074 (orden de candados), 0075 (solicitudes de producción),
0077 (almacén archivado), 0087 (reporte de producción), 0089 (empresa de
demostración), 0091 (verificación) y 0093 (cierre de la orden) · Flujo:
`docs/flujos/PRODUCCION_CALIDAD.md` y decisiones del fundador del
2026-11-16 (noche, segunda y tercera tanda)

## Contexto

El fundador decidió (2026-11-16): «al liberar un pedido, lo que falta de un
producto con receta genera su solicitud de producción ligada a la línea; lo
producido se aparta para ese pedido y sigue a surtido y embarque»; «cada
empresa decide si lo usa (ajuste, apagado por omisión)»; «si hay material en
inventario se embarca directo; si no lo hay y el pedido necesita producirse,
la orden queda ligada al embarque para que no pueda irse sin lo que pidió el
cliente»; y «un embarque solo lleva lo que ya existe en inventario».

Hoy cada pieza existe por separado: al liberar un pedido se aparta lo que
hay y lo que falta queda como «faltante» de la línea (WMS-13/14); las
solicitudes de producción (WMS-28B) las pide una persona del área; lo
producido entra en inspección (WMS-29), se aprueba (WMS-30B) y sale a
acomodo (WMS-31); y el cross-docking (WMS-54) ya reparte lo que llega a los
pedidos que lo esperan. Falta la liga y la regla que impide despachar
incompleto.

## Ajuste

`inventory.outbound.make_to_order` (Operación › Inventario, área
«Pedidos»): `off` por omisión («Lo que falta queda pendiente», como hoy) u
`on` («Se pide a producción»). Se lee con `readSetting` dentro de la
transacción que libera. Con `off`, nada de lo de este ADR ocurre. Con `on`
pero sin Producción **activo** (no contratado, quitado o en solo lectura),
tampoco: la línea queda corta como hoy y no falla nada.

## Flujo operativo

### 1. Liberar el pedido

1. Quien libera (`inventory.outbound.release`) pulsa «Liberar» en la ficha
   del pedido. Se aparta lo que hay, como siempre (`pickSources`).
2. Con el ajuste en `on` y Producción activo, cada línea a la que le falta
   algo se revisa: **se puede producir** si su producto tiene una versión de
   receta **vigente** y un área de producción en el almacén del pedido: la
   de la receta (`recipe.areaLocationId`) si es de ese almacén, de uso
   «Producción» y no está archivada; si la receta no dice área, **la única**
   área de producción del almacén. Con varias áreas y sin área en la receta,
   o sin ninguna, la línea no se puede producir (la ayuda del ajuste dice
   «pon el área en la receta»).
3. Lo que falta de una línea que se puede producir **no es un faltante que
   detenga la liberación**: no se pregunta «¿liberar con lo que hay?» por
   ella. Una línea corta que no se puede producir sigue la regla de hoy
   (`short` o «Liberar con lo que hay»). Un pedido sin nada apartado se
   libera si al menos una línea queda esperando producción (como con
   cross-docking encendido).
4. En la misma transacción, por cada línea que se puede producir:
   - se abre su **espera de producción** (`outbound_line_wait`, ver
     «Modelo»): cuánto espera = lo pedido − lo apartado al liberar (ya
     cumple la regla de cantidad del producto, porque ambas cifras la
     cumplen);
   - nace una **solicitud de producción ligada** (`production_request`
     con `lineWaitId`), por esa cantidad, en el almacén del pedido y el área
     de arriba, a nombre de quien liberó (`requestedByUserId`), sin nota.
     Es una solicitud «del pedido»: **no** pasa por las tres condiciones de
     la solicitud manual (WMS-28B: nada a su nombre, de su área, cerca del
     mínimo), que son para el operario que pide por su cuenta; quien libera
     no necesita `production.request.create` porque la solicitud no la pide
     una persona del área sino el pedido, y el permiso que se exige es el de
     liberar (`inventory.outbound.release`). No se declaran permisos nuevos.
5. El aviso «por decidir» (`production.request_to_decide`) va a quien decide
   solicitudes y alcanza el área (la misma regla de WMS-28B), con el texto
   «Hay que producir 20 piezas de Tabla para un pedido (SP-0004).». No
   nombra el pedido ni al cliente: un mismo texto va a personas que quizá no
   leen pedidos.
6. La respuesta de liberar lo dice: «Se liberó el pedido PS-0001 … y se
   pidió producir 1 producto (SP-0004).».

**Qué no hace al liberar:** no mira las órdenes abiertas del mismo producto
que no están ligadas (pueden ser para existencias; quien decide las ve en la
pantalla de decisión, WMS-28B); no reparte entre pedidos (cada línea tiene
su propia espera y su propia solicitud); no redondea a la base de la
receta (una orden puede ser de cualquier múltiplo del paso del producto,
WMS-28).

**Liberar dos veces o a la vez:** liberar es una sola vez por pedido (bajo
su candado; la segunda vez responde `repeated` sin escribir). Una línea
tiene a lo más **una espera abierta** (`openLineId`, único).

**Olas (WMS-25):** crear una ola **no** pide producción: libera como hoy y
rechaza un pedido corto («Libéralo con lo que hay desde su pantalla»). Un
pedido ya liberado desde su pantalla, que espera producción, sí entra a una
ola (está `RELEASED`).

### 2. Decidir la solicitud ligada

Se decide como cualquier solicitud (WMS-28B): Encargado de producción,
Administración, Almacén y Supervisor de almacén que alcanzan el área. Al
aceptar nace la orden con `requestId` (ya existe), así que la orden queda
ligada a la línea por la solicitud. Diferencias:

- **Sin personas asignadas por omisión** (quien liberó suele no poder
  reportar producción); quien acepta puede elegirlas.
- **Si la espera ya no está abierta** (el pedido se canceló, dejó de esperar
  o ya recibió lo que le faltaba), aceptar se rechaza: «Ya no hace falta
  para el pedido: recházala.». Se lee después de tomar la solicitud
  (`claim`), así que una cancelación del pedido que ganó el candado se ve.
- La regla «quien no puede crear y liberar órdenes acepta como mucho lo
  pedido» sigue igual. Si se acepta más de lo que espera el pedido, lo que
  sobra sigue a acomodo (punto 3).
- La ficha de la solicitud dice «Para el pedido PS-0001 de <destinatario>»
  solo a quien lee pedidos (`inventory.outbound.read`) y alcanza el almacén;
  a los demás, «Para un pedido de un cliente».

Rechazar la solicitud deja la espera **abierta** y avisa (punto 5).

### 3. Lo producido se aparta para el pedido

El punto donde lo producido queda **disponible** es la verificación
(WMS-30B; sin Calidad, la misma verificación con
`production.output.verify`). Al decidir una verificación de un lote cuya
orden nació de una solicitud ligada a una espera **abierta**:

1. De lo aprobado (`AVAILABLE`) en cada lugar de destino se aparta para la
   línea, **antes** del acomodo: `min(lo aprobado ahí, lo que espera la
   espera − lo que ya recibió, lo que le falta a la línea, lo libre ahí)`.
   «Lo que le falta a la línea» es lo pedido − sus reservas activas (la
   misma cifra que usa el cross-docking).
2. Cada parte aparta para la línea y crea su tarea de surtido normal (`PICK`)
   desde ese lugar hasta «Preparación» del almacén, con `createPickTasks`
   (el mismo núcleo que liberar y el cross-docking). No se escribe un
   segundo reparto: el reparto entre pedidos no existe aquí, porque lo
   producido de una orden ligada es de **una** línea.
3. La espera suma lo recibido (`received`); cuando llega a lo que espera
   queda `DONE` («Ya llegó lo que faltaba»).
4. **Lo que sobra** (se produjo o aprobó más de lo que la línea espera)
   sigue a acomodo con la regla de WMS-31.
5. «Cambiar estado» de inspección a disponible **no** aparta para el pedido:
   el camino de lo producido es la verificación. Lo liberado así queda
   libre y la línea sigue esperando (la ficha del pedido lo dice).
6. Lo que el cross-docking manda a una línea que espera producción (llega
   una compra o una entrada a un lugar de paso) también suma a lo recibido
   de su espera: si con eso se completa, la espera queda `DONE` y lo
   producido después sigue a acomodo.

La etapa «Se guardó» del lote (WMS-31) no cuenta las tareas de surtido: con
lo aprobado apartado para el pedido, el lote ya salió del flujo de
producción.

### 4. El embarque no se va sin lo que falta

Un pedido con una espera **abierta** no queda «Surtido»: `settlePickedOrder`
lo deja «En surtido» aunque no le queden tareas de surtido abiertas. Como
el empaque solo empieza desde «Surtido» y un embarque solo admite pedidos
«Surtido» o «Empacado», el pedido **no se puede empacar, embarcar ni
despachar** mientras espera. `dispatchShipment` lo vuelve a revisar bajo sus
candados (defensa: responde «PS-0001 espera producción»). La tabla de
estados del pedido y del embarque **no cambia**.

Se suelta de tres formas, todas explícitas:

- **Llega lo que faltaba** (punto 3): la espera queda `DONE` y el pedido
  sigue con sus tareas de surtido.
- **«Dejar de esperar»** en la ficha del pedido (`inventory.outbound.release`,
  motivo obligatorio de 3 a 300 caracteres): las esperas abiertas del pedido
  quedan `DROPPED`, las solicitudes ligadas aún por atender se cancelan, y si
  el pedido estaba «En surtido» sin tareas abiertas pasa a «Surtido» con lo
  que tiene (se embarca parcial; el faltante queda como hoy). Las órdenes
  ligadas ya creadas **siguen su curso sin liga**: lo que produzcan va a
  acomodo.
- **Cancelar el pedido** (solo desde borrador o liberado, como hoy): las
  esperas quedan `CANCELLED` y sus solicitudes por atender se cancelan; las
  órdenes ya creadas siguen sin liga.

### 5. Cancelaciones y cierres, en cualquier orden

| Ocurre | Espera | Solicitud | Orden | Aviso |
| --- | --- | --- | --- | --- |
| Se rechaza la solicitud | sigue abierta | `REJECTED` | — | a quien liberó y a quien libera pedidos en ese almacén: «PS-0001 sigue esperando…; pide producción de nuevo o deja de esperar» |
| Se cancela la orden ligada (borrador o liberada) | sigue abierta | `ACCEPTED` | `CANCELLED` | el mismo |
| Se cierra la orden ligada con menos de lo que espera la línea | sigue abierta | — | `CLOSED` | el mismo, con cuánto falta |
| Se revierte un reporte | sin cambio (nada se había apartado: lo producido estaba en inspección) | — | — | — |
| La verificación rechaza todo | sin cambio | — | — | (al cerrar la orden, el aviso de arriba) |
| Se cancela el pedido | `CANCELLED` | por atender → `CANCELLED` | sigue sin liga | — |
| «Dejar de esperar» | `DROPPED` | por atender → `CANCELLED` | sigue sin liga | — |
| Llega todo lo que faltaba | `DONE` | — | sigue (lo demás va a acomodo) | — |

**«Pedir producción de nuevo»** (ficha del pedido, `inventory.outbound.release`):
para cada espera abierta **sin solicitud activa** (activa = por atender, o
aceptada con su orden en borrador, liberada o en proceso), nace otra
solicitud ligada a la misma espera por lo que aún espera (lo que espera −
lo recibido). Si todas tienen una activa responde `repeated`.

Nunca queda algo apartado para un pedido cancelado: cancelar el pedido ya
libera las reservas de sus líneas (WMS-13) y lo producido después no se le
aparta porque su espera ya no está abierta. Un pedido que espera una orden
que ya no existe lo ve quien libera pedidos (aviso y ficha) y se resuelve
con «Pedir producción de nuevo» o «Dejar de esperar».

### 6. Lo que se ve

- **Pedido** (`/pedidos/[id]`): por línea, «Espera producción: 20 piezas»,
  y si quien mira lee solicitudes u órdenes y alcanza el área, «Solicitud
  SP-0004 (por atender)» u «Orden OP-0007 (liberada)» con su enlace; si la
  espera ya no tiene nada activo, «Sin producción en curso». Los botones
  «Pedir producción de nuevo» y «Dejar de esperar» solo con
  `inventory.outbound.release`. La lista de pedidos marca «Espera
  producción».
- **Solicitud, orden y lote producido**: «Para el pedido PS-0001 de
  <destinatario>» con enlace, solo a quien lee pedidos y alcanza el almacén.
- **Inicio**: nada nuevo (el aviso lleva a la ficha del pedido).
- **Menú**: nada nuevo.

## Modelo

`outbound_line_wait` (Inventario, de empresa, en `TENANT_MODELS`):

| Columna | Qué es |
| --- | --- |
| `orderId`, `lineId`, `productId` | el pedido, su línea y el producto (inmutables) |
| `quantity`, `unitCode` | cuánto espera, en la unidad del producto (inmutable) |
| `received` | lo que ya se le apartó desde que se abrió (producción o cross-docking); solo sube |
| `status` | `OPEN`, `DONE`, `DROPPED`, `CANCELLED` (`OUTBOUND_WAIT_TRANSITIONS` de `wait-states.ts` y el disparador `outbound_line_wait_transition`, que cambian juntos: de `OPEN` a cualquiera de los otros, una vez) |
| `openLineId` | la línea mientras está abierta, `NULL` al cerrarse; único con la empresa: una espera abierta por línea |
| `openedByUserId`, `createdAt` | quién liberó y cuándo (inmutables) |
| `closedAt`, `closedByUserId`, `closeReason` | al cerrarse (`DONE` sin persona) |

No se borra (disparador). `production_request.lineWaitId` (nuevo, opcional,
inmutable: el disparador de transición lo agrega a lo que no cambia), con su
llave compuesta a `outbound_line_wait`. La orden llega a la espera por
`requestId` (ya existe y es inmutable). No hay disparadores que lean otras
tablas (regla de WMS-82): lo sostienen los servicios.

## Cómo se reparte el código

Inventario no importa Producción. Lo que Inventario necesita de Producción al
liberar se le **pasa** desde la aplicación, como los tipos de aprobación:
`MakeToOrder` (tipo de Inventario) con cuatro funciones que implementa
Producción (`makeToOrder` de `src/modules/production/make-to-order.ts`,
expuesto por `src/modules/registry`):

- `areasFor(client, facilityId, productIds)`: antes de los candados, qué
  áreas usarían esos productos (para bloquearlas en su orden);
- `makeable(tx, facilityId, productIds, lockedAreaIds)`: bajo los
  candados, qué productos se pueden producir y en qué área; con Producción
  no activo, nada;
- `ask(tx, actor, order, lines)`: crea las solicitudes ligadas (salta las
  esperas con una solicitud activa) y sus avisos;
- `closed(tx, actor, waitIds, why)`: cancela las solicitudes por atender de
  esas esperas (con Producción no activo no hace nada: aceptar las rechaza).

`releaseOutboundOrder`, `cancelOutboundOrder`, `stopWaitingForProduction` y
`askProductionAgain` reciben `{ makeToOrder }`. Las Server Actions de la
ficha del pedido lo pasan. **Quien llame a esos servicios sin `makeToOrder`
obtiene el comportamiento de hoy** (sin esperas nuevas; al cancelar, las
solicitudes por atender quedan y aceptarlas se rechaza). La verificación
(Calidad) llama a Inventario (`sendProducedToWait`) y Producción llama a
Inventario para leer la espera de una orden: ese sentido de dependencia ya
existía.

## Candados

Orden global (ADR 0074): productos → almacén → ubicaciones → documento →
contenedor → tareas → capacidad → progreso → archivos. Dentro de
«documento», el pedido de salida va **antes** que la solicitud de
producción, la orden de producción, la verificación y el embarque cuando una
misma transacción toma dos de ellos.

| Operación | Candados |
| --- | --- |
| Liberar con producción | productos de las líneas → almacén (exclusivo, solo la primera vez que se crea «Preparación») → **áreas de producción (compartido)** → pedido → (insertar solicitudes y esperas) → tareas |
| Pedir producción de nuevo | productos de las líneas que esperan → áreas (compartido) → pedido → insertar |
| Dejar de esperar | pedido → solicitudes (actualización condicionada) → ola |
| Cancelar el pedido | pedido → solicitudes (actualización condicionada) → ola (como hoy) |
| Aceptar la solicitud | productos de los materiales → solicitud → almacén (compartido) → orden → progreso (como WMS-28B); lee la espera sin candado después de tomar la solicitud |
| Decidir la verificación | producto → ubicaciones (inspección y destinos) → **pedido ligado** → (devolución) → verificación → tareas → capacidad → progreso → archivos |
| Cross-docking | productos → ubicaciones → (orden de compra) → pedidos → … (como hoy; suma a la espera bajo el candado del pedido) |
| Despachar | productos → ubicaciones → embarque → pedidos → bultos (como hoy; lee las esperas bajo el candado de los pedidos) |

Por qué las áreas se bloquean al liberar: insertar una solicitud dispara
`production_request_insert_rules`, que lee la ubicación del área y toma un
candado compartido sobre ella. Sin bloquearla antes del pedido, «Pedir
producción de nuevo» (pedido → área) se interbloquearía con la entrega de
una tarea de surtido de ese pedido que sale del área (área → pedido). Las
áreas se leen antes sin candado (`areasFor`) y, bajo el candado, una receta
que cambió de área responde «La receta cambió mientras se liberaba» sin
escribir.

Todas las escrituras de una espera ocurren bajo el candado de su pedido
(liberar, pedir de nuevo, dejar de esperar, cancelar, verificación,
cross-docking): ese candado es lo que impide dos esperas abiertas o dos
solicitudes activas para una línea, y lo que hace que «dos pedidos esperando
el mismo producto» no se crucen (cada orden aparta solo para su línea).

## Alcance, permisos y contexto

- **Alcance (ADR 0038):** la solicitud ligada usa el área de la receta aunque
  quien libera no alcance esa zona (la pide el pedido, no la persona). Un
  pedido existe para quien alcanza su almacén; una solicitud u orden, para
  quien alcanza su área. Cada ficha nombra al otro documento solo si quien
  mira lo alcanza y lo puede leer. Los avisos van por permiso y lugar.
- **Costos:** nadie nuevo ve costos; ninguna pantalla ni aviso de este paso
  los muestra.
- **Sesión de PIN:** liberar, dejar de esperar y pedir de nuevo siguen la
  regla de `inventory.outbound.release` en una terminal (se conserva).
- **Plan vencido o Producción en solo lectura:** todo se ve; liberar con
  producción no crea nada (Producción no está activo) y lo demás es
  escritura, rechazada como siempre. «Dejar de esperar» y cancelar el pedido
  siguen funcionando con el plan vigente aunque Producción ya no esté
  activo, para que un pedido nunca quede atrapado.
- **Quitar Producción:** `productionOpenWork` cuenta también los pedidos que
  esperan producción.
- **Empresa de demostración (ADR 0089):** nada sale hacia terceros: sin
  cambios.
- **API:** no se agrega nada (la API solo crea borradores).

## Lo que no entra

Reproceso (WMS-29B), indicadores de producción (WMS-33), automatizaciones
(WMS-64), pedir producción desde la API o al crear una ola, reparto de una
orden entre varios pedidos, unir varias líneas en una sola solicitud,
apartar al liberar con «Cambiar estado», y avisar cuando la espera se
completa.

## Riesgos y migración

Migración `20261120170000_wms79_outbound_line_wait`, de expansión: tabla
nueva, columna opcional nueva en `production_request` y el disparador de
transición de la solicitud recreado con la columna nueva. El código anterior
ignora las esperas: con él, un pedido que espera podría pasar a «Surtido».

## Pendientes conocidos

- Las pantallas no se revisaron en navegador; `verify:ui`/`verify:a11y`
  llevan la ficha del pedido.
- Un pedido liberado sin nada apartado cuya espera se deja sigue «Liberado»
  sin tareas: se cancela.
- Si una persona libera a mano lo producido con «Cambiar estado», la línea
  sigue esperando aunque haya existencias libres: hay que surtirla a mano o
  dejar de esperar.

## Decisiones que el fundador puede cambiar

1. Ajuste apagado por omisión y por empresa (no por producto ni por
   cliente).
2. La solicitud nace a nombre de quien libera y sin las tres condiciones de
   la solicitud manual.
3. Con varias áreas y sin área en la receta, no se pide producción.
4. Liberar no pregunta por las líneas que se van a producir.
5. Una solicitud por línea; no se juntan líneas ni pedidos.
6. Solo la verificación aparta lo producido para el pedido; «Cambiar estado»
   no.
7. Lo que sobra va a acomodo.
8. Rechazar la solicitud, cancelar o cerrar corta la orden **no** cierra la
   espera: el pedido sigue esperando hasta que alguien pide de nuevo o deja
   de esperar (avisado).
9. Cancelar el pedido o dejar de esperar cancela las solicitudes por
   atender pero no las órdenes ya creadas.
10. Las olas no piden producción.
11. Sin personas asignadas por omisión en la orden de una solicitud ligada.

## Consecuencias

Un pedido puede esperar producción sin que nadie lo empuje a mano, sin
despacharse incompleto por accidente y con cada documento ligado a la vista
de quien puede verlo. Lo existente (liberar sin el ajuste, olas,
cross-docking, verificación sin liga) no cambia.
