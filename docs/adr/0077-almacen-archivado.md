# ADR 0077 — Un almacén archivado no recibe existencias ni documentos

Fecha: 2026-11-16 (revisión: 2026-11-17) · Estado: aceptada · Paso: WMS-82 (corazón) · Corrige:
ADR 0035 (varios almacenes), ADR 0074 (pendientes) · Origen: hallazgos del
revisor independiente de WMS-76 sobre código ya unido

## Contexto

Medido por el revisor de WMS-76 con `Promise.all` sobre los servicios
reales:

1. **Un almacén archivado recibía existencias.** `archiveFacility` solo
   marcaba la fila del almacén; sus ubicaciones seguían activas y ningún
   movimiento leía `facility.archivedAt`. En secuencia, archivar y después
   registrar una entrada en un estante de ese almacén respondían `ok` las
   dos; en carrera, también, en todas las rondas. El almacén quedaba
   archivado con existencias que ningún almacén activo muestra.
2. **Un almacén quedaba archivado con documentos creados mientras se
   archivaba** (pedido, embarque, solicitud, incidencia…): 26 a 32 de 80
   rondas de `archiveFacility` contra crear un pedido. Crear un documento
   solo lee el almacén activo (`activeFacilityOf`, sin candado) y su llave
   foránea toma un candado compartido en `(organizationId, id)`, que nunca
   espera al candado de `archiveFacility` en la llave primaria (ADR 0074).
3. `lockAllFacilities` suponía que un almacén nuevo tiene un id mayor que los
   que ya bloqueó. Con varias instancias y relojes desfasados no es seguro: un
   almacén nuevo con id menor se bloqueaba fuera de orden.

## Decisión

Dos candados que ya existían ponen en fila a quien archiva con quien mete
existencias o crea un documento, sin agregar un candado nuevo al camino de los
movimientos:

### 1. Archivar un almacén archiva sus ubicaciones (existencias)

Todo movimiento ya bloquea las ubicaciones a las que mete existencias
(`lockRows(tx, "location", …)`, INV-16) y ya rechaza una ubicación archivada
con su mensaje (««X» está archivada. Elige otra ubicación.»). Por eso
`archiveFacility`, con todos los almacenes bloqueados (como hoy):

1. bloquea **todas** las ubicaciones del almacén por la llave primaria, en una
   sola llamada y **sin esperar** (`lockRows(…, { nowait: true })`, `FOR
   UPDATE NOWAIT`). Si alguna está tomada por una operación en curso responde
   «Hay movimientos en curso en este almacén. Intenta de nuevo en un momento.»
   y no escribe nada;
2. con esos candados vuelve a contar lo que lo impide (lectura nueva, READ
   COMMITTED): lo que acaba de entrar ya se ve;
3. archiva el almacén y después cada una de sus ubicaciones activas.

Así, o gana archivar (la operación espera la ubicación, la lee archivada y se
rechaza con su mensaje) o gana la operación (archivar no toma la ubicación o
ve lo que entró, y se rechaza). **`NOWAIT` es lo que evita un orden nuevo:**
archivar nunca espera una ubicación, así que no cierra un círculo con un
movimiento que bloquea dos ubicaciones en llamadas separadas (una entrada que
después crea su tarea de acomodo hacia otro estante). Archivar es raro y lo
hace una persona: reintentarlo es aceptable; un movimiento nunca se rechaza
por esta razón.

La entrada manual y el saldo de un producto en «General» no bloqueaban
«General» (nunca se archivaba): ahora la resuelven primero y la bloquean como
cualquier otra ubicación. Si «General» se archivó con su almacén mientras la
entrada esperaba, responden «Tu almacén se archivó mientras registrabas.
Vuelve a intentarlo: quedará en el almacén en el que trabajas ahora.».
Consecuencia: dos entradas de productos distintos a «General» del mismo
almacén ya no corren en paralelo, igual que dos entradas al mismo estante
(medido con `Promise.all`: 20 entradas a la vez de productos distintos
tardan unos 555 ms hacia «General» contra unos 229 ms hacia 20 estantes
distintos).

**Un disparador que lee otra tabla es un candado.** Un `SELECT` dentro de un
disparador toma un candado compartido sobre las filas que lee, también en
READ COMMITTED (lo midió el revisor en `performance_schema.data_lock_waits`).
Por eso **solo se permite un disparador que lee otra tabla si todo servicio
que escribe esa fila ya tomó ese mismo candado antes, en el orden global**
(ADR 0074); si no, es un candado escondido fuera de orden.

