# ADR 0081 — Búsqueda global

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-66 (Fase 4) · Depende de:
ADR 0038 (alcance por almacén y zona), ADR 0041 (rastreo), INV-10/11/12

## Contexto

Hoy cada pantalla busca lo suyo: Inventario busca productos por nombre, clave
o código de barras; Proveedores por nombre o RFC; Tarimas por código; y
«Rastrear lote, serie o pedido» (`findTraceMatches`, `/inventario/rastrear`)
reconoce un lote, una serie o un número `PS-`, `OC-`, `EM-`, `DV-`, `TR-` o
de tarima, pero solo para quien tiene `inventory.movement.read` y solo para
abrir el rastro. Quien tiene un número o un código en la mano (una hoja, una
etiqueta, una llamada) tiene que saber primero en qué sección vive. La mayoría
de las listas de documentos no tiene búsqueda de texto: filtran por estado y
paginan por número.

## Flujo operativo

- **Quién:** cualquier persona de la empresa, cada una con lo que ya puede ver.
  Del titular a Consulta; también el piso (Almacenista, Montacarguista), los
  roles de producción y calidad, una sesión de PIN en una terminal y soporte
  de plataforma con su ventana abierta.
- **Dónde:** pantalla `/buscar`. Se llega por «Buscar», junto a «Avisos», en la
  barra lateral (escritorio) y en el encabezado (teléfono). El enlace aparece
  solo si la persona puede buscar al menos un tipo; saberlo no cuesta consultas
  (se decide con los permisos y módulos que el layout ya tiene).
- **Qué hace:** escribe o escanea (lector USB, o cámara en Android con
  `CameraScanButton`) y envía. El formulario es `Form` de `next/form` con `GET`
  y la búsqueda vive en la dirección (`/buscar?q=…`); sin Server Action.
- **Qué ve:** los resultados agrupados por tipo, en un orden fijo (productos,
  ubicaciones, lotes, series, tarimas, pedidos, embarques, devoluciones,
  traslados, tareas, incidencias, órdenes de compra, solicitudes de compra,
  proveedores, órdenes de producción, solicitudes de producción). Cada fila
  completa abre la pantalla donde ese registro se cuenta entero. Un grupo con
  más de lo que se muestra dice «Ver todos» si su lista acepta la misma
  búsqueda (productos y proveedores).
- **Lectura exacta:** si lo buscado es exactamente el código, número, código de
  barras o serie de **un solo** resultado y no hay ningún otro resultado, la
  pantalla abre ese registro directamente (lo que espera quien escanea). Con
  más de un resultado se muestra la lista. La redirección reemplaza la
  entrada del historial, así que «Atrás» no vuelve a la búsqueda que redirige.
- **Sin resultados:** lo dice con el texto buscado y lista qué se busca en cada
  tipo que la persona puede ver (nada de lo que no puede).
