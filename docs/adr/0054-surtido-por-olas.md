# ADR 0054 — Surtido por olas, por lotes y por zona

Fecha: 2026-11-15 · Estado: aceptada · Paso: WMS-25 (último de la Fase 2) y
el pendiente «surtir primero de las ubicaciones de surtido» de ADR 0051 ·
Completa el surtido de WMS-14, ADR 0038 (alcance por zona), ADR 0036 (código
de ubicación) y ADR 0051 (reposición)

## Contexto

Hoy cada pedido liberado crea sus tareas de surtido (`PICK`), una por línea y
por ubicación de origen, y cada tarea se toma, se confirma y se entrega sola
(WMS-14). Con muchos pedidos chicos al día eso obliga a caminar el almacén una
vez por pedido y a tomar del mismo estante varias veces seguidas. El plan pide
que el supervisor agrupe pedidos en una **ola**, que el sistema ordene el
recorrido por ubicación y reparta las tareas por persona o por zona, y que con
varios pedidos a la vez se surta «por lotes» (tomar de un jalón lo de varios
pedidos) y se consolide en preparación. Habla de cuatro «modalidades»
(individual, lotes, zona, ola).

## Decisión: qué ve la persona y qué queda interno

La gente de piso no necesita cuatro nombres de libro. Ve **una sola idea
nueva: la ola** («Ola OL-0003: 3 pedidos»), y dentro de ella el trabajo
ordenado por dónde se camina y juntado por estante. Las cuatro modalidades
del plan quedan así:

| Del plan | Cómo queda | Quién lo ve |
| --- | --- | --- |
| Individual | Lo de hoy: pedido por pedido, tarea por tarea | Nadie nota nada (por omisión) |
| Ola | Documento «Ola» que agrupa pedidos | Supervisión la crea; el piso la abre en Tareas |
| Lotes (*batch*) | La ola junta lo del mismo producto, lugar y lote: «Toma 30: 10 para PS-0001, 12 para PS-0002, 8 para PS-0003» | El piso, dentro de la ola; nunca se llama «lote» (esa palabra ya es el lote del producto) |
| Zona | Filtro «Zona» dentro de la ola y «Tomar las de esta zona» / «Asignar las de esta zona»; el alcance de WMS-20 sigue mandando sobre qué tareas existen para cada quien | El piso y supervisión |

Un solo ajuste de la empresa: **`inventory.picking.mode`** («Cómo se organiza
el surtido»): `orders` (pedido por pedido, por omisión: nada cambia) o
`waves` (por olas). Con `orders` no aparece nada nuevo y crear una ola se
rechaza. No hay un segundo ajuste para «juntar por estante»: dentro de una ola
siempre se junta (es la razón de la ola) y fuera de ella no hay nada que
juntar.

## Lo que no cambia (base de integridad)

- **Cada tarea `PICK` sigue siendo de una línea de un pedido**, con su reserva
  en su origen, su lote, sus series, `confirmPick`, `deliverPick`,
  `settlePickedOrder`, empaque y despacho por pedido. Por eso «lo surtido en
  ola cuadra por pedido» sale del modelo y no de una conciliación posterior, y
  cancelar un pedido de la ola libera solo lo suyo (sus reservas y sus
  tareas), como hoy.
- **No se crea una tarea que junte varias líneas.** Tomar 30 piezas para tres
  pedidos es, por dentro, confirmar las tres tareas en la misma transacción
  con sus cantidades. Una tarea conjunta exigiría repartir lo tomado entre
  pedidos al entregar (otra reserva, otra regla de faltantes, otra forma de
  cancelar) y rompería la regla «una reserva por línea» de la que dependen
  empaque, despacho y reconciliación. La única ventaja de una tarea conjunta
  (un solo movimiento) no le importa a la persona: lo que le importa es
  escanear una vez y caminar una vez, y eso lo da la pantalla.
- Ola, juntar y zona solo **agrupan, ordenan y reparten** tareas que ya
  existen. Nada se mueve hasta la entrega; el saldo cambia solo con su
  movimiento (`task:<id>`, uno por tarea), como siempre.

## Flujo operativo

### Crear la ola (supervisión, `inventory.outbound.release`)

1. En Pedidos › «Olas de surtido» › «Nueva ola», la persona ve los pedidos del
   almacén activo en borrador o liberados que no están en otra ola abierta,
   urgentes primero, luego por día de salida y número. Puede acotar por día de
   salida y por «Solo urgentes» (formulario GET).
