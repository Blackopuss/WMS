# ADR 0043 — Tarimas y contenedores (LPN)

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-53 · Completa ADR 0033
(dimensiones del saldo), ADR 0041 (series) y ADR 0042 (acomodo)

## Contexto

En muchos almacenes la mercancía no se mueve pieza por pieza sino en
**tarimas**, cajas o jaulas con una etiqueta propia (en la industria, *LPN*:
número de unidad de carga). La especificación (6.1) y el plan v3 (WMS-53)
piden que al recibir se arme una tarima con su etiqueta, que moverla mueva
todo lo que contiene con un solo escaneo, que se acomode, se cuente y se
desarme **sin perder el detalle por producto y lote**. El empaque (WMS-15)
armará bultos ligados a un pedido y el despacho (WMS-16) los embarcará: el
modelo debe servirles.

La llave del saldo es producto + ubicación + estado + lote (ADR 0033) y las
series viven aparte del saldo (ADR 0041). La pregunta del paso es si el
contenedor entra en esa llave o se guarda aparte.

## Opciones

**(a) El contenedor como otra dimensión del saldo** (`containerId` +
`containerKey` en `stock_balance`, `stock_movement_line`, reservas, tareas,
conteos…). Es exacto —cada fila dice si está en una tarima— pero cambia la
llave única de `stock_balance` y **toda** lectura y operación de existencias
tendría que decidir qué hace con el contenedor: salida, salida rápida,
reubicación, ajuste, conteo, cambio de estado, reservas, surtido, acomodo,
importaciones, devoluciones, reversas, mínimos, valor, exportaciones. Armar
una tarima sería un movimiento (sale «suelto», entra «en tarima») aunque nada
cambie de lugar, y una empresa que no usa tarimas pagaría en cada consulta
una dimensión que nunca usa. Es la misma razón por la que las series no
hicieron crecer la llave (ADR 0041).

**(b) El contenedor como agrupación aparte del saldo.** Una tabla de
contenedores (código, tipo, dónde está) y otra con su contenido (producto,
lote, estado, cantidad), mientras el saldo sigue igual. Lo que dicen los
contenedores de una ubicación es una **parte** de su saldo: lo demás está
«suelto». La regla que importa —el contenido nunca dice más de lo que hay—
se puede escribir en la base, con un disparador en cada lado.

**Se elige (b).** La integridad no exige (a): el saldo sigue siendo la suma
de las líneas (ADR 0012) y el contenido de los contenedores queda acotado
por el saldo en la base, en ambas direcciones, y comparado en la
reconciliación. Lo que se pierde frente a (a) es que el historial de
movimientos no dice qué pieza salió «de una tarima»: no hace falta, porque
**nada sale de una tarima por su cuenta** (regla abajo): una tarima solo se
mueve entera, y lo que se saca de ella primero queda suelto, con su rastro
en la historia del contenedor.

## Flujo

1. **La empresa lo enciende.** Configuración › Operación, área «Tarimas»,
   «Tarimas y cajas»: **«No se usan»** (por omisión) o **«Se arman tarimas y
   cajas»**. Apagado, nadie ve nada nuevo: ni enlaces, ni la opción al
   recibir, ni cifras «en tarima». Si se apaga con contenedores armados,
   estos se siguen viendo, moviendo, vaciando y desarmando (nunca quedan
   atrapadas existencias); solo no se arma ni se agrega nada.
2. **Qué es un contenedor.** Una tarima, una caja, una jaula… El **tipo** es
   texto libre de una línea (la pantalla sugiere «Tarima», «Caja»,
   «Contenedor»; por omisión «Tarima»): no se decide por la empresa en una
   lista, porque no cambia ninguna regla. Su **código** es lo que se
   escanea: lo pone el sistema (`C-0001`, consecutivo por empresa, prefijo
   propio distinto de tareas `T-` y pedidos `PS-`) o lo escribe la persona
   si ya trae etiqueta (se guarda sin espacios de más y en mayúsculas; único
   en la empresa; un código escrito no puede tener la forma `C-` + número,
   que es la del sistema). Vive en **una ubicación**. No se borra: se
   **desarma** (queda cerrado, vacío, con su historia).
3. **Armar.** Inventario › «Tarimas y cajas» › «Armar tarima»: en una
   ubicación, se elige un producto que está ahí **suelto y libre** (lote,
   series y cantidad, como en una reubicación) y se pone en un contenedor
   nuevo o en uno abierto de esa misma ubicación. Desde la ficha del
   contenedor, «Agregar» repite el paso. **Armar no mueve existencias** (no
   escribe movimiento ni toca el saldo): solo dice qué parte del saldo de esa
   ubicación va dentro. Su rastro es la **historia del contenedor**
   (`container_event`, inmutable), como el movimiento es su propio rastro:
   no se duplica en la bitácora.