- **Qué valida:** el texto pasa por `normalizeSearch` (sin caracteres de
  control, hasta 100 caracteres, hasta 6 palabras); `%`, `_` y `\` son texto,
  nunca comodines. Un texto vacío muestra la ayuda.
- **Qué se configura por empresa:** nada en esta entrega. Que una lectura
  exacta abra el registro es siempre así (el fundador puede cambiar: podría ser
  un ajuste de la empresa).
- **Qué no entra:** escribir nada; búsqueda difusa o por similitud; texto libre
  dentro de documentos (destinatario, referencia, notas, transportista); la API
  (no ofrece búsqueda); historial de búsquedas; buscar en usuarios, bitácora,
  movimientos (ya tienen su pantalla con filtros) o en ajustes.

## Decisión

### Arquitectura: motor en la plataforma, fuentes en cada módulo

La plataforma no importa módulos. Igual que avisos, aprobaciones y procesos:

- `src/platform/search` (nuevo) define el contrato `SearchSource` (clave
  `modulo.cosa`, etiqueta, **el permiso de lectura de la pantalla que abre**,
  ayuda, tope y la función que busca) y el motor `runGlobalSearch(actor,
  texto, fuentes)`. `assertValidSearchSources` rechaza al cargar una clave
  repetida, un permiso desconocido, **un permiso que no sea de lectura o
  exportación** o un tope fuera de 1 a 20.
- Cada módulo declara sus fuentes en su `search.ts` (Inventario, Compras,
  Producción) y `src/modules/registry/search.ts` las junta en `searchSources`.
  Productos y ubicaciones son tablas de plataforma, pero sus pantallas son de
  Inventario (`/inventario`, `/ubicaciones`, permisos `inventory.*`): su fuente
  vive en Inventario. Proveedores (tabla de plataforma, pantalla de Compras):
  en Compras. Calidad no tiene nada que buscar todavía.
- El motor carga una sola vez el sujeto (`loadSubject`) y los derechos de la
  empresa (`getEntitlements`), y corre solo las fuentes cuyo permiso la persona
  tiene **y** cuyo módulo cubre ese permiso (`can` + `entitles`: con el módulo
  en solo lectura las lecturas siguen; sin módulo, nada). Corre las permitidas
  a la vez y pide a cada una su tope + 1 para saber si hay más. Descarta todo
  resultado cuyo `href` no sea una ruta propia (`isInternalHref`). Un fallo
  esperado de una fuente (`AppError` de permiso, no encontrado o validación, por
  ejemplo quien quedó sin ningún almacén en su alcance) deja ese grupo vacío;
  lo inesperado sube como error.

Con esto los casos especiales salen solos de la política, sin camino nuevo de
permisos:

- **Módulo no contratado:** sus fuentes no corren. **En solo lectura:** sí
  (buscar solo lee).
- **Roles de producción y calidad:** `permissionsOf` ya les quita todo sin su
  módulo y les deja solo sus lecturas en solo lectura.
- **Sesión de PIN:** conserva las lecturas (`keptAtTerminal`), así que busca lo
  mismo que ve en la terminal.
- **Soporte de plataforma:** solo `.read`; la búsqueda solo usa `.read`.
- **API:** no hay ruta de búsqueda en `/api/v1`.

### Cada tipo se lee con la regla de su pantalla

La regla: **un resultado aparece solo si su pantalla de destino lo mostraría a
esa persona**. Para los documentos buscados por número, la fuente encuentra el
id por el número (único por empresa, índice `(organizationId, number)`) y
después **llama al mismo servicio que su pantalla de detalle** (`getOutboundOrder`,
`getTask`, `getShipment`…): si ese servicio responde «no existe» (otra empresa,
fuera del alcance, borrador ajeno), el resultado no se lista ni se cuenta. Así
el alcance es exactamente el de la ficha, sin copiarlo. Las fichas aceptan
cualquier almacén del alcance (no solo el activo), así que **la búsqueda de
documentos es de toda la empresa dentro del alcance**, como la ficha.

| Tipo | Qué se busca | Permiso (el de su pantalla) | Almacén | Tope | Abre |
| --- | --- | --- | --- | ---: | --- |
| Productos | Cada palabra en nombre, clave o código de barras; exacta = clave o código de barras | `inventory.product.read` | Toda la empresa (el catálogo), solo activos: las condiciones de `listProducts` en una consulta propia | 8 | `/inventario/[id]` |
| Ubicaciones | Código exacto, o cada palabra en nombre o código (no en la ruta) | `inventory.location.read` | **Almacén activo**, sin archivadas ni tránsito, y alcance: las condiciones de `listLocations` filtradas en la base (la pantalla de ubicaciones es del almacén activo) | 5 | `/ubicaciones#ubicacion-<id>` |
| Lotes | Código exacto (`normalizeLotCode`), cualquier producto | `inventory.stock.read` | Lote con algún movimiento en el alcance (regla del rastreo) | 5 | `/inventario/lotes/[id]` |
| Series | Serie exacta (`normalizeSerial`), cualquier producto | `inventory.movement.read` | Unidad con algún movimiento en el alcance (`traceSerial`) | 5 | `/inventario/rastrear?serie=…` |
| Tarimas y cajas | Código exacto | `inventory.stock.read` | La condición de `getContainer`: su ubicación en el alcance | 1 | `/inventario/tarimas/[id]` |
| Pedidos | `PS-n` | `inventory.outbound.read` | `getOutboundOrder` | 1 | `/pedidos/[id]` |
| Embarques | `EM-n` | `inventory.shipment.read` | `getShipment` | 1 | `/pedidos/embarques/[id]` |
| Devoluciones | `DV-n` | `inventory.customer_return.read` | `getCustomerReturn` | 1 | `/pedidos/devoluciones/[id]` |
| Traslados | `TR-n` | `inventory.facility_transfer.read` | `getFacilityTransfer` (origen o destino en alcance) | 1 | `/movimientos/traslados/[id]` |
| Tareas | `T-n` | `inventory.task.read` | `getTask` (`taskScope`) | 1 | `/tareas/[id]` |
| Incidencias | `INC-n` | `inventory.incident.read` | `getIncident` | 1 | `/incidencias/[id]` |
| Órdenes de compra | `OC-n` | `purchasing.order.read` | `getPurchaseOrder` (`orderInScope`; sin almacén = toda la empresa) | 1 | `/compras/ordenes/[id]` |
| Solicitudes de compra | `SC-n` | `purchasing.request.read` | `getPurchaseRequest` (un borrador solo para quien lo escribe) | 1 | `/compras/solicitudes/[id]` |
| Proveedores | Cada palabra en nombre o RFC | `purchasing.supplier.read` | Toda la empresa, sin archivados: las condiciones de `listSuppliers` en una consulta propia | 5 | `/compras/proveedores/[id]` |
| Órdenes de producción | `OP-n` | `production.order.read` | `getProductionOrder` (alcance del área) | 1 | `/produccion/[id]` |
| Solicitudes de producción | `SP-n` | `production.request.read` | `getProductionRequest` | 1 | `/produccion/solicitudes/[id]` |

