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
| Toda fila con `facilityId` | Compartido en `(organizationId, id)` por su llave foránea | Nunca espera a los anteriores |

Una operación que bloquea productos nunca toma el almacén antes que ellos.

## Cómo comprobarlo

Una operación nueva que bloquee filas que otra también bloquea agrega su
caso a `tests/server/lock-order.int.test.ts` (o a la prueba de su módulo):
`Promise.all` sobre los servicios reales, varias rondas, cero errores
crudos y, si mueve existencias, `reconcileStock` vacío. Una prueba que
falla «a veces» por interbloqueo es un defecto: se mira `SHOW ENGINE
INNODB STATUS` (sección «LATEST DETECTED DEADLOCK») para ver qué índice
tenía y pedía cada transacción. No se agregan reintentos para tapar un
interbloqueo.
