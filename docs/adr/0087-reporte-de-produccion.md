# ADR 0087 — Reporte de producción

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-29 (Fase 3, producción) ·
Usa ADR 0012 (movimientos y saldos), 0031 (costo promedio), 0033 (estado y
lote del saldo), 0038 (alcance), 0039 (capacidad), 0040 y 0041 (lotes y
series), 0043 (tarimas), 0053 (aprobaciones), 0057 (avisos), 0061 (PIN),
0062 (roles de producción), 0063 y 0076 (fotos), 0066 (recetas), 0068
(retención y desecho), 0069, 0071 y 0073 (procesos y órdenes), 0072
(restauración), 0074 (orden de candados), 0075 (solicitudes), 0077
(almacén archivado), 0078 (desechar con autorización) · Flujo:
`docs/flujos/PRODUCCION_CALIDAD.md` (sexta versión), D1, D5, D8, D11, P1,
P2, P7d, P10b, P12 y secciones 5.4, 5.6, 6, 7, 8 y 10

## Contexto

Una orden de producción (WMS-28, ADR 0073) se crea, se libera y aparta sus
materiales, pero nada se consume ni entra. El fundador decidió que el
operario solo dice **cuánto hizo** (y, si hubo, cuántas piezas malas), que
**el consumo es automático según la receta** (P1), que no se produce más de
lo que pide la orden (D11), que **cada reporte es un lote** con la
nomenclatura de la empresa (D8, P12), que **lo producido espera
verificación** (D5, PC-5), que el costo de lo producido es **solo
materiales** (D1) y que la merma extra de material es **una operación
aparte**, fuera del costo del producto.

Este paso deja el reporte, su reversa, la merma de material, la
nomenclatura de lotes, el aviso de material que falta y el rastreo. **No**
verifica ni inspecciona (WMS-30B), no acomoda ni cierra la orden (WMS-31),
no reprocesa (WMS-29B) ni liga pedidos (WMS-79).

## Flujo operativo

1. **Quién y dónde.** Quien tiene `production.report.create` (Operario,
   Encargado de producción, Administración y titular), en teléfono, tableta
   o una terminal compartida con PIN (el permiso se conserva ahí), y
   alcanza el área de la orden. **Si la orden tiene personas asignadas,
   reportan ellas y quien puede crear órdenes** (`production.order.create`:
   Encargado, Administración, titular); sin personas asignadas, cualquiera
   con el permiso que alcance el área. (El fundador puede cambiarlo: hoy la
   asignación sí limita.)
2. **Entrada.** En la ficha de la orden (`/produccion/[id]`) → «Reportar
   producción» (`/produccion/[id]/reportar`). La orden debe estar liberada
   o en proceso.
3. **Lo que se captura** (nada más):
   - **Hice**: cantidad buena, en la unidad de la orden con la regla de
     cantidad de su producto (`parseQuantity`). Nunca más de lo que falta:
     cantidad de la orden − lo bueno de los reportes no revertidos,
     comprobado bajo el candado de la orden (D11, regla fija).
   - **Piezas malas** (opcional) y su **motivo** (obligatorio si hay
     malas): no entran al almacén, pero su material sí se descuenta.
   - Si un material es **por serie**: las series que se usan (única captura
     del consumo, para la trazabilidad).
   - Si lo que sale es **por serie**: las series de lo producido.
   - Si lo que sale es **por lote con caducidad**: la caducidad (obligatoria
     si el producto la exige). El código del lote lo pone el sistema.
   - **Foto** según el ajuste `production.report.photo` (ver «Foto»).
   - Debe haber algo: buenas + malas > 0. Un reporte solo con malas es
     válido (se rompió todo lo que se hizo): consume y no entra nada.
4. **Antes de guardar**, la pantalla dice con lo que hay a su alcance para
   cuánto alcanza el material («Con el material a tu alcance alcanza para
   80 piezas»). Es solo una lectura; el servidor decide bajo candado.
5. **Guardar.** En una transacción: descuenta lo que dice la receta para
   buenas + malas, mete lo producido **en `INSPECTION` en el área**, crea su
   lote, guarda el reporte con su foto y, si la orden estaba liberada, la
   pasa a «En proceso». Si el material no alcanza, **no guarda nada** y dice
   qué falta y para cuánto alcanza («Falta 1 hoja de Material A; con lo que
   hay alcanza para 96 piezas»). La persona puede reportar lo que sí
   alcanza y tocar «Avisar que falta material».