- **Nunca costos ni datos que la pantalla destino no muestra:** cada fila lleva
  solo título y una línea (clave, destinatario, estado, producto, ruta).
  Las fuentes leen con los servicios de lectura, que ya omiten costos.
- Un número se escribe como en papel o etiqueta: «PS-0012», «ps 12», «PS12»
  (`documentNumber` de `@/platform/search`, puro). Un número solo («12») no se
  busca: sería ambiguo entre tipos.
- **Rastreo: convive y comparte.** `/inventario/rastrear` sigue siendo la
  herramienta de trazabilidad (su caja y el detalle de una serie o una orden
  de compra) y es el destino de las series. La búsqueda global no lo duplica:
  la búsqueda de lotes por código y de series exactas se sacó de
  `findTraceMatches` a dos funciones internas de Inventario
  (`findLotsByCode`, `findSerialsBySerial`) que usan los dos. Para los
  documentos, la búsqueda global no copia las condiciones del rastreo: usa los
  servicios de detalle, que son la fuente de verdad del alcance.

### Rendimiento

Las fuentes de texto corren en **cada** búsqueda; las de número, solo cuando el
texto es un número de su tipo. Por eso (revisión independiente, 2026-11-19):

- **Una sola revisión de permisos por búsqueda.** El motor carga el sujeto y
  los derechos una vez. Las fuentes de texto (productos, ubicaciones, lotes,
  series, tarimas, proveedores) no llaman a los servicios de lista, que
  volverían a comprobar el permiso cada uno (unas cuatro consultas por
  servicio): leen con **una consulta propia acotada** que repite las
  condiciones de su lista (ver la tabla). Es la excepción a «leer con el
  servicio de la pantalla», limitada a esas seis fuentes; una condición nueva
  en esas listas se repite aquí.
- **El alcance se lee una vez por búsqueda** (`reachOf`, memorizado sobre el
  objeto de la consulta, que es el mismo para todas las fuentes de una
  búsqueda) y lo comparten ubicaciones, lotes, series y tarimas.
- **Ubicaciones en la base**, no en memoria: antes se leía el árbol del almacén
  (hasta 1,000 filas, `MAX_LOCATIONS`) y una ubicación de un almacén más grande
  podía quedar fuera sin aviso. Ahora se filtra por nombre o código en la base
  con tope. El título es el nombre y la línea dice su código y dónde está (un
  nivel arriba): la ruta completa costaría una consulta por nivel.
