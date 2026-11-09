# Plan WMS v2

Actualizado: 2026-11-09. Reemplaza los pasos pendientes de `docs/PLAN_WMS.md`
(WMS-09..12 de ese plan); los pasos WMS-01..08 ya cerrados no cambian. Parte de
`docs/ESTADO_WMS.md`, de la revisión del fundador del 2026-11-09 y de
`docs/ESPECIFICACION_WMS_v5.md` (las secciones citadas son de ella).

## Cómo se usa este plan

- Un paso a la vez, en orden. Un paso no empieza si su dependencia no está
  cerrada. Cada paso cierra solo cuando se cumple su «Listo cuando» y pasan sus
  pruebas.
- Cada paso cierra con `npm run check` y `npm run build` en verde, un commit en
  español `WMS-xx: …`, y CI en verde antes del siguiente (`AGENTS.md`, «Estado
  actual»).
- **No romper lo que hay**: las 1,687 pruebas actuales siguen en verde en cada
  paso; `npm run stock:reconcile` sin diferencias; cada tabla nueva de empresa en
  `TENANT_MODELS` y con su dato en `tests/isolation/two-companies.int.test.ts`;
  cada Server Action nueva en `REVIEWED`; cada permiso nuevo en la matriz y el
  catálogo; cada pantalla nueva del menú en `verify-a11y.mjs`.
- **Mientras no haya producción**, una migración puede cambiar o quitar columnas
  (ADR 0032). Desde el primer despliegue vuelve la regla de migraciones solo de
  expansión.
- Estados de un documento: tabla pura en código + disparador que la repite
  (patrón de `task-states.ts`). Lo que mueve existencias: candados producto →
  ubicación → documento, `LOCKING_TRANSACTION`, clave de idempotencia y
  respuesta `repeated` ante un reintento.
- Pruebas críticas de la especificación (sección 15) que cada etapa debe dejar
  probadas: se indican como **PC-n**.

## Principio de diseño

Un núcleo WMS genérico con módulos que se activan por empresa. Un comercio, una
manufacturera y un operador logístico usan el mismo código con distinta
configuración. CFDI, integraciones ERP y 3PL avanzado esperan a que el flujo
completo de inventario funcione (entrada → almacenamiento → producción →
salida).

## Resumen de etapas

| Etapa | Pasos | Para qué |
| --- | --- | --- |
| A. Modelo de existencias | WMS-09..12 | Estados, lotes y reservas en el saldo, una sola vez, antes de construir flujos |
| B. Salida | WMS-13..17 | Pedidos, surtido, empaque, despacho y devoluciones de clientes |
| C. Varios almacenes | WMS-18..22 | Almacenes, alcance de permisos, ubicaciones configurables, capacidad, trazabilidad |
| D. Reabastecimiento | WMS-23..26 | Reglas de reposición, tareas automáticas, olas, etiquetas |
| E. Producción y calidad | WMS-27..31 | Recetas, órdenes, consumo, inspección y liberación |
| F. Analítica | WMS-32..34 | Indicadores de almacén, producción y calidad |
| G. Piso y móvil | WMS-35..42 | PWA, cámara, fotos, PIN, incidencias, sesiones, ajustes con autorización, equipos |
| H. Preparación comercial | WMS-43..48 | Configuración inicial, demo, plantillas por giro, manuales, staging y producción |
| I. Después del piloto | — | 3PL, API e integraciones, CFDI |

---

## Etapa A. Modelo de existencias (especificación 6.1, 6.2, 5.2)

Hoy el saldo es único por producto + ubicación (`stock_balance`). Estados,
lotes y reservas cambian esa llave; se cambia una vez, aquí, para que surtido,
producción y calidad no obliguen a rehacerla.

### WMS-09 · Decisión: dimensiones del saldo (ADR 0033)

- **Qué:** ADR que fija la llave del saldo: producto + ubicación + estado + lote
  (opcional) y, más adelante, propietario (3PL, sin columna todavía). Define los
  estados de la especificación 6.2 y cuáles cuentan como «disponible», cómo se
  reserva sin descontar, cómo se migran los saldos actuales (todo a «disponible»,
  sin lote) y cómo cambian `reconcileStock` y `reconcileValue`.