6. **Avisar que falta material** (en la ficha de la orden, para quien
   reporta): un aviso a quien decide en el área (Encargado de producción,
   Almacén, Supervisor de almacén, Administración y titular por su
   permiso), con la orden y el material que falta, una vez por orden y
   hora. No abre incidencia (se reporta aparte si se quiere).
7. **Corregir.** «Revertir reporte» (`production.report.reverse`: Encargado,
   Administración, titular), con motivo, mientras **todo** lo producido por
   ese reporte siga en inspección en el área, sin verificar ni movido (ver
   «Reversa»). Después, la diferencia la reporta quien verifica (WMS-30B).
8. **Merma de material** («Reportar merma de material» en la ficha,
   `production.scrap.create`): material de la orden, cantidad, motivo y, si
   es por serie, sus series. Escribe un `DISPOSAL` ligado a la orden que
   saca lo apartado para la orden y, si no alcanza, lo libre (mismas reglas
   de «de dónde» que el reporte). No entra al costo de lo producido. Puede
   pedir autorización (ver «Merma y autorización»).

## Cantidades y redondeo

Sea `C` la suma de buenas + malas de los reportes **no revertidos** de la
orden contando el nuevo, `G` la de buenas, y `base` el «para cuánto» de la
versión de la receta que copió la orden:

- **Material de cada línea:** objetivo = `ceil_paso(cantidad de la receta ×
  C ÷ base)` (una sola división, redondeo al paso del material hacia
  arriba, la regla pura `scaleInput` de `order-rules.ts`); este reporte
  consume **objetivo − lo ya consumido** por la línea en reportes no
  revertidos (nunca negativo). Así la suma de los consumos de varios
  reportes parciales es siempre el objetivo acumulado: **no deja residuos
  ni pasa de lo copiado en la orden mientras `C ≤ cantidad de la orden`**.
  Las piezas malas pueden llevar `C` por encima de la cantidad de la orden:
  entonces se consume más de lo apartado y lo que falta se toma de lo libre.
- **Lo que sale:** objetivo = `floor_paso(cantidad de salida × G ÷ base)`
  (`scaleOutput`, hacia abajo, nunca promete de más) menos lo ya producido
  de esa salida. Con la receta usual (el producto de la orden sale en la
  cantidad base) entran exactamente las buenas. Lo que no llega a una
  unidad completa en un reporte entra en el siguiente (acumulado).
- **El último reporte** no tiene trato especial: el acumulado lo cuadra.
- Las piezas malas **no** producen subproductos (solo las buenas).
- Pasos decimales: todo con `Decimal` exacto; el paso es el de cada
  producto.
- La regla pura nueva `reportPlan` (`report-rules.ts`) calcula consumos,
  salidas y «alcanza para», con prueba unitaria.

## De dónde se consume

Bajo el candado de los productos, por cada línea, en este orden:

1. **Lo apartado para la línea** (reservas `production_order_line` activas)
   en ubicaciones **al alcance de quien reporta**, **menos lo que una tarea
   `ISSUE` abierta de esa línea todavía tiene que llevar** desde ahí (su
   origen, producto y lote), donde esté: lo que caduca antes primero,
   después lo que está dentro del área, después por ubicación. Se toma como
   mucho lo suelto (saldo disponible menos lo que está en una tarima de
   almacenamiento: lo de una tarima no se toma suelto, ADR 0043).
2. **Lo libre**, con `pickSources` (lo que caduca antes primero; no
   caducados salvo el ajuste), en el almacén de la orden, al alcance de
   quien reporta y, en modo `issue`, solo dentro del área.
3. Si no alcanza: no se guarda (ver arriba).

- **Materiales por serie:** las series escaneadas mandan: cada unidad debe
  estar disponible, en una ubicación al alcance (en modo `issue`, en el
  área o donde haya algo apartado para la línea sin tarea que lo respalde;
  fuera del área, como mucho tantas series como lo apartado ahí: unidades
  libres fuera del área no se toman y el reporte responde «no alcanza»,
  igual que sin serie), sin tarea abierta ni tarima; por cada ubicación y lote se toma
  primero lo apartado ahí para la línea y el resto debe estar libre. El
  número de series debe ser exactamente lo que se consume.
- **Fuera del alcance:** lo apartado en ubicaciones que quien reporta no
  alcanza no se toma y no se nombra. (Decisión conservadora que el fundador
  puede cambiar: en modo `direct` conviene que el Operario alcance las
  zonas de los materiales, o usar modo `issue`.)
- **Lo apartado que no se usa** se queda apartado para la orden; lo suelta
  el cierre (WMS-31) o la cancelación.
- **Tareas `ISSUE` a medias:** no se tocan; lo que traen sigue apartado en
  su origen hasta que se entregan, y ni el reporte ni la merma lo toman,
  en cualquier modo.

