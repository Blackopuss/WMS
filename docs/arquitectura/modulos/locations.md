# Plataforma: almacenes y ubicaciones (`platform/locations`)

## Responsabilidad

Lo físico que comparten Inventario y Compras: almacenes (varios por empresa,
uno principal), los niveles de cada almacén, el árbol de ubicaciones con su
código y uso, la ubicación «General», la de «Preparación» y la de «En
tránsito» (WMS-19), los límites de una
ubicación (capacidad y restricciones) y el alcance por almacén y zona aplicado
a ubicaciones.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Alta de empresa | `bootstrap.ts` | `ensureDefaultLocation`, `createDefaultLevels` (en la transacción que crea la empresa o el almacén; los scripts importan `@/platform/locations/bootstrap`) |
| Almacenes | `facilities.ts` | `createFacility` (dentro del límite `facilities`), `updateFacility`, `archiveFacility` (solo vacío), `listFacilities`, `switchFacility`, `activeFacilityOf`, `getActiveFacility` |
| Árbol | `hierarchy.ts` | `createLocation`, `editLocation`, `renameLocation`, `moveLocation`, `archiveLocation`, `restoreLocation`, `listLocations`, `saveLocationLevels`, `setStagingLocation`, `setLocationLimits` |
| Reglas puras | `levels.ts`, `limits.ts` | `canContain`, `fitProblem`, rutas (`locationPath`, `LOCATION_PARENTS`), `normalizeLocationCode`, usos `LOCATION_TYPES`; capacidad (`parseCapacity`, `describeCapacity`…) |
| Lugares fijos | `locations.ts`, `staging.ts`, `transit.ts` | `getDefaultLocation` (General del almacén activo), `ensureStagingLocation`, `ensureTransitLocation` (la de tránsito de un almacén, la crea el primer traslado hacia él) y `NOT_TRANSIT` |
| Alcance | `scope.ts` | `assertLocationsInScope`, `locationScopeWhere`, `isLimited`, `isFacilityInScope`, `assertFacilityInScope`, `assertWholeFacilityInScope`, `locationsOutOfScope` |

Todo cambio al árbol pasa por `hierarchy.ts` (bloquea el almacén). Nunca se
borra una ubicación: se archiva. Todo lo que ofrece ubicaciones o crea
documentos usa `activeFacilityOf`. La ubicación de tránsito (`isTransit`)
es del sistema: `listLocations`, los servicios del árbol, las zonas del
alcance y todo lo que ofrece ubicaciones la excluyen (`isTransit: null`), y la
base no deja archivarla, meter nada dentro ni tener ahí otra cosa que
`IN_TRANSIT`. `archiveFacility` rechaza un almacén con traslados en borrador
o en camino.

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

0010 (ubicación inicial), 0011 (jerarquía), 0035 (varios almacenes), 0036
(niveles), 0038 (alcance), 0039 (capacidad y restricciones), 0048
(traslados entre almacenes).
