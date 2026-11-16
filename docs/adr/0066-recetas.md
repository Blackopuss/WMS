# ADR 0066 — Receta en la ficha del producto

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-27 (Fase 3, producción) ·
Usa ADR 0007 (módulos), ADR 0012 (movimientos y saldos), ADR 0017
(producto-proveedor), ADR 0031 (costo promedio), ADR 0062 (roles de
producción y calidad) · Flujo: `docs/flujos/PRODUCCION_CALIDAD.md` (sexta
versión), D4, P1, P13 y secciones 5.1, 7, 9 y 12

## Contexto

El fundador decidió (D4, P1, P13) que lo que se produce se describe **en la
ficha del producto**, con una receta estándar que define quien manda (no el
operario), versionada, y que **cada producto tiene una sola receta**: otra
forma de hacerlo es otro producto, y no hay sustitutos dentro de la receta.
El consumo será automático según la receta (P1); el costo de lo producido
es solo el de los materiales (D1, sección 7).

Este paso deja la receta y nada más: no hay órdenes, reportes, consumo,
costo de lo producido, área de producción ni proceso (WMS-28 y siguientes).
**No toca existencias**: no escribe movimientos, saldos ni reservas.

Con este paso el módulo **Producción pasa a disponible** (ADR 0062 lo dejó
anunciado hasta tener algo que usar): el personal de plataforma ya puede
activarlo. Precio, nombre comercial y textos del sitio y de los términos
siguen siendo del fundador; no se agregan aquí.

## Flujo operativo

1. **Quién y dónde.** El Encargado de producción, Administración o el
   titular (`production.recipe.manage`), en escritorio (también funciona en
   tableta con su propia sesión; **nunca en una terminal compartida con
   PIN**, donde la receta se lee y no se cambia), en la ficha del producto (`/inventario/[id]`), bloque
   **«Receta»**. El bloque existe solo con Producción contratada y para
   quien tiene `production.recipe.read`; con el módulo en solo lectura (plan
   vencido o módulo quitado) se ve y no se edita.
2. **Agregar receta.** «Agregar receta» pide **para cuánto** (la cantidad
   base, en la unidad del producto de la ficha: «1», «100», «500») y crea la
   receta con su **versión 1 en borrador**. Lo que sale empieza siendo el
   producto de la ficha, en la cantidad base, con el 100 % del costo.
3. **Armar el borrador** (pantalla `/inventario/[id]/receta`):
   - **Materiales**: producto (nombre, clave o código de barras, como en
     pedidos), cantidad para la base y merma esperada en % (opcional). La
     cantidad se captura en la unidad del producto y después se puede
     cambiar a una presentación («2 cajas») o a otra unidad de la misma
     medida («250 g»); el servidor la convierte con `resolveConversion`
     y guarda lo capturado, la presentación con su versión, el factor y la
     cantidad en la unidad del producto, como una línea de orden.
   - **Lo que sale**: productos con su cantidad para la base (en su unidad,
     `parseQuantity`) y su parte del costo en %. Sirve para coproductos y
     subproductos (con 0 % si no cargan costo) y para recetas que
     desarman: lo que sale puede no incluir el producto de la ficha.
   - **Para cuánto** se puede cambiar; si lo que sale del producto de la
     ficha era igual a la cantidad base anterior, cambia con ella.
4. **Activar.** «Activar esta versión» vuelve a comprobar todo bajo el
   candado de la receta (ver «Validaciones») y, si pasa, la hace la vigente (`ACTIVE`) y retira la anterior
   (`RETIRED`) en la misma transacción. Bitácora
   `production.recipe_activated`.
5. **Cambiar receta.** Una versión que dejó de ser borrador no se edita
   (disparador). «Cambiar receta» crea la siguiente versión en borrador,
   copiada de la vigente (o de la última que lo fue), y se activa igual. Si
   nunca hubo una vigente (todos los borradores se descartaron), empieza como
   una receta nueva: con el producto de la ficha saliendo con el 100 %. Si ya hay un
   borrador, lleva a él (uno por receta). «Descartar borrador» lo deja
   `DISCARDED`, con su bitácora. Nada se borra: ni recetas ni versiones.