- **Depende de:** nada.
- **Listo cuando:** el ADR está en `docs/adr/0033-dimensiones-del-saldo.md` con
  el esquema propuesto, la migración de datos y la lista de servicios que cambian.
- **Pruebas:** no aplica (documento).
- **Estado:** hecho (2026-11-09).

### WMS-10 · Estados de inventario en el saldo

- **Qué:** `stock_balance` y `stock_movement_line` llevan `status` (`AVAILABLE`,
  `RECEIVING`, `INSPECTION`, `QUARANTINE`, `DAMAGED`, `REJECTED`, `IN_TRANSIT`,
  `BLOCKED`; `RESERVED` no es un estado físico: lo dan las reservas, WMS-12).
  Tabla `lot` vacía y `lotId` opcional en saldo y líneas (se usa en WMS-21). Las
  operaciones actuales trabajan sobre `AVAILABLE`. «Hay» y «disponible» se
  muestran por separado donde ya se muestran existencias.
- **Depende de:** WMS-09.
- **Listo cuando:** migración aplicada en `wms_dev` y `wms_test` con los saldos
  existentes en `AVAILABLE`; todas las pantallas y servicios actuales siguen
  igual; la reconciliación compara por estado.
- **Pruebas:** las actuales sin cambio; reconciliación por estado; un saldo
  `REJECTED` o `DAMAGED` nunca aparece como disponible (**PC-5**).
- **Estado:** hecho (2026-11-09). Migración escrita a mano (la diferencia de Prisma
  soltaba llaves foráneas); pruebas en `tests/inventory/stock-status.int.test.ts`.

### WMS-11 · Cambiar el estado de existencias

- **Qué:** movimiento `STATUS_CHANGE` (salida de un estado y entrada al otro en
  la misma ubicación), con motivo, quién lo hizo y bitácora. Permisos
  `inventory.status.change` (poner en cuarentena, dañado, bloqueado) e
  `inventory.status.release` (devolver a disponible). Pantalla en la ficha del
  producto y en la ubicación.
- **Depende de:** WMS-10.
- **Listo cuando:** Supervisor y Almacén cambian estados con motivo; Almacenista
  solo reporta dañado; liberar exige `inventory.status.release`; el historial lo
  muestra.
- **Pruebas:** permisos por rol; no se cambia más de lo que hay en el estado de
  origen; concurrencia de dos cambios sobre el mismo saldo; reconciliación.
- **Estado:** hecho (2026-11-09). Permisos `inventory.status.change`,
  `inventory.status.release` e `inventory.damage.report`; pruebas en
  `tests/inventory/status-change.int.test.ts`.

### WMS-12 · Reservas

- **Qué:** `stock_reservation` (producto, ubicación o solo producto, lote
  opcional, cantidad, documento que reserva, estado). Disponible para reservar =
  `AVAILABLE` − reservado. Reservar no descuenta; liberar o consumir una reserva
  queda registrado. Servicio `reserve`/`release`/`consume` usado por los
  documentos (pedidos, producción).
- **Depende de:** WMS-10.
- **Listo cuando:** existencias muestran «disponible», «reservado» y «total»; una
  salida manual no puede tomar lo reservado (aviso claro).
- **Pruebas:** dos reservas simultáneas no pasan de lo disponible (**PC-2**);
  reintento no duplica (**PC-3**); una salida manual respeta las reservas.

## Etapa B. Salida (especificación 5.2)

### WMS-13 · Pedidos de salida

- **Qué:** `outbound_order` + líneas (sin precios, caja ni cobro). Destinatario:
  contacto con faceta cliente o texto libre; fecha compromiso; prioridad.
  Estados: borrador → liberado → en surtido → surtido → empacado → despachado,
  y cancelado con motivo. Liberar valida y reserva (WMS-12); cancelar libera.
  Permisos `outbound.order.read|create|release|cancel`. Sección «Pedidos» en el
  menú (uso diario). Importación de pedidos desde Excel.
