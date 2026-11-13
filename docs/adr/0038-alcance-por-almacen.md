# ADR 0038 — Alcance de permisos por almacén y zona

Fecha: 2026-11-12 · Estado: aceptada · Paso: WMS-20 · Completa ADR 0035

## Contexto

Desde WMS-18 una empresa tiene varios almacenes y cada persona trabaja en uno
a la vez, pero cualquiera con el permiso podía cambiarse a otro almacén o
mandar el id de una ubicación ajena: el rol dice _qué_ puede hacer alguien, no
_dónde_. Las instrucciones del fundador piden que cada persona vea y mueva solo
lo de su área (plan v3, WMS-20; prueba crítica PC-12).

## Flujo

1. En Configuración › Equipo, quien administra abre «Almacenes» de una persona
   y elige «Todos los almacenes» o «Solo los que elija». De cada almacén
   elegido: «Todo el almacén» o «Solo estas zonas» (las ubicaciones que están
   directamente en el almacén, «General» y «Preparación» incluidas).
2. El cambio aplica de inmediato y queda en la bitácora
   (`team.scope_changed`, con el antes y el después en palabras).
3. La persona limitada solo ve en el menú sus almacenes; si el que tenía
   activo quedó fuera, cae en uno permitido. Todo lo que intente fuera de su
   alcance se rechaza en el servidor, aunque el id llegue manipulado.

## Decisión

- **Tabla `membership_scope`** (de empresa, en `TENANT_MODELS`): membresía,
  almacén y ubicación opcional. **Sin filas = sin límite**, como antes. Una
  fila sin ubicación abre el almacén completo; con ubicación, esa ubicación y
  todo lo que contiene (se decide por los ancestros de la ubicación, así que
  sigue valiendo si el árbol cambia). Un almacén sin fila está cerrado.
- **El titular nunca está limitado.** Las reglas de equipo
  (`checkTeamChange`, cambio `set_scope`) lo protegen, aceptar la titularidad
  borra las filas del nuevo titular en la misma transacción y, aunque hubiera
  filas, `loadSubject` y `loadScope` las ignoran para el titular.
  `loadScope(cliente, userId)` es una sola lectura por el cliente de empresa
  (membresía, titular y filas), así que corre dentro de cualquier transacción.
- **Una sola decisión:** el alcance viaja en el sujeto (`Subject.scope`) y la
  política pura lo decide: `inScope(subject, lugar)` y
  `can(subject, permiso, lugar?)`. `src/platform/locations/scope.ts` convierte
  un id de ubicación en ese «lugar» leyendo de la base su almacén y sus
  ancestros, y ofrece lo que usan los servicios:
  `assertLocationsInScope(tx, userId, ids)` (lanza `ForbiddenError`),
  `locationsOutOfScope`, `isFacilityInScope`, `assertWholeFacilityInScope` y
  `locationScopeWhere` (filtro de Prisma para listas).
- **Almacén activo:** `activeFacilityOf` nunca devuelve un almacén fuera del
  alcance (el elegido, si no el principal, si no el primero permitido por
  nombre); `switchFacility` rechaza uno fuera y `listFacilities` solo lista
  los permitidos. Como pedidos y tareas ya se listan por almacén activo, con
  esto basta para el alcance por almacén en esas listas.
- **Quién lo cambia:** `setMemberScope` de `team.ts`, dentro de
  `withTeamChange` (candado de empresa, reglas, bitácora), con el permiso
  `platform.team.assign_roles` (no hay permiso nuevo). Nunca a uno mismo;
  a un administrador, solo el titular. Quien está limitado solo reparte lo
  que tiene y no puede dar «todos». Almacenes y zonas se validan en la empresa
  de la sesión (activos; la zona directamente en su almacén).
- **Alcance al invitar (2026-11-12):** la invitación guarda el alcance
  (`invitation.scope`, las mismas filas) y al aceptarla se copian a
  `membership_scope` en la misma transacción: la persona entra ya limitada.
  Se valida con la misma función que al editar (`resolveScopeRows` de
  `scope-rows.ts`). Quien está limitado nunca invita sin límite: si no elige
  nada, la invitación toma su propio alcance. Si al aceptar todo lo que
  nombraba fue archivado, el enlace deja de servir (no entra «sin límite»).

## Dónde se aplica

Almacén y zona, comprobado en el servidor:

- Ubicaciones: `listLocations`, `listStockLocations`, `getDefaultLocation`;
  crear, editar, mover, archivar y reactivar ubicaciones; niveles y ubicación
  de preparación (exigen el almacén completo); crear almacén (solo sin
  límite), editar y archivar almacén.
- Movimientos: entrada, saldo inicial, salida, salida rápida, reubicación
  (origen y destino), ajuste, reversa, cambio de estado, recepción de órdenes
  (`postReceiptEntry`), devolución al proveedor (`postReturnExit`),
  existencias y salidas importadas (al revisar, por la lista de ubicaciones, y
  otra vez en el worker).
- Conteos: abrir, y todo lo demás (capturar, quitar captura, cancelar,
  aplicar, ver, listar): un conteo de una ubicación fuera «no existe».
- Tareas: crear (también quien la recibe debe alcanzar origen y destino),
  asignar, y cada paso, ver y listar: una tarea cuenta solo si origen **y**
  destino están dentro. Para surtir con zonas hay que incluir la ubicación de
  preparación.
- Lecturas por ubicación: existencias por ubicación de un producto
  (`getStockByLocation`, `getProductStock`, `getStockTotals`), historial de
  movimientos y exportaciones de existencias y movimientos.

Solo por almacén (un documento es del almacén, no de una zona): pedidos de
salida (ver, editar, liberar, cancelar, listar, importar).

## Lo que no cubre (pendiente)

- Cifras de toda la empresa (2026-11-12, cerrado): existencias bajas, valor
  del inventario y sugerencias de compra son **solo para quien no tiene
  límite** (`seesWholeCompany`): un mínimo se compara con todo lo que tiene la
  empresa, así que a una persona limitada no se le lista nada y la pantalla
  dice por qué. Siguen sin desglose, por ser de poco riesgo: la
  reconciliación (solo operación), los productos sin existencias y la guía de
  primer uso.
- Compras: órdenes, recepciones y devoluciones tienen almacén desde WMS-57
  (ADR 0055): una orden de un almacén fuera del alcance «no existe». Las
  órdenes escritas antes (sin almacén) y las que crean las sugerencias siguen
  siendo de toda la empresa y las ve quien puede ver órdenes.
- En una reubicación entre dos zonas, el historial y la exportación muestran
  el movimiento a quien alcanza una de las dos (con la ruta de la otra).
- Lo apartado sin ubicación (reservas a nivel producto) no se descuenta de lo
  «disponible» que ve una persona limitada; las operaciones lo siguen
  comprobando bajo su candado.

## Consecuencias

- Un servicio nuevo que reciba o lea una ubicación llama
  `assertLocationsInScope` (o filtra con `locationScopeWhere`) con el cliente
  de su transacción; uno que trabaje sobre un documento de almacén,
  `isFacilityInScope`.
- Cada operación hace una o dos consultas más (el alcance y, si lo hay, los
  ancestros de las ubicaciones). Sin filas de alcance el costo es una
  consulta.
- Si todos los almacenes de una persona limitada se archivan, se queda sin
  dónde trabajar (`ForbiddenError`, «No tienes ningún almacén asignado») hasta
  que alguien edite su acceso: se cierra, no se abre.
- De paso, la ubicación por omisión de entradas, salidas, ajustes, salida
  rápida y recepciones es «General» **del almacén activo** (antes, la de
  cualquier almacén de la empresa).
