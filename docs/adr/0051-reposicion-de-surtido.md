# ADR 0051 — Reposición de ubicaciones de surtido

Fecha: 2026-11-14 · Estado: aceptada · Pasos: WMS-23 (reglas de reposición) y
WMS-24 (reabastecimiento automático) · Completa ADR 0036 (uso de ubicación),
ADR 0039 (capacidad), ADR 0040 (lotes), ADR 0042 (acomodo) y el surtido de
WMS-14

## Contexto

Muchos almacenes separan **dónde se guarda** (ubicaciones de uso
«Almacenamiento»: racks altos, tarimas completas) de **dónde se surte**
(uso «Surtido»: el anaquel a la mano, de donde se toman las piezas de cada
pedido). Las ubicaciones de surtido se vacían con el surtido y alguien tiene
que llenarlas otra vez desde almacenamiento antes de que se acaben. Hoy eso
depende de que una persona lo note y cree una tarea de traslado a mano.

El plan v3 pide: **WMS-23**, mínimo, máximo y cantidad de reposición por
producto y ubicación de surtido; **WMS-24**, una ronda periódica que cree
tareas de reposición desde almacenamiento hacia las ubicaciones de surtido
bajo su mínimo, sin duplicar tareas abiertas, y que respete el alcance por
almacén.

Ya existe todo lo que hace falta: tareas con su máquina de estados (WMS-06),
el apartado de una tarea en su origen (`TASK_HOLD`, WMS-52), lotes y series en
tareas (WMS-21A/B), la regla única de lo que admite una ubicación
(`checkPlacement`, WMS-22B), el orden de surtido por caducidad (WMS-21A) y las
rondas del worker (`ScheduledRound`). Este paso las junta; no agrega otra
forma de mover existencias.

## Flujo

1. **Para quién es.** Para un almacén con ubicaciones de uso «Surtido». Una
   empresa que no tiene ninguna, ni reglas, no ve nada nuevo: el enlace
   «Reposición de surtido» de Inventario solo aparece si el almacén activo
   tiene alguna ubicación de surtido o alguna regla.
2. **Regla de reposición.** En Inventario › «Reposición de surtido» ›
   «Agregar regla», quien configura mínimos elige el **producto** (clave o
   código de barras, escaneado o escrito), la **ubicación de surtido** (solo
   las de uso «Surtido», activas, del almacén activo y de sus zonas) y tres
   cantidades en la unidad del producto:
   - **«Reponer cuando queden menos de»** (mínimo, mayor que cero);
   - **«Llenar hasta»** (máximo, mayor que el mínimo);
   - **«En múltiplos de»** (opcional: cajas completas, por ejemplo; no puede
     ser mayor que la diferencia entre máximo y mínimo, así siempre cabe al
     menos uno).
   Una regla por producto y ubicación. No es el mínimo de compra del producto
   («Avisarme cuando queden», INV-30, de toda la empresa): las etiquetas lo
   dicen sin explicaciones. Si la ubicación no admite el producto
   (restricciones de WMS-22B) la regla no se guarda.
3. **Cuánto hay en una ubicación de surtido** («Para surtir»): lo disponible
   ahí, de todos sus lotes, **menos lo que ya está apartado** ahí para pedidos
   (eso ya tiene dueño y se irá en el siguiente surtido). **En camino:** lo que
   llevan las tareas de reposición abiertas hacia esa ubicación.
4. **Estado de cada regla** (en la lista, derivado cada vez, nada guardado):
   - **«Bien»**: lo que hay no está bajo el mínimo;
   - **«Repuesto en camino»**: está bajo el mínimo pero las tareas abiertas
     lo cubren;
   - **«Por reponer»**: hace falta y hay de dónde traerlo (lo hará la ronda o
     «Reponer ahora»);
   - **«Sin existencias para reponer»**: hace falta y en almacenamiento no hay
     nada libre;
   - **«Sin espacio»**: la ubicación no admite más (capacidad o restricción);
   - **«Revisar la regla»**: la ubicación se archivó o ya no es de surtido, o
     el producto se archivó. La ronda no la toma en cuenta.
