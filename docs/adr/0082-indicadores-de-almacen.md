# ADR 0082 — Indicadores de almacén

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-32 · Completa WMS-73
(resumen del día), WMS-55 (exactitud, ADR 0050), ADR 0031 (costos), ADR 0038
(alcance) y WMS-50 (Gerencia) · Prepara WMS-34 (tableros por rol y
exportación) y WMS-65 (slotting)

## Contexto

El plan v3 (Fase 4) pide indicadores de almacén: rotación, productos de mayor
movimiento, sin movimiento, exactitud de inventario, pedidos completos y a
tiempo, tiempos de recepción y de surtido, rendimiento por trabajador y por
zona, con filtros por periodo, almacén, producto y persona. Las instrucciones
del fundador (sección L) piden lo mismo con «comparaciones mensuales» y
«dashboards gerenciales» (estos últimos son WMS-34).

Pruebas de la fase: cada indicador contra un escenario con resultado
conocido, costos solo para quien puede verlos y carga con p95 < 500 ms.

Es **solo lectura**: no escribe existencias, documentos ni tablas de resumen.

## Flujo operativo

1. **Quién:** quien dirige o supervisa el almacén (titular, Administración,
   Supervisor de almacén y Gerencia; los mismos que ya ven el resumen del día
   y la exactitud). Desde el escritorio; la pantalla se lee también en el
   teléfono (tablas con desplazamiento propio), pero no está pensada para el
   piso.
2. **Dónde:** Inventario › «Indicadores» (`/inventario/indicadores`), un
   enlace en la fila bajo el título de Inventario y otro en el bloque «Lo que
   se hizo hoy» de Inicio. **No es una sección nueva del menú**: no es de uso
   diario para el piso (regla KISS), y quien la usa ya entra a Inventario o
   Inicio.
3. **Qué ve:** arriba, el periodo (chips «7 días», «30 días» —por omisión—,
   «90 días», «Este mes», «Mes anterior») y el almacén si alcanza más de uno.
   Fechas a mano («Del … al …») van plegadas en «Más filtros». Después, en
   este orden:
   - **Pedidos:** completos, a tiempo y completos y a tiempo, con sus
     porcentajes; mediana del tiempo de surtido.
   - **Recepción:** mediana del tiempo de recepción a acomodo.
   - **Exactitud:** de los conteos aplicados en el periodo (enlace a Conteos
     › Exactitud para el detalle semanal o mensual).
   - **Productos de mayor movimiento** con su rotación y días de inventario.
   - **Productos sin movimiento** (con existencias y sin movimiento en los
     últimos N días).
   - **Rendimiento por persona** (solo con su permiso) y **por zona**.
4. **Filtros de producto y persona:** se aplican tocando el nombre de un
   producto o de una persona en sus tablas (queda un chip «Producto: …» o
   «Persona: …» con «Quitar»). No hay selector de cientos de productos ni de
   personas. Todo el estado vive en la dirección (`?periodo=`, `?desde=`,
   `?hasta=`, `?almacen=`, `?producto=`, `?persona=`) y los formularios son
   `Form` GET, sin Server Actions.

## Alcance y permisos

- **Permisos nuevos** (los dos terminan en `.read`: siguen con el plan
  vencido; módulo Inventario):
  - `inventory.kpi.read` — indicadores del almacén: T, A, SU, GE.
  - `inventory.worker_performance.read` — rendimiento por persona y filtro
    por persona: T, A, SU, GE. Es dato sensible: nadie del piso (Almacenista,
    Montacarguista), ni Consulta, ni Comprador, ni Almacén, ni los roles de
    producción y calidad lo reciben. **No se conserva en una sesión de PIN**
    (`TERMINAL_DESK_ONLY`): una terminal es un dispositivo compartido del
    piso. *El fundador puede cambiar* que Almacén (`warehouse`) también vea
    indicadores; hoy sigue al resumen del día, que tampoco ve.
- Sin `inventory.worker_performance.read` la respuesta **no trae** el bloque
  de personas (`people` no existe) y `?persona=` se ignora. Rendimiento por
  zona sí se ve: no nombra personas.
- **Costos:** con `inventory.cost.read` (`mayReadInventoryCosts`, ADR 0031) la
  respuesta agrega el valor de lo que salió (por producto y total) y el valor
  de lo que no se mueve; para los demás esos campos no existen.