2. Marca los pedidos (casillas, hasta `WAVE_MAX_ORDERS` = 30) y pulsa «Crear
   ola». En una sola transacción:
   - bloquea los productos de todos los pedidos (`lockRows`, ordenados),
     prepara la ubicación «Preparación» del almacén y bloquea los pedidos
     (`lockRows`, ordenados);
   - comprueba bajo el candado que cada pedido sigue en borrador o liberado,
     es del almacén y no está en otra ola abierta;
   - **libera los borradores** con el mismo núcleo de `releaseOutboundOrder`
     (`releaseUnderLock`, sin duplicarlo), en el orden urgentes → día de
     salida → número, para que lo urgente aparte primero. Si un borrador no
     alcanza, no se crea nada y la respuesta dice qué pedido y qué producto
     (se libera ese pedido «con lo que hay» desde su pantalla, o se deja fuera
     de la ola);
   - exige que cada pedido tenga al menos una tarea de surtido abierta;
   - crea la ola (`pick_wave`, `OL-0001`, del almacén, quién la creó) y sus
     renglones (`pick_wave_order`, con `openOrderId` = el pedido mientras la
     ola está abierta: índice único, así un pedido está en una sola ola
     abierta también si dos personas la crean a la vez).
3. Bitácora `inventory.wave_created`.

### Surtir la ola (piso, `inventory.task.execute`)

1. En Tareas aparece «Olas abiertas: OL-0003…» (solo con el ajuste en
   `waves` y si hay alguna). La ola (`/tareas/olas/[id]`) muestra **lo que
   sigue** arriba, con su formulario, y debajo el resto del recorrido.
2. **Recorrido** (`pick-route.ts`, pura): las tareas se ordenan por el
   **código de la ubicación de origen** en orden natural (`A-01-02` antes que
   `A-01-10` antes que `B-01-01`); una ubicación sin código usa su ruta
   («Zona A › Pasillo 2 › Estante 3») con la misma comparación. Sin
   coordenadas ni distancias.
3. **Juntar por estante:** las tareas por surtir (pendientes, o asignadas o
   tomadas por esa persona) del mismo producto, origen y lote forman un
   renglón: «Toma 30 piezas de Tornillo, lote L-07, en A-01-02: 10 para
   PS-0001 · 12 para PS-0002 · 8 para PS-0003». La persona escanea **una vez**
   el producto, el lugar y el lote, y pulsa «Ya tomé 30 piezas».
   `confirmWavePick` bloquea producto → pedidos → tareas, y para cada tarea,
   en la misma transacción: la toma si estaba pendiente (el pedido pasa a
   `PICKING`) y la confirma con su cantidad completa con las mismas reglas de
   `confirmPick`. **Si una falla, no queda nada a medias** (todo se revierte y
   se dice cuál y por qué).
4. **Surtir menos** o un producto **por serie** no se confirma junto: el
   renglón ofrece «Surtir por pedido», con un enlace a cada tarea (donde están
   el motivo del faltante y las series). Así la regla del faltante y la de las
   series siguen siendo las de WMS-14 y WMS-21B, sin una versión conjunta.
5. **Dejar en Preparación:** cuando la persona trae tareas surtidas de la ola,
   un botón «Dejar N en Preparación» las entrega todas (`deliverWavePicks`) en
   una transacción: productos → ubicaciones → pedidos → tareas → capacidad →
   ola. Cada tarea escribe su reubicación (`task:<id>`), aparta lo surtido
   para su línea en preparación y suelta lo que faltó, como `deliverPick`.
6. «Siguiente tarea»: en el detalle de una tarea propia ya entregada aparece
   la que sigue en el recorrido entre las tareas abiertas de esa persona; en
   «Mis tareas» la lista va en orden de recorrido (urgentes primero).

### Repartir

- **Por persona:** cada quien toma (renglón por renglón, o «Tomar las de esta
  zona») o supervisión asigna («Asignar las de esta zona a…»,
  `inventory.task.create`, con las mismas reglas de `assignTask`: la persona
  puede hacer tareas y alcanza el lugar). Asignar y tomar una tarea suelta
  sigue igual en su detalle.
