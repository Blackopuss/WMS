# ADR 0074 — Orden de candados: siempre por la llave primaria

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-76 (corazón, antes de
WMS-29) · Corrige: ADR 0012 (movimientos), ADR 0035 (varios almacenes),
ADR 0072 (sección 4, candados de la rama), ADR 0073 (sección «Candados»),
ADR 0069 (claves de confirmación del motor de procesos) · Origen: hallazgos
del revisor independiente de WMS-28 sobre código ya unido

## Contexto

Cuatro defectos de concurrencia, todos reproducidos con `Promise.all` sobre
los servicios reales y, los tres primeros, confirmados con `SHOW ENGINE
INNODB STATUS` sobre `pruebas` tal cual (commit `ee4f9f1`):

1. **Reubicar contra salida, cambio de estado o liberar un pedido** sobre el
   mismo estante, con productos distintos (los candados de producto no los
   ponen en fila; solo el estante). InnoDB:
   - (1) `SELECT id FROM location WHERE organizationId = ? AND id IN (?, ?)
     … FOR UPDATE` (la reubicación) tiene X en
     `location_organizationId_id_key` y espera X en `PRIMARY`;
   - (2) `INSERT INTO stock_movement_line …` (la salida) tiene X en
     `PRIMARY` y espera S en `location_organizationId_id_key`.
2. **El primer pedido de un almacén contra cambios de almacenes y
   ubicaciones.** InnoDB:
   - (1) `UPDATE facility SET updatedAt = … WHERE organizationId = ?`
     (`changeTree` / `inFacilities`) tiene X en
     `facility_organizationId_id_key` y espera X en `PRIMARY`;
   - (2) `INSERT INTO location … isStaging …` (`ensureStagingLocation`,
     que bloqueó el almacén con `lockRows` de un id) tiene X en `PRIMARY` y
     espera S en `facility_organizationId_id_key`.
3. **Cambiar de almacén activo contra crear o archivar uno.** InnoDB:
   - (1) `UPDATE membership SET activeFacilityId = …` (`switchFacility`)
     tiene X en la fila de la membresía y espera S en
     `facility_organizationId_id_key` (llave foránea compuesta);
   - (2) `UPDATE membership SET activeFacilityId = NULL WHERE
     activeFacilityId = …` (`archiveFacility`) tiene X en
     `facility_organizationId_id_key` (de su `UPDATE facility … WHERE
     organizationId`) y espera la fila de la membresía.
4. **Motor de procesos: la misma clave de confirmación en dos procesos dio
   dos `ok`** (una de cinco corridas). No era un candado.

### La causa de 1 a 3

MySQL decide por su cuenta por qué índice entra una consulta, y las filas de
empresa tienen dos índices únicos con su id: la llave primaria `(id)` y
`(organizationId, id)`, que es además el índice al que apunta toda llave
foránea compuesta (PLT-13).

- `lockRows` con **un** id: `const` por `PRIMARY`. Solo la llave primaria.
- `lockRows` con **varios** ids: `range` por `(organizationId, id)` (o, con
  300 ids en la medición, por `(organizationId, facilityId, id)`, que
  recorre toda la empresa): X en ese índice primero y X en `PRIMARY`
  después.
- `UPDATE … WHERE organizationId = ?` usado como candado: igual, un índice
  secundario primero.
- Insertar o cambiar una fila con llave foránea compuesta: S en
  `(organizationId, id)` de la fila a la que apunta. Lo hacen casi todas las
  escrituras (líneas de movimiento, reservas, tareas, ubicaciones nuevas,
  membresías…), muchas veces sin haber bloqueado esa fila.

Quien tenía la llave primaria y escribía una fila hija pedía el índice
único; quien tenía el índice único (varios ids o un `UPDATE` por empresa)
pedía la llave primaria. Orden contrario: interbloqueo. WMS-75 lo evitó en
un lugar (bloquear la rama de una en una) y WMS-28 agregó `byTenantKey`
(forzar el índice único) para otro; cada lugar nuevo tenía que acordarse.

### La causa de 4

`act` (`src/platform/processes/work.ts`) busca la clave de confirmación y,
si la encuentra, la trata como reintento cuando coinciden persona, **etapa**
y acción. Dos procesos de la misma versión publicada comparten sus etapas
(`process_stage` es de la versión, no del progreso), así que el paso del
primer documento pasaba por reintento del segundo y respondía «Ya quedó
registrado.» (`ok`, `repeated`) sin hacer nada en el segundo. Solo cuando
las dos llegaban exactamente a la vez ninguna veía a la otra, chocaban en
el índice único `(organizationId, idempotencyKey)` y salía `key_reused`;
cuando la primera alcanzaba a confirmar antes de que la segunda buscara,
salían dos `ok`. De ahí lo intermitente. Una prueba secuencial lo
reproduce siempre (falla con el código anterior, ver «Pruebas»).