6. **Lo que se ve.** La ficha muestra la versión vigente (para cuánto,
   materiales, lo que sale), si hay un borrador pendiente y «Ver
   versiones» (historial: número, estado, quién y cuándo la activó o
   retiró). También «Se usa en», las recetas vigentes que usan el producto
   como material (para saber qué afecta archivarlo).

Estados de una versión (tabla pura `RECIPE_VERSION_TRANSITIONS` de
`recipe-states.ts` y el disparador `recipe_version_transition`, que
cambian juntos):

```text
DRAFT ──▶ ACTIVE ──▶ RETIRED
  └─────▶ DISCARDED
```

## Decisiones

### Modelo

- `recipe`: una por producto (`@@unique([organizationId, productId])`),
  nunca se borra (disparador); el producto no cambia (disparador).
- `recipe_version`: número consecutivo por receta, estado, para cuánto
  (`baseQuantity`, `DECIMAL(12,3)`, en la unidad del producto de la ficha,
  con esa unidad guardada en `unitCode`), quién y cuándo la creó, activó,
  retiró o descartó (se escribe una vez y ya no cambia: disparador; lo que
  no es de su estado no se escribe). Toda versión **nace borrador**
  (disparador `BEFORE INSERT`): una vigente solo llega por la activación.
  **Una sola vigente y un solo borrador por receta**:
  columnas `activeRecipeId` y `draftRecipeId` que valen el id de la receta
  solo en ese estado (`CHECK`) con índice único, como `openOrderId` de los
  embarques. Receta, número y autor nunca cambian; para cuánto y unidad
  solo cambian en un borrador que sigue siéndolo (nunca en la misma
  sentencia que cambia el estado). En `recipe`, producto y autor no cambian.
- `recipe_input`: un material por línea, un producto una sola vez por
  versión, con `capturedQuantity`, `presentationId`,
  `presentationVersionId`, `capturedUnitCode` (si se escribió en otra
  unidad de la misma medida), `factor`, `baseQuantity` y `unitCode` (la
  unidad del material al capturarlo), y `scrapPercent` opcional (0 a menos
  de 100, dos decimales).
- `recipe_output`: un producto por línea, una sola vez por versión, con
  `quantity` en su unidad (`unitCode` guardada) y `costShare` (0 a 100, dos
  decimales).
- Las líneas solo se escriben o borran mientras su versión es borrador
  (disparadores); una versión usada (vigente o retirada) es inmutable en
  servicio y en base.
- **Cantidades exactas.** Todo con `Decimal` y `parseQuantity` de la regla
  de cada producto; la receta va por cantidad base justamente para que
  «0.25 kg por 100 piezas» se guarde exacto (0.0025 por pieza no cabe en
  tres decimales). Nunca se calcula por unidad aquí.
- **Merma esperada** es informativa: la cantidad del material ya es lo que
  se consume (P1: el consumo automático descuenta lo que dice la receta);
  el % dice cuánto de eso se espera perder y servirá para comparar con la
  merma reportada (WMS-29, WMS-33). No cambia ninguna cantidad.
- **Sin sustitutos ni varias recetas por producto** (P13): un material
  distinto es otra versión; otra forma de hacerlo es otro producto.

### Validaciones

En cada cambio del borrador (rechazos claros, nada escrito) y **otra vez al
activar**, releyendo la versión y sus líneas bajo el candado de la receta.
Los productos (estado, unidad, precisión) se leen sin bloquearlos: activar
no toma candados de producto, para no detener movimientos de existencias por
una receta. Un producto archivado o con otra unidad justo después de activar
queda como en «Cambios en los productos de una receta vigente», y WMS-28
vuelve a comprobarlo al crear y al liberar cada orden.

- Para cuánto, cantidades de materiales y de lo que sale: `parseQuantity`
  (o `resolveConversion`) con la regla vigente de cada producto.
