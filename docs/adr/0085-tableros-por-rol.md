# ADR 0085 — Tableros por rol y exportación de indicadores

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-34 · Completa WMS-32
(indicadores, ADR 0082), WMS-73 (resumen del día), WMS-08 (Inicio por rol),
IMP-11 (exportaciones), ADR 0038 (alcance) y WMS-50 (Gerencia)

## Contexto

El plan v3 (Fase 4) pide «Tableros por rol (gerencia, supervisión) y
exportación», después de los indicadores de almacén (WMS-32). La
especificación (sección de dispositivos por rol) pide:

- Encargado de almacén o supervisor, en tablet y escritorio: «tablero de
  operación, asignación de tareas, excepciones, autorizaciones, conteos y
  seguimiento del personal».
- Gerencia, en escritorio (lectura rápida en móvil): «KPIs, comparativos,
  costos y reportes ejecutivos».
- Para todos los que pueden: «exportar reportes permitidos».

Lo que ya existe y **no se duplica** (instrucciones, regla 2):

- Inicio › «Para hoy» (WMS-08 y siguientes): por permiso, aprobaciones,
  mis tareas y disponibles, incidencias abiertas, equipos que piden
  atención, tareas con problema, pedidos por empacar y por despachar,
  traslados y devoluciones por revisar, conteos de hoy, solicitudes de
  compra y órdenes por recibir; cada número abre su lista con la misma
  condición. Avisos de sin acomodar, por inspeccionar y por caducar.
- Inicio › «Lo que se hizo hoy» (WMS-73): entradas, salidas, recepciones,
  tareas terminadas, pedidos surtidos y despachados, y quién hizo qué hoy.
- Inventario › «Indicadores» (WMS-32): los indicadores de un periodo en un
  almacén.

Ya es, entonces, casi todo el «tablero de operación» del supervisor. Falta:
seguimiento del personal en lo que **tiene abierto** (no solo lo que ya
terminó), la comparación con el periodo anterior, la comparación entre
almacenes y la exportación.

## Decisión: qué es «tablero» aquí

**No hay una pantalla ni una sección nueva del menú.** Cada rol ya tiene la
pantalla que usa a diario; el tablero de cada uno es esa pantalla con lo que
le faltaba:

1. **Supervisión: el Inicio.** Es lo primero que ve al entrar, en tablet o
   escritorio, y ya trae «Para hoy» y «Lo que se hizo hoy». Se agrega,
   dentro del bloque «Lo que se hizo hoy», la tarjeta **«Trabajo abierto por
   persona»**: por cada persona con tareas asignadas sin terminar en el
   almacén activo (y dentro del alcance), cuántas tiene y cuántas de ellas
   tienen un problema. Cada fila abre Tareas › Abiertas filtrada por esa
   persona (`/tareas?vista=open&persona=<id>`), con **la misma condición**
   (`assignedOpenWhere` de `tasks.ts`, compartida por el conteo y la lista).
2. **Gerencia (y quien dirige): Inventario › «Indicadores».** Se agregan:
   - **«Comparado con el periodo anterior»**, arriba: las cifras principales
     del periodo con las del periodo anterior junto a cada una y el cambio
     en texto.
   - **«Por almacén»**, una vista de la misma pantalla (`?vista=almacenes`),
     solo para quien alcanza más de un almacén: las cifras principales de
     cada almacén que alcanza, en una tabla; cada fila abre los indicadores
     de ese almacén.
   - **«Descargar»** los indicadores del periodo en Excel o CSV.

Por qué así: una sección nueva no entra al menú sin uso diario (KISS); un
«tablero» aparte repetiría los números de Inicio e Indicadores con otro
camino de consulta, y dos números distintos para lo mismo es justo lo que no
se quiere. El rol no decide la pantalla: deciden los permisos, como en todo
el sistema (una empresa puede dar a un Administrador lo de Gerencia).

## Quién ve qué

Sin permisos nuevos (la matriz solo cambia la descripción de
`inventory.export.create` para nombrar los indicadores).