### De dónde, sin depender del ajuste vigente

Corrección de la revisión independiente: decidir por el valor **de hoy** de
`production.materials.mode` rompía las órdenes abiertas cuando la empresa
lo cambiaba. De `issue` a `direct`, el reporte consumía en el origen lo
apartado que respaldaba una tarea `ISSUE` y la tarea ya no podía entregarse
ni cancelarse; de `direct` a `issue`, el reporte respondía «no alcanza»
aunque lo apartado para la orden estaba en el estante y no existía ninguna
tarea que lo trajera. Ahora **lo apartado se decide por lo que la orden
tiene de verdad**, sin columna nueva: nunca se toma lo que respalda una
tarea `ISSUE` abierta (se resta por origen y lote), sí lo ya entregado al
área, y sí lo apartado fuera del área que ninguna tarea respalda. El ajuste
solo decide **lo libre** (en `issue`, solo en el área). Así una orden
liberada en cualquier modo sigue produciendo después del cambio y cada
tarea encuentra lo que lleva al entregarse (pruebas «where materials come
from, whatever the setting says now»). Se descartó guardar el modo en la
orden al liberarla: exigía columna, migración y resolver por sus tareas
las órdenes ya liberadas, y la regla por lo que la orden tiene da el mismo
resultado sin eso. En modo `issue` sin cambios de ajuste el resultado es el
de antes: lo apartado fuera del área siempre tiene su tarea.
- Lo apartado para la orden ya restaba de lo libre, así que tomarlo nunca
  quita nada a otro documento; lo libre se toma con las reglas de siempre.

## Lo que escribe el reporte

Un movimiento nuevo **`PRODUCTION`** (valor nuevo de `StockMovementType`):

- Una línea `OUT` por cada ubicación, lote y estado de cada material
  (siempre `AVAILABLE`), con sus series.
- Una línea `IN` por cada salida con cantidad > 0, **siempre en
  `INSPECTION`** en el área, con su lote y sus series. Lo producido nunca
  queda disponible sin verificar (PC-5); sin WMS-30B lo decide «Cambiar
  estado» (como lo recibido en inspección, ADR 0068).
- `reference`: «OP-0001 · R-02». Clave de confirmación del formulario en
  `idempotencyKey`.
- **No se reversa desde Inventario** (como `RECEIPT`, `SHIPMENT`…): se
  corrige con «Revertir reporte».

Tablas nuevas (de empresa, en `TENANT_MODELS`, inmutables por disparador
salvo la marca de reversa una sola vez; nada se borra):

- `production_report`: orden, número dentro de la orden (`R-01`), movimiento
  (único), buenas, malas, motivo de las malas, unidad, código de lote
  producido (texto, para mostrar), quién y cuándo; y, una sola vez, quién,
  cuándo y por qué se revirtió y su movimiento de reversa.
- `production_report_line`: una por línea del movimiento: material
  (`INPUT`, con su línea de la orden y **cuánto salió de lo apartado**, para
  devolverlo al revertir) o salida (`OUTPUT`, con su salida de la orden).
  Es lo que suma «ya consumido» y «ya producido».
- `production_scrap`: la merma de material (orden, línea, movimiento
  `DISPOSAL`, cantidad, cuánto salió de lo apartado, motivo, quién).
- `production_lot_numbering` y `production_lot_sequence`: la nomenclatura.

`production_order.startedAt` se escribe con el primer reporte (y el estado
pasa `RELEASED → IN_PROGRESS`; la tabla y el disparador ya lo admiten).
**Quién ejecutó** (P7d) son las personas de los reportes: la ficha lo
muestra.

## Costo (sección 7)

- Cada material sale al costo promedio (`openCostBook`, `exit`), antes de
  cambiar saldos, con los productos bloqueados.
- Valor del reporte = Σ cantidad × costo de cada material **que tiene
  costo** (buenas y malas: el material de las malas queda en el costo de
  las buenas).
- Se reparte entre las salidas que **entran en este reporte**, en
  proporción a su parte del costo de la receta (normalizada entre las que
  entran; si todas las que entran tienen 0 %, todo va a la primera). Costo
  por unidad = su parte ÷ lo que entra. Una salida con 0 % entra con costo
  explícito 0.
