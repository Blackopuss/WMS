# ADR 0086 — Sugerencias de reubicación (slotting)

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-65 · Se apoya en WMS-32
(indicadores, ADR 0082), WMS-55 (clasificación ABC, ADR 0050), WMS-22A/22B
(niveles, uso, capacidad y restricciones, ADR 0036 y 0039), WMS-52 (acomodo,
ADR 0042), WMS-23/24 (reposición, ADR 0051), WMS-25 (orden de recorrido,
ADR 0054) y WMS-06 (tareas de traslado)

## Contexto

El plan v3 (Fase 4, inteligencia operativa) pide «slotting: recomendación de
reubicar por rotación y optimización de espacios». El sistema no tiene planos
ni distancias: tiene el **uso** de cada ubicación (`PICKING` «Surtido»,
`STORAGE` «Almacenaje»…), su **código** (que ya sigue los pasillos: con él se
ordena el recorrido del surtido, ADR 0054), su zona, su capacidad y sus
restricciones, y sabe qué sale y qué no se mueve (clasificación ABC y
«sin movimiento»).

Regla de fondo: **este paso recomienda**. No inventa una forma nueva de mover
existencias. Una recomendación aceptada es una **tarea de traslado** normal,
creada con el mismo servicio (`createTask`), con sus validaciones, candados,
estados y entrega. Nada se mueve solo.

## Flujo operativo

1. **Quién:** quien organiza el almacén (titular, Administración, Almacén y
   Supervisor de almacén) desde el escritorio o la tableta; Gerencia y
   Consulta solo ven. El piso (Almacenista, Montacarguista) no ve la pantalla:
   recibe las tareas que se crean, como cualquier traslado.
2. **Dónde:** Inventario › «Sugerencias de reubicación»
   (`/inventario/reubicaciones`), un enlace en la fila bajo el título de
   Inventario. **No es sección del menú** (no es de uso diario) ni lleva aviso
   en Inicio (pendiente si el fundador lo pide).
3. **Qué ve:** una lista corta (20 por omisión) de renglones, cada uno con
   producto (y lote), de dónde, a dónde, cuánto y **una línea de por qué**:
   - «Sale seguido y no tiene lugar de surtido: muévelo de A-07-3 a S-01-2.»
   - «No ha salido en 90 días y ocupa un lugar de surtido: muévelo de S-01-4
     a A-12-1.»
   - «Está repartido en 3 ubicaciones de almacenaje: junta lo de A-04-1 con
     lo de A-02-2.»
4. **Qué hace:** «Crear tarea» en un renglón. El servidor vuelve a decidir esa
   sugerencia y, si sigue igual, crea la tarea de traslado (sin asignar,
   prioridad normal, con la nota «Sugerencia de reubicación: …»). La persona
   va a la tarea o sigue con la lista. Quien hace la tarea la toma, recoge y
   entrega como cualquier otra (con su foto si la empresa la pide).
5. **Rastro:** la tarea misma (quién la creó, cuándo, nota con el motivo) y,
   al entregarse, su movimiento `TRANSFER` (`task:<id>`). No se guarda nada
   más: ni recomendaciones, ni «descartadas», ni banderas.

## Qué se recomienda (tres tipos, nada más)

En todo lo que sigue: «el almacén» es el almacén activo de la persona;
«en su alcance» es dentro de sus zonas (ADR 0038); una ubicación **hoja** es
una que no contiene otras activas; «libre para mover» es `freeToMoveFrom`
(disponible − apartado ahí, sin lo que está dentro de una tarima de
almacenaje); siempre se trabaja con existencias **disponibles** (`AVAILABLE`).

### 1. Acercar a surtido (`closer`)

- **Producto:** de clase A del almacén (la misma clasificación ABC de los
  conteos cíclicos, `abcClassesOf`: base, cortes y periodo de la empresa,
  `inventory.abc.*`), o A y B si la empresa lo elige
  (`inventory.slotting.fast_classes`).
- **Condición:** no tiene existencias disponibles en ninguna ubicación de
  surtido del almacén (en todo el almacén, no solo en el alcance: si ya tiene
  lugar de surtido en otra zona no se sugiere otro) y no tiene regla de
  reposición en el almacén (la reposición ya cuida su lugar).