- **Depende de:** WMS-12.
- **Listo cuando:** crear, liberar y cancelar un pedido funciona; lo liberado
  queda reservado; un pedido que no alcanza dice qué falta y permite liberar en
  parcial o esperar.
- **Pruebas:** tabla de estados y disparador; liberar dos pedidos sobre el mismo
  saldo a la vez no sobre-reserva (**PC-2**); entre empresas; permisos por rol.

### WMS-14 · Surtido (picking)

- **Qué:** al liberar, se generan tareas de surtido (`warehouse_task` con
  `kind = PICK`, ligada a la línea del pedido): qué producto, de qué ubicación,
  cuánto. La ubicación sale de una estrategia de asignación (primero la más
  llena; FIFO por fecha de entrada; FEFO cuando haya lotes, WMS-21) detrás de una
  sola función. El almacenista confirma producto, ubicación y cantidad
  escaneando; surtir menos de lo pedido deja faltante explicado. Lo surtido pasa a
  una ubicación de preparación (sin salir todavía).
- **Depende de:** WMS-13 y WMS-06 (tareas).
- **Listo cuando:** un pedido liberado genera sus tareas; el almacenista las
  hace desde el teléfono; el pedido queda surtido o con faltante.
- **Pruebas:** una tarea de surtido no se confirma dos veces (**PC-6**);
  confirmar con producto o ubicación equivocados se rechaza; faltante libera la
  reserva que no se usó; reconciliación.

### WMS-15 · Verificación y empaque (packing)

- **Qué:** en la zona de preparación se verifica lo surtido contra el pedido
  (escaneo por pieza o por presentación), se arman bultos (caja, tarima) con
  peso opcional y se imprime la etiqueta del bulto (WMS-26 la mejora).
- **Depende de:** WMS-14.
- **Listo cuando:** un pedido surtido se verifica y empaca; una diferencia se
  corrige antes de despachar.
- **Pruebas:** no se empaca más de lo surtido; diferencias explicadas.

### WMS-16 · Despacho

- **Qué:** confirmar salida: transportista, guía, placas, quién entrega. El
  despacho escribe el movimiento de salida (clave `ship:<id>`), consume las
  reservas y cierra el pedido. Documento PDF de embarque (patrón de
  `order-pdf.ts`).
- **Depende de:** WMS-15.
- **Listo cuando:** el pedido queda despachado y las existencias bajan una sola
  vez; el PDF de embarque se descarga.
- **Pruebas:** despacho repetido no duplica la salida (**PC-3**); no se despacha
  un pedido sin empacar; reconciliación; extracción de texto del PDF.

### WMS-17 · Devoluciones de clientes

- **Qué:** recibir mercancía devuelta (con o sin pedido de origen), entra en
  `INSPECTION`; la inspección decide disponible, dañado o rechazado (WMS-11),
  con motivo.
- **Depende de:** WMS-16 y WMS-11.
- **Listo cuando:** una devolución entra, se inspecciona y termina en el estado
  decidido; nada devuelto queda disponible sin decisión.
- **Pruebas:** lo devuelto no aparece como disponible antes de inspeccionarse
  (**PC-5**); permisos; reconciliación.

## Etapa C. Varios almacenes y estructura (especificación 3.1, 4.1, 6.5)

### WMS-18 · Varios almacenes y sucursales

- **Qué:** `facility` deja de ser una por empresa: varias instalaciones con
  nombre, código, dirección y sucursal. Cada ubicación es de una instalación;
  pantallas y listas filtran por almacén, con un almacén activo por persona. El
  cupo de almacenes va en el plan.
- **Depende de:** etapa B cerrada (para no rehacer surtido).
- **Listo cuando:** una empresa crea un segundo almacén y opera en él sin
  mezclar existencias; los reportes permiten elegir almacén o todos.
- **Pruebas:** existencias y movimientos no se mezclan entre almacenes; cupo;
  entre empresas.

### WMS-19 · Traslados entre almacenes

- **Qué:** documento de traslado: sale del almacén A a `IN_TRANSIT` y entra al B
  al recibirse, con diferencias registradas.
