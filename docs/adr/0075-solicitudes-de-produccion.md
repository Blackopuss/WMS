# ADR 0075 — Solicitudes de producción

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-28B (Fase 3, producción) ·
Usa ADR 0038 (alcance), ADR 0055 (solicitudes de compra: solicitud →
documento con `repeated`), ADR 0057 (avisos), ADR 0061 (terminales con
PIN), ADR 0062 (roles de producción), ADR 0066 (recetas), ADR 0069 (motor
de procesos), ADR 0073 (órdenes de producción) · Flujo:
`docs/flujos/PRODUCCION_CALIDAD.md` (sexta versión), D11, P7, P7c, P7d, P8,
P8c, P8d y secciones 5.3, 6.4, 10 y 12

## Contexto

El fundador decidió que no se produce más de lo que pide una orden (D11),
pero que quien produce no se quede parado: si no tiene nada a su nombre,
puede pedir que se produzca algo de su área que esté por acabarse (P8, P8c,
P8d). Deciden el Encargado de producción del área y Administración (P7
posterior) y también Almacén y el Supervisor de almacén (P7c); al aceptar
nace la orden a nombre de quien aceptó, y la orden guarda quién aprobó la
solicitud y quién la ejecutó (P7d).

En este ADR, **«Decidido»** es lo que dijo el fundador; **«Propuesta de la
5.3, fijada aquí»** es lo que la propuesta dejaba como propuesta y este paso
fija (el fundador puede cambiarlo); **«Decisión de este paso»** es lo que la
propuesta no decía.

## Flujo operativo

1. **Quién pide** (`production.request.create`: titular, Administración,
   Operario y Encargado de producción). Desde «Mis tareas» (`/tareas`) en el
   teléfono o en una terminal con PIN. El bloque **«Queda poco»** aparece
   solo si la persona puede pedir **y** hay algo que pedir; si no, no
   aparece nada nuevo.
2. **Las tres condiciones** (se comprueban al pintar la pantalla y otra vez
   en el servidor, dentro de la transacción que guarda la solicitud):
   1. **Nada a su nombre** (decidido, P8c y P8d): ni órdenes de producción
      `RELEASED` o `IN_PROGRESS` donde está asignada, ni pendientes de
      proceso que tomó o le asignaron (`process_stage_state` en `READY`,
      etapa manual, de un progreso activo, con `takenByUserId` = la
      persona), ni tareas de almacén asignadas a ella que sigan abiertas
      (`ASSIGNED`, `ACCEPTED`, `PICKED_UP` o `BLOCKED`). **Lo disponible que
      nadie ha tomado no cuenta.** Decisión de este paso: se cuenta en todos
      los almacenes y documentos (no solo en el almacén activo ni solo lo que
      hoy puede leer): «a su nombre» es a su nombre en la empresa; una tarea
      reportada con problema (`BLOCKED`) sigue siendo suya hasta que
      supervisión la libere o la cancele.
   2. **De su área** (propuesta de la 5.3, fijada aquí): productos activos
      con receta vigente cuya área (`recipe.areaLocationId`) es de uso
      «Producción», sin archivar, del almacén activo de la persona y dentro
      de su alcance; si la receta no tiene área, el producto se ofrece
      cuando hay al menos un área de producción del almacén activo dentro de
      su alcance. Una receta con área en **otro** almacén no se ofrece aquí.
   3. **Cerca de existencias bajas** (propuesta de la 5.3, fijada aquí): el
      producto tiene mínimo y su disponible está en o por debajo de
      **mínimo × (1 + margen)**, con el ajuste
      `production.request.low_margin` (`0`, `10`, **`25`** o `50` %). El
      disponible es **el mismo total que usa el mínimo** (`listLowStock`,
      INV-30): todo lo `AVAILABLE` de la empresa menos lo apartado
      (`PRODUCT_HOLDS`). La cuenta la hace el servidor (`productsNearMinimum`
      de Inventario, nueva, sin permiso propio: la llama quien ya comprobó
      el suyo) y **no se devuelve ninguna cantidad**.