- **Si un material no tiene costo conocido** (WMS-92, decidido por el
  fundador el 2026-11-20: «Y lo de material haz que tome el costo de todo
  lo demás»): sale sin costo y aporta cero; lo producido toma el valor de
  los demás materiales, repartido igual que siempre. **Lo producido entra
  sin costo solo si ningún material de la orden** (no solo los que toma
  este reporte) **tiene costo conocido** al reportar, leído con los
  candados de productos que el reporte ya toma (sin candados nuevos); en
  ese caso entra al promedio vigente si ya tenía, o sin costo. **Si alguno
  lo tiene, el valor es siempre explícito**: la suma de lo que salió con
  costo en **ese** reporte, aunque sea 0 (un reporte posterior que solo
  toma materiales sin costo, o ninguno porque lo cubrieron los anteriores,
  hace entrar lo producido a 0 y no al promedio vigente). Así la suma del
  valor de lo producido nunca pasa de lo que salió de los materiales (prueba
  «a later report that only takes materials without cost adds no value»:
  base 10 con 1 A de costo 10 y 10 B sin costo, orden de 2 reportada
  pieza por pieza: lo producido vale 10 en total, el segundo reporte entra
  a 0 y su reversa saca lo producido a 0). Antes de este cambio, un solo
  material sin costo dejaba todo lo producido sin costo y el valor de los
  que sí lo tenían salía del inventario.
- **Que se sepa:** la ficha del reporte, solo para quien tiene
  `inventory.cost.read`, dice qué materiales no están en el costo de lo
  producido porque no tienen costo registrado (derivado de las líneas de
  salida sin costo del movimiento; nada guardado nuevo). Un reporte solo
  de piezas malas no produce nada y no lleva ese aviso. El valor de la
  ficha es «sin costo conocido» solo cuando ningún material salió con
  costo y lo producido entró sin costo.
- **Redondeo:** el costo por unidad de cada salida es su parte ÷ lo que
  entra, redondeado a la escala del libro de costos (`COST_SCALE`). La
  diferencia entre lo que entra y lo que salió es de hasta media unidad de
  `COST_SCALE` **por unidad producida**; con cantidades muy grandes el
  total puede llegar a unidades enteras de moneda (medido por el revisor:
  −1.34 sobre 222,222 con 2 millones de kg). No se reparte el residuo: es
  el comportamiento que ya tenía `valueEntry` en cualquier entrada.
  `reconcileValue` compara cada producto con sus propias existencias × su
  promedio, así que queda vacío (pruebas «splits it among the outputs by
  their share» y «partial reports add up to one report»).
- **Salidas que no entran por el redondeo:** una salida cuya cantidad
  acumulada redondeada al paso todavía no llega a una unidad más no entra
  en ese reporte, y su parte del valor se queda en las salidas que sí
  entran (el reparto se normaliza entre ellas). Cuando entre en un reporte
  posterior, entra con su parte del valor de ese reporte.
- La merma extra sale al promedio como pérdida y **no** entra al costo de
  lo producido.
- `reconcileValue` queda vacío: todo pasa por el libro de costos.
- Costos solo para `inventory.cost.read`: el campo no existe para los
  demás (ficha del reporte).

## Lote de lo producido (sección 5.6)

- Solo para salidas **por lote**. Un lote por reporte (P12): un código
  nuevo por producto por lote que entra; `lotForEntry` lo crea.
- **Nomenclatura** (Configuración › «Lotes de lo producido»,
  `platform.organization.update` + Producción activo): prefijo (letras,
  números y guion, hasta 12), fecha (ninguna, `AAAA`, `AAMM`, `AAMMDD`, del
  calendario de la empresa), consecutivo (`001`, `0001`, `00001`,
  `000001`), reinicio (nunca, cada año, cada mes) y alcance del consecutivo
  (cada producto o toda la empresa), con vista previa. Pasa por
  `normalizeLotCode`.
- **Sin configurar:** `OP-0001-01` (número de la orden y número del reporte
  en la orden).
- **Consecutivo sin repetir:** con nomenclatura, el reporte bloquea la fila
  de la nomenclatura de la empresa (después de la orden) y avanza
  `production_lot_sequence` bajo ese candado; si el código ya existe para
  ese producto (un lote dado de alta a mano), salta al siguiente (hasta 50
  veces). El candado se toma después de las ubicaciones y la capacidad
  (ver «Nomenclatura: lo más tarde posible»). Sin nomenclatura, el número
  del reporte se toma bajo el candado de la orden. Un número usado no se reutiliza (tampoco al revertir).
  Reportes simultáneos de toda la empresa con nomenclatura van en fila en
  ese candado (aceptado: dura lo que la transacción).
- Las salidas **por serie** llevan las series escaneadas; las salidas sin
  lote ni serie se rastrean por el reporte.

## Foto