- **Por zona:** la zona de una tarea es la ubicación raíz del almacén que
  contiene su origen (la misma noción de zona de WMS-20). La ola ofrece un
  filtro «Zona» con las zonas de sus tareas (`?zona=`, solo si es una de
  ellas). No hay otra noción de zona. El alcance de WMS-20 sigue igual: una
  tarea existe para quien alcanza su origen **y** su destino (`taskScope`),
  así que quien está limitado a un almacén ve todas las de ese almacén, y
  quien está limitado a unas zonas ve las de surtido solo si «Preparación»
  también le queda dentro (se elige con `setStagingLocation`). Abrir el
  destino de surtido a quien solo alcanza el origen cambiaría la regla de
  alcance de todos los movimientos (`transferWithin` la revisa) y queda
  pendiente.

### Terminar, cancelar y consolidar

- **La ola se termina sola** cuando ninguna tarea de surtido de sus pedidos
  sigue abierta: lo comprueba `settleWaveOf` bajo el candado de la ola al
  final de cada entrega o cancelación de una tarea de surtido y al cancelar un
  pedido. Suelta sus pedidos (`openOrderId` vacío) y queda `DONE`.
- **Cancelar un pedido de la ola** es `cancelOutboundOrder`, sin cambios:
  libera sus reservas y cancela sus tareas; los demás pedidos siguen.
- **Cancelar la ola** (supervisión, `inventory.outbound.release`, con motivo)
  solo la **desagrupa**: sus pedidos y tareas siguen su curso pedido por
  pedido, y pueden entrar en otra ola. Cancelar los pedidos es otra decisión
  y se toma en cada pedido. Bitácora `inventory.wave_cancelled`.
- **Consolidar en preparación:** lo surtido llega apartado por línea de
  pedido (WMS-14), así que la pantalla del pedido ya dice cuánto de cada
  línea está en preparación, el empaque es por pedido (WMS-15) y el despacho
  también (WMS-16). La ola muestra, por pedido, cuántas tareas faltan y su
  estado, y el enlace al pedido. No hace falta otra cosa.

## Surtir primero de las ubicaciones de surtido (pendiente de ADR 0051)

`rankStockSources` agrega un criterio: **entre iguales de caducidad** (y de
antigüedad del lote con FIFO), las ubicaciones de uso `PICKING` van antes que
las demás; después sigue el ajuste de la empresa (más llena, más vacía). **Lo
que caduca antes sigue saliendo antes**: un lote que caduca antes en un
estante de almacenamiento se surte antes que uno que caduca después en una
ubicación de surtido. Sin ubicaciones `PICKING` el orden es exactamente el de
antes. La reposición usa la misma función solo con orígenes `STORAGE`, así que
para ella nada cambia.

## Lo que quedó fuera (pendiente)

- **Surtir directo de una tarima** (ADR 0043): tomar de una tarima exige que la
  reserva pueda apartar lo contenido (hoy `freeToTake` lo resta y la base
  impide bajar el saldo por debajo de lo contenido), que la tarea lleve la
  tarima y la bloquee en cada paso y que la entrega la vacíe en la misma
  transacción. Es otro paso, con su propio flujo.
- **Surtir por zona con alcance limitado cuando «Preparación» queda fuera de
  la zona**: hoy esa persona no ve las tareas de surtido (ver «Repartir»).
- Agregar o quitar pedidos de una ola ya creada (hoy: se cancela y se crea
  otra).
- Recorrido por coordenadas o distancias, y por pasillo en serpentina.
- Juntar al confirmar lo de un producto por serie o un faltante repartido.
- Olas automáticas (por hora de corte o transportista) y olas de varios
  almacenes.
- El rastreo no busca por `OL-…`.

## Consecuencias

- Tablas `pick_wave` y `pick_wave_order` (de empresa, en `TENANT_MODELS`,
  `pick_wave` bloqueable). Estados `OPEN → DONE`, `OPEN → CANCELLED` con
  `PICK_WAVE_TRANSITIONS` (`wave-states.ts`) y el disparador
  `pick_wave_transition`: cambian juntos. Una ola no se borra; un renglón solo
  suelta su pedido (`openOrderId` a vacío) y la ola no se cierra con pedidos
  sin soltar (disparadores).
- Candados: productos → ubicaciones → pedidos → contenedor → tareas →
  capacidad → **ola** (la ola va al final: solo se bloquea para terminarla o
  cancelarla).
- Servicios solo en `waves.ts`; el orden de recorrido solo en `pick-route.ts`;
  el criterio del uso de la ubicación solo en `rankStockSources`.
- Migración `20261115000000_wms_pick_waves` (solo expansión).