- **Origen:** una ubicación hoja de almacenaje, en su alcance, con libre para
  mover; de varias, la que `rankStockSources` toma primero (lo que caduca
  antes primero, después la estrategia de surtido de la empresa): así lo que
  caduca antes nunca queda escondido detrás. Lotes caducados no se acercan
  salvo que la empresa surta caducados (`inventory.picking.expired`).
- **Destino:** una ubicación hoja de surtido del almacén, en su alcance,
  **vacía** (sin saldo de ningún producto ni estado), sin regla de
  reposición, sin tarea abierta que vaya hacia ella, que admita el producto
  (`checkPlacement` en modo `report`: restricciones y capacidad). De varias,
  **la primera en el orden de recorrido** (`compareRoute` sobre el código o la
  ruta, el mismo orden de las olas, ADR 0054).
- **Cantidad:** lo libre para mover en el origen, de ese lote, recortado a lo
  que cabe en el destino (la mayor cantidad en pasos del producto,
  `largestThatFits`). Si no cabe ni un paso, se prueba el siguiente destino
  (hasta 10).

### 2. Sacar de surtido lo que no sale (`idle`)

- **Producto y lugar:** existencias disponibles en una ubicación hoja de
  surtido en su alcance, de un producto **sin ninguna línea de movimiento en
  el almacén** en los últimos N días (`inventory.kpi.idle_days`, el mismo
  ajuste de «Productos sin movimiento» de los indicadores, 90 por omisión).
- **Condición:** esa ubicación no tiene regla de reposición de ese producto
  (la regla dice que va ahí) y todo lo disponible de ese lote ahí está libre
  para mover (si hay algo apartado, alguien lo necesita).
- **Destino:** una ubicación hoja de almacenaje del almacén, en su alcance,
  sin tarea abierta hacia ella, que admita **todo** (la idea es vaciar el
  lugar de surtido; mover la mitad no sirve). Orden: el mismo del acomodo
  (`rankPutawayPlaces` con `inventory.putaway.preference`: junto a lo mismo,
  o lo más vacío; el desempate es el código, o el nombre si no tiene, en
  orden natural, no la ruta completa, para no hacer una consulta por nivel),
  hasta 10 probadas.
- **Cantidad:** todo lo disponible de ese lote en el origen.

### 3. Juntar lo repartido (`consolidate`)

- **Producto y lote:** disponible en dos o más ubicaciones hoja de
  almacenaje del almacén y en su alcance (solo almacenaje: los lugares de
  surtido los cuida la reposición). Se puede apagar
  (`inventory.slotting.consolidate`, encendido por omisión).
- **Origen:** la ubicación con **menos**, si todo lo de ese producto ahí es
  de ese lote, disponible y libre para mover (así el lugar queda libre de ese
  producto; si no, se prueba la siguiente con menos).
- **Destino:** de las demás, la que tiene **más** y admite todo
  (`checkPlacement` en `report`), sin tarea abierta hacia ella.
- **Cantidad:** todo lo del origen. Nunca mezcla lotes: solo junta el mismo
  lote.

### Para los tres

- **Una vez:** cada ubicación aparece como destino de una sola sugerencia y
  cada producto y origen en una sola; un origen o un destino con una tarea
  abierta (de cualquier tipo) de ese producto, o un destino con cualquier
  tarea abierta hacia él, no se sugiere: **lo que ya va en camino no se
  vuelve a sugerir**.
- **Sin contradicciones:** dos sugerencias de un mismo producto nunca usan
  como origen lo que la otra usa como destino ni al revés (por ejemplo,
  «acercar de Y» y «juntar X en Y» no salen juntas).
- **Series:** entran como cualquier producto (la tarea pide escanear las
  series al recoger, como todo traslado).
- **Orden y tope:** primero «acercar» (clase A antes que B, después por
  nombre), luego «sacar de surtido», luego «juntar»; hasta
  `inventory.slotting.limit` (10, 20 por omisión o 50).