3. **El Operario no ve cifras.** `listRequestableProducts` devuelve solo id
   y nombre de cada producto (y el área cuando hay que elegirla), o por qué
   no puede pedir. Nunca cantidades, ubicaciones ni almacenes. Así no rompe
   la regla de WMS-20 (cifras de toda la empresa solo para quien no tiene
   límite).
4. **«Pedir producción»**: producto, cantidad (en la unidad del producto,
   `parseQuantity`) y motivo opcional. Si la receta no dice el área y hay
   más de una de su alcance, la persona elige cuál; con una sola, se toma
   esa. Número `SP-0001`. **No aparta nada.** Queda **«Por atender»**.
   Decisión de este paso: una persona no tiene dos solicitudes por atender
   del mismo producto («Ya pediste … espera la respuesta»); se comprueba
   bajo el candado de su membresía, así dos envíos a la vez no pasan los
   dos.
5. **Quién decide** (decidido, P7 posterior y P7c):
   `production.request.decide` (titular, Administración, Almacén, Supervisor
   de almacén y Encargado de producción) **y** alcanzar el área de la
   solicitud. Para quien no la alcanza, la solicitud «no existe» (como un
   documento de otra zona). El primero que decide la cierra.
6. **Pantalla de decisión** (`/produccion/solicitudes/[id]`, propuesta de
   la 5.3, fijada aquí), **dentro del alcance de quien decide y en el
   almacén de la solicitud**, sin costos:
   - del **producto pedido**: disponible (lo `AVAILABLE` menos lo apartado),
     apartado, mínimo, lo que ya está en órdenes de producción abiertas de
     ese producto (cantidad de las órdenes `DRAFT`, `RELEASED` e
     `IN_PROGRESS` de áreas que alcanza; WMS-29 restará lo ya producido) y
     lo que espera en inspección (`INSPECTION`);
   - de **cada material** de la receta vigente para la cantidad pedida: lo
     que hace falta (las mismas reglas de la orden: una sola división y
     hacia arriba al paso), lo libre para tomar (lo que `pickSources`
     ofrecería, nunca preparación ni lo apartado) y si alcanza; arriba,
     «Con el material libre alcanza para 16 de 20»;
   - otras solicitudes por atender del mismo producto que alcanza.
   Lo que está en zonas que no alcanza no se cuenta ni se nombra; si su
   alcance está limitado dice «Solo cuenta lo de tus zonas». El mínimo es de
   toda la empresa (INV-30): se muestra (es un dato del catálogo, no una
   existencia), pero el disponible al lado es solo el de su alcance, y así
   lo dice la pantalla.
7. **Aceptar** (puede cambiar cantidad, día compromiso y a quién se
   asigna; por omisión quien pidió): en la **misma transacción** nace la
   orden de producción **a nombre de quien aceptó** (`createdByUserId`), con
   la solicitud de la que nació (`production_order.requestId`), y **queda
   liberada** (aparta materiales con el mismo núcleo de «Liberar orden»).
   - Si un material no alcanza manda `production.release.short`: con `ask`
     la pantalla dice qué falta y deja **«Aceptar y apartar lo que hay»** o
     **«Aceptar como borrador»**; con `block` nace **en borrador** y la
     respuesta lo dice.
   - Si la orden no se puede liberar por otra razón (nada libre de ningún
     material, una etapa del proceso de la empresa antes de liberar, el
     área no admite un material), no se acepta y la pantalla lo dice;
     «Aceptar como borrador» sigue disponible.
   - Aceptar dos veces responde `repeated`; aceptar una solicitud ya
     rechazada o cancelada lo dice.
8. **Rechazar** exige motivo. **Cancelar** es de quien pidió, mientras esté
   por atender (`repeated` si ya estaba cancelada).

## Estados

```text
SUBMITTED ──▶ ACCEPTED
    │
    ├──────▶ REJECTED
    │
    └──────▶ CANCELLED
```

Tabla pura `PRODUCTION_REQUEST_TRANSITIONS` (`request-states.ts`) y
disparador `production_request_transition`, que cambian juntos (una prueba
compara la tabla con la base). Una solicitud nace `SUBMITTED` (disparador),
nunca se borra, y número, almacén, área, producto, cantidad pedida, unidad,
motivo, quién y cuándo pidió nunca cambian.

## Modelo

