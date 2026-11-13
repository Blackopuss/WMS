# ADR 0050 — Conteos cíclicos

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-55 · Completa INV-31..33
(conteos), ADR 0034 (ajustes), ADR 0038 (alcance), ADR 0040 (lotes) y ADR
0043 (tarimas) · Prepara WMS-41 (autorizaciones, hecho en ADR 0053)

## Contexto

Hasta hoy un conteo lo abre una persona, a mano, ubicación por ubicación
(INV-31). El plan v3 pide que **el supervisor defina programas (por
clasificación ABC, por zona o por ubicación) y el sistema genere los conteos
del día**; que se cuenten desde el teléfono; que las diferencias grandes
requieran autorización (WMS-41, todavía no existe); y la **exactitud de
inventario** con comparaciones semanales y mensuales. Sus pruebas: un
programa no duplica conteos al repetirse la ronda; exactitud contra un
escenario conocido.

El modelo de conteo no cambia: un conteo es de **una ubicación**, capturar no
mueve nada, aplicar escribe un ajuste con la diferencia contra
`systemQuantity` (INV-32/33) y el estado del conteo bajo su candado es la
guarda de idempotencia.

## Flujo operativo

1. **Supervisión o administración crea un programa** en el almacén en que
   trabaja (Conteos › Programas de conteo › Nuevo programa): nombre, qué
   cubre (una zona o ubicación con todo lo que contiene, o todo el almacén),
   cada cuánto (los mismos días para todas las ubicaciones, o por clase ABC:
   días de A, de B y de C, con A ≤ B ≤ C) y cuántas ubicaciones por día como
   máximo. Se puede cambiar, pausar y reanudar; nunca se borra (disparador).
2. **La ronda del worker** (cada hora, `ScheduledRound`
   `inventory.cycle_counts`) recorre, empresa por empresa, los programas
   activos y crea los conteos que tocan **hoy** (día del calendario de la
   empresa, `dayWindow`): conteos normales de una ubicación, marcados con su
   programa y su día. El supervisor puede adelantar la vuelta con «Generar
   los de hoy» (la misma función; no crea nada que la ronda no crearía).
3. **Quien cuenta** los ve en Conteos › «De hoy» y en Inicio («Conteos de
   hoy», solo cuando hay alguno abierto), dentro de su almacén y su alcance.
   Los cuenta y aplica como cualquier otro conteo.
4. **Diferencias grandes:** si la empresa lo pide (ajuste), el conteo marca
   las líneas que pasan del umbral y aplicarlo exige confirmar «Revisé las
   diferencias» además del motivo de siempre y del permiso de aplicar.
5. **Exactitud** (Conteos › Exactitud): de lo contado y aplicado esta semana
   (o este mes), qué porcentaje de renglones coincidió con el sistema,
   comparado con la semana (o el mes) anterior; por programa si se elige.

## Qué cubre un programa y qué ubicación toca

- **Cubre** su raíz y todo lo que contiene (o todo el almacén), sin las
  archivadas, sin la ubicación de tránsito (`isTransit`, es del sistema, ADR
  0048) y sin «Preparación» (lo que espera ahí ya va apartado para un pedido
  y se corrige en el empaque o el despacho). De esas, **se cuenta una
  ubicación si tiene existencias o si no contiene otras**: una zona o un
  pasillo que solo agrupa no se cuenta por sí mismo (su contenido sí), y un
  estante vacío sí (ahí aparece lo que se dejó en otro lugar).
- **Le toca** si nunca se contó, o si su último conteo aplicado fue el día
  `hoy − frecuencia` o antes. «Contado» es cualquier conteo aplicado de esa
  ubicación, también uno abierto a mano: un conteo manual reciente aplaza el
  programado. Un conteo cancelado no cuenta.
- **No se genera** sobre una ubicación con un conteo abierto (de cualquier
  origen; un programado que nadie hizo ayer sigue abierto y no se duplica).
- **Reparto:** de las que tocan, primero las que nunca se contaron y luego
  las de conteo más antiguo (con ABC, a igual fecha, A antes que B y C), hasta
  `locationsPerDay` menos lo que el programa ya generó hoy. Con N
  ubicaciones y K por día, una vuelta completa toma ⌈N/K⌉ días; la pantalla
  del programa lo dice.

Se consideró generar conteos «por producto» para ABC; se descarta porque un
conteo es de una ubicación (y así el piso recorre lugares, no catálogos). Con
ABC, **la clase de una ubicación es la mejor clase de lo que tiene**: una
ubicación con un producto A se cuenta con la frecuencia de A; una vacía es C.

## Que la ronda no duplique (la decisión central)

La ronda puede correr dos veces (reinicio del worker, «Generar los de hoy» a
la vez, dos workers). Tres capas:

1. **El programa se bloquea** (`lockRows(tx, "countProgram", …)`,
   `LOCKING_TRANSACTION`) y, bajo el candado, se cuenta lo que ya generó para
   hoy: la segunda vuelta encuentra el cupo del día lleno y no crea nada.
2. Las ubicaciones elegidas se bloquean y se vuelve a revisar que no tengan un
   conteo abierto ni estén archivadas (orden de candados: programa →
   ubicaciones, el mismo que «abrir conteo» usa después de la ubicación).
3. La base tiene `UNIQUE (organizationId, programId, programDay, locationId)`
   y `openLocationId` sigue siendo único: aunque algo se escape, no se puede
   crear dos veces. Un disparador impide cambiar el programa o el día de un
   conteo generado.

Cada programa va en su propia transacción: uno que falla queda en el registro
(`cycle_count_program_failed`) y no detiene a los demás; una empresa que falla
no detiene a las otras (`runScheduledRounds`).