- **Almacén:** por omisión, el almacén activo de la persona; `?almacen=` solo
  acepta un almacén activo de la empresa que la persona alcanza
  (`isFacilityInScope`); lo demás se ignora. No hay «todos los almacenes»:
  una cifra de toda la empresa queda para WMS-34 (*el fundador puede
  cambiar*; sería solo para quien `seesWholeCompany`).
- **Zonas (ADR 0038):** todo lo que se deriva de ubicaciones (saldos, líneas
  de movimiento, tareas, conteos) se filtra además con `locationScopeWhere`.
  Pedidos y embarques son documentos de todo el almacén: se cuentan para
  quien alcanza el almacén, igual que en el resumen del día (WMS-73).
- Soporte de plataforma solo lee (sus permisos `.read` lo permiten); la API no
  ofrece indicadores (WMS-34 decidirá).
- Roles ligados a un módulo (producción y calidad): no reciben estos
  permisos.

## Periodo

- Un periodo es una serie de días del **calendario de la empresa**
  (`dayWindow`), del primer día a las 00:00 al día siguiente del último a las
  00:00, en su zona horaria; nunca días de UTC.
- Presets relativos a hoy: «7 días» y «30 días» y «90 días» terminan hoy
  (incluido); «Este mes» va del día 1 a hoy; «Mes anterior», el mes completo.
- Fechas a mano: `desde` y `hasta` (`AAAA-MM-DD`); si falta una, o no es un
  día, o `hasta` es antes que `desde`, o pasa de hoy, se usa el preset por
  omisión; **máximo 92 días** (`KPI_MAX_DAYS`): un periodo más largo se recorta
  a los 92 días que terminan en `hasta` y la pantalla lo dice.

## Definición de cada indicador

En todo lo que sigue, «en el lugar» quiere decir: ubicación del almacén
elegido y, si la persona está limitada a zonas, dentro de ellas. Cantidades
en la unidad del producto (`baseQuantity`), sumadas en la base con
`groupBy`/`_sum` y tratadas con `Decimal`; nunca `Number()` sobre existencias.
Las duraciones sí son números (milisegundos).

### Salidas (base de rotación y mayor movimiento)

Una **salida** es una línea `OUT` de un movimiento `EXIT` (salida manual,
salida rápida, salidas importadas) o `SHIPMENT` (despacho), en el lugar y en
el periodo, **cuyo movimiento no fue reversado** (`reversedBy` vacío). Es la
misma definición de «salida» que la clasificación ABC (`abcClassesOf`) más la
exclusión de lo reversado. No cuentan traslados, cambios de estado, ajustes,
devoluciones al proveedor, desechos ni traslados entre almacenes: no son
demanda.

### Productos de mayor movimiento

Los 20 productos (`KPI_TOP_PRODUCTS`) con más **líneas de salida** en el
periodo; empate por id. Por cada uno: líneas, cantidad que salió y, con
costos, su valor (`Σ baseQuantity × unitCost` de esas líneas, agrupado en la
base por producto y costo). Además, total de líneas de salida del periodo.
Con `?producto=`, solo ese producto (aunque no tenga salidas).

### Rotación y días de inventario (por producto)

- Existencia final del periodo = saldo de hoy en el lugar (todos los estados:
  «hay», ADR 0033) − neto de las líneas en el lugar posteriores al periodo.
- Existencia inicial = existencia final − neto de las líneas en el lugar
  dentro del periodo. (Neto = Σ entradas − Σ salidas de **todas** las líneas
  de movimiento, de cualquier tipo.) Es exacto porque un saldo solo cambia
  junto con una línea (ADR 0012).
- Existencia promedio = (inicial + final) ÷ 2. **Es una aproximación** (no se
  guarda el saldo de cada día; integrar el saldo día por día costaría una
  consulta por movimiento): se dice en el ADR y en la ayuda de la columna.
- **Rotación = salidas del periodo ÷ existencia promedio** («veces»). Sin
  existencia promedio (cero) la rotación no existe (`null`, «—»).
- **Días de inventario = días del periodo ÷ rotación** (sin rotación, «—»).
- Se calcula solo para los productos que se muestran (los 20 de mayor
  movimiento o el filtrado), no para todo el catálogo.
- **Fuera:** rotación global en valor (costo de lo vendido ÷ inventario
  promedio a costo). `product_cost` es de toda la empresa y vigente, no por
  almacén ni por día; el número resultante sería engañoso. Se muestra solo el
  valor de lo que salió.