La migración `20261117110000` agregó disparadores en los documentos y en
tareas, conteos y contenedores que leían el almacén o la ubicación. Esos
cerraban círculos con la operación diaria, y la migración `20261117120000`
los quita. Lo que encontró el revisor (20 de 20 o 30 de 30 rondas con 1213,
y 0 sin el disparador):

- `warehouse_task_archived_location`: entregar un acomodo hacia el estante E
  (bloquea [E, M]) contra una entrada de otro producto al muelle M, que al
  insertar su tarea de acomodo hacia E pedía E compartido después de M; y
  entregar un surtido de cross-docking del muelle a «Preparación» contra una
  entrada al mismo muelle que reparte a otro pedido.
- `customer_return_archived_facility`: el primer surtido de un almacén
  (producto → almacén en exclusivo por «Preparación» → tarea que pedía el
  estante) contra una devolución de cliente sin pedido en ese estante
  (producto → estante → `customer_return`, que pedía el almacén).

Se quedan, porque el servicio ya tiene el candado que leen:

- `stock_balance_archived_location_insert|update` (antes de insertar o de
  subir la cantidad de un saldo): lee la ubicación con candado compartido
  por su llave primaria y rechaza una archivada. Todo servicio que mete
  existencias bloquea antes esa ubicación en exclusivo (INV-16; lo mismo
  hacía ya `stock_balance_transit_rule`). Bajar un saldo no se revisa.
- `location_archived_facility_insert|update`: una ubicación de un almacén
  archivado nace y queda archivada, y «General» y la de tránsito solo se
  archivan con su almacén. Leen el almacén; toda escritura de `location`
  (`changeTree`, `inFacilities`, `ensureStagingLocation`,
  `ensureTransitLocation`, el alta de la empresa) ocurre con su almacén ya
  bloqueado en exclusivo. La regla de «General» y tránsito vivía en los CHECK
  `location_general_check` y `location_transit` («nunca archivada»), que no
  pueden mirar el almacén: la migración los vuelve a crear sin la condición
  de `archivedAt` (los relaja; ninguna fila que antes pasaba deja de pasar).
  Por eso `archiveFacility` marca primero el almacén y después sus
  ubicaciones.

Estos disparadores no dan el mensaje para la persona: lo dan los servicios.
Los documentos no tienen disparador: los sostienen los servicios del punto 2.

### 2. Un documento toma su almacén compartido antes de nacer

`holdOpenFacility(tx, facilityId)` (`facility-lock.ts`): `lockRows(tx,
"facility", [id], { mode: "share" })` y lee `archivedAt` bajo ese candado;
responde `null` si el almacén no existe o se archivó. Lo llama todo servicio
que crea un documento con `facilityId` **que no bloquea antes una ubicación de
ese almacén**:

| Documento | Servicio | Dónde toma el almacén |
| --- | --- | --- |
| Pedido de salida | `createOutboundOrder` | Primero (no bloquea productos) |
| Pedido de salida por la API | `createOutboundDraft` | Después de los productos |
| Pedidos importados | `confirmOutboundImport` | Después de la fila de la importación (nadie que tenga el almacén en exclusivo espera esa fila) |
| Embarque | `createShipment` | Primero, antes de sus pedidos |
| Orden de compra | `createPurchaseOrder` | Primero, dentro de su transacción |
| Solicitud de compra | `createPurchaseRequest` | Primero |
| Programa de conteo | `createCountProgram` | Primero, antes de su ubicación raíz |
| Incidencia | `reportIncident` | Después de la búsqueda por clave, antes de escribir |
| Equipo | `createEquipment` | Después de revisar el alcance, antes del tipo |
| Llave de la API | `createApiKey` | **Antes** del candado de la empresa (lectura con candado por llave primaria en la transacción de `db`): archivar tiene los almacenes y después escribe filas que apuntan a la empresa (su línea de bitácora); tomar la empresa primero cerraba un círculo (lo encontró la carrera de esta prueba, 1213) |
| Devolución de cliente | `receiveCustomerReturn` | Después de los productos y antes de su ubicación (revisión, A1) |
| Orden de compra desde una solicitud | `convertPurchaseRequest` | Después de los productos y antes de la solicitud: `archiveFacility` cuenta las órdenes antes que las solicitudes, y una conversión confirmada entre las dos cuentas dejaba una orden abierta en un almacén archivado |
| Orden de producción | `shareFacility` (crear, guardar borrador, cambiar personas, aceptar una solicitud) | Primero, como ya lo hacía; ahora además rechaza un almacén archivado |
| Solicitud de producción | `submitProductionRequest` | Después de la empresa compartida y **antes** de la membresía: `archiveFacility` toma el almacén en exclusivo y después las membresías que trabajan ahí, así que tomar la membresía antes que el almacén cerraría un círculo |