Quien «inicia» un conteo generado es la persona que creó el programa
(`startedByUserId` no admite vacío); la pantalla dice «por el programa …».

## Clasificación ABC

Derivada en cada ronda, nunca capturada ni guardada (una bandera envejece):

- **Base** (`inventory.abc.basis`): por omisión `lines`, el número de líneas
  de salida (`EXIT` y `SHIPMENT`) del producto en el almacén; o `value`,
  cantidad que salió × costo promedio de hoy. La segunda no expone costos:
  solo produce la letra de la clase, y la calcula el sistema.
- **Cortes** (`inventory.abc.cuts`): 80/15/5 por omisión, o 70/20/10 o
  50/30/20. Se ordena de mayor a menor; un producto es A mientras lo anterior
  a él no llega al primer corte, B mientras no llega a los dos primeros, C
  después; lo que no salió es C.
- **Periodo** (`inventory.abc.period`): 30, 90 (por omisión), 180 o 365 días.

Costo: un `groupBy` de las líneas de salida del periodo por producto (sobre el
índice `organizationId, locationId, createdAt`) y, con `value`, una lectura de
`product_cost`; se hace **una vez por almacén y por ronda** (`AbcCache`) y la
comparten los programas ABC de ese almacén. El plan de un programa lee además
las ubicaciones del almacén (tope 20,000), los saldos agrupados por
ubicación y producto (tope 100,000) y el último conteo aplicado por
ubicación (agrupado); todo en la base, nada guardado.

## Diferencias grandes y WMS-41

Ajuste `inventory.count.review_threshold`: `off` (por omisión), `any`
(cualquier diferencia), o más de 10, 25 o 50 % de lo que el sistema tenía al
contarlo (un producto que el sistema no tenía y apareció cuenta como
diferencia grande). No hay umbral por cantidad: las unidades cambian de un
producto a otro y un número fijo no significa lo mismo para tornillos que
para tarimas.

Hoy **marca** el conteo (cada línea dice «Revisar») y `applyCount`, con el
ajuste leído bajo el candado del conteo, rechaza (`field: "reviewed"`) si
llega sin `reviewed: true`; con él aplica y deja `revisado` y
`productosRevisados` en la bitácora. Aplicar sigue exigiendo
`inventory.count.apply` + `inventory.adjustment.create` y el motivo. No se
inventa un flujo de aprobaciones. **Con WMS-41 (ADR 0053, 2026-11-14)**, si la
empresa enciende la regla de `inventory.count_apply` (Configuración › Reglas
de aprobación, donde ahora vive también este umbral), la misma condición
(`needsReview`) crea una solicitud de autorización en vez de pedir la
casilla: el conteo sigue abierto pero congelado (sin capturas, sin cancelarse
ni aplicarse a mano) hasta que alguien con la regla y con
`inventory.count.apply` + `inventory.adjustment.create` lo autorice; entonces
se aplica con `applyCount`, a nombre de quien lo pidió. Con la regla apagada
se queda la casilla. El umbral y la marca no cambian.

## Exactitud

`getCountAccuracy` (permiso `inventory.count_accuracy.read`: titular,
administración, supervisión y Gerencia): conteos aplicados (`closedAt`) en la
semana (lunes a domingo) o el mes del calendario de la empresa, del almacén
activo y dentro del alcance de la persona, opcionalmente de un programa. Un
renglón es una línea de conteo (producto + ubicación + lote); es exacto si lo
contado es igual a `systemQuantity`. Se compara con el periodo anterior
(«+10.0 puntos»). El **valor de las diferencias** es lo que movieron los
ajustes de esos conteos al costo con que se escribió cada línea; solo existe
en la respuesta para quien tiene `inventory.cost.read`. Tope
`ACCURACY_MAX_ROWS` (20,000 renglones por periodo): si se llega, `truncated`
y la pantalla avisa que las cifras están incompletas. Es del almacén activo,
así que no hay cifra de toda la empresa (no hace falta `seesWholeCompany`).

## Pendientes de conteo de pasos anteriores

- **Conteo con tarimas (ADR 0043):** la captura ahora dice qué parte de lo
  que tiene el sistema está en tarimas o cajas de esa ubicación (`contained`
  por línea, mientras el conteo está abierto); aplicar ya rechazaba dejar un
  saldo debajo de lo contenido («saca de la tarima lo que haga falta o
  desármala») y la base lo impide. Sigue pendiente contar **por tarima**.
- **Conteo por serie (ADR 0041): pendiente.** Exige capturar las series
  escaneadas por línea (tabla nueva), comparar con las unidades dentro y
  aplicar con `serialsForEntry`/`serialsForTake` + `writeSerialMoves`; no
  cupo con seguridad en este paso. Hoy la captura sigue rechazando un
  producto por serie y se corrige con un ajuste que nombra las series.

## Otros pendientes

- Elegir qué tipos de movimiento cuentan como «salida» para ABC (hoy salidas
  y embarques; las devoluciones al proveedor no).
- Conteos generados de días anteriores que nadie hizo siguen abiertos; no se
  cancelan solos. Un aviso de «atrasados» queda para WMS-32 (indicadores).
- Conteo ciego (no mostrar lo que dice el sistema a quien cuenta).
- Asignar los conteos del día a personas (hoy los toma quien los abre).

## Alternativas descartadas

- **Guardar la clase ABC en el producto:** envejece y alguien tendría que
  recalcularla; derivarla por ronda cuesta dos consultas agrupadas.
- **Una tabla de «corridas» de la ronda:** el candado del programa más la
  llave única del conteo ya dicen qué se generó cada día.
- **Contar todo el almacén el día que toca:** es lo que la gente evita; el
  tope diario reparte la carga.
