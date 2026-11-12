# ADR 0039 — Capacidad y restricciones de ubicación

Fecha: 2026-11-12 · Estado: aceptada · Paso: WMS-22B · Completa ADR 0036

## Contexto

Desde WMS-22A cada almacén tiene sus niveles y cada ubicación un uso
(almacenamiento, surtido, recepción, preparación, cuarentena, andén), pero el
uso solo informaba: nada impedía meter mercancía donde no cabe o donde no debe
estar. La especificación (8.x) pide validar capacidad y restricciones al mover,
y que los reportes de un nodo sumen a sus descendientes sin duplicar (PC-11).

## Flujo

1. **Quién configura y dónde.** Quien puede cambiar ubicaciones
   (`inventory.location.update`) abre Configuración › Ubicaciones. Al agregar
   una ubicación, o al abrir una que existe, despliega «Capacidad y
   restricciones» (plegado: casi nadie lo llena) y escribe lo que aplique:
   - **Capacidad**, cada dato opcional (vacío = sin límite): unidades, peso
     (kg) y volumen (m³).
   - **Solo admite estas categorías** (casillas) y **solo admite estos
     productos** (sus claves, una por línea). Sin nada, admite cualquiera.
   - El **uso «Cuarentena»** (ya existía) ahora es una regla: ahí solo entran
     existencias que no están disponibles.
2. **Peso y volumen del producto.** En la ficha del producto, «Peso y volumen
   (opcional)»: peso de una unidad en kilogramos y volumen en litros. Un
   producto que se controla por peso (kg, g) ya dice su peso y uno por volumen
   (L, mL) su volumen: ese campo no se pide. Un producto sin el dato **no
   cuenta** en esa medida, y la lista de ubicaciones lo dice.
3. **Qué se valida.** Toda operación que mete existencias a una ubicación
   pregunta, dentro de su transacción, si pueden entrar (ver «Dónde se
   comprueba»). Una regla de una ubicación vale para todo lo que contiene: la
   capacidad de una zona cuenta lo de sus pasillos y estantes; una zona de
   cuarentena o limitada a una categoría lo es con todo lo que tiene dentro.
4. **Qué pasa al pasarse de la capacidad** lo decide la empresa en
   Configuración › Operación, «Al pasar la capacidad de una ubicación»:
   **avisar** (por omisión: la operación no se guarda, dice por cuánto se pasa y
   ofrece «… de todos modos») o **no permitirlo**. Las **restricciones** no son
   un aviso: siempre detienen.
5. **Qué deja de rastro.** Cambiar capacidad o restricciones queda en la
   bitácora (`location.limits_changed`, con el antes y el después en palabras);
   cambiar el parámetro, como cualquier ajuste (`settings.changed`). Un
   movimiento aceptado por encima de la capacidad es un movimiento normal: su
   resumen lo dice y la lista de ubicaciones muestra la ubicación «por encima
   de su capacidad».
6. **Qué se ve.** La lista de ubicaciones muestra, por nodo, cuánto hay sumando
   lo que contiene («120 de 500 unidades · 80 de 1,000 kg»).

## Decisión

- **Capacidad en tabla aparte** (`location_capacity`, una fila por ubicación
  solo mientras tenga algún límite; `CHECK`: al menos uno y todos positivos).
  Además de guardar los límites, **la fila es el candado**: la operación que
  mete existencias bloquea, como **último** candado de su transacción y en
  orden de id (`lockRows(tx, "locationCapacity", …)`), las filas de capacidad
  de la ubicación de destino y de sus ancestros. Así dos entradas a estantes
  distintos de la misma zona se deciden una tras otra. No se bloquean las filas
  de `location` de los ancestros: esas ya se toman antes, en otro orden, y
  habría interbloqueos (una reubicación entre una zona y su estante contra una
  entrada al estante).
- **Restricciones** en `location_restriction` (ubicación + producto **o**
  categoría, `CHECK` de exactamente uno). Sin filas, admite todo.
- **Peso y volumen** en `product.unitWeight` (kg) y `product.unitVolume`
  (litros), opcionales y positivos (`CHECK`). La capacidad de volumen de una
  ubicación va en m³ (1 m³ = 1,000 L); todo con decimal exacto.
- **Cómo cuenta «unidades»:** la suma de las cantidades de cada producto que
  hay en la ubicación y en lo que contiene, **cada una en la unidad de su
  producto** (10 piezas + 2.5 kg = 12.5) y en **todos los estados** (ADR 0033:
  lo que físicamente está, disponible o no; lo apartado sigue ahí y cuenta).
- **Una sola función**: `checkPlacement(tx, llegadas, política)` de
  `src/modules/inventory/placement.ts`. Recibe lo que llega (producto,
  cantidad en su unidad, destino, origen si lo hay, estado en que llega) y
  responde `ok` (con notas), `restricted` o `over_capacity` (`blocked` según el
  parámetro). La política de capacidad la da quien llama: `ask` (el parámetro
  de la empresa; con «avisar», solo pasa con `accepted`), `report` (nunca
  detiene, lo dice en las notas) o `skip` (solo restricciones).
  `loadPlacementRules` lee las reglas una vez (el árbol del almacén, las
  restricciones y las capacidades: tres consultas) y sirve a un lote.
- **Entrar a un nodo.** Una restricción de productos y una capacidad se
  preguntan solo de los nodos a los que la mercancía **entra**: mover dentro de
  una misma zona no suma a la zona ni vuelve a pedirle permiso. La regla de
  cuarentena se pregunta siempre que el estado de llegada es «disponible»,
  aunque no se mueva (liberar en el lugar).