| Lo nuevo | Permiso | Roles hoy |
| --- | --- | --- |
| Trabajo abierto por persona (Inicio) | `inventory.summary.read` y `inventory.task.read` | Titular, Administración, Supervisor de almacén, Gerencia |
| Comparado con el periodo anterior | `inventory.kpi.read` | Titular, Administración, Supervisor de almacén, Gerencia |
| Por almacén | `inventory.kpi.read`, y alcanzar más de un almacén | Los mismos |
| Fila «Toda la empresa» de «Por almacén» | además `seesWholeCompany` | Los mismos, sin límite de almacén ni zona |
| Descargar indicadores | `inventory.export.create` y `inventory.kpi.read` (el servicio pide los dos) | Titular, Administración, Supervisor de almacén, Gerencia |
| Valor (dinero) en todo lo anterior | además `inventory.cost.read` | Titular, Administración, Gerencia (el Supervisor de almacén no ve costos) |
| Hoja «Por persona» del archivo | además `inventory.worker_performance.read` | Los mismos que hoy la ven en pantalla |

- El piso (Almacenista, Montacarguista), Consulta, Comprador, Almacén y los
  roles de producción y calidad no ven nada nuevo: siguen sin
  `inventory.summary.read` ni `inventory.kpi.read`. *El fundador puede
  cambiar* que Almacén (`warehouse`) vea indicadores (ya anotado en el
  ADR 0082).
- **Sesión de PIN (terminal compartida):** `inventory.export.create` no se
  conserva en una terminal (`TERMINAL_EXPORT_KEEP` solo deja la hoja de
  embarque y la de traslado), así que ahí no se descargan indicadores; la
  pantalla no ofrece el enlace. `inventory.worker_performance.read` tampoco
  se conserva (ya era así). Lo demás de la pantalla se ve igual.
- **Plan vencido:** todo lo de este paso es lectura o exportación
  (`*.read`, `*.export.create`): sigue funcionando.
- **Soporte de plataforma:** solo lee (sus permisos son `.read`); no
  descarga.
- **La API** no ofrece tableros ni indicadores (no lo ha pedido nadie).

## De dónde sale cada número

Regla: **ningún número de este paso tiene una consulta propia que pueda
dar otra cifra que la de su lista o su pantalla de detalle.**

### Trabajo abierto por persona

- Tareas del almacén activo (origen en ese almacén), dentro del alcance de
  quien mira (`taskScope`, la misma de Tareas), con persona asignada y en
  estado Asignada, Aceptada, Recogida o Con problema (`ASSIGNED_OPEN`): la
  condición `assignedOpenWhere`. Las «Disponibles» (sin persona) ya están en
  «Para hoy».
- Un `groupBy` por persona y estado; los nombres salen de las membresías de
  la empresa (quien ya no está: «Alguien que ya no está en el equipo»).
  Orden: más tareas primero, después nombre e id. Tope de 50 personas
  (`OPEN_WORK_PEOPLE_MAX`), con aviso si hay más.
- La lista de destino (`listTasks` con `view: "open"` y `person`) usa la
  misma condición más el alcance. **El filtro solo vale para un miembro de
  la empresa (activo o desactivado) con al menos una tarea abierta a su
  nombre en el almacén activo y dentro del alcance de quien mira**; si no,
  se ignora (lista abierta sin filtrar) y no se nombra a nadie. Es la regla
  de WMS-32 para personas (hallazgo de la revisión: antes bastaba con ser
  miembro y se nombraba a alguien sin nada dentro del alcance). Una persona
  desactivada con tareas que siguen a su nombre se puede seguir, porque ese
  trabajo hay que liberarlo o reasignarlo.
- Quién tiene tareas abiertas ya se ve en Tareas › Abiertas para quien lee
  tareas; la tarjeta solo agrupa.

### Cifras principales de un periodo («titulares»)

Son las mismas de la pantalla de Indicadores, calculadas por **la misma
función** (`periodHeadline`, que ahora usa también `getWarehouseIndicators`
para esos bloques), con las mismas definiciones del ADR 0082:

| Cifra | Definición (ADR 0082) |
| --- | --- |
| Pedidos despachados | pedidos del almacén cuyo embarque salió en el periodo (`shippedOnWhere`) |
| Completos | % de los leídos (tope 2,000) |
| A tiempo | % de los que tienen día de salida |
| Completos y a tiempo | % de los que tienen día de salida |
| Mediana de surtido | de liberar a la última tarea de surtido cerrada (`pickedOnWhere`) |
| Mediana de recepción a acomodo | tareas de acomodo entregadas cuyo origen está en el lugar |
| Exactitud | líneas de conteos aplicados que coincidieron (solo con `inventory.count_accuracy.read`) |
| Líneas de salida | líneas `OUT` de `EXIT`/`SHIPMENT` no reversadas en el lugar |
| Valor de lo que salió | solo con `inventory.cost.read` |
| Tareas entregadas | **nueva:** tareas entregadas en el periodo cuyo origen está en el lugar (misma condición que el tiempo de recepción y el rendimiento por persona, `taskWhere`) |