5. **Reponer.** Para cada regla bajo su mínimo (lo que hay + lo en camino <
   mínimo) se crean tareas de reposición por lo que falta para llegar al
   máximo, en múltiplos, sin pasar la capacidad de la ubicación, desde
   ubicaciones de almacenamiento del mismo almacén con existencias libres. Lo
   hace:
   - la **ronda** del worker, cada hora, si la empresa lo pidió (ajuste
     «Reposición de surtido»: «Solo al pulsar Reponer ahora», por omisión, o
     «Cada hora, automáticamente»), almacén por almacén;
   - el botón **«Reponer ahora»** de la lista, con la misma función y el mismo
     resultado, solo sobre lo que alcanza quien lo pulsa (almacén activo y sus
     zonas). Funciona aunque la ronda esté apagada.
   Repetir cualquiera de los dos, o los dos a la vez, no crea nada nuevo: lo en
   camino ya cubre lo que faltaba.
6. **La tarea.** Aparece en Tareas como «Reponer» (en «Disponibles», o en
   «Mis tareas» si un supervisor la asigna) y cuenta en el Inicio como
   cualquier otra. Se toma, se recoge (un producto por serie escanea aquí sus
   unidades) y se entrega como un traslado: «Ya la dejé en Pasillo 1 ›
   Surtido 3». Lo que lleva **queda apartado en su origen** desde que se crea:
   nadie lo saca, lo surte ni lo mueve por otro lado. Entregar mueve la
   mercancía (reubicación con clave `task:<id>`); cancelar suelta lo apartado
   y la siguiente ronda vuelve a decidir.
7. **Al surtir.** Liberar un pedido que deja una ubicación de surtido bajo su
   mínimo no crea tareas de reposición en esa misma operación: la siguiente
   ronda (o «Reponer ahora») lo cubre. Ver «Decisión».

## Decisión

- **Tabla `replenishment_rule`** (producto + ubicación, única por empresa;
  `minQuantity`, `maxQuantity`, `multiple` opcional, en la unidad del
  producto; quién y cuándo la creó y la cambió). `CHECK`: mínimo > 0, máximo >
  mínimo, múltiplo > 0 y ≤ máximo − mínimo. Producto y ubicación no cambian
  (disparador): otra ubicación es otra regla. Una regla se puede quitar
  (no es un registro de existencias: su rastro es la bitácora,
  `inventory.replenishment_rule_saved` / `_removed`). Las cantidades pasan por
  `parseQuantity` con la regla del producto. La ubicación debe ser de uso
  `PICKING`, activa, del almacén activo y del alcance de quien guarda; nunca
  «General», «Preparación» ni la de tránsito (ninguna de ellas es de uso
  `PICKING`, pero el servicio lo comprueba igual).
- **Permisos: ninguno nuevo.** Ver las reglas es `inventory.minimum.read`;
  crearlas, cambiarlas y quitarlas, `inventory.minimum.update` (quien
  configura mínimos: titular, administración, almacenista y supervisión);
  «Reponer ahora» pide además `inventory.task.create`; hacer las tareas,
  `inventory.task.execute`. Gerencia ya tiene `inventory.minimum.read`. La
  matriz menciona las reglas en esos dos permisos.
- **Una sola función decide**: `replenishmentPlan` de
  `src/modules/inventory/replenishment.ts`, con sus piezas puras en
  `replenishment-rules.ts` (cuánto falta, múltiplos, estado; prueba unitaria)
  y el orden de los orígenes en `stock-sources.ts` (`rankStockSources`, el
  mismo orden que ya usaba `pickSources`, sacado de ahí para no duplicarlo):
  1. lo que hay (punto 3) y lo en camino;
  2. si lo que hay + lo en camino < mínimo, falta `máximo − hay − en camino`,
     redondeado hacia abajo al múltiplo;
  3. **capacidad y restricciones** con `checkPlacement` (política `report`,
     reglas leídas una vez con `loadPlacementRules`; no se duplica ninguna
     regla): la llegada es lo en camino + lo que se pide; si no cabe, se busca
     (búsqueda binaria sobre múltiplos o sobre el incremento del producto) la
     mayor cantidad que cabe; si no cabe nada, «Sin espacio»;
  4. **de dónde**: saldos disponibles del producto en ubicaciones de uso
     `STORAGE` del mismo almacén, activas, nunca General, preparación ni
     tránsito, dentro del alcance de quien repone, con lo libre de cada
     ubicación y lote (`freeToTake`: respeta reservas, tareas y tarimas). En
     orden: **lo que caduca antes sale antes, siempre** (fundador); sin
     caducidad al final; después lo que diga «Cómo se elige de dónde surtir»
     (`PICKING_STRATEGY`: más llena, más vacía o el lote más antiguo). Los
     lotes caducados no se reponen, salvo que la empresa permita surtirlos
     (`PICK_EXPIRED`). De cada origen se toma en múltiplos; si ningún origen
     tiene un múltiplo completo, se toma lo que haya (mejor que dejar vacía la
     ubicación de surtido).
  Una tarea por origen (ubicación + lote).