- Propósito `production_report_photo` (escribe `production.report.create`,
  lee `production.order.read`, 5 por reporte), dueño el reporte
  (`evidence_photo.productionReportId`, con su `CHECK` de un solo dueño y de
  propósito, y la regla de `evidence_photo_owner_rules`). El reporte nace
  con sus fotos, así que **no** es `boundToOwner` (como incidencias y
  rechazos al recibir). Ver una foto es `reachesProductionReport` (la orden
  existe para la persona). Se ligan con `attachEvidencePhotos` al final de
  la transacción (los archivos son los últimos candados).
- Ajuste `production.report.photo`: `off`, `optional`, **`required` por
  omisión** (D5: «que si producción dice que hizo 100 de algo se tome la
  foto»; la decisión posterior de dejar opcional la foto **al entregar una
  tarea** no habló del reporte). Se lee con `readSetting` bajo los
  candados. **El fundador puede cambiar el valor por omisión.**

## Reversa

- Mientras la orden siga liberada o en proceso.
- Todo lo que entró por el reporte sigue en `INSPECTION` en el área, en su
  lote y con sus series, sin retención (`heldStock`) y **sin ninguna salida
  posterior** de ese producto, área y estado (y lote, si lo tiene): si algo
  se movió, verificó o cambió de estado, no se revierte (lo corrige quien
  verifica, WMS-30B, o un ajuste).
- Los materiales regresan **a la ubicación, lote y series de donde
  salieron**, disponibles, al costo con que salieron; las ubicaciones deben
  seguir activas (un almacén archivado no recibe). Lo producido sale al
  costo con que entró (`exitAt`).
- Lo que había salido de lo apartado **se vuelve a apartar** para su línea
  en la misma ubicación y lote.
- Un movimiento `REVERSAL` con `reversesMovementId` = el del reporte (la
  base impide reversar dos veces); el reporte queda marcado una vez.
- **Alcance (WMS-20):** quien revierte debe alcanzar todas las ubicaciones
  que el movimiento del reporte tocó (los orígenes de los materiales y el
  área); si no, se rechaza sin nombrarlas («que lo revierta alguien que
  las alcance»). Corrección de la revisión independiente: antes solo se
  exigía alcanzar el área.
- Más estricta de lo necesario, a propósito (seguro): con productos sin
  lote, dos reportes que dejan lo producido en la misma casilla
  `INSPECTION` del área se estorban: revertir uno cuenta como «salida
  posterior» del otro. Se revierte el más reciente primero o se corrige al
  verificar.
- La orden **no** regresa a «Liberada» aunque ya no tenga reportes vigentes
  (la tabla de estados no lo admite): se cierra con faltante (WMS-31).
- El lote creado se queda (los lotes no se borran) y su número no se
  reutiliza.

## Merma y autorización

- `production.scrap.create` (Operario, Encargado, Administración y
  titular). Escribe con el núcleo `postDisposal` de Inventario, que hoy
  nunca saca lo disponible: gana la opción **`takesAvailable`**, solo para
  un llamador que ya resolvió las reservas (la merma consume primero lo
  apartado para la orden con `consumeReservation` y el resto lo pide libre
  bajo el candado). Ningún otro llamador la usa.
- **Tipo de aprobación propio `production.scrap`** («Merma de material de
  producción»), apagado por omisión y sin umbral, con
  `requestPermissions` y `decidePermissions` = `production.scrap.create`
  (autorizar nunca da más poder que reportar merma). **No** reutiliza
  `inventory.disposal`. Con la regla encendida, la merma se valida completa
  y espera (`pending_approval`, nada escrito, nada retenido); al
  autorizarse se vuelve a hacer entera a nombre de quien la pidió y vence
  si la orden ya no está abierta, si quien pidió perdió el permiso, la
  membresía o el alcance, o si ya no hay de dónde tomarla. Como en ADR
  0078, la descripción de la regla dice que **una empresa que autoriza los
  desechos debe encender también esta**, para no dejar un rodeo. (El
  fundador puede cambiar que sean reglas separadas.)
- Un **material archivado** que sigue en el área se puede reportar como
  merma (está ahí y se rompió; la merma no consume receta). En la práctica
  archivar rechaza un producto con existencias, así que solo pasa con datos
  anteriores (prueba «an archived material still in the area may be
  scrapped»). El reporte, en cambio, sí rechaza consumir un material
  archivado.
- Foto de la merma: pendiente (no hay propósito todavía).

## Candados

Orden global: productos → almacén → ubicaciones → documento → contenedor →
tareas → capacidad → progreso → archivos.