- `production_request`: número por empresa, almacén (`facilityId`), área
  (`areaLocationId`, de uso «Producción» de ese almacén, disparador),
  producto, cantidad y su unidad, motivo opcional, estado, quién pidió,
  quién decidió y cuándo, motivo del rechazo, quién canceló y cuándo
  (`CHECK`: decidida con quién y cuándo; rechazada con motivo; cancelada con
  quién y cuándo, y nada de eso en otro estado).
- `production_order.requestId` (opcional, único por empresa, llave
  compuesta a la solicitud): la solicitud de la que nació la orden. **Una
  solicitud da como mucho una orden** (índice único) y la base exige que la
  solicitud esté aceptada y sea del mismo producto y almacén (disparador al
  insertar); la columna nunca cambia (disparador aparte, sin tocar el de
  transiciones de WMS-28). **Quién aprobó** es quien decidió la solicitud
  (`production_request.decidedByUserId`), que además es el autor de la
  orden; **quién ejecutó** saldrá de los reportes (WMS-29).

## Aprobar no da permisos sobre órdenes (propuesta de la 5.3, fijada aquí)

- Almacén y el Supervisor de almacén **no** reciben
  `production.order.create`, `.release` ni `.cancel`: su permiso es
  `production.request.decide`, y el efecto de aceptar es crear y liberar
  **esa** orden, con el producto, el almacén y el área de la solicitud.
- Las funciones públicas de órdenes no cambian de permiso. El núcleo que
  usan por dentro (`createOrderUnderLock`, `releaseUnderLock` y su plan, en
  `orders.ts`) **no se exporta** desde `index.ts`; solo lo llaman
  `createProductionOrder`, `releaseProductionOrder` y la aceptación de una
  solicitud, que comprueba `production.request.decide`, el alcance del área
  y que la solicitud siga por atender bajo su candado.
- Después, la orden es una orden más: liberarla (si nació en borrador),
  cancelarla, cambiar sus personas o cerrarla sigue siendo del Encargado de
  producción y de Administración. Por eso, cuando quien acepta no puede
  cancelar órdenes, se avisa al Encargado y a Administración que alcanzan
  el área que nació una orden aprobada por Almacén.
- Para el Encargado y Administración, aceptar no exige además sus permisos
  de órdenes: decidir la solicitud es lo que los habilita (es el mismo
  efecto para todos los que deciden).

## Candados

Orden global de ADR 0073: productos → ubicaciones → documento → contenedor
→ tareas → capacidad → progreso. **Una operación que bloquea productos
nunca toma el almacén antes que ellos.**

- **Pedir:** membresía de quien pide (`lockRows(tx, "membership", …)`, como
  las fotos pendientes) → lecturas → solicitud nueva → aviso. No bloquea
  productos ni el almacén: no aparta nada.
- **Aceptar:** lee la solicitud y la receta vigente sin candado; bloquea
  los productos de los materiales (ordenados) → **la solicitud**, con una
  actualización condicionada (`UPDATE … WHERE status = 'SUBMITTED'`, la
  misma técnica de «actualización usada como candado» de INV-19B; así no
  se agrega la tabla a `lockRows`, que otro paso está cambiando) → el
  almacén **compartido por el índice único** (el mismo de crear una orden,
  después de los productos) → la orden nueva → el núcleo de liberar
  (productos ya tomados → orden → capacidad → progreso). Si la receta
  cambió entre la lectura y los candados (otros materiales), responde que
  se intente de nuevo sin escribir nada.
- **Dos decisiones a la vez:** la segunda espera en la actualización
  condicionada; al seguir (READ COMMITTED) la solicitud ya no está por
  atender y responde `repeated` (la misma persona) o «Ya la decidió …»;
  nunca nacen dos órdenes (además, el índice único de `requestId`).
- **Rechazar y cancelar:** solo la actualización condicionada de la
  solicitud; no bloquean productos.

## Alcance

- Una solicitud existe para quien alcanza su área (como una orden). Las
  listas filtran por el almacén activo y `locationScopeWhere`.
- Al pedir, el área sale del alcance de quien pide (condición 2); al
  decidir, del de quien decide.
- Aceptar libera la orden **apartando solo de lo que alcanza quien acepta**
  (la regla de ADR 0073). La pantalla de decisión calcula con lo mismo.