- **Lectura acotada:** cada tipo lee como mucho 2,000 saldos candidatos
  (`SLOTTING_SCAN_MAX`); si hubo más, la respuesta trae `truncated` y la
  pantalla dice que puede haber más sugerencias.

## Qué queda fuera

- Ubicaciones sobre su capacidad (ya las muestra la ocupación de
  Ubicaciones; sugerir qué sacar exige elegir producto y destino a la vez).
- Distancias, planos o coordenadas; «cerca» es el orden de recorrido.
- Mover tarimas enteras, reacomodar por peso o volumen, rediseñar niveles o
  capacidades, crear reglas de reposición desde la sugerencia.
- Rondas automáticas que creen tareas (pendiente: sería como la ronda de
  reposición) y avisos en Inicio.
- Existencias no disponibles (inspección, dañado, restauración…): nunca se
  sugiere moverlas.
- Tableros (WMS-34) y automatizaciones (WMS-64).

## Aceptar: crear la tarea

`acceptSlottingSuggestion(actor, { kind, productId, fromLocationId, lotId,
toLocationId })`:

1. Permisos: `inventory.slotting.read` y `inventory.task.create`
   (`assertModulePermission`: con el plan vencido el módulo está en solo
   lectura y no se crea nada).
2. Antes de leer nada más, comprueba que origen y destino sean del almacén
   activo y estén dentro de su alcance; si no, responde «Esta sugerencia
   cambió…» como si no existieran (nunca dice si hay una tarea ahí). Después
   vuelve a calcular **solo esa sugerencia** (mismo tipo, producto, origen y
   lote) con las mismas reglas, sin candados; en «acercar», el origen debe
   seguir siendo el primero en orden de salida (si llegó un lote que caduca
   antes, la sugerencia cambió). Si ya no existe o su destino ya
   no es el que la persona vio, responde «Esta sugerencia cambió…» sin
   escribir. **El navegador nunca manda cantidades**: la cantidad es la que
   decide el servidor en ese momento (la respuesta la dice).
3. Llama al núcleo de `createTask` con producto, origen, destino, lote y
   cantidad decididos, más una **guarda que corre bajo sus candados**
   (producto → ubicaciones): si ya hay una tarea abierta de ese producto que
   sale del origen o del destino, o que llega al origen, o cualquier tarea
   abierta hacia ese destino (la misma regla del plan), no crea nada y
   responde «Ya hay una tarea…» (`repeated` si es de ese producto entre esas
   ubicaciones). Así **dos aceptaciones a la vez no crean dos tareas**: la
   segunda espera el candado del producto (o de la ubicación de destino) y ve
   la primera.
4. Todo lo demás es `createTask` tal cual: alcance de origen y destino,
   producto activo, lote, existencias, libre para mover, `checkPlacement` en
   modo `ask` (si la empresa solo avisa y ya no cabe, se responde el aviso y
   no se crea; la sugerencia se vuelve a calcular en la siguiente visita).

**No cambia** cómo una tarea mueve existencias, sus reservas, su tabla de
estados, sus candados ni `movements.ts`. Una tarea de traslado no aparta lo
que lleva (como siempre); por eso la sugerencia descuenta lo que va en camino
evitando orígenes y destinos con tareas abiertas.

Candados: los de `createTask` (producto → ubicaciones) y nada más. Una
transacción por aceptación. La lectura de la lista no toma candados.

## Permisos

- **Nuevo** `inventory.slotting.read` — «Ver sugerencias de reubicación»:
  titular, Administración, Almacén, Supervisor de almacén, Consulta y
  Gerencia. Termina en `.read`: sigue con el plan vencido y se conserva en
  una sesión de PIN.
- **Crear la tarea:** además `inventory.task.create` (titular,
  Administración, Almacén y Supervisor). El botón se pinta solo con los dos
  y con el módulo en uso (no en solo lectura); el servicio lo vuelve a
  comprobar.
- El piso, Comprador y los roles de producción y calidad no ven la pantalla.
- Soporte de plataforma ve (sus permisos `.read`); la API no la ofrece.

## Alcance