- Documentos: una lectura por índice único `(organizationId, number)` y, si
  existe, el servicio de la ficha (que sí vuelve a revisar permiso y alcance).
- Índices: productos `(organizationId, status, name, sku, barcode)`;
  proveedores `(organizationId, isSupplier, name, rfc, id)`; series
  `(organizationId, serial)`; tarimas único `(organizationId, code)`; lotes,
  nuevo `lot(organizationId, code)` (migración `20261119110000`, que también
  usa el rastreo); ubicaciones, las del almacén `(organizationId, facilityId,
  …)`: `contains` recorre las ubicaciones de un almacén, que son pocas
  comparadas con productos o movimientos.
- **Costo medido** (una persona sin límite): 63 a 64 consultas por búsqueda
  antes de la revisión (medido con `SHOW GLOBAL STATUS 'Questions'`), 23 a 24
  después, sea cual sea el texto («consulta», seis palabras, una clave exacta;
  «PS-0001» suma el servicio de la ficha si existe). `global-search.int.test.ts`
  cuenta solo las consultas de su propio proceso (evento `query` de Prisma,
  encendido con `WMS_QUERY_EVENTS=1` antes de crear el cliente y nunca en
  producción; el contador del servidor lo mueven otras corridas) y fija un
  máximo de 25.
- Las fuentes corren en paralelo. La pantalla está en `screens()` de la prueba
  de carga; meta p95 < 500 ms.

### Interfaz (KISS)

- Un campo con etiqueta visible «Qué buscas», botón «Buscar» con texto y el botón
  de cámara donde el navegador lo permite. El campo recibe el foco al abrir la
  pantalla y conserva lo buscado.
- Un renglón dice cuántos resultados hubo en total; cada grupo lleva su
  encabezado. Cada fila es un enlace de bloque completo (toda la fila es el
  objetivo); nada de botones de solo ícono.
- «Ver todos» lleva a la lista con lo buscado; si el texto codificado no cabe
  en una dirección (acentos y otras letras crecen al codificarse), lleva las
  primeras palabras que caben.
- Sin descripción que repita el título. Ayuda de una línea bajo el campo.
- Se agrega a `verify-a11y` y `verify-ui`.

## Consecuencias

- Una pantalla de detalle nueva que valga la pena buscar declara su fuente en su
  módulo, con el permiso de su pantalla, y agrega su caso a
  `tests/platform/global-search.int.test.ts`.
- Una fuente que lea con algo distinto al servicio de su pantalla tiene que
  justificarlo aquí (hoy: las seis fuentes de texto, por costo; ver
  «Rendimiento»).
- La búsqueda revela que existe un documento con ese número solo a quien lo
  podría abrir; a los demás les responde igual que si no existiera.
- **Riesgo aceptado: tiempo de respuesta.** Un número que no existe cuesta una
  consulta; uno que existe fuera del alcance cuesta esa más el servicio de la
  ficha. Midiendo tiempos, una persona limitada podría saber que existe un
  documento con ese número en otro almacén de **su** empresa (nunca de otra
  empresa, y los números son consecutivos, así que ya se deduce). El rastreo
  ya tenía lo mismo. Igualarlo costaría correr el servicio en cada búsqueda.

## Decisiones que el fundador puede cambiar

- Una lectura exacta con un solo resultado abre el registro (podría ser un
  ajuste o no hacerse).
- Los documentos se buscan solo por número; buscar por destinatario, referencia
  del cliente o transportista quedó fuera (exige índices nuevos en tablas que
  crecen).
- Las ubicaciones se buscan solo en el almacén activo (como su pantalla) y por
  su nombre o código, no por la ruta.
- Topes: 8 productos, 5 ubicaciones, lotes, series y proveedores, 1 por número.

## Pendiente

- Buscar por referencia del pedido (la del cliente) y por número de guía.
- Olas (`OL-`), conteos, equipos y recetas.
- Resultados de almacenes archivados.
