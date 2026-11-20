# Candados y su orden

Cómo se ponen en fila las operaciones que cambian lo mismo. Decisión en
[ADR 0074](../adr/0074-orden-de-candados.md) (WMS-76); antes, ADR 0012
(movimientos) y la regla INV-19B de `AGENTS.md`.

## `lockRows`

`lockRows(tx, modelo, ids, { mode })` de `@/server` es la única forma de
bloquear filas de empresa (el cliente de empresa no permite SQL directo):

```sql
SELECT id FROM `<tabla>` FORCE INDEX (PRIMARY)
WHERE organizationId = ? AND id IN (?, …) ORDER BY id FOR UPDATE   -- o FOR SHARE
```

- **Siempre por la llave primaria**, con uno o con muchos ids, en orden de
  id y en una sola consulta. Sin `FORCE INDEX`, MySQL entraba con varios ids
  por el índice único `(organizationId, id)` y lo bloqueaba en exclusivo
  antes que la llave primaria; ese índice es el que revisa toda llave
  foránea compuesta (un candado compartido al insertar una línea, una
  reserva, una tarea…), y dos transacciones se esperaban en círculo.
- Nadie toma en exclusivo el índice `(organizationId, id)`: las llaves
  foráneas lo toman compartido y nunca esperan a quien bloqueó la fila.
- Devuelve los ids que existen en la empresa; una fila de otra empresa con
  ese id no se queda bloqueada.
- `mode: "share"`: `FOR SHARE`, para quien solo necesita que la fila no
  cambie mientras decide; nunca se toma y después se escribe la misma fila.
- La transacción se abre con `LOCKING_TRANSACTION` (READ COMMITTED) y toma
  sus candados antes de leer lo que decide.
- Nunca un `UPDATE` o `DELETE … WHERE organizationId` como candado: entra
  por un índice secundario que elige MySQL.

## Orden global

**productos → almacén → ubicaciones → documento → contenedor → tareas →
capacidad → progreso del proceso**, y dentro de cada tabla en orden de id
(`lockRows` lo hace). Las variantes de cada documento (por ejemplo
pedido → tarea en el surtido, orden de compra después de las ubicaciones en
una recepción) están en el documento de su módulo.

## Almacenes

Una sola puerta, en `src/platform/locations/facility-lock.ts`:

| Quién | Cómo | Cuándo |
| --- | --- | --- |
| Crear, editar o archivar un almacén; crear, editar, mover o archivar una ubicación (`inFacilities`, `changeTree`) | Exclusivo, todos (`lockAllFacilities`) | Primero; no bloquean productos |
| Crear «Preparación» (`ensureStagingLocation`, al liberar el primer pedido o la primera ola) | Exclusivo, uno | Después de los productos, antes de cualquier ubicación |
| Crear un traslado entre almacenes (y su «En tránsito», `ensureTransitLocation`, que vuelve a tomar el destino que ya tiene) | Exclusivo, los dos | Primero; no bloquea productos |
| Crear, guardar o cambiar personas de una orden de producción | Compartido, uno | Primero |
| Crear un documento con `facilityId` sin bloquear antes una ubicación de ese almacén (`holdOpenFacility`, WMS-82: pedido, embarque, orden y solicitud de compra, conversión de una solicitud, programa de conteo, incidencia, equipo, llave de la API, devolución de cliente, solicitud de producción) | Compartido, uno, y lee `archivedAt` con la misma consulta | Después de los productos (si los hay), antes de cualquier ubicación y antes de un candado de empresa; la solicitud de producción, entre la empresa compartida y la membresía |
| Toda fila con `facilityId` | Compartido en `(organizationId, id)` por su llave foránea | Nunca espera a los anteriores |

Una operación que bloquea productos nunca toma el almacén antes que ellos.
Quien tomó un almacén compartido no lo vuelve a pedir en exclusivo (por
ejemplo, creando «Preparación»): dos así se esperan en círculo.

## Archivar un almacén (WMS-82, ADR 0077)

`archiveFacility`, con todos los almacenes en exclusivo, bloquea **todas las
ubicaciones del almacén sin esperar** (`lockRows(…, { nowait: true })`, `FOR
UPDATE NOWAIT`; `isLockBusy` reconoce el rechazo): si una está tomada
responde «Hay movimientos en curso en este almacén. Intenta de nuevo en un
momento.». Con todas tomadas, cuenta lo que lo impide y archiva el almacén y
sus ubicaciones. Todo movimiento bloquea las ubicaciones a las que mete
existencias y rechaza una archivada, así que nada entra a un almacén
archivado sin agregar un candado al camino de los movimientos. No esperar es
lo que evita el círculo con una operación que bloquea dos ubicaciones en
llamadas separadas (una entrada y, al final, el estante de su tarea de
acomodo). Nadie más usa `nowait`, salvo reactivar.

## Reactivar un almacén (WMS-85, ADR 0088)

`reactivateFacility` sigue el mismo camino: todos los almacenes en exclusivo
(`inFacilities`), después las ubicaciones que va a reactivar por la llave
primaria y **sin esperar** (si alguna está tomada responde «intenta de
nuevo»), y escribe almacén → ubicaciones → bitácora. No toma productos. El
límite del plan se cuenta bajo los candados de almacén, así que reactivar,
crear y archivar van en fila.

## Un disparador que lee otra tabla es un candado

Un `SELECT` dentro de un disparador toma un candado compartido sobre las
filas que lee, también en READ COMMITTED. Un disparador nuevo que lea otra
tabla solo se permite si **todo servicio que escribe esa fila ya tomó ese
mismo candado antes, en el orden global**; si no, es un candado escondido
fuera de orden (WMS-82: los disparadores de documentos y de tareas que leían
el almacén o la ubicación interbloqueaban la entrega de un acomodo con una
entrada al mismo muelle, y el primer surtido de un almacén con una devolución
de cliente; se quitaron). Quedan `stock_balance_archived_location_*` (lee la
ubicación, que todo servicio que mete existencias ya bloqueó) y
`location_archived_facility_*` (lee el almacén, que toda escritura de
`location` ya bloqueó). Los que ya existían antes (por ejemplo
`stock_balance_transit_rule`, que lee la ubicación) cumplen la misma regla.

`lockAllFacilities` lanza `FacilitySetChanged` si en la segunda vuelta
aparece un almacén con id menor que uno ya tomado (otra instancia con el
reloj atrasado); `inFacilities` y `changeTree` repiten la transacción completa
(`retryingFacilitySet`, hasta tres veces) para volver a tomar en orden.

## Cómo comprobarlo

Una operación nueva que bloquee filas que otra también bloquea agrega su
caso a `tests/server/lock-order.int.test.ts` (o a la prueba de su módulo):
`Promise.all` sobre los servicios reales, varias rondas, cero errores
crudos y, si mueve existencias, `reconcileStock` vacío. Una prueba que
falla «a veces» por interbloqueo es un defecto: se mira `SHOW ENGINE
INNODB STATUS` (sección «LATEST DETECTED DEADLOCK») para ver qué índice
tenía y pedía cada transacción. No se agregan reintentos para tapar un
interbloqueo.
