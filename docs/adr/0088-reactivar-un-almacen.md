# ADR 0088 — Reactivar un almacén archivado

Fecha: 2026-11-20 · Estado: aceptada · Paso: WMS-85 (corazón) · Completa:
ADR 0077 (almacén archivado, punto 5) · Relacionado: ADR 0035 (varios
almacenes), ADR 0036 (niveles), ADR 0038 (alcance), ADR 0048 (tránsito),
ADR 0074 (orden de candados)

## Contexto

Desde WMS-82 un almacén archivado no recibe existencias ni documentos:
`archiveFacility` archiva el almacén y después todas sus ubicaciones activas
con la **misma marca de tiempo**, y los disparadores
`location_archived_facility_*` mantienen archivada toda ubicación de un
almacén archivado. No había camino de regreso: `restoreLocation` rechaza una
ubicación de un almacén archivado y nada quitaba el archivo del almacén.

Además, las bases anteriores a WMS-82 pueden tener almacenes archivados
**con existencias** (el defecto que corrigió WMS-82); la migración de WMS-82
archivó sus ubicaciones con la fecha de archivo del almacén y esas
existencias quedaron atrapadas (ninguna operación acepta una ubicación
archivada). El fundador aprobó este paso el 2026-11-19 como la salida: se
reactiva, se sacan y se vuelve a archivar.

## Flujo operativo

1. En Configuración › Almacenes, quien puede reactivar ve al pie, bajo
   «Archivados», los almacenes archivados que alcanza **completos**; los que
   tienen existencias heredadas llevan la etiqueta «Tiene existencias».
2. La fila abre el almacén. Ahí se explica qué vuelve y qué no, y el botón
   «Reactivar almacén» abre una confirmación con ese mismo resumen y
   «Reactivar» / «Cancelar».
3. Al confirmar, el almacén y las ubicaciones que se archivaron con él quedan
   activos; la persona vuelve a la lista con «Almacén reactivado.». Para
   trabajar en él, lo elige como cualquier otro almacén.
4. Si tenía existencias heredadas, se sacan, se ajustan o se trasladan con
   las operaciones de siempre, y después se archiva otra vez (con las reglas
   de siempre: vacío y sin nada abierto).

## Decisión

### 1. Qué se reactiva

- **El almacén** (`facility.archivedAt = NULL`).
- **Las ubicaciones que se archivaron junto con él:** las que tienen
  exactamente la misma marca `archivedAt` que el almacén. `archiveFacility`
  escribe las dos con el mismo `now` en la misma transacción, y la migración
  de WMS-82 hizo lo mismo con los almacenes ya archivados; una ubicación
  archivada antes por su cuenta tiene otra marca y **se queda archivada**,
  como estaba. Así el árbol vuelve exactamente como estaba al archivarse.
  El conjunto es cerrado hacia arriba: `archiveLocation` exige archivar antes
  lo que contiene, así que una ubicación activa al archivar el almacén tenía
  a su padre activo; nunca queda una activa dentro de una archivada.
- **«General» y la de tránsito, siempre** (`isDefault` o `isTransit`), aunque
  su marca no coincida: solo pueden estar archivadas con su almacén (CHECK
  hasta WMS-82 y disparador desde entonces), y un almacén activo con una de
  ellas archivada rompería todo lo que las busca. «Preparación» no se puede
  archivar por su cuenta (`archiveLocation` la rechaza), así que siempre cae
  en la regla de la marca.

No hace falta columna nueva ni migración: la marca de tiempo ya distingue
los dos casos. **Riesgo aceptado:** si una ubicación se archivó por su cuenta
en el mismo milisegundo en que, después, se archivó su almacén (dos
transacciones que esperan los mismos candados de almacén, una tras otra),
volvería con él. No se puede provocar desde la pantalla en la práctica y
solo devolvería una ubicación vacía que se vuelve a archivar.

### 2. Orden de escritura y disparadores

Primero el almacén y después sus ubicaciones: `location_archived_facility_update`
rechaza una ubicación activa en un almacén archivado y lee el almacén, que
la transacción ya tiene bloqueado en exclusivo (`lockAllFacilities`). No se
toca ningún disparador ni se agrega migración.

### 3. Candados

Mismo camino que archivar, por la puerta única (ADR 0074, ADR 0077):

1. `inFacilities` → `lockAllFacilities`: todos los almacenes en exclusivo, en
   orden de id (con `retryingFacilitySet` si aparece uno nuevo con id menor).
2. Las ubicaciones que va a reactivar, por la llave primaria, en una llamada
   y **sin esperar** (`lockRows(…, { nowait: true })`). Si alguna está
   tomada responde «Hay movimientos en curso en este almacén. Intenta de
   nuevo en un momento.» sin escribir. Igual que en archivar, no esperar es
   lo que evita un orden nuevo: quien tenga tomada una ubicación de un
   almacén archivado está a punto de rechazarse por eso mismo.
3. Escribe almacén → ubicaciones → bitácora.

Nada de productos. Carreras (cada una con su prueba con `Promise.all` sobre
los servicios reales):

- **Contra archivar otro almacén, crear uno o reactivar otro:** los dos toman
  todos los almacenes en exclusivo; van en fila y cada uno vuelve a contar el
  límite bajo el candado.
- **Contra reactivar el mismo:** el segundo lo encuentra activo y responde
  `repeated`.
- **Contra `switchFacility`:** solo lee; o ve el almacén archivado («ya no
  existe») o ya activo.