- **Reporte:** productos (materiales y salidas, de una vez) → la orden →
  **cambio de estado de la orden a «En proceso»** (antes de bloquear
  cualquier ubicación: regla de WMS-28 para documentos con `facilityId` en
  un índice) → ubicaciones de donde sale y el área
  (de una vez, ordenadas; leídas después y rechazadas si están archivadas,
  WMS-82) → capacidad del área (`checkPlacement` en modo `report`: las
  restricciones detienen, la capacidad solo se dice) → **nomenclatura** →
  progreso de la orden
  (`assertStagesDone`, `reachMilestone`, `completeOperationStage`) y
  `startProcess` del lote → archivos de las fotos. No toma el almacén:
  como liberar, deja que la llave foránea lo revise.
- **Reversa:** **todos los productos de la orden** (materiales y salidas, de
  una vez) → orden → ubicaciones (área y orígenes) → progreso del lote. Las
  reservas que se vuelven a apartar no esperan a nadie.
- **Merma:** **todos los productos de la orden** (de una vez) → orden →
  ubicaciones. Autorizada (`applyApprovedScrap`): la solicitud (la toma
  `decideApproval` primero, como toda autorización) → los mismos candados
  en el mismo orden, con el mismo código.
- **Configurar la nomenclatura:** solo su fila; la primera vez la crea y,
  si dos la crean a la vez, la llave única de la empresa detiene a la
  segunda, que vuelve a intentar y actualiza.
- La documentación del orden de candados de la orden (ADR 0073/0074) se
  amplía con estos casos en `docs/arquitectura/candados.md`; las carreras
  nuevas van en `tests/server/lock-order.int.test.ts`.

### Por qué «orden antes que ubicaciones» no se interbloquea

El reporte toma la orden antes que las ubicaciones (al revés que el orden
global, por la regla de WMS-28). Es seguro porque **toda transacción que
bloquea esta orden toma antes un producto que el reporte también toma**, y
**toda transacción que bloquea una ubicación toma antes sus productos**.
Por eso la merma y la reversa bloquean **todos** los productos de la orden,
no solo los que mueven (corrección de la revisión independiente: la merma
de un material, con solo ese producto, cerraba un ciclo con la entrega de
la tarea `ISSUE` de otro material de la misma orden —la tarea sostenía el
área y esperaba la orden; la merma sostenía la orden y esperaba el área—,
25 de 25 vueltas; la reversa, igual con un material cuyo consumo en ese
reporte redondeó a 0 y no estaba en sus líneas):

| Operación | Qué toma, en orden | Por qué no cierra un ciclo con el reporte |
| --- | --- | --- |
| Pasos y entrega de una tarea `ISSUE` de la orden | su material → ubicaciones → la orden → la tarea | Su material es un material de la orden y **el reporte, la merma y la reversa toman todos los productos de la orden**: espera (o hace esperar) en el producto, antes de tocar la orden o una ubicación. Pruebas «Surtir a producción deliveries», «scrap of one material…» y «reversing a report… consumed none of». |
| Liberar y cancelar la orden | materiales → la orden | Los mismos productos primero; no toma ubicaciones. Prueba «releases». |
| Aceptar una solicitud | materiales → la solicitud → almacén compartido → una orden **nueva** | Nunca toma una orden existente ni una ubicación. Usa el núcleo de liberar (cubierto por la prueba de liberaciones). |
| Otro reporte, la reversa y la merma | todos los productos de la orden → la orden → (reporte) → ubicaciones | El mismo orden que el reporte. Prueba con reportes, merma y reversa a la vez. |
| `changeTree` (editar, mover o archivar ubicaciones o almacenes) | todos los almacenes → ubicaciones | No bloquea órdenes de producción (cuenta las abiertas sin candado) y el cambio de estado de la orden no revisa la llave foránea del almacén (no cambia `facilityId`). Archivar un almacén usa `nowait` y responde «ocupado». Pruebas «changes of the area» y «archiving a shelf». |
| Salidas, reubicaciones, surtido y recepciones sobre las mismas ubicaciones | sus productos → ubicaciones | No bloquean la orden; si sostienen una ubicación ya sostienen sus productos, que no son del reporte (si lo fueran, habrían esperado al reporte en el producto). Pruebas «exits, moves» y «exits from the area». |
| La nomenclatura | solo reportes (después de la capacidad) y guardar la configuración (solo su fila) | Nadie la sostiene mientras espera algo que el reporte tenga. |

Todas las carreras corren con los servicios reales a la vez en
`tests/server/lock-order.int.test.ts`.

### Nomenclatura: lo más tarde posible