## Avisos (ADR 0057)

- `production.request_to_decide` al pedir: por permiso
  `production.request.decide` y el lugar (área), a los roles Encargado de
  producción, Almacén y Supervisor de almacén (`ownerByRole: false`); si no
  le llegó a nadie (nadie de ellos activo que la alcance, o todos lo
  apagaron), a Administración y al titular. **El texto no lleva cifras de
  existencias**: el motor manda un mismo texto a todos y no puede
  calcularlas dentro del alcance de cada destinatario; las cifras están en
  la pantalla de decisión, que sí las calcula por persona. Dice quién, qué
  y cuánto pidió: «Ana Ruiz pidió producir 20 piezas de Tabla 60×40
  (SP-0003).»
- `production.request_answered` a quien pidió, al aceptar o rechazar (con el
  motivo del rechazo).
- `production.order_from_request` al nacer la orden: a Almacén y al
  Supervisor de almacén que alcanzan el área (para que preparen materiales)
  y, cuando quien aceptó no puede cancelar órdenes, al Encargado de
  producción y a Administración que la alcanzan. Nunca a quien aceptó.

## Terminales con PIN

`production.request.create`, `.read` y `.decide` se conservan en una
terminal con PIN (el Operario pide desde el piso; el Encargado puede decidir
desde la tableta, como hoy libera órdenes, ADR 0073 pregunta 3). Decidir no
es una aprobación del motor (`mayDecide` no aplica).

## Ajustes (Operación › Producción)

- `production.request.low_margin`: `0`, `10`, `25` (por omisión) o `50` %.
  Se lee con `readSetting` dentro de la transacción que guarda la solicitud
  (y al pintar).

## Pantallas

- `/tareas` («Mis tareas»): bloque **«Queda poco»** con los nombres y
  «Pedir producción» por producto.
- `/produccion/solicitudes` (enlace bajo el título de Producción): lista
  paginada en la base, por atender primero; filtro por estado y «Mías».
- `/produccion/solicitudes/nueva?producto=…`: formulario de pedir.
- `/produccion/solicitudes/[id]`: la solicitud, la pantalla de decisión
  (solo para quien decide), «Aceptar», «Rechazar» y «Cancelar solicitud».
- La orden muestra «Nació de la solicitud SP-0001, aprobada por …» y su
  bitácora (`production.order_created`) lleva la solicitud y quién la
  aprobó.

## Quitar el módulo

`productionOpenWork` agrega «N solicitudes de producción por atender».
Nada se cancela.

## Bitácora

`production.request_created`, `production.request_accepted`,
`production.request_rejected`, `production.request_cancelled`.

## Decisiones que el fundador puede cambiar

1. «Nada a su nombre» cuenta en toda la empresa y cuenta las tareas
   reportadas con problema (`BLOCKED`).
2. Una persona no tiene dos solicitudes por atender del mismo producto.
3. El aviso a quien decide no lleva cifras de existencias (el motor no
   permite un texto por destinatario).
4. Si nadie de los roles que deciden recibe el aviso, va a Administración y
   al titular.
5. Una orden que nace de una solicitud usa el área de la solicitud; para
   otra área se rechaza y se crea la orden a mano.
6. Aceptar habilita a cualquiera que decide (también al Encargado) sin
   pedir además sus permisos de órdenes.
7. Si la orden no se puede liberar por algo distinto de un faltante, no se
   acepta y se ofrece «Aceptar como borrador».
8. Decidir se puede desde una terminal con PIN.

## Fuera de este paso

Quién ejecutó (WMS-29), rastreo de órdenes de producción (no existe aún en
«Rastrear»: entra con el lote producido de WMS-29), etapas de proceso de la
solicitud, solicitudes por API, campos personalizados.

## Consecuencias

- Tabla `production_request` en `TENANT_MODELS`; columna
  `production_order.requestId`.
- Servicios en `src/modules/production/requests.ts`; reglas puras en
  `request-states.ts` y `request-rules.ts`.
- `orders.ts` separa su núcleo de crear y liberar (sin cambiar lo que hacen
  las funciones públicas).
- Inventario agrega `productsNearMinimum` (`minimums.ts`), que comparte el
  total con `listLowStock`.