## Decisión

### 1. `lockRows` siempre por la llave primaria

`lockRows` arma su consulta con `FORCE INDEX (PRIMARY)` (`lockStatement` de
`src/server/tenant-db.ts`), con uno o con muchos ids, en orden de id, en
una sola consulta. Así:

- **Nadie toma X en el índice `(organizationId, id)`.** Las llaves
  foráneas solo piden S ahí, y S con S no se esperan: escribir una fila
  hija nunca espera a quien tiene bloqueada la fila padre.
- Dos transacciones que bloquean las mismas filas, sean una o muchas, se
  encuentran en la misma entrada (la llave primaria) y en el mismo orden
  (id ascendente). Ya no importa cuántos ids lleve la llamada.
- Una fila de otra empresa con uno de esos ids se bloquea solo mientras se
  compara su empresa (READ COMMITTED la suelta en seguida): es lo que ya
  pasaba con un id. No se reporta ni se queda bloqueada.
- `mode: "share"` (`FOR SHARE`) también va por la llave primaria: ahora sí
  choca con un `FOR UPDATE` de la misma fila. Antes, con un índice
  secundario que cubría la consulta, un `FOR SHARE` podía quedarse solo en
  el índice secundario.
- **`byTenantKey` se quitó.** Existía para coincidir con el `UPDATE facility
  … WHERE organizationId` de `changeTree`, que ya no existe. Su único
  usuario (`shareFacility` de `src/modules/production/orders.ts`) toma el
  almacén compartido por la llave primaria, y sigue chocando con
  `changeTree`, que lo tiene en exclusivo por la llave primaria.
- `refuseAvailableInside` (`hierarchy.ts`, WMS-75) vuelve a bloquear toda la
  rama en una sola llamada.

### 2. Una sola puerta a los almacenes

`lockAllFacilities(tx)` (`src/platform/locations/facility-lock.ts`) lee los
ids de los almacenes y los bloquea con `lockRows` (llave primaria, orden de
id); si entre la lectura y el candado se confirmó un almacén nuevo, lo
bloquea en la siguiente vuelta (uno nuevo solo se crea con estos mismos
candados, y su UUIDv7 ordena después de los que ya se tienen). Reemplaza el
`tx.facility.updateMany({ where: {} })` de `changeTree` (`hierarchy.ts`) y
de `inFacilities` (`facilities.ts`), que además cambiaba `updatedAt` de
todos los almacenes en cada cambio del árbol (nadie lo leía).

Orden y forma, para todo el sistema:

| Quién | Cómo | Cuándo |
| --- | --- | --- |
| Crear, editar o archivar un almacén; crear, editar, mover o archivar una ubicación | Exclusivo, todos (`lockAllFacilities`) | Primero; no bloquean productos |
| Crear «Preparación» (`ensureStagingLocation`, al liberar el primer pedido o la primera ola) | Exclusivo, uno | Después de los productos, antes de cualquier ubicación |
| Crear un traslado entre almacenes (y su «En tránsito», `ensureTransitLocation`, que vuelve a tomar el destino que ya tiene) | Exclusivo, los dos | Primero; no bloquea productos |
| Orden de producción (crear, guardar, personas) | Compartido, uno | Primero; no bloquea productos |
| Toda fila con `facilityId` (llave foránea) | S en `(organizationId, id)` | Nunca espera a los anteriores |

Orden global que queda: **productos → almacén → ubicaciones → documento →
contenedor → tareas → capacidad → progreso del proceso**. Una operación que
bloquea productos nunca toma el almacén antes que ellos (ADR 0073); eso
sigue valiendo.

### 3. Clave de confirmación del motor de procesos

Un reintento es la misma persona, **el mismo proceso** (`progressId`), la
misma etapa y la misma acción. La misma clave en otro proceso responde
`key_reused`, haya llegado antes o al mismo tiempo. El índice único
`(organizationId, idempotencyKey)` de `process_step` sigue siendo lo que
impide dos pasos con una clave.

### 4. Nada de reintentos

No se agregó ningún reintento. El único que existía
(`retryingDeadlock` de `src/platform/entitlements/quota.ts`, fuera de una
transacción, para contadores de cupo de empresas anteriores a que el plan
los creara) se queda como estaba: su causa es otra (filas que se crean al
primer uso) y no cambia con esto.

## Auditoría