### Productos sin movimiento

Productos con existencias hoy en el lugar (Σ saldo > 0, todos los estados)
**sin ninguna línea de movimiento en el lugar en los últimos N días**
(cualquier tipo), N = ajuste `inventory.kpi.idle_days` (30, 60, 90 por
omisión, 180). No depende del periodo elegido (se dice en pantalla). Cuántos
son (dos `groupBy` por producto en la base: con existencias en el lugar y con
movimiento reciente en el lugar, y la resta; medido con 10,000 productos
cuesta la mitad que un `count` con `some`/`none`) y los primeros 20 por
nombre y id,
con su existencia, la fecha de su último movimiento en el lugar y, con
costos, el valor a costo promedio vigente. Con `?producto=`, solo ese.

### Exactitud de inventario

La misma regla de WMS-55 (`getCountAccuracy`): de las líneas de los conteos
aplicados en el periodo (por `closedAt`) en el lugar, cuántas coincidieron
con lo que tenía el sistema al contarse; con costos, el valor de las
diferencias. Se reutiliza el cálculo extrayendo de `count-accuracy.ts` la
función `accuracyFigures` (mismo tope de 20,000 filas y `truncated`); la
pantalla de Exactitud no cambia. Pide además `inventory.count_accuracy.read`
(hoy los mismos roles); sin él el bloque no existe. No se filtra por producto
ni por persona.

### Pedidos completos y a tiempo

- Universo: pedidos del almacén **despachados en el periodo** (el embarque en
  que salieron tiene `shippedAt` en el periodo; misma condición que
  `shippedOnWhere`). Los cancelados no cuentan.
- **Completo:** cada línea salió completa: Σ `shipment_line.quantity` de la
  línea = cantidad pedida (nunca sale más). Cubre a la vez lo que faltó al
  liberar («apartar lo que hay»), al surtir («menos de lo pedido» con motivo)
  y al empacar (`outbound_pack_shortage`), porque todo eso termina en salir
  menos.
- **A tiempo:** el día del calendario de la empresa en que salió el embarque
  ≤ «día de salida» del pedido (`dueOn`). Un pedido sin día de salida no
  cuenta para «a tiempo» ni para «completo y a tiempo» (se dice cuántos hay).
- **Completo y a tiempo** = las dos cosas; su porcentaje es sobre los pedidos
  con día de salida.
- Tope: 2,000 pedidos por periodo (`KPI_ORDERS_MAX`, por id); con más,
  `truncated` y la pantalla avisa que los porcentajes son de los primeros. El
  total de pedidos despachados es siempre exacto (`count`).
- No se filtra por producto ni por persona.

### Tiempo de surtido

Por pedido surtido en el periodo (salió de surtido y su última tarea de
surtido se cerró en el periodo; misma condición que `pickedOnWhere` con el
periodo como ventana): desde que se liberó (`releasedAt`) hasta que se cerró
su última tarea `PICK` (entregada o cancelada). Se muestran **mediana** y
**percentil 90**, y cuántos pedidos. Mismo tope de 2,000 pedidos.

### Tiempo de recepción (recepción → acomodo)

Por tarea de acomodo (`PUTAWAY`) entregada en el periodo cuyo origen está en
el lugar: de su creación (nace en la misma transacción que la recepción o la
entrada, ADR 0042) a su entrega. Mediana, percentil 90 y cuántas. Solo existe
con el acomodo por tareas (`inventory.putaway.mode = tasks`); sin tareas el
bloque dice que no hay datos y por qué.
**Fuera:** la descarga (llegada del camión a recepción) no se guarda; el
tiempo de entrega del proveedor ya está en la comparación de proveedores de
Compras (WMS-57) y no se repite.

### Rendimiento por persona

Solo con `inventory.worker_performance.read`. En el periodo y en el lugar:

- Tareas entregadas por la persona que la tenía (`assignedToUserId`), por
  tipo (traslado, surtido, acomodo, reposición, a producción): `groupBy` en
  la base, exacto.
- Mediana de lo que tardó cada tarea, desde que la aceptó (`acceptedAt`)
  hasta que la entregó; de las filas leídas (tope `KPI_TASK_ROWS_MAX` =
  10,000 por periodo, por id, con `truncated`). Una tarea sin `acceptedAt` no
  entra en la mediana.
- Movimientos que registró (`createdByUserId`, cualquier tipo, con alguna
  línea en el lugar): `groupBy`, exacto.
