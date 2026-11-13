# Auditoría de seguridad 5 (revisión de código, 2026-11-13)

- **Alcance:** lo que entró el 2026-11-12 y no había tenido revisión: alcance por almacén y zona (WMS-20, ADR 0038), aviso de entrada repetida (WMS-71), existencias sin acomodar (WMS-72), resumen del día (WMS-73) y capacidad y restricciones de ubicación (WMS-22B, ADR 0039). Código de `src` y `prisma` entre `9bb1634` y `77fb612`.
- **Método:** lectura de código siguiendo cada camino desde la Server Action hasta la consulta. Sin hallazgos de gravedad alta: ningún cruce entre empresas ni forma de mover existencias fuera del alcance.

## Hallazgos y corrección

| # | Gravedad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 1 | Media | Quien solo tenía una zona de un almacén podía cambiarle nombre, código y dirección al almacén entero y, si estaba vacío, archivarlo (`updateFacility`, `archiveFacility` preguntaban «algo del almacén», no «todo el almacén»). Los rechazos de archivar además decían si había existencias, pedidos o tareas en zonas ajenas. | `checkScope` de `facilities.ts` exige el almacén completo. Prueba en `member-scope.int.test.ts`. |
| 2 | Baja | Un día que no existe en la dirección (`/tareas?vista=closed&dia=2026-13-45`, `/pedidos?dia=…`) tiraba la pantalla con un error de servidor, que cuenta en «errores recientes» de `/api/salud` y puede disparar alertas. | `dayWindow` descarta los días que no existen. Prueba en `day-summary.int.test.ts`. |
| 3 | Baja | El aviso de entrada repetida le decía a una persona limitada quién registró qué cantidad en otra zona del mismo almacén. | El aviso solo considera entradas dentro del alcance de quien registra. Prueba en `scope.int.test.ts`. |
| 4 | Baja | Al crear o editar una ubicación, el mensaje de código repetido daba el nombre de una ubicación fuera del alcance. | Si quien tiene el código está fuera del alcance, el mensaje no la nombra. Prueba en `member-scope.int.test.ts`. |

## Aceptados o pendientes

- **Equipo muestra los almacenes y zonas de cada persona** a cualquiera con `platform.team.read`, aunque esté limitado a otros. Son solo nombres, no existencias. Aceptado por ahora; si se cierra, `listTeamMembers` recibe al actor y deja solo lo que cae en su alcance.
- **Una invitación pendiente conserva el alcance con que se emitió** aunque después se le reduzca a quien invitó; reenviarla no lo vuelve a validar. Era legítimo al emitirse y el titular puede cancelarla. Pendiente: revalidar en `resendInvitation`.
- **La reversa no consulta lo apartado** (anterior a este alcance, WMS-12): reversar una entrada saca existencias comprobando el saldo, no `freeToTake`, y puede dejar sin mercancía a una tarea de surtido que la tenía apartada. Exige `inventory.movement.reverse`. Pendiente: se corrige después de integrar WMS-21A, que cambia el mismo núcleo de movimientos.
- **Una persona con zonas libera pedidos de todo su almacén** y el surtido aparta fuera de su zona: es la decisión del ADR 0038 (un pedido es del almacén, no de una zona).

## Resistieron sin fallas

Cruce entre empresas (cliente de empresa en todo lo nuevo, tablas en `TENANT_MODELS`, `lockRows` con filtro de empresa); edición de alcance (ni a uno mismo, ni al titular, ni dar más de lo propio); alcance al invitar y aceptar; almacén activo; árbol de ubicaciones; movimientos, tareas, conteos y pedidos dentro del alcance y bajo candado; cambio de estado con `toLocationId` (permiso de reubicar, mismo almacén, ambos extremos en alcance); `acceptCapacity` y `fingerprint` (no saltan el modo «no permitirlo» ni una restricción); orden de candados de capacidad; topes de tamaño en claves, categorías, filas de alcance y niveles; decimales exactos; Server Actions nuevas en `REVIEWED`; ninguna respuesta nueva con costos.