4. **Recibir en tarima.** Al recibir una orden de compra, con el parámetro
   encendido, «Llegó en una tarima» (código opcional y tipo): todo lo que
   entra en esa recepción queda dentro de un contenedor nuevo (o de uno
   abierto con ese código en el mismo lugar), en la misma transacción. Todas
   las líneas deben ir a la misma ubicación (una tarima está en un solo
   lugar).
5. **Mover con un escaneo.** «Mover una tarima» (en «Tarimas y cajas», en la
   ficha y desde «Cambiar de lugar»): se escanea la etiqueta del contenedor y
   la del lugar (código, ruta o nombre, como en el acomodo). Se escribe
   **un** movimiento de reubicación (`TRANSFER`, con `containerId` y la
   referencia `C-0001`) con dos líneas por producto, lote y estado que trae
   —y sus series—; el saldo cambia con sus líneas y el contenido cambia de
   ubicación junto con el contenedor, todo en la misma transacción. Pasa por
   lo mismo que toda reubicación: mismo almacén, alcance de quien mueve,
   ubicación activa y `checkPlacement` **una vez con todas las llegadas**
   (restricciones siempre; capacidad como decidió la empresa, con
   «Dejarlo ahí de todos modos»). Clave de confirmación con `repeated`; la
   misma clave a otro lugar es `KEY_REUSED`. Un movimiento de contenedor no
   se reversa desde Inventario: se mueve la tarima de regreso.
6. **Acomodo de una tarima (WMS-52).** Con el acomodo por tareas, una tarima
   recibida (o que espera en un lugar «de paso» sin tarea) crea **una** tarea
   `PUTAWAY` para la tarima, no una por producto. El lugar recomendado lo
   decide `putawayTarget`, ahora con todas las llegadas del contenedor (el
   orden usa la primera; `checkPlacement` las revisa todas). Los pasos son los
   de siempre: tomar, «Ya recogí la carga» (sin escanear series: van en la
   tarima) y escanear el lugar donde la dejó. La entrega mueve el contenedor
   con el mismo núcleo del punto 5 (clave `task:<id>`). «Crear tareas de
   acomodo» también crea las que faltan para tarimas.
7. **Sacar de un contenedor y desarmar.** En la ficha: «Sacar de la tarima»
   (un producto, lote, series y cantidad) deja eso **suelto** en la misma
   ubicación; «Desarmar» saca todo y cierra el contenedor. Ninguno mueve
   existencias ni cambia el saldo; quedan en la historia.
8. **La regla al sacar (un solo lugar).** **Lo que está en un contenedor no
   se toma suelto**: para una salida, salida rápida, reubicación, tarea,
   surtido, apartado, cambio de estado, devolución o reversa, lo que hay en
   una ubicación es su saldo **menos lo que está en contenedores** (y menos
   lo apartado). Se decide en `freeToTake`/`freeToMoveFrom`
   (`reservations.ts`), que ya era el único lugar que decía «cuánto se puede
   tomar de aquí»: lo contenido cuenta como un apartado de la ubicación (como
   `TASK_HOLD`, no resta del total del producto). El mensaje lo dice: «Hay 20
   piezas dentro de tarimas o cajas en Estante 1: sácalas de la tarima o
   desármala primero». Para las series, `serialsForTake` rechaza una unidad
   que está en un contenedor («La serie S-9 está en la tarima C-0003»).
   Ajustes, conteos y salidas importadas, que no preguntan lo libre, no
   dejan el saldo por debajo de lo que hay en contenedores: se rechazan (el
   ajuste o la fila) con el mismo motivo. Y debajo de todo, la base
   (`stock_balance_container_floor`) rechaza cualquier cambio del saldo que
   lo deje por debajo de lo contenido: ninguna operación futura puede romper
   la regla sin saberlo.
9. **Conteo.** Un conteo sigue contando lo que hay en la ubicación (suelto y
   en contenedores); como el saldo no cambia al armar, la ubicación sigue
   cuadrando. Aplicar un conteo cuya diferencia dejaría el saldo por debajo
   de lo que dicen sus contenedores se rechaza con el producto y el motivo
   («desarma o saca de la tarima y vuelve a contar»). Contar **por tarima**
   (escanear el contenedor y confirmar su contenido) queda pendiente.