- Nombres solo de miembros de la empresa (como el resumen del día); quien ya
  no está aparece como «Ya no está en el equipo».
- Con `?persona=`, rendimiento, zonas y tiempo de recepción se limitan a esa
  persona (tareas que tenía y movimientos que registró).

No se compara a una persona con otra en una «calificación»: son conteos y
tiempos. *El fundador puede cambiar* si quiere un índice.

### Rendimiento por zona

Zona = la ubicación raíz del almacén que contiene el lugar (WMS-20; misma
función `zonesOf` que las olas, que pasa a un archivo compartido). Por zona,
en el periodo: tareas entregadas (zona de su origen, salvo el acomodo, que
cuenta en la zona donde quedó: `placedLocationId`), mediana de lo que tardó
cada tarea (de las mismas filas leídas) y líneas de movimiento en ubicaciones
de la zona (`groupBy` por ubicación en la base, sumado por zona). Lo que está
directamente en el almacén sin zona («General», «Preparación», tránsito)
cuenta como su propia zona con su nombre.

## Filtro de producto

Aplica a mayor movimiento y rotación (una fila), sin movimiento (una fila),
tiempo de recepción y tareas de las personas y las zonas (`productId` de la
tarea) y a las líneas de movimiento por zona. No aplica a exactitud ni a
pedidos (se dice en pantalla). Solo un producto de la empresa; lo demás se
ignora.

## Topes, orden y rendimiento

- Periodo máximo 92 días; 20 productos por tabla; 2,000 pedidos; 10,000 filas
  de tareas para tiempos; 20,000 filas de conteo (las de WMS-55); 5,000 grupos
  de costo para el valor total de lo que salió. Todo lo leído va en orden fijo
  terminado en `id`, y cada bloque devuelve `truncated` cuando se topó.
- Todas las consultas van en paralelo después de resolver almacén, alcance y
  periodo.
- Índice nuevo `warehouse_task (organizationId, deliveredAt)` (migración de
  expansión): las tareas entregadas en un periodo hoy solo tenían índices por
  estado y número. Lo demás usa índices existentes (`stock_movement_line` por
  ubicación y fecha y por producto y fecha; `shipment` por estado y
  `shippedAt`; `stock_count`).
- **Sin tablas de resumen**: se mide con `npm run load:test` (la pantalla entra
  a `screens()`; la persona de la carga es ahora Almacén y Supervisión, para
  que los indicadores se lean de verdad). Medición en este contenedor (4
  núcleos, 16 GB, app compilada, 10,000 productos): el servicio solo tarda unos
  170 ms; con una persona, p95 de 362 ms; con 20 personas a la vez, 615 ms,
  cuando Inicio e Inventario también pasaban de 500 ms en la misma corrida
  (la máquina estaba saturada). *Pendiente de volver a medir en el equipo de
  referencia; si no llegara a la meta, la primera opción es cargar el bloque
  de personas y zonas aparte.*

## Lo que varía por empresa

- `inventory.kpi.idle_days`: 30, 60, **90** (omisión) o 180 días sin
  movimiento.
- Ningún otro: «a tiempo» es el día de salida del pedido (sin tolerancia).
  *El fundador puede cambiar* si quiere una tolerancia de días por empresa.

## Lo que no entra

- Exportación y tableros por rol (WMS-34), indicadores de producción y
  calidad (WMS-33), slotting (WMS-65).
- Comparación contra el periodo anterior (salvo la de Exactitud, que ya
  existe en su pantalla): WMS-34.
- Cifras de toda la empresa (varios almacenes a la vez).
- Rotación global en valor, tiempo de descarga, productividad «por hora
  trabajada» (no se guardan turnos ni horarios).

## Consecuencias

- Servicio nuevo `getWarehouseIndicators` en
  `src/modules/inventory/indicators.ts` (con reglas puras de periodo y
  medianas en `indicator-rules.ts`), permisos nuevos en matriz y catálogo,
  ajuste nuevo, índice nuevo y una pantalla.
- `count-accuracy.ts` expone `accuracyFigures` (sin cambiar su resultado) y
  `zonesOf` pasa de `waves.ts` a `zones.ts`.
- Un indicador nuevo se define aquí (qué cuenta, desde dónde hasta dónde, en
  qué lugar) antes de programarse, con su escenario de prueba en
  `tests/inventory/indicators.int.test.ts`.