- **Parámetro** `inventory.capacity.mode` (`warn` por omisión, `block`), en
  `INVENTORY_SETTINGS`; se lee con `readSetting` dentro de la transacción.
- **El aviso no viaja a otros datos.** La pantalla manda la aceptación con una
  marca (`fingerprint` de producto, lugar y cantidad): si la persona cambia
  algo después del aviso, la aceptación ya no vale y se vuelve a preguntar.
- **Cambiar estado puede decir dónde queda** (`changeStockStatus` con
  `toLocationId`, mismo almacén; además del permiso del cambio exige
  `inventory.transfer.create`). Es lo que hace usable la regla de cuarentena:
  hoy una reubicación solo mueve existencias disponibles, así que sin esto nada
  podría entrar a una ubicación de cuarentena ni salir de ella al liberarse.
  Poner en cuarentena = cambiar a «En cuarentena» y elegir la ubicación de
  cuarentena; liberar = cambiar a «Disponible» y elegir a dónde va. Un solo
  movimiento `STATUS_CHANGE` con sus dos líneas.
- **«General» no lleva capacidad ni restricciones**: ahí cae lo que no tiene
  lugar (entradas sin ubicación, recepciones, importaciones).
- **Ocupación por nodo (PC-11):** `getLocationOccupancy` deriva en cada lectura
  lo que hay en cada ubicación del almacén activo y, por nodo, la suma de lo
  suyo más lo de cada descendiente, una sola vez; respeta el alcance de WMS-20.
  No se guarda nada. Lee hasta 50,000 saldos y avisa si quedó incompleto.

## Dónde se comprueba

| Operación | Restricciones | Capacidad |
| --- | --- | --- |
| Entrada (`registerEntry`) | Detienen | Según el parámetro (aviso con aceptación o bloqueo) |
| Saldo inicial (`registerInitialBalance`) | Detienen | Según el parámetro |
| Reubicación, destino (`registerTransfer`) | Detienen | Según el parámetro |
| Recepción de orden de compra (`postReceiptEntry`) | Detienen | Según el parámetro; todas las líneas juntas |
| Cambio de estado (`changeStockStatus`) | Detienen (cuarentena en el lugar; todas si cambia de lugar) | Según el parámetro, si cambia de lugar |
| Crear tarea de traslado (`createTask`) | Detienen | Según el parámetro |
| Entregar tarea de traslado o de surtido (`postTaskTransfer`) | Detienen | **No detiene**: lo dice en el resumen |
| Reversa que devuelve mercancía (`reverseMovement`) | Detienen | **No detiene**: lo dice en el resumen |
| Existencias importadas (`checkImportedStock`, worker) | Detienen (el producto falla entero, con su motivo) | **No se comprueba** |

Decisiones donde «avisar» no cabe, y por qué:

- **Entrega de una tarea:** la carga ya está frente a su destino. Se preguntó
  al **crear** la tarea, donde alguien puede elegir otro lugar; en la entrega
  la capacidad no detiene (en ningún modo) y el resumen dice que la ubicación
  quedó por encima. Las tareas de surtido las crea la liberación del pedido
  hacia «Preparación»: ahí no se pregunta capacidad.
- **Reversa:** deshace un registro equivocado, no trae mercancía nueva; la
  capacidad no la detiene y el resumen lo dice. Una restricción sí.
- **Importación de existencias (worker):** es lo que ya había en el almacén y
  no hay nadie a quien preguntar; la capacidad no se comprueba y la ocupación
  lo muestra. Una restricción sí detiene ese producto.

No se comprueban, porque registran lo que ya pasó o lo que físicamente hay:
ajustes de existencias y aplicación de conteos. Tampoco las salidas (sacan).

## Lo que quedó fuera (pendiente)

- **Dimensiones** de la ubicación (largo, ancho, alto) y acomodo por ellas:
  WMS-52 (acomodo con recomendación) usará la capacidad de aquí.
- **Mover existencias no disponibles sin cambiar su estado** (de un estante a
  otro en cuarentena): sigue sin haber forma; hoy se cambia de estado al mover.
- **Mover una ubicación en el árbol** (`moveLocation`) no revisa la capacidad
  del nuevo padre, ni cambiar una capacidad o una restricción revisa lo que ya
  hay: lo guardado no se «repara», la lista lo muestra por encima de su
  capacidad. Lo que ya viola una restricción no se señala todavía.
- **Tareas pendientes** hacia un destino no se descuentan de su capacidad al
  crear otra tarea.
- La **revisión previa** de una importación no anticipa las restricciones: el
  producto falla al aplicarse, con su motivo.
- Peso y volumen **en la importación de productos** (columnas del archivo).
- Bloquear una ubicación por mantenimiento (especificación 8.x) es otro paso.

## Consecuencias

- Una operación nueva que meta existencias a una ubicación llama
  `checkPlacement` una sola vez por transacción, con todas sus llegadas, después
  de sus candados y antes de escribir saldos; con `ask` no toma ningún candado
  después.
- Sin nada configurado cuesta tres consultas más por operación (el árbol del
  almacén, restricciones y capacidades del destino y sus ancestros). Con
  capacidad de peso o volumen en un nodo grande, cada entrada suma los saldos
  de ese nodo por producto.
- Tabla nueva de empresa: `LocationCapacity` y `LocationRestriction` en
  `TENANT_MODELS`; `locationCapacity` en las tablas que `lockRows` admite.