- **Depende de:** WMS-18 y WMS-10.
- **Listo cuando:** lo enviado se ve en tránsito hasta recibirse y el total de la
  empresa no cambia durante el traslado.
- **Pruebas:** recibir dos veces no duplica; reconciliación.

### WMS-20 · Alcance de permisos por almacén y zona

- **Qué:** una membresía puede limitarse a almacenes o zonas
  (`membership_scope`). `can` sigue siendo la única decisión y recibe el alcance;
  cada servicio que lee o mueve existencias comprueba que la ubicación esté
  dentro del alcance, aunque el id llegue manipulado.
- **Depende de:** WMS-18.
- **Listo cuando:** una persona limitada al almacén B no ve ni mueve nada del A,
  en pantallas, búsquedas, exportaciones ni tareas.
- **Pruebas:** **PC-12** con ids de otro almacén en cada Server Action que recibe
  una ubicación; `REVIEWED` actualizado con el alcance.

### WMS-21 · Lotes, caducidad y números de serie

- **Qué:** cada producto dice si se controla por lote, por serie o ninguno. La
  recepción captura lote (y caducidad) o series; los saldos y movimientos
  llevan el lote; surtir con FEFO (primero lo que caduca antes) o FIFO; alertas
  de caducidad próxima.
- **Depende de:** WMS-10 (columna `lotId`) y WMS-14 (estrategia de asignación).
- **Listo cuando:** un producto por lote se recibe, almacena, surte y despacha
  con su lote; un producto por serie no admite series repetidas.
- **Pruebas:** FEFO elige el lote correcto; serie única por empresa; reconciliación
  por lote.

### WMS-22 · Ubicaciones configurables y capacidad

- **Qué:** niveles con nombre libre por almacén (bodega, pasillo, rack, nivel,
  posición), sin profundidad fija; código único por almacén, QR o código de
  barras, estado, capacidad (peso, volumen, unidades), dimensiones y
  restricciones (solo cuarentena, solo cierto producto). Ruta completa visible;
  los reportes suman los nodos descendientes. Al acomodar, se sugiere una
  ubicación que respete capacidad y restricciones. Reemplaza los tres tipos
  fijos actuales (ADR 0011 se actualiza).
- **Depende de:** WMS-18.
- **Listo cuando:** un almacén con seis niveles y otro con dos conviven; acomodar
  más de la capacidad avisa o se bloquea según la regla.
- **Pruebas:** sin ciclos; código único; los reportes por nodo no duplican
  (**PC-11**); capacidad respetada; migración de las ubicaciones actuales.

### Trazabilidad completa (cierra la etapa C)

Con WMS-21 cerrado, una consulta «de dónde vino y a dónde fue» por lote, serie o
pedido: recepción → acomodo → traslados → surtido → despacho. Se agrega como
parte de WMS-21 si cabe en el paso, o como WMS-22B.

## Etapa D. Reabastecimiento y etiquetas

### WMS-23 · Reglas de reposición

- **Qué:** mínimo, máximo y cantidad de reposición por producto y ubicación de
  surtido (además del mínimo general que ya existe).
- **Depende de:** WMS-22.
- **Listo cuando:** se configuran y la lista «por reponer» las usa.
- **Pruebas:** validación de cantidades con `parseQuantity`; derivado, no guardado.

### WMS-24 · Reabastecimiento automático

- **Qué:** una ronda periódica (`ScheduledRound`) detecta ubicaciones de surtido
  bajo su mínimo y crea tareas de traslado desde el almacenamiento, sin
  duplicar tareas abiertas.
- **Depende de:** WMS-23 y WMS-06.
- **Listo cuando:** bajar de su mínimo una ubicación de surtido genera una sola
  tarea de reposición.
- **Pruebas:** la ronda puede repetirse sin crear tareas duplicadas; respeta el
  alcance por almacén.

### WMS-25 · Surtido por olas

- **Qué:** agrupar varios pedidos liberados en una ola con una ruta ordenada por
  ubicación; las tareas se reparten por persona o zona.
- **Depende de:** WMS-14 y WMS-22 (orden de ruta).
- **Listo cuando:** una ola de varios pedidos se surte en un recorrido y cada
  pedido queda con lo suyo.