10. **Ver.** Ficha del contenedor (`/inventario/tarimas/[id]`): código a la
    vista con botón para copiarlo, tipo, dónde está, qué trae (producto,
    lote y caducidad, series, cantidad) y su historia paginada (armado,
    agregado, sacado, movido —con su movimiento—, desarmado). Lista paginada
    con búsqueda por código. El cuadro «Rastrear lote, serie o pedido» acepta
    también un código de contenedor. En la ficha del producto, por ubicación,
    «N en tarimas». Imprimir la etiqueta es WMS-26.

## Decisión

- **Tablas nuevas** (en `TENANT_MODELS`, dato de ejemplo entre empresas):
  - `container`: número consecutivo (`C-0001`), código único por empresa,
    tipo (texto), **propósito** (`purpose`, hoy solo `STORAGE`; WMS-15
    agregará el de empaque con su pedido ligado), ubicación, estado
    (`OPEN`/`CLOSED`), quién y cuándo lo cerró. No se borra; número, código,
    propósito y creación no cambian; cerrado no vuelve a abrir
    (disparadores).
  - `container_item`: contenedor + producto + ubicación (la del contenedor)
    + estado + lote (`lotKey`, como el saldo) + cantidad (> 0). Una fila por
    producto, estado y lote dentro de cada contenedor; se borra al quedar en
    cero (la historia vive en `container_event`).
  - `container_event`: historia inmutable (`CREATED`, `PACKED`,
    `UNPACKED`, `MOVED`, `CLOSED`), con producto, lote, cantidad, ubicación,
    origen, movimiento y tarea cuando aplica.
  - Columnas nuevas, opcionales: `serial_unit.containerId` (qué unidades van
    en cuál contenedor), `stock_movement.containerId` (el contenedor que
    movió ese movimiento) y `warehouse_task.containerId`.
- **Hoy solo existencias disponibles** entran a un contenedor (`status`
  existe en `container_item` para cuarentena o devoluciones por tarima
  futuras, con su regla en la base igual que hoy). Cambiar el estado de lo
  que está dentro exige sacarlo primero.
- **Reglas en la base:**
  - `container_item_rules` (al insertar y al cambiar): la ubicación es la de
    su contenedor, el contenedor está abierto, el lote es de su producto, y
    la suma de lo que dicen los contenedores en esa llave (producto,
    ubicación, estado, lote) **no pasa** del saldo.
  - `stock_balance_container_floor` (al cambiar el saldo): el saldo nunca
    queda por debajo de lo que dicen los contenedores de esa llave.
  - `serial_unit_container_rule`: una unidad solo entra a un contenedor
    estando en su ubicación y disponible.
  - Con eso, mover un contenedor exige un orden fijo dentro de la
    transacción, que guarda `moveContainerWithin`: primero sube el saldo del
    destino, luego cambia la ubicación del contenedor y de su contenido, y al
    final baja el saldo del origen.
- **Reconciliación.** `reconcileStock` agrega `source: "containers"`: por
  cada llave, lo que dicen los contenedores contra el saldo (nunca más); el
  contenido en la ubicación de su contenedor; un contenedor cerrado vacío; y,
  para productos por serie, tantas unidades marcadas en el contenedor (y en
  su ubicación) como dice su contenido. Toda prueba que ya terminaba con
  `reconcileStock` vacío lo comprueba sin cambios.
- **Un solo lugar en el código:** `containers.ts` (armar `packStock`, sacar
  `unpackStock`, desarmar `closeContainer`, mover `moveContainer` y su núcleo
  `moveContainerWithin`, `containedAt` para los mensajes y las comprobaciones,
  lecturas). La regla de lo que se toma suelto vive en `freeToTake` /
  `freeToMoveFrom`; la de las series, en `serialsForTake`.
- **Candados.** Orden fijo: productos → ubicaciones → documento (orden de
  compra, conteo, pedido) → **contenedor** (`lockRows(tx, "container", …)`)
  → tarea → filas de capacidad. Mover lee el contenido antes de la
  transacción para saber qué productos bloquear, bloquea productos →
  ubicaciones (origen y destino) → contenedor, y vuelve a leer: si el
  contenido trae un producto que no bloqueó o el contenedor cambió de lugar,
  repite la operación entera (nunca toma un candado de producto después del
  del contenedor). La recepción bloquea el contenedor antes de
  `checkPlacement`, así su candado de capacidad sigue siendo el último. Como
  nadie toma un producto o una ubicación después de un contenedor, ni un
  contenedor después de una tarea o de una capacidad, no hay ciclos. Un
  contenedor con una tarea abierta no se mueve a mano, ni se arma, vacía o
  desarma (su contenido es el que la tarea va a mover).