No lo necesitan, porque nacen de algo que ya impide archivar y que **sigue
abierto antes y después** de crearlos (así no importa en qué orden cuente
`archiveFacility`): la **ola** (agrupa pedidos abiertos del almacén, que
siguen abiertos). Una conversión no cumple eso (la solicitud se cierra en la
misma transacción que abre la orden), por eso `convertPurchaseRequest` sí
toma el almacén.

Archivar toma todos los almacenes en exclusivo (`lockAllFacilities`), así que
espera a quien tiene el suyo compartido y, al seguir, ve el documento abierto
y se rechaza; quien llega después ve el almacén archivado y se rechaza.

Ya ponían en fila a su almacén, sin cambio: el traslado entre almacenes (toma
sus dos almacenes en exclusivo y lee `archivedAt`), la terminal compartida
(toma el suyo en exclusivo) y los tipos de equipo. Los documentos que nacen
bloqueando una ubicación del almacén quedan cubiertos por el punto 1 (archivar
toma esa ubicación sin esperar y la deja archivada):

- **Tareas:** toda tarea nace bloqueando su origen o de un documento abierto
  que ya impide archivar. `createTask` bloquea origen y destino; el acomodo y
  el surtido de cross-docking nacen dentro de la entrada o la recepción, que
  bloquearon el lugar de paso de origen; la reposición bloquea origen y
  destino; el surtido nace de un pedido liberado y «Surtir a producción» de
  una orden liberada, los dos abiertos. Y una tarea abierta (desde o hacia el
  almacén) impide archivar.
- **Conteos:** el manual bloquea su ubicación y la revisa; la ronda de
  conteos bloquea las ubicaciones elegidas y vuelve a revisar que no estén
  archivadas.
- **Contenedores:** armar bloquea la ubicación; un bulto de empaque nace de
  un pedido abierto.
- **Reglas de reposición y programas de conteo de una zona:** bloquean su
  ubicación.

Las solicitudes de autorización y el progreso de un proceso nacen dentro de
la operación de su documento.

**Orden:** productos → almacén (compartido) → ubicaciones → documento, el de
ADR 0074. Nadie que tome el almacén compartido toma después «Preparación» en
exclusivo del mismo almacén (dos transacciones que suben de compartido a
exclusivo sobre la misma fila se interbloquean): ningún servicio de la tabla
libera pedidos ni crea «Preparación».

`holdOpenFacility` lee `archivedAt` con la misma consulta que toma el candado
(`shareFacilityRow` de `@/server`): una lectura con candado ve lo último
confirmado aunque la transacción sea REPEATABLE READ y ya haya leído algo
antes.

### 3. Qué impide archivar

Lo de antes (existencias en cualquier estado, pedidos sin terminar, tareas
abiertas, tarimas armadas, traslados sin terminar, terminales) más:
embarques sin despachar, órdenes de compra del almacén sin cerrar (borrador,
enviada, parcial), solicitudes de compra abiertas (borrador, enviada, por
atender), conteos abiertos, apartados vigentes en sus ubicaciones,
incidencias abiertas o en atención, olas abiertas, órdenes de producción
abiertas, solicitudes de producción por atender, solicitudes de autorización
pendientes, equipos sin dar de baja y llaves de la API vigentes (sin revocar
y sin vencer: una vencida no se puede revocar desde la pantalla). Cada uno con
su mensaje; el primero que aplica responde.

Los programas de conteo no lo impiden: la ronda ya no genera conteos en un
almacén archivado.

### 4. `lockAllFacilities` en orden aunque llegue un id menor