El candado de la fila de nomenclatura se toma **después** de las ubicaciones
y de la revisión de capacidad del área (`postProduction` lo pide con
`lotCodes`), justo antes de crear el lote; solo quedan después el costo, las
escrituras, el proceso y las fotos. Garantía: **sin repetidos y sin huecos
propios** — el consecutivo se escribe en la misma transacción del reporte,
así que un reporte que falla después lo revierte; solo se saltan números
cuyo código ya usaba un lote dado de alta a mano.

### `takesAvailable` y la regla de desechos

`takesAvailable` es un argumento interno del núcleo `postDisposal` (no
viene de ningún formulario): solo lo pasa `reportMaterialScrap`;
`disposeStock` y su Server Action nunca lo pasan y siguen rechazando lo
disponible (prueba «only the scrap of production takes available stock»).
La merma nunca toma más que lo apartado para la orden más lo libre a su
alcance (prueba «never takes more than…»); `postDisposal` sigue consultando
`heldStock` y, con `takesAvailable`, rechaza lo que está en una tarima de
almacenamiento. **Con la regla `inventory.disposal` encendida y
`production.scrap` apagada, la merma de producción es una salida de
existencias disponibles sin autorización**: así lo dice la descripción de la
regla «Merma de material de producción» en pantalla, que pide encenderla
junto con la de desechos.

## Idempotencia

- La clave del formulario es la del movimiento `PRODUCTION`. Repetida por
  la misma persona con lo mismo (orden, buenas, malas, series de
  materiales y de salidas, caducidad de cada lote producido) responde
  `repeated` con el reporte; con otra cosa, `KEY_REUSED` (`sameDetails`
  compara las series como conjuntos, sin mayúsculas ni acentos, y la
  caducidad como día; pruebas «a repeated confirmation compares serials and
  expiry»). Se revisa después de los candados de
  productos y orden, antes de validar.
- Respuesta perdida (INV-22): `findProductionReportByKey` busca el reporte
  de esa clave y persona; la pantalla lo consulta antes de dejar reintentar.
- Reversa: `repeated` si ya se revirtió. Merma: misma regla con su
  `DISPOSAL` (y, con autorización, la de WMS-83).
- **Dos reportes a la vez de la misma orden** se ordenan por el candado de
  los productos y de la orden: el segundo lee lo que el primero ya reportó
  y nunca pasa de lo que falta ni consume dos veces lo mismo.

## Permisos y contexto

- `production.report.create`, `production.report.reverse` y
  `production.scrap.create` (WMS-59), sin permisos nuevos. Inventario no
  pide sus permisos: Producción los comprueba (como el surtido a
  producción). `production.shift.manage` **no se usa todavía** (ver
  «Fuera»).
- **PIN:** reportar, merma y avisar se conservan en una terminal; revertir
  también (es del Encargado en piso). Una sesión de PIN no decide la
  autorización de la merma (el motor lo impide).
- **Alcance:** la orden existe solo para quien alcanza su área; consumo
  solo de ubicaciones a su alcance.
- **Plan vencido o Producción quitada:** todo en solo lectura
  (`assertModulePermission`); lo apartado sigue apartado (ADR 0073).
- **Soporte:** solo lectura. **API y webhooks:** nada en este paso.
- **Avisos:** `production.material_short` por `permissions`
  (`production.request.decide` y `production.order.release`, cualquiera),
  con el área como lugar; nunca solo por roles, sin cantidades de
  existencias ni costos.

## Procesos

- **Orden:** operación nueva «Producción reportada»
  (`production.order.reported`, hito `RELEASED`, `leadsTo:
  "IN_PROGRESS"`): la empresa puede poner etapas antes del primer reporte
  (por ejemplo, «Materiales surtidos» como manual); el primer reporte las
  espera (`assertStagesDone`), escribe «En proceso», `reachMilestone` y
  `completeOperationStage`. Los reportes siguientes (ya en proceso) no
  esperan etapas.
- **Lote producido** (sección 6, P10b): documento nuevo del motor
  `production.batch` («Lote producido»), uno por reporte, con hitos
  `REPORTED` («Reportado», abierto) y `REVERSED` («Revertido», cierra), sin
  operaciones todavía: la empresa puede definir etapas manuales del lote
  («Lijado», «Secado») que ya se siguen y se hacen; **WMS-30B** agregará el
  hito y la operación de la verificación (con `assertStagesDone`, el
  candado del mismo lote) y WMS-31 la del acomodo. Lectura
  `production.order.read`; dirección `/produccion/reportes/<id>`. El
  reporte llama `startProcess` (lugar: almacén y área) y la reversa
  `reachMilestone(REVERSED)`.