- **Pruebas:** lo surtido en ola cuadra por pedido; cancelar un pedido dentro de
  una ola libera solo lo suyo.

### WMS-26 · Etiquetas e impresión

- **Qué:** PDF de etiquetas con código de barras (Code 128) y QR para producto,
  ubicación, tarima o bulto y pedido, con el `PdfPageWriter` propio (sin librería
  nueva). Tamaños comunes de etiqueta.
- **Depende de:** WMS-15 y WMS-22.
- **Listo cuando:** se imprimen etiquetas de ubicaciones y bultos que el lector
  vuelve a leer.
- **Pruebas:** el código generado se decodifica de vuelta (prueba unitaria); PDF
  sin contenido activo.

## Etapa E. Producción y calidad (especificación 5.4–5.6)

Módulos nuevos `production` y `quality`, contratables, con sus permisos y roles
(Operario de producción, Supervisor de producción, Inspector de calidad) en la
matriz.

### WMS-27 · Recetas (lista de materiales)

- **Qué:** receta por producto terminado: insumos, cantidades por unidad, merma
  esperada, versiones (una receta usada no se edita: se versiona).
- **Depende de:** etapa A.
- **Pruebas:** cantidades exactas; versión inmutable.

### WMS-28 · Órdenes de producción

- **Qué:** orden con producto, cantidad objetivo, receta, fecha y estados;
  liberar reserva los insumos (WMS-12) y puede generar tareas de surtido a
  producción.
- **Depende de:** WMS-27 y WMS-14.
- **Pruebas:** estados y disparador; reservas de insumos; cancelación libera.

### WMS-29 · Consumo, producción y merma

- **Qué:** registrar consumo real, cantidad producida por operación, turno y
  trabajador, y merma con motivo. Lo producido entra como lote en `INSPECTION`
  (o disponible si el producto no pide inspección). Ejemplo de la especificación
  5.5 (crates de madera) como prueba de aceptación.
- **Depende de:** WMS-28 y WMS-21.
- **Pruebas:** consumo y producción cuadran con la orden; caso 5.5 completo;
  reconciliación y valor (costo del producto terminado desde sus insumos).

### WMS-30 · Inspección de calidad y liberación

- **Qué:** inspección por lote: recibido, inspeccionado, aprobado, rechazado y en
  cuarentena, defectos, evidencias, decisión. Solo lo aprobado se libera a
  disponible.
- **Depende de:** WMS-29, WMS-11 y WMS-37 (evidencias) si ya existe.
- **Pruebas:** no se aprueba más de lo inspeccionado ni se libera más de lo
  aprobado (**PC-4**); rechazado nunca disponible (**PC-5**).

### WMS-31 · Producto terminado a su ubicación

- **Qué:** al liberar, se generan tareas de traslado a producto terminado;
  cierre de la orden con conciliación de cantidades.
- **Depende de:** WMS-30.
- **Pruebas:** el cierre cuadra producido = liberado + rechazado + merma.

## Etapa F. Analítica (especificación 7)

### WMS-32 · Indicadores de almacén

- **Qué:** existencias actuales y comprometidas, rotación, entradas y salidas por
  periodo, exactitud de inventario (de los conteos), pedidos completos y a
  tiempo, tiempos de recepción y de surtido. Filtros por periodo, almacén,
  producto y usuario según permisos. Todo derivado, sin contadores guardados.
- **Depende de:** etapa B y WMS-18.

### WMS-33 · Indicadores de producción y calidad

- **Qué:** producción por día, turno, orden, producto y trabajador (con contexto
  del tipo de trabajo), porcentaje de aprobación y rechazo, merma por causa,
  tiempo entre producción, inspección y almacenamiento.
- **Depende de:** etapa E.

### WMS-34 · Tablero por rol y exportación

- **Qué:** tablero de escritorio para administración y gerencia; exportación de
  cada indicador con `buildExport`.
- **Depende de:** WMS-32.
- **Pruebas (F):** cada indicador contra un escenario con resultado conocido; los
  costos solo para quien puede verlos; carga (`load:test`) con p95 < 500 ms.