- **Contra un movimiento a una de sus ubicaciones** (alguien que mandó a
  mano el id): el movimiento bloquea la ubicación y la lee; o la ve
  archivada y se rechaza, o reactivar responde «intenta de nuevo», o la ve
  ya activa y entra. Nunca queda un saldo en una ubicación archivada (lo
  sostiene también `stock_balance_archived_location_*`).
- **Contra crear un documento del almacén (`holdOpenFacility`):** el
  documento toma el almacén compartido; reactivar lo espera (o al revés) y
  el documento ve el almacén archivado y se rechaza, o activo y nace.

### 4. Límite del plan, código, nombre y almacén principal

- Se cuenta como en `createFacility`: `readLimit(tx, organizationId,
  "facilities") ?? 1` contra los almacenes activos, **contados bajo
  `lockAllFacilities`** (no hay contador en `quota_usage` para almacenes).
  Si no cabe: «Tu plan incluye N almacenes y ya están en uso. Archiva uno o
  cambia de plan.».
- **Plan vencido** o módulo Inventario en solo lectura: no se reactiva
  (`assertModulePermission` con un permiso de escritura).
- **Código:** es único en la empresa contando los archivados (índice único
  `(organizationId, code)`), así que nadie pudo tomar el código mientras
  estaba archivado; aun así se vuelve a revisar bajo el candado. El nombre
  puede repetirse, como al crear.
- **El almacén principal** nunca se archiva, así que nunca se reactiva.

### 5. Permiso, alcance y quién

- Permiso propio **`inventory.facility.reactivate`**: titular y
  Administración. Ni Almacén ni Supervisor de almacén (que sí archivan), ni
  Gerencia ni Consulta. Es decisión conservadora: reactivar ocupa un lugar
  del plan y devuelve existencias que no se veían. **El fundador puede
  cambiarlo** (dárselo a Almacén y a Supervisor de almacén).
- **No en una sesión de PIN** (`TERMINAL_DESK_ONLY`). Soporte de plataforma
  solo tiene lecturas, así que tampoco.
- **Alcance:** solo quien alcanza el almacén **completo** (sin límite, o con
  el almacén entero en su alcance), como archivar. Quien está limitado a
  zonas de ese almacén, o no lo alcanza, recibe el mensaje de siempre y el
  almacén no le aparece en «Archivados».
- **Alcance de las personas:** archivar no borra `membership_scope`, así que
  quien tenía el almacén o una de sus zonas en su alcance lo vuelve a tener
  tal cual; nadie gana alcance que no tenía. Una zona que se archivó antes
  por su cuenta sigue archivada (y sigue fuera de las listas). Tampoco vuelve
  nadie a «trabajar ahí»: archivar dejó en blanco `activeFacilityId` y no se
  restaura. Una invitación pendiente cuyo alcance era ese almacén vuelve a
  servir (dejaba de servir solo porque estaba archivado).

### 6. Rastro

Bitácora `facility.reactivated` («Reactivó un almacén») con nombre, código,
cuántas ubicaciones volvieron y la fecha en que se había archivado. Sin
aviso a nadie (quien reactiva lo hace a propósito; **el fundador puede
pedir** un aviso a la Administración).

### 7. Qué no vuelve solo

- Terminales compartidas quitadas, equipos dados de baja y llaves de la API
  revocadas o vencidas: se registran de nuevo.
- Las ubicaciones que se archivaron por su cuenta antes que el almacén.
- Quién trabajaba ahí (cada quien lo elige otra vez).

Y lo que **sí** vuelve a funcionar porque nunca se apagó: los programas de
conteo cíclico que no estaban pausados (la ronda solo saltaba el almacén
archivado) y las reglas de reposición de sus ubicaciones. La confirmación lo
dice para que se pausen si no se quieren.

### 8. Existencias heredadas

Después de reactivar se ven y se operan como cualquier existencia del
almacén (salida, ajuste, reubicación, traslado entre almacenes);
`reconcileStock` y `reconcileValue` no cambian porque nunca miraron si la
ubicación estaba archivada. La lista de archivados (`listArchivedFacilities`)
dice si un almacén tiene existencias (saldo mayor que cero en cualquiera de
sus ubicaciones, en cualquier estado); como solo lista almacenes que la
persona alcanza completos, nunca cuenta nada de fuera de su alcance.

## No entra

Fusionar almacenes, mover existencias entre almacenes fuera del traslado que
ya existe, reparar datos viejos de forma automática, reactivar desde la API,
y reactivar una sola ubicación archivada junto con su almacén (para eso está
`restoreLocation` una vez activo el almacén).

## Decisiones que el fundador puede cambiar

1. Permiso solo para titular y Administración (no Almacén ni Supervisor).
2. Sin aviso al reactivar.
3. Los programas de conteo y las reglas de reposición vuelven como estaban
   (no se pausan solos).

## Consecuencias

- Un almacén archivado puede volver; `archiveFacility` debe seguir
  escribiendo la misma marca en el almacén y en sus ubicaciones (es lo que
  usa este paso para saber qué devolver). Quien cambie eso actualiza este
  ADR.
- Pruebas en `tests/platform/archived-facility.int.test.ts` (reactivar,
  carreras, existencias heredadas, límite, permisos, dos empresas),
  `tests/inventory/scope.int.test.ts` (alcance) y
  `tests/server/lock-order.int.test.ts`.