Si en la segunda vuelta aparece un almacén con id menor que el mayor ya
bloqueado, lanza `FacilitySetChanged` sin bloquearlo; `inFacilities` y
`changeTree` repiten la transacción desde el principio (hasta tres veces).
No es un reintento ante un interbloqueo: es soltar todo para volver a tomar
en orden. Con una sola instancia nunca pasa.

### 5. Lo que ya existe

Una empresa que hoy tiene un almacén archivado con existencias o documentos
abiertos (nacidos por el defecto) **no se repara**: no se tocan saldos, ni
movimientos, ni documentos. La migración solo archiva las ubicaciones
activas de los almacenes ya archivados (con la fecha de archivo del almacén),
para que la regla «almacén archivado ⇒ ubicaciones archivadas» valga también
para ellos. Sus existencias siguen contando en los totales de la empresa y
`reconcileStock`/`reconcileValue` no cambian (comparan saldos contra
movimientos, no miran si la ubicación está archivada).

**Esas existencias quedan atrapadas** (lo señaló el revisor): la base dejaría
bajar el saldo, pero los servicios rechazan toda ubicación archivada
(`registerExit` y `registerAdjustment` responden ««Z» está archivada»;
`registerTransfer` «es de otro almacén»). Antes tampoco se veían ni se
ofrecían en ninguna pantalla; solo se podían sacar armando a mano el id de la
ubicación. No hay una forma limpia dentro de este paso: dejar activas solo
las ubicaciones con saldo rompería la regla que sostiene todo lo demás (un
almacén archivado con ubicaciones activas vuelve a recibir existencias), y una
excepción en las salidas para ubicaciones archivadas abriría un camino que el
resto de la regla cierra. **Hoy no hay servidor ni datos reales** (el WMS no
se ha desplegado), así que esto solo puede pasar en bases de desarrollo.
**Propuesta:** un paso propio «Reactivar un almacén» (servicio que, con todos
los almacenes bloqueados, quita el archivo del almacén y de sus ubicaciones
—«General» y tránsito incluidas—, con bitácora); con él, lo heredado se
saca o se traslada como en cualquier almacén y después se vuelve a archivar.
Reactivar un almacén por SQL a mano dejaría «General» y sus ubicaciones
archivadas (no hay servicio que las reactive y `restoreLocation` rechaza una
ubicación de un almacén archivado, pero no reactiva «General»).

## Costo

- Movimientos: ningún candado nuevo. El disparador del saldo hace una
  lectura por llave primaria con candado compartido sobre una fila que la
  transacción ya tiene bloqueada. Medido en local: 300 movimientos (150
  entradas y 150 salidas) tardaron 9.08, 9.28 y 9.61 s con el disparador y
  9.91, 8.93 y 9.43 s sin él, alternando: la diferencia queda dentro del
  ruido.
- Documentos sin ubicación: un candado compartido por llave primaria. Varios
  documentos del mismo almacén no se esperan entre sí; solo esperan a quien
  cambia almacenes o el árbol de ubicaciones (raro y breve).
- Archivar: bloquea todas las ubicaciones del almacén (una consulta) y cuenta
  dieciocho cosas. Es una operación de administración.
- Entradas a «General»: ahora se ponen en fila entre sí dentro de un almacén
  (ver punto 1).

## Consecuencias

- Una operación que mete existencias **bloquea su ubicación antes de leerla**
  y rechaza una archivada (como hoy); no hay otra revisión de almacén que
  agregar.
- Un servicio nuevo que crea un documento con `facilityId` sin bloquear antes
  una ubicación de ese almacén llama `holdOpenFacility` (después de sus
  productos, antes de cualquier ubicación y antes de un candado de empresa),
  agrega su cuenta a `refuseWhatStaysOpen` y su carrera a
  `tests/platform/archived-facility.int.test.ts`.
- Un disparador nuevo que lea otra tabla es un candado: solo si todo servicio
  que escribe esa fila ya tomó ese candado antes, en el orden global.
- Nadie toma una ubicación con `NOWAIT` fuera de `archiveFacility`.

## Pendiente

- Reactivar un almacén (paso propio, punto 5): es la salida para lo heredado.
- Mostrar en Configuración › Almacenes un almacén archivado con existencias
  heredadas (hoy solo se ve en la base y en los totales).
- Sin carrera en las pruebas: terminal compartida (toma su almacén en
  exclusivo, como antes), importación de pedidos, autorizaciones, entrega de
  reposición, «Surtir a producción» y `submitProductionRequest` contra
  archivar.