Los filtros de producto y de persona de la pantalla aplican igual que en el
ADR 0082 (a los pedidos y a la exactitud no).

### Periodo anterior

`previousPeriod(period)` (pura, en `indicator-rules.ts`):

- «7», «30», «90» días y fechas a mano: los mismos días inmediatamente
  antes del primero.
- «Mes anterior»: el mes completo de antes.
- «Este mes» (del 1 a hoy): del 1 del mes anterior al mismo número de día,
  sin pasar del fin de ese mes (el 31 de marzo compara con el 1 al 28 o 29
  de febrero).

El cambio se muestra en palabras: en conteos «Subió 12 (25.0 %)» o «Bajó
3» (el porcentaje solo si el anterior no es cero); en porcentajes, puntos
(«Subió 5.0 puntos»); en tiempos, «12 min más rápido» o «más lento»; sin
dato en uno de los dos periodos, «—»; igual, «Sin cambio». Nunca empieza con
`+` ni `−`: una celda que empieza con un signo llegaría a la hoja de cálculo
neutralizada como fórmula («'+12»; hallazgo de la revisión). **No se colorea
como bueno o malo** (subir las salidas no es bueno ni malo por sí solo); una
barra no aporta aquí y no se dibuja. Las consultas del periodo anterior usan
**sus propios días** (de su primer día al día siguiente del último): con
«Este mes» termina antes de que empiece el actual (hallazgo de la revisión:
se sumaba el mes anterior completo).

### Por almacén

- Una fila por cada almacén activo que la persona alcanza
  (`facilityInScope`), en orden de nombre, con los titulares del periodo de
  ese almacén **dentro de las zonas de la persona** (mismo `place` que la
  pantalla). Tope de 10 almacenes (`KPI_FACILITIES_MAX`) con aviso.
- Los filtros de producto y persona no aplican en esta vista (se dice en
  pantalla); el periodo sí.
- Fila **«Toda la empresa»** solo para quien `seesWholeCompany` (sin límite
  de almacén ni zona) y solo si se mostraron todos los almacenes: conteos
  sumados y porcentajes calculados de las sumas (no promedio de
  porcentajes); las medianas no se pueden sumar y van como «—». La
  exactitud de toda la empresa es líneas que coincidieron entre líneas
  contadas de todos los almacenes.
- Una persona limitada a un almacén no ve la vista (no hay nada que
  comparar); una limitada a zonas de dos almacenes ve los dos, cada uno
  solo con lo de sus zonas, y nunca la fila de la empresa.
- Cada fila lleva a la vista normal de ese almacén con el mismo periodo.

## Exportación

- Tipo nuevo `indicadores` en `EXPORT_KINDS` (lee `inventory.kpi.read`), por
  `buildExport` (pide `inventory.export.create` y el permiso de lectura),
  ruta `GET /api/exportaciones/indicadores` (la misma ruta de las demás,
  protegida en `proxy.ts` como ya está `/api/exportaciones`), con los mismos
  parámetros de la pantalla (`periodo`, `desde`, `hasta`, `almacen`,
  `producto`, `persona`, `vista`) y `formato` (`xlsx` por omisión o `csv`).
- Lo que sale es lo que la persona ve en pantalla, leído con **el mismo
  servicio** (`getWarehouseIndicators` y, con `vista=almacenes`,
  `getIndicatorsByFacility`): mismas reglas de alcance, de costos (las
  columnas de valor no existen sin `inventory.cost.read`, no van vacías) y
  de personas (la hoja «Por persona» solo con su permiso).
- Excel: una hoja por bloque: «Resumen» (periodo, almacén y filtros
  aplicados; cada titular con su valor, el del periodo anterior y el
  cambio), «Mayor movimiento», «Sin movimiento», «Por persona», «Por zona»;
  con `vista=almacenes`, una sola hoja «Por almacén». CSV: los mismos
  bloques uno tras otro en un solo archivo, cada uno con una fila de título
  y una fila en blanco entre bloques (un CSV no tiene hojas; *el fundador
  puede cambiar* a un CSV por bloque).
- Topes: los de la pantalla (20 productos por tabla, 50 personas por
  rendimiento —sin tope nuevo, son miembros—, zonas, 10 almacenes). Cada
  bloque que se topó lleva «Sí» en una fila «Incompleto» del Resumen y el
  aviso de la pantalla; el total de filas nunca se acerca a
  `EXPORT_MAX_ROWS`.
- Cantidades y dinero como texto ya formateado (como la pantalla); duraciones
  en texto («2 h 15 min»).
- Bitácora: `inventory.export_created` con contenido «Indicadores de
  almacén», formato, filas, periodo y almacén (sin nombres de personas ni
  costos).

## Lo que se configura por empresa

**Nada nuevo.** Qué ve cada rol lo deciden los permisos; los indicadores ya
tienen su ajuste (`inventory.kpi.idle_days`). *El fundador puede cambiar*:
elegir por empresa qué bloques ve cada rol, o una tolerancia en «a tiempo»
(ADR 0082).

## Costo

Medido contando solo las sentencias del adaptador de cada prueba (nunca el
contador global del servidor):

- Inicio: «Trabajo abierto por persona» cuesta 16 sentencias (permiso,
  almacén activo y alcance —las mismas lecturas que la lista de Tareas—, un
  `groupBy` y los nombres), solo para quien ve «Lo que se hizo hoy»
  (`dashboards.int.test.ts` fija el tope).
- Indicadores (vista normal): 66 sentencias, contra 50 de WMS-32: los
  titulares del periodo anterior son unas 14 y la vista misma suma dos
  (tareas entregadas y los tiempos de acomodo, que ahora lee la función de
  titulares en vez de sacarlos de las filas de tareas). Sin comparación
  (`compare: false`, lo usa el archivo de la vista por almacén y las
  pruebas) son 52. `indicators.int.test.ts` fija los dos.
- Por almacén: 6 sentencias para empezar y unas 18 por almacén, en
  paralelo; con tres almacenes, 60 (tope en la prueba: 64). Tope de 10
  almacenes. Solo se carga si se pide.
- Exportación: lo mismo que su pantalla.
- Un cambio de comportamiento menor: «De recibir a acomodar» dice que está
  incompleto cuando las tareas de acomodo leídas pasan del tope, no cuando
  lo pasan todas las tareas del periodo (es más exacto).
- `npm run load:test` (2026-11-19, este contenedor: 4 núcleos, 16 GB, app
  compilada; la pantalla «Indicadores por almacén» entra a `screens()`): con
  100 y 1,000 productos todo queda bajo la meta (Indicadores p95 de 112 a
  205 ms con 20 personas; por almacén de 216 a 260 ms). Con 10,000
  productos Indicadores pasa de la meta (587 ms con una persona, 902 ms con
  20; por almacén 1,049 ms con 20), igual que Inicio (845 ms con 20).
  **No lo causa este paso:** con los mismos datos y la misma máquina, el
  servicio de WMS-32 sin cambios tarda unos 740 ms y el de este paso con la
  comparación unos 770 ms; la vista por almacén sola, 26 ms. La medición de
  WMS-32 (362 ms) no se reprodujo aquí. **Pendiente de un paso propio** (la revisión
  coincide): lo que crece con el catálogo es «sin movimiento» (dos `groupBy`
  por producto) y «mayor movimiento»; corregirlo y volver a medir en el
  equipo de referencia.

## Lo que no entra

- Indicadores de producción y calidad (WMS-33), automatizaciones (WMS-64),
  slotting (WMS-65).
- Gráficas con librería; envío del tablero por correo; una pantalla de
  tablero por rol configurable; asignar tareas desde el tablero (se asigna
  en la ficha de la tarea, como hoy).
- Tendencia de muchos periodos (semana a semana): la exactitud ya la tiene
  en su pantalla; para lo demás, el periodo anterior.
- La API.

## Consecuencias

- `indicators.ts` separa `periodHeadline` y agrega `getIndicatorsByFacility`
  y `previous` (titulares del periodo anterior) a `getWarehouseIndicators`;
  `indicator-rules.ts` agrega `previousPeriod` y las reglas de cambio.
- `tasks.ts` agrega `assignedOpenWhere`, `listOpenWorkByPerson` y el filtro
  `person` de `listTasks`.
- `exports.ts` agrega el tipo `indicadores` (`indicator-export.ts`).
- Un titular nuevo se define aquí y en el ADR 0082, se calcula en
  `periodHeadline` y entra en la comparación, en «Por almacén» y en el
  archivo a la vez.