- **Tareas de contenedor.** `warehouse_task` admite un contenedor en lugar
  de un producto: `productId`, `quantity` y `unitCode` pasan a ser opcionales
  y un `CHECK` exige exactamente uno de los dos (con producto, cantidad y
  unidad; con contenedor, sin cantidad, lote ni pedido, y solo `TRANSFER` o
  `PUTAWAY`). El contenedor de una tarea no cambia (disparador). Es solo
  expansión: la versión anterior nunca escribe tareas sin producto.
- **Permisos:** ninguno nuevo. Ver es `inventory.stock.read`; armar, sacar,
  desarmar y mover, `inventory.transfer.create` (agrupar y mover existencias
  dentro del almacén, como una reubicación); recibir en tarima es parte de
  recibir (`purchasing.receipt.create`). La pantalla y el servicio piden lo
  mismo.
- **Alcance (WMS-20).** Un contenedor en una ubicación fuera de los almacenes
  o zonas de la persona no existe para ella (lista, búsqueda, ficha,
  rastreo, mover); el destino de un movimiento debe estar dentro.
- **Parámetro** `inventory.containers.mode` (`off` por omisión, `on`) en
  `INVENTORY_SETTINGS`, leído con `readSetting` en la transacción que arma.

## Dónde se aplica

| Operación | Con contenedores |
| --- | --- |
| Salida, salida rápida, reubicación, tarea de traslado, surtido, apartados, cambio de estado, devolución, reversa | Solo toman lo suelto (`freeToTake`/`freeToMoveFrom`); series en contenedor se rechazan |
| Ajuste (`registerAdjustment`) | No deja el saldo por debajo de lo contenido; un ajuste por serie no puede dar por faltante una unidad que está en un contenedor |
| Aplicar conteo (`applyCount`) | Igual que el ajuste, por producto y lote |
| Salidas importadas | La fila falla con el motivo si tomaría de lo contenido |
| Recepción de orden de compra | «Llegó en una tarima»: arma el contenedor con lo recibido |
| Acomodo por tareas | Una tarea por tarima; sus productos no generan tareas propias |
| Reversa de un movimiento de contenedor | No se reversa: se mueve la tarima de regreso |
| Entrada manual, saldo inicial, importación de existencias | Entran sueltas; se arman después |

## Lo que quedó fuera (pendiente)

- **Registrar una entrada «en tarima»** (entrada manual): hoy se registra y
  después se arma en la misma ubicación (dos pasos). La recepción de una
  orden de compra sí lo hace en uno.
- **Surtir directo de una tarima** (tomar piezas escaneando el contenedor):
  hoy se saca de la tarima primero. No llegó con el reabastecimiento (WMS-24)
  ni con las olas (WMS-25): ADR 0054 explica lo que exige y queda para un
  paso propio.
- **Tarea de traslado de una tarima creada a mano** (`/tareas/nueva`): el
  modelo y la entrega ya la admiten; hoy solo el acomodo las crea. Mover a
  mano una tarima es un escaneo.
- **Conteo por tarima** y cambiar el estado de lo que está dentro sin
  sacarlo (cuarentena de una tarima entera).
- **«Sin acomodar» (WMS-72) por tarima:** una tarima que espera en «General»
  aparece ahí por sus productos (la fila abre «Cambiar de lugar», que dice
  que eso está en una tarima); su tarea de acomodo sí es una por tarima.
  Mostrar la tarima como una fila propia queda pendiente.
- **Archivar** una ubicación o un almacén con una tarima armada (aunque esté
  vacía) se rechaza: se mueve o se desarma antes.
- **Contenedores dentro de contenedores** (cajas en una tarima).
- **Peso y volumen del contenedor mismo** (la tarima vacía): la capacidad
  cuenta solo lo que trae.
- **Etiquetas impresas** (WMS-26), **bultos de empaque ligados a un pedido**
  (WMS-15, nuevo valor de `purpose` y su documento) y **embarque** (WMS-16).

## Consecuencias

- Una operación nueva que saque existencias de una ubicación pregunta
  `freeToTake`/`freeToMoveFrom` (ya lo hacían todas las que respetan
  apartados); una que fije un saldo sin preguntarlo (como un ajuste) compara
  con `containedAt` y, si no, la base la rechaza.
- Cada cambio de saldo hace una lectura más por índice (la suma de lo
  contenido en esa llave), haya o no contenedores.
- Migración `20261114140000_wms_containers` (solo expansión): tres tablas,
  tres columnas opcionales, `warehouse_task.productId`, `quantity` y
  `unitCode` opcionales con sus `CHECK`, y disparadores nuevos (ninguno
  existente se reemplaza).