- Materiales y lo que sale: productos **activos** de la empresa; al activar
  se exige además que la unidad guardada en cada línea siga siendo la del
  producto (si cambió, «vuelve a capturar su cantidad»).
- Un producto no está a la vez en materiales y en lo que sale de la misma
  versión; al menos un material y al menos una salida; el producto de la
  ficha está en materiales o en lo que sale.
- Partes del costo que suman exactamente 100 (decimal exacto).
- Hasta 100 materiales y 20 salidas por versión.
- **Sin ciclos** (ver abajo).

### Ciclos y candado

Un producto no puede usarse, directa o indirectamente, para hacerse a sí
mismo. El grafo es «material → lo que sale» de las versiones **vigentes**
de todas las recetas de la empresa (no «material → producto de la ficha»:
en una receta que desarma, lo que sale es otro producto). Activar la
versión V de la receta R agrega las aristas «cada material de V → cada
salida de V» y quita las de la versión vigente de R. Hay ciclo si, desde
alguna salida de V, siguiendo las versiones vigentes de las demás recetas,
se llega a algún material de V (o si un producto está en los dos lados).
La regla pura (`findRecipeCycle` de `recipe-rules.ts`) recibe las aristas
y devuelve la cadena para decirla en pantalla («X se hace con Y, que se
hace con X»); el servicio lee el grafo por niveles desde las salidas.

**Dos activaciones a la vez no pueden formar un ciclo:** todas las
activaciones de una empresa se ordenan con un candado propio,
`recipe_lock` (una fila por empresa, su id es el de la empresa; se crea
antes de la transacción si falta, en una escritura aparte que tolera la
carrera). Orden de candados al activar: `recipe_lock` → `recipe` (la
receta) → lectura de la versión y sus líneas. La fila de `recipe_lock` no
se borra (disparador) y activar exige haber bloqueado exactamente una; si
faltara, falla en vez de activar sin orden. Las ediciones del borrador
bloquean solo su `recipe`, así que nunca esperan a otra activación en
círculo. Con READ COMMITTED (`LOCKING_TRANSACTION`), la segunda activación
lee el grafo ya con la primera vigente y la rechaza si cerraría un ciclo.
No se usa el candado de la empresa (`lockOrganization`): las llaves
foráneas hacia `organization` de cualquier inserción lo esperarían, y una
edición de receta que bloqueó su `recipe` e inserta líneas podría
interbloquearse con una activación.

La comprobación también corre (sin candado, solo para avisar antes) al
agregar un material o una salida.

**Armar y desarmar el mismo producto (pendiente del fundador).** Hoy una
empresa no puede tener a la vez «Juego = A + B» (armar) y «Juego → A + B»
(desarmar): con la de armar vigente, la de desarmar cierra el ciclo
Juego → A → Juego y se rechaza; además no cabría en la ficha del juego,
que ya tiene su receta (una por producto, P13). Lo fija la prueba
«assembling and taking apart the same kit». Si el fundador lo quiere:

- **Permitir desarmar lo que se arma:** el ciclo tendría que medirse por
  costo y no por grafo (desarmar no «hace» el juego con sus partes), o
  marcar la receta como «desarmar» y excluirla del grafo de armado; y la
  receta de desarmar viviría en la ficha de una de las partes o en un
  producto aparte («Juego para desarmar»).
- **Dejarlo como está:** quien desarma usa otro producto (el juego que
  regresa) con su propia receta.

### Cambios en los productos de una receta vigente

Inventario no conoce Producción (ADR 0007), así que archivar un producto,
cambiar su unidad o su control por lote o serie **no se detiene** por una
receta. Lo que pasa:

- **Material o salida archivados:** la receta vigente sigue igual y el
  bloque lo marca («archivado»). Activar una versión que lo use se
  rechaza. WMS-28 rechazará crear órdenes con una receta vigente que use
  algo archivado. La ficha del material muestra «Se usa en» para que quien
  archiva lo sepa antes.