- **`kind = REPLENISH`** en `warehouse_task` (un valor más del enumerado). Se
  eligió un tipo propio en vez de un traslado marcado: la pantalla la nombra
  «Reponer», «en camino» se cuenta con una condición simple (tipo + producto +
  destino + estado abierto) y los reportes la distinguen. La máquina de
  estados (`WAREHOUSE_TASK_TRANSITIONS` y el disparador) no cambia, ni los
  `CHECK` de la tabla: reponer es tomar, recoger y entregar. La lleva su lote
  (inmutable) y su nota dice de dónde salió («Reposición automática» o
  «Reposición pedida por …»). Quien la crea es la persona que pulsó «Reponer
  ahora» o, en la ronda, el titular de la empresa (la tabla exige una
  persona; el titular nunca está limitado por alcance).
- **Apartado** en el origen con `TASK_HOLD` (como el acomodo): solo cuenta en
  su ubicación. Entregar lo consume y escribe la reubicación con el núcleo de
  siempre (`postTaskTransfer`, capacidad `report`, como toda entrega);
  cancelar lo suelta (`releaseReservations`); liberarla (con problema →
  disponible) lo conserva.
- **Candados y repetición.** Una transacción por producto
  (`LOCKING_TRANSACTION`): producto → ubicaciones (destinos de sus reglas y
  orígenes posibles, en una sola llamada) → las tareas nuevas, sin candado
  propio. Bajo el candado del producto se vuelven a leer reglas, saldos y lo
  en camino: dos rondas, o la ronda y «Reponer ahora», a la vez, se ordenan
  por ese candado y la segunda ve las tareas de la primera. Dos productos a la
  vez pueden tomar el mismo número de tarea: se repite la transacción
  (`isTaskNumberClash`, hasta cinco intentos).
- **La ronda** (`inventory.replenishment`, en `scheduledRounds`): para cada
  empresa con Inventario, solo con el ajuste en «round» y con el módulo con
  escritura (un plan vencido no crea tareas), almacén por almacén (los
  activos), producto por producto. Una empresa que falla no detiene a las
  demás (`runScheduledRounds`). Corre cada hora, como todas las rondas;
  «Reponer ahora» cubre lo urgente.
- **No dentro de liberar un pedido.** Meterlo en la transacción de liberar
  agregaría candados de ubicaciones de almacenamiento a cada liberación (más
  esperas e interbloqueos posibles con el surtido), y la reposición no puede
  ir antes que el surtido que la provoca: lo apartado para el pedido ya no es
  «para surtir». La ronda y el botón lo cubren con la misma regla.
- **Ajuste** `inventory.replenishment.mode` (`off` por omisión, `round`) en
  `INVENTORY_SETTINGS`, leído con `readSetting` en la ronda.

## Lo que quedó fuera (pendiente)

- **Reponer desde una tarima** (pendiente del ADR 0043): hoy lo que está en
  una tarima de almacenamiento no es origen de reposición (lo libre lo resta);
  hay que sacarlo de la tarima antes. Tomarlo al recoger exige que la tarea
  lleve la tarima de origen, bloquear el contenedor entre el documento y la
  tarea en cada paso y un apartado que no reste dos veces lo contenido; queda
  para un paso propio.
- ~~**Surtir primero de las ubicaciones de surtido**~~: cerrado en WMS-25
  (ADR 0054): `rankStockSources` prefiere las ubicaciones `PICKING` entre
  iguales de caducidad; la reposición no cambia (solo ve orígenes `STORAGE`).
- **Reposición por demanda** (lo apartado por pedidos liberados que aún no se
  surten) y cercanía o recorrido.
- **Una ronda más frecuente** que la de cada hora: el mecanismo de rondas es
  uno solo para todos los módulos.

## Consecuencias

- Una operación nueva que cree tareas que llenan ubicaciones de surtido usa
  `replenishmentPlan`; un criterio nuevo de origen va en `rankStockSources`.
- Una lectura de «en camino» hacia una ubicación usa `REPLENISH` + estados
  abiertos (`OPEN_TASK_STATUSES`).
- Migración `20261114210000_wms_replenishment` (solo expansión): un valor más
  del enumerado `kind` de `warehouse_task`, la tabla `replenishment_rule` con
  sus llaves foráneas compuestas, sus `CHECK` y el disparador que impide
  cambiar producto y ubicación.