Se revisaron las 199 llamadas a `lockRows`, todo `FOR UPDATE`/`FOR SHARE`
escrito a mano y todo `updateMany`/`deleteMany` usado como candado.

### `lockRows` con más de un id (todas por la llave primaria desde ahora)

| Tabla | Quién llama (archivo) | Cuántos ids | Con quién se cruzaba antes |
| --- | --- | --- | --- |
| `location` | `registerTransfer` (`movements.ts`), `postTaskTransfer`/`deliverTask` y `createTask` (`tasks.ts`), `changeStockStatus` con destino (`status-change.ts`), `postReceiptEntry` (`receipt-entry.ts`), salida rápida (`quick-exit.ts`), despacho (`shipments.ts`), empaque (`packing.ts`), tarimas (`containers.ts`), devoluciones de cliente (`customer-returns.ts`), al proveedor (`returns.ts`, `return-exit.ts`), desecho (`disposal.ts`), traslados entre almacenes (`facility-transfers.ts`), acomodo (`putaway.ts`), conteos cíclicos (`cycle-counts.ts`), salidas de archivo (`exit-import-apply.ts`), reversas (`movements.ts`), la rama de `refuseAvailableInside` (`hierarchy.ts`) | 2 a cientos | **Toda** entrada, salida, cambio de estado, reserva o tarea de un solo estante (llave primaria + S del índice al escribir su línea). Defecto 1. |
| `product` | salida rápida, despacho, empaque, tarimas, acomodo, olas (`waves.ts`), liberar pedidos (`outbound-orders.ts`), devoluciones, órdenes de producción (`production/orders.ts`), sugerencias (`purchasing/suggestions.ts`), recepciones (`purchasing/receipts.ts`, `receipt-entry.ts`), órdenes y solicitudes de compra (`orders.ts`, `requests.ts`), devoluciones al proveedor (`returns.ts`), conteos (`counts.ts`), importaciones (`import-apply.ts`, `exit-import-apply.ts`), traslados entre almacenes, desecho, reversas | 2 a cientos | Cualquier movimiento de un solo producto que escribe una fila hija del producto (línea, reserva, lote). Mismo patrón que el defecto 1. |
| `facility` | traslados entre almacenes (2), `lockAllFacilities` (todos) | 2 a límite del plan | `ensureStagingLocation`/`ensureTransitLocation` (un id) y toda fila con `facilityId`. Defectos 2 y 3. |
| `outboundOrder` | olas, embarques, cross-docking, pasos de tareas de surtido | 2 a cientos | Escrituras de líneas, reservas y tareas que apuntan al pedido. |
| `warehouseTask` | pasos agrupados de olas (`tasks.ts`) | 2 a cientos | Series de tarea (`warehouse_task_serial`) que apuntan a la tarea. |
| `productionOrder` | pasos de tareas `ISSUE` | 1 a pocos | Líneas y tareas que apuntan a la orden. |
| `container` | despacho y empaque (bultos del pedido o del embarque) | varios | Contenido y eventos que apuntan al contenedor. |
| `locationCapacity` | `checkPlacement` (`placement.ts`) | destino y ancestros | Nada la referencia; consistente de todos modos. |
| `storedFile` | evidencia (`files/evidence.ts`) | hasta el tope por vez | Fotos que apuntan al archivo. |
| `customField` | campos personalizados (`custom-fields/fields.ts`) | varios | Valores que apuntan al campo. |
| `purchaseOrder` y otras con `[id]` | un id | 1 | Ya iban por la llave primaria. |

### Candados escritos a mano o con `UPDATE`

| Dónde | Qué | Decisión |
| --- | --- | --- |
| `changeTree` (`hierarchy.ts`), `inFacilities` (`facilities.ts`) | `UPDATE facility … WHERE organizationId` como candado de todos los almacenes | Reemplazado por `lockAllFacilities` (defectos 2 y 3). |
| `lockOrganization`, `lockOwner`, `bootstrap.ts`, `payments.ts`, `modules.ts`, `provisioning.ts` | `SELECT … FROM organization WHERE id = ? FOR UPDATE` | Sin cambio: `organization` tiene una sola entrada (su llave primaria, a la que apunta también la llave foránea `organizationId`). |
| `organizations.ts` | `SELECT … FROM user WHERE id = ? FOR UPDATE` | Sin cambio, mismo motivo. |
| `jobs/queue.ts` | `FOR UPDATE SKIP LOCKED` por id | Sin cambio: un id, por la llave primaria; no espera. |
| `throttle.ts` | candados de intentos por llave | Sin cambio: tabla propia sin llaves foráneas compuestas. |
| `processes/config.ts` | `processVersion.update` por id como candado | Sin cambio: por la llave primaria. |
| `serialUnit.updateMany` (`shipments.ts`, `containers.ts`), `warehouseTask.updateMany` (`production/orders.ts`) con `id: { in }` | Escrituras de filas ya protegidas | Sin cambio: corren con el candado del producto (series) o de las tareas (ya tomado por la llave primaria), así que nadie más llega a esas filas. |
| `membership.updateMany` (`switchFacility`, `archiveFacility`) | Escrituras, no candados | Sin cambio: con el almacén por la llave primaria ya no esperan en círculo (defecto 3). |