- **Cambio de unidad** (solo posible sin movimientos, INV-15): cada línea
  guarda su `unitCode`; si ya no coincide, el bloque lo marca, activar se
  rechaza y WMS-28 no la usará hasta una versión nueva.
- **Control por lote o serie:** la receta no lo usa; qué lote o serie se
  consume lo decide el consumo (WMS-29). Un producto que pasó a serie
  exige enteros: activar vuelve a pasar cada cantidad por `parseQuantity`.

### Quién ve qué

Permisos que ya existen (ADR 0062), sin nuevos:

- `production.recipe.read`: titular, Administración, Almacén, Consulta,
  Supervisor de almacén, Gerencia, Operario y Encargado de producción.
- `production.recipe.manage`: titular, Administración y Encargado de
  producción; **nunca en una terminal compartida con PIN**
  (`TERMINAL_DESK_ONLY` en `keptAtTerminal`): ahí la receta se lee y no se
  cambia, aunque el Encargado entre con PIN (`pin_roles =
  floor_supervision`).
- Almacenista, Montacarguista, Comprador e Inspector de calidad no la ven
  (el Inspector no tiene `production.recipe.read` en la matriz).
- **Nadie ve costos por aquí**: la parte del costo es un porcentaje, no un
  importe; el costo de lo producido es de WMS-29 y solo para
  `inventory.cost.read`.

### Alcance por almacén

Una receta es **de la empresa**, como el producto (el catálogo no tiene
almacén): no se filtra por alcance. El área de producción (ubicación de uso
«Producción» de un almacén) llega con WMS-28 como columna opcional de la
versión o de la receta (migración de expansión), y desde ahí las órdenes y
lo que consumen sí respetan el alcance.

### Cómo llega el bloque a la ficha

La ficha es una pantalla de `app/`, que puede importar módulos por su
`index.ts` (como hoy importa Compras para «Quién te lo vende»). El bloque
es un componente de `app/(app)/inventario/[id]/receta/` que la ficha pinta
con una sola línea; **Inventario (el módulo) no importa Producción**. El
bloque decide por sí mismo: sin `production.recipe.read` o sin el módulo no
pinta nada.

### Cómo la usará WMS-28

- La orden toma la versión **vigente** al crearse y guarda su id; copia
  materiales y salidas multiplicados por cantidad ÷ para cuánto (decimal
  exacto, `parseQuantity` de cada material al apartar). Una versión usada
  no cambia, así que la orden siempre sabe con qué se hizo.
- Antes de crear la orden comprueba: versión vigente, productos activos y
  unidades iguales a las guardadas.
- Área de producción y proceso (WMS-74) se agregan con columnas opcionales
  (`areaLocationId`, `processId`) en una migración de expansión; las
  versiones anteriores quedan sin ellas.
- Se exporta `activeRecipeOf(tx, productId)` para leer la vigente dentro de
  la transacción de la orden.

### Quitar el módulo

`moduleOpenWork` avisa de los borradores de receta sin activar
(«N recetas con cambios sin activar»). Nada se cancela ni se borra: queda
en solo lectura.

### Historial

«Ver versiones» se pagina en la base (20 por página, `?pagina=`, INV-10):
cada «Cambiar receta» agrega una versión y ninguna se borra.

### Fuera de este paso

Órdenes, consumo, reportes, costo de lo producido, área de producción,
proceso, menú de producción, importar o exportar recetas, campos
personalizados en recetas, API y webhooks, avisos.

## Consecuencias

- Tablas `recipe`, `recipe_version`, `recipe_input`, `recipe_output` y
  `recipe_lock`, en `TENANT_MODELS`; `recipe` y `recipeLock` en `LOCKABLE`.
- Servicios en `src/modules/production/recipes.ts`, reglas puras en
  `recipe-rules.ts` y `recipe-states.ts`.
- Bitácora: `production.recipe_created`, `production.recipe_activated`,
  `production.recipe_discarded`.
- `productionModule` pasa a `availability: "available"` (versión 1.0.0).
- Pendiente del fundador: precio por nivel en `PLAN_TIERS`, nombre y textos
  del sitio y de los términos para Producción.
