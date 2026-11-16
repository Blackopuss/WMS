# Plataforma: almacenes y ubicaciones (`platform/locations`)

## Responsabilidad

Lo físico que comparten Inventario y Compras: almacenes (varios por empresa,
uno principal), los niveles de cada almacén, el árbol de ubicaciones con su
código y uso, la ubicación «General», la de «Preparación» y la de «En
tránsito» (WMS-19), los límites de una
ubicación (capacidad y restricciones) y el alcance por almacén y zona aplicado
a ubicaciones.

Los usos «Cuarentena» y «Restauración» (WMS-75) no admiten existencias
disponibles, ni en ellos ni en lo que contienen: `editLocation` rechaza
cambiar a uno de esos usos, y `moveLocation` meter algo dentro de uno de
ellos, mientras la ubicación o algo dentro tenga saldo disponible (bloquea
antes las filas de toda la rama en una llamada de `lockRows`, que va por la
llave primaria como los movimientos, ADR 0072 y 0074); lo que llega después
lo detiene `checkPlacement` de Inventario.

Los cambios de almacenes y del árbol de ubicaciones (`inFacilities` y
`changeTree`) bloquean todos los almacenes con `lockAllFacilities`
(`facility-lock.ts`), por la llave primaria; «Preparación» y «En tránsito»
bloquean solo su almacén, después de los productos. Detalle en
[../candados.md](../candados.md).

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Alta de empresa | `bootstrap.ts` | `ensureDefaultLocation`, `createDefaultLevels` (en la transacción que crea la empresa o el almacén; los scripts importan `@/platform/locations/bootstrap`) |
| Almacenes | `facilities.ts` | `createFacility` (dentro del límite `facilities`), `updateFacility`, `archiveFacility` (solo vacío y sin nada abierto; archiva también sus ubicaciones, WMS-82), `listFacilities`, `switchFacility`, `activeFacilityOf`, `getActiveFacility` |
| Árbol | `hierarchy.ts` | `createLocation`, `editLocation`, `renameLocation`, `moveLocation`, `archiveLocation`, `restoreLocation`, `listLocations`, `saveLocationLevels`, `setStagingLocation`, `setLocationLimits` |
| Reglas puras | `levels.ts`, `limits.ts` | `canContain`, `fitProblem`, rutas (`locationPath`, `LOCATION_PARENTS`), `normalizeLocationCode`, usos `LOCATION_TYPES`; capacidad (`parseCapacity`, `describeCapacity`…) |
| Lugares fijos | `locations.ts`, `staging.ts`, `transit.ts` | `getDefaultLocation` (General del almacén activo), `ensureStagingLocation`, `ensureTransitLocation` (la de tránsito de un almacén, la crea el primer traslado hacia él) y `NOT_TRANSIT` |
| Campos personalizados | `custom-values.ts` | `getLocationCustomValues` (WMS-58: campos y valores de las ubicaciones dentro del alcance de la persona; la única forma de leerlos). `createLocation`/`editLocation` reciben `customFields` y los validan con [custom-fields](custom-fields.md) en su transacción |
| Almacén de un documento | `facility-lock.ts` | `holdOpenFacility` (WMS-82: el almacén compartido y si sigue activo, antes de crear un documento con `facilityId`) y `ARCHIVED_FACILITY_MESSAGE` |
| Alcance | `scope.ts` | `assertLocationsInScope`, `locationScopeWhere`, `isLimited`, `isFacilityInScope`, `assertFacilityInScope`, `assertWholeFacilityInScope`, `locationsOutOfScope` |

Todo cambio al árbol pasa por `hierarchy.ts` (bloquea el almacén). Nunca se
borra una ubicación: se archiva. Todo lo que ofrece ubicaciones o crea
documentos usa `activeFacilityOf`. La ubicación de tránsito (`isTransit`)
es del sistema: `listLocations`, los servicios del árbol, las zonas del
alcance y todo lo que ofrece ubicaciones la excluyen (`isTransit: null`), y la
base no deja archivarla (salvo con su almacén), meter nada dentro ni tener
ahí otra cosa que `IN_TRANSIT`. `archiveFacility` rechaza un almacén con
existencias, apartados, tareas, tarimas, traslados, pedidos, embarques,
órdenes y solicitudes de compra, conteos, olas, órdenes y solicitudes de
producción, autorizaciones pendientes, incidencias, terminales, equipos o
llaves de la API abiertos, y archiva el almacén junto con todas sus
ubicaciones (incluidas «General» y la de tránsito), bajo sus candados y sin
esperarlos (WMS-82, ADR 0077): un almacén archivado no recibe existencias ni
documentos, y la base lo repite (`stock_balance_archived_location_*`,
`location_archived_facility_*`, `<tabla>_archived_facility`). Una ubicación
de un almacén archivado no se reactiva.

## Permisos

`inventory.location.read|create|update|archive` (son del módulo Inventario) y
`platform.organization.update` para elegir la ubicación de preparación.

## Tablas

`facility`, `location_level`, `location`, `location_capacity`,
`location_restriction`. El alcance está en `membership_scope`
([authorization](authorization.md)).

## Ajustes y trabajos

Ninguno propio; el modo de capacidad (`inventory.capacity.mode`) es un ajuste
de [inventory](inventory.md), que es quien mete existencias.

## ADR

0056 (campos personalizados), 0010 (ubicación inicial), 0011 (jerarquía), 0035 (varios almacenes), 0036
(niveles), 0038 (alcance), 0039 (capacidad y restricciones), 0048
(traslados entre almacenes), 0072 (uso «Restauración» y cambio de uso con
existencias disponibles), 0074 (orden de candados), 0077 (almacén archivado).