## Pantallas

- Ficha de la orden: avance (pedido, bueno, malas, falta), consumido y
  apartado por material, reportes (número, quién, cuándo, buenas, malas,
  lote, revertido), mermas, «Reportar producción», «Reportar merma de
  material», «Avisar que falta material». Muestra **quién ejecutó** (las
  personas de los reportes).
- `/produccion/[id]/reportar` y `/produccion/[id]/merma`.
- `/produccion/reportes/[id]`: el reporte (consumos con lote y series, lo
  que entró con lote y series, fotos, costo solo con `inventory.cost.read`,
  proceso del lote, «Revertir reporte»).
- `/configuracion/lotes-de-produccion`: nomenclatura con vista previa.
- Rastreo (`/inventario/rastrear`): acepta `OP-…` (la orden: reportes,
  materiales con lote y series, lotes producidos); un lote producido dice
  de qué orden y reporte salió y con qué materiales; un lote de material
  dice en qué órdenes se usó. La búsqueda global ya encuentra `OP-…`.

## Lo que no entra

- **WMS-30B:** verificación e inspección, decisiones de Calidad, el
  candado de etapas del lote antes de verificar, «verificar sin Calidad».
- **WMS-31:** producto a su lugar (acomodo desde el área), «Se guardó»,
  cierre con faltante y liberar lo apartado que sobró.
- **WMS-29B:** reproceso. **WMS-79:** ligar pedidos.
- **Turnos** (`production.shift.manage`): no hay tabla de turnos todavía;
  el reporte guarda fecha y hora y el turno se agrega como columna
  opcional cuando exista su catálogo por almacén. Queda pendiente.
- Foto de la merma, webhook del reporte, reportar desde la API,
  incidencia automática de «falta material», nomenclatura por producto
  (P14) y para otros consecutivos (P15).

## Riesgos y migración

- Migraciones de expansión (`20261120130000` y siguientes): valor
  `PRODUCTION` en `stock_movement.type`, tablas nuevas, columna
  `evidence_photo.productionReportId`. **Una vez escrito un movimiento
  `PRODUCTION`, el código anterior no conoce ese valor** (como `DISPOSAL` y
  `REPAIR`): listas de movimientos y rastreo de una versión anterior
  podrían fallar al leerlo.
- Un área de producción dentro de «Cuarentena» o «Restauración» (pendiente
  de WMS-28): **se permite reportar**, porque lo producido entra en
  `INSPECTION` (que esas ubicaciones admiten) y los materiales salen de
  donde están; WMS-30B/31 deberán sacar lo aprobado del área antes de dejarlo
  disponible (`checkPlacement` no admite disponible ahí).
- El candado de la nomenclatura pone en fila los reportes de toda la
  empresa cuando hay nomenclatura configurada.

## Decisiones del fundador

- **2026-11-20 (WMS-92):** «Y lo de material haz que tome el costo de todo
  lo demás»: un material sin costo no deja lo producido sin costo; lo
  producido toma el costo de los materiales que sí lo tienen (sección
  «Costo»). Era la decisión 4 de la lista siguiente.

## Decisiones que el fundador puede cambiar

1. Con personas asignadas, solo ellas (y quien crea órdenes) reportan.
2. Foto del reporte obligatoria por omisión.
3. Solo se consume de ubicaciones al alcance de quien reporta.
5. Las piezas malas no producen subproductos.
6. La merma tiene su propia regla de autorización, separada de la de
   desechos.
7. Revertir solo mientras todo lo producido siga intacto en inspección.
8. Reporte solo con piezas malas permitido.
9. Sin turnos todavía.
10. Revertir exige alcanzar todas las ubicaciones que el reporte tocó.
11. Se puede reportar como merma un material archivado que sigue en el
    área.

## Consecuencias

- Servicios en `src/modules/production/reports.ts`, `scrap.ts`,
  `lot-numbering.ts` y reglas puras en `report-rules.ts` y
  `lot-numbering-rules.ts`; el movimiento y su reversa los escribe
  Inventario (`production-entry.ts`), que no conoce Producción.
- Bitácora: `production.reported`, `production.report_reversed`,
  `production.scrap_reported`, `production.lot_numbering_changed`,
  `production.material_short`.
- Pruebas: `tests/production/reports.int.test.ts`,
  `tests/production/case-5-5.int.test.ts`, `report-rules.test.ts`,
  `lot-numbering-rules.test.ts` y casos en `scope.int.test.ts`,
  `two-companies.int.test.ts`, `module-guard.int.test.ts`,
  `lock-order.int.test.ts` y `server-actions.int.test.ts`.