## Costo medido

Tabla `location` con 100,000 filas (200 empresas de 500), 200 transacciones
`START TRANSACTION; SELECT … FOR UPDATE; COMMIT` por caso, READ COMMITTED,
MySQL 9.4 local, tiempo por transacción incluido el cliente:

| Ids | Antes (índice que elige MySQL) | Ahora (`PRIMARY`) |
| --- | --- | --- |
| 1 | 0.61 ms (`PRIMARY`) | 0.76 ms (mismo plan; ruido) |
| 10 | 1.05 ms (`organizationId_id`) | 0.90 ms |
| 50 | 2.01 ms (`organizationId_id`) | 1.41 ms |
| 300 | 6.22 ms (`organizationId_facilityId_id`, recorre la empresa) | 4.25 ms |

Una sola consulta, igual que antes: sin viajes de más. Con muchos ids es
más barato porque ya no lee un índice secundario y después la llave
primaria. `lockAllFacilities` agrega una lectura de los ids de los
almacenes (unos cuantos por empresa) antes del candado.

## Pruebas

- `tests/server/lock-order.int.test.ts`: reubicar en los dos sentidos
  contra salida, cambio de estado y liberar un pedido (productos distintos,
  mismos estantes, 10 rondas); salida rápida de 12 líneas contra
  reubicaciones de esos productos (6 rondas); entregar 4 tareas en sentidos
  contrarios a la vez contra una salida rápida (6 rondas); el primer pedido
  de un almacén nuevo, dos a la vez, contra `editLocation`,
  `createLocation`, `createFacility` y `archiveFacility` (6 rondas);
  `switchFacility` contra crear y archivar almacenes (10 rondas). Cero
  errores crudos y `reconcileStock` vacío. Con el código anterior fallan los
  casos 1, 2 y 3 por el error 1213.
- `tests/platform/processes.int.test.ts`: la misma clave en un segundo
  proceso después de confirmar el primero responde `key_reused` (falla con
  el código anterior: daba `ok`), el reintento real en el primero sigue
  siendo `repeated`, y 50 rondas de la misma clave en dos procesos a la vez
  dan exactamente un `ok`.
- `src/server/tenant-db.test.ts`: la consulta de `lockRows` fuerza la llave
  primaria con 1, 2 y 300 ids, en los dos modos.
- Siguen pasando las mezclas de `tests/production/orders.int.test.ts` y
  `tests/platform/location-limits.int.test.ts`.

## Consecuencias

- **Regla nueva** (para `AGENTS.md`): toda fila de empresa se bloquea con
  `lockRows`, que va siempre por la llave primaria; nunca un `UPDATE` o
  `DELETE … WHERE organizationId` como candado ni otro índice forzado. Las
  llaves foráneas toman S en `(organizationId, id)` y nada compite con ellas
  en exclusivo. Los almacenes se bloquean solo por las puertas de la tabla
  de arriba.
- **Lo que deja de pasar por casualidad.** El `UPDATE facility … WHERE
  organizationId` de archivar un almacén esperaba, sin que nadie lo hubiera
  pedido, a una escritura en curso de una fila con ese `facilityId` (un
  pedido, un embarque, una solicitud), solo cuando esa escritura llegaba
  primero; si llegaba después, el documento se creaba de todos modos en el
  almacén ya archivado. Tampoco cubría las existencias (un movimiento no
  apunta al almacén). Ahora tampoco cubre el primer caso: crear un documento
  en el mismo instante en que se archiva su almacén nunca estuvo protegido
  por un candado explícito. Si se quiere, cada documento con `facilityId`
  tomaría el almacén compartido antes de crearse (como las órdenes de
  producción); se deja como pendiente, no se hizo aquí porque cambia el
  orden de muchos servicios.
- Un `lockRows` sobre muchas filas sigue siendo una sola consulta; no hay
  tope nuevo.

## Lo que queda

- El pendiente de arriba (documentos creados mientras se archiva su
  almacén).
- `retryingDeadlock` de cupos (anterior a este paso, fuera de transacción).
- Las pantallas no cambian; no se revisaron en navegador.