- Solo el almacén activo de la persona.
- Orígenes y destinos: solo ubicaciones dentro de su alcance; nada de fuera se
  nombra ni se cuenta.
- La **clasificación** (ABC, sin movimiento) y la condición «ya tiene lugar de
  surtido» miran todo el almacén, como los conteos cíclicos: son propiedades
  del producto en ese almacén, no se muestran como cifras. *Riesgo aceptado
  (así quedó):* quien está limitado a una zona puede deducir (a) que un
  producto tiene lugar de surtido en otra zona del mismo almacén, porque no
  se le sugiere acercarlo, (b) que un producto de su zona sale en otra zona
  (clase A) aunque en la suya no salga, y (c) que un producto se movió en
  otra zona, porque no se le sugiere sacarlo de surtido. Nunca se nombra ni se
  cuenta un lugar, documento o cifra de fuera.

## Lo que varía por empresa (ajustes de Operación › Inventario)

- `inventory.slotting.fast_classes`: qué cuenta como «sale seguido»: clase A
  (por omisión) o A y B.
- `inventory.slotting.consolidate`: sugerir juntar lo repartido (encendido por
  omisión) o no.
- `inventory.slotting.limit`: cuántas sugerencias a la vez: 10, 20 (por
  omisión) o 50.
- Reutilizados: base, cortes y periodo ABC (`inventory.abc.*`), días sin
  movimiento (`inventory.kpi.idle_days`), estrategia de surtido, surtir
  caducados y preferencia de acomodo.

*El fundador puede cambiar:* los tres tipos y su orden, que «cerca» sea el
orden de recorrido, que acercar mueva todo lo libre del origen (y no, por
ejemplo, una cantidad fija), que juntar sea solo en almacenaje, que la
clasificación mire todo el almacén, los topes y que no haya aviso en Inicio
ni ronda automática.

## Costo

Sin tablas ni migraciones. **El costo no crece con los candidatos**
(corrección de la revisión: la primera versión consultaba por candidato y
llegaba a 645 sentencias con 150 productos sin movimiento y una ubicación de
almacenaje, y a 1,074 con 100 productos de clase A y 10 lugares de surtido
restringidos):

- Cada tipo decide primero si queda algún destino posible; si no, no lee
  candidatos.
- Lo que hace falta de los candidatos se lee **en lote** (por conjunto de
  productos y ubicaciones): saldos, apartados y tarimas en tres consultas
  agrupadas que repiten la cuenta de `freeToMoveFrom` (disponible − apartado
  ahí − dentro de tarimas de almacenaje; de la ubicación y del lote, la
  menor), las reglas de ubicación una vez por tipo, y lo de la preferencia de
  acomodo (mismo producto, lote o categoría) en una consulta cada uno.
  `createTask` vuelve a comprobar todo bajo sus candados al aceptar.
- Restricciones y cuarentena se deciden en memoria (`restrictionProblem`);
  solo un destino con capacidad consulta la base (`checkPlacement`), con un
  presupuesto de **40 comprobaciones por lista** y 50,000 pares revisados en
  memoria. Agotado, la lista se corta y trae `truncated`.
- Se deja de buscar al llegar al tope de sugerencias o cuando ya no queda
  destino libre.

Medido con la prueba (cuenta solo las sentencias de su propio adaptador):
unas 50 sentencias fijas más menos de 3 por sugerencia extra; los dos
escenarios de la revisión quedan en 47 y 37, con tope de 55 en la prueba.

## Consecuencias

- Nuevo: `src/modules/inventory/slotting.ts` (servicio) y `slotting-rules.ts`
  (reglas puras con prueba unitaria); pantalla
  `src/app/(app)/inventario/reubicaciones/`; el núcleo de `createTask` acepta
  una guarda interna (no expuesta en `index.ts` ni en la pantalla de
  tareas).
- Pruebas en `tests/inventory/slotting.int.test.ts` y casos en
  `scope.int.test.ts`; la acción nueva en `REVIEWED`.
- Pendiente: aviso en Inicio, ronda automática, ubicaciones sobre su
  capacidad, mover tarimas, sugerir reglas de reposición.