## Etapa G. Piso y móvil (especificación 4.3–4.5, 16.1)

| ID | Paso | Depende de |
| --- | --- | --- |
| WMS-35 | PWA instalable (manifiesto, ícono, pantalla sin conexión que lo dice); sin operar sin conexión todavía | — |
| WMS-36 | Escaneo con cámara (API del navegador con respaldo de captura manual) en búsqueda, recepción, tareas y surtido | WMS-35 |
| WMS-37 | Evidencias fotográficas (archivos privados, `storeFile`) en recepción, tareas, devoluciones e inspecciones | — |
| WMS-38 | Terminales compartidas: cambio rápido de persona con PIN (con `reserveAttempt`), cierre automático y rastro individual | — |
| WMS-39 | Incidencias y notificaciones dentro de la app (tarea bloqueada, faltante, diferencia de recepción, caducidad) | etapa B |
| WMS-40 | Sesiones del equipo para el administrador: ver dispositivo, navegador, IP y última actividad, y cerrarlas a distancia | — |
| WMS-41 | Ajustes con autorización por umbral: quién pide y quién autoriza, con evidencia | WMS-37 |
| WMS-42 | Equipos (montacargas): registro, mantenimiento e incidencias; la tarea puede pedir un tipo de equipo | WMS-06 |

Operar sin conexión (cola local con idempotencia) solo después de WMS-35..36 y
solo para las operaciones que la especificación permita (4.5).

## Etapa H. Preparación comercial e infraestructura (especificación 11–13, 16)

| ID | Paso | De quién |
| --- | --- | --- |
| WMS-43 | Asistente de configuración inicial: almacenes, ubicaciones, equipo, importación de productos y existencias | Desarrollo |
| WMS-44 | Empresa de demostración con datos ficticios por giro (script sobre servicios reales) | Desarrollo |
| WMS-45 | Plantillas por giro (almacén general, comercial, manufactura, 3PL) que activan módulos y catálogos | Desarrollo |
| WMS-46 | Manuales y capacitación por rol en `docs/manuales/` (piso, supervisión, administración) | Desarrollo |
| WMS-47 | Staging y producción: VPS, dominio, Cloudflare (DNS, WAF, límites), respaldos fuera del servidor, monitoreo de CPU, RAM, disco y base, alertas, prueba de restauración periódica (**PC-8**), secretos y política de parches | Fundador elige proveedor; desarrollo adapta `deploy/` |
| WMS-48 | Lo comercial: nombre, precios de instalación y suscripción, contrato, SLA, respaldos y retención, cancelación y exportación de datos, términos y privacidad revisados por un abogado, procedimiento de alta de empresas | Fundador |

Después: **piloto comercial** en una empresa real, medir y corregir antes de
escalar.

## Etapa I. Después del piloto

- Operación 3PL: propietario del inventario en el saldo (previsto en ADR 0033),
  cobro por almacenaje y movimientos.
- API pública e integraciones (ERP, básculas, impresoras).
- CFDI mediante un PAC (16.3).

## Correspondencia con el plan anterior

| Plan anterior | Este plan |
| --- | --- |
| WMS-09 Pedidos de salida y surtido | WMS-12..16 |
| WMS-10 Estados de inventario | WMS-09..11 |
| WMS-11 Producción y calidad | WMS-27..31 |
| WMS-12 Analítica | WMS-32..34 |

## Dónde se ubican las sugerencias de la revisión del 2026-11-09

| Sugerencia | Paso |
| --- | --- |
| Reabastecimiento automático y reglas de reposición | WMS-23, WMS-24 |
| Picking por olas | WMS-25 |
| Packing | WMS-15 |
| Devoluciones de clientes | WMS-17 |
| Trazabilidad completa | cierre de la etapa C (WMS-21/22B) |
| FIFO / FEFO | WMS-14 (estrategia) y WMS-21 (lotes) |
| Capacidad de ubicaciones | WMS-22 |
| Etiquetas e impresión | WMS-26 |
| Mantenimiento de equipos | WMS-42 |
