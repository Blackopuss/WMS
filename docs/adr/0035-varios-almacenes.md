# ADR 0035 — Varios almacenes por empresa

Fecha: 2026-11-10 · Estado: aceptada · Paso: WMS-18 · Actualiza ADR 0010

## Contexto

Las instrucciones del fundador (4.B, Fase 1) y la especificación (3.1, 6.5)
piden varios almacenes y sucursales por empresa. Hasta WMS-17 había una sola
instalación (`facility.organizationId` único) y cada flujo lo suponía.

## Decisión

- **`facility` es un almacén**, varios por empresa, con nombre, código único
  (mayúsculas, sin espacios), dirección y uno principal (`isDefault`, true o
  NULL). No se borra (disparador): se archiva vacío —sin existencias en ningún
  estado, sin pedidos sin terminar ni tareas abiertas—; el principal no se
  archiva.
- **Cada almacén tiene su General** (se crea con él) y su ubicación de
  preparación. Las ubicaciones siguen ligadas a su almacén por la llave
  compuesta que ya existía; el almacén de todo lo demás (saldos, movimientos,
  tareas, conteos, recepciones) se deriva de la ubicación.
- **Almacén activo por persona** en `membership.activeFacilityId` (vacío = el
  principal; uno archivado se lee como el principal). Lo resuelve
  `activeFacilityOf`. Listas de ubicaciones, ubicación por omisión, pedidos de
  salida y tareas trabajan en el almacén activo; se cambia desde el menú
  lateral (solo aparece con más de un almacén).
- **Nada cruza almacenes por accidente:** una reubicación o tarea con origen y
  destino en almacenes distintos se rechaza; entre almacenes se hace un
  traslado con tránsito (WMS-19, ADR 0048). Un pedido de salida guarda su almacén (`facilityId`, solo
  cambia en borrador) y se surte solo de ahí, hacia su preparación.
- **Cupo** en el plan: límite `facilities` (1 cuando el plan no lo dice), que
  pone la consola interna. Crear o archivar bloquea todos los almacenes de la
  empresa (el mismo candado del árbol de ubicaciones).

## Pendiente

- Mostrar el almacén junto a la ruta de una ubicación en historial, ficha de
  producto y reportes cuando hay más de uno.
- Órdenes de compra con almacén de destino: hechas en WMS-57 (ADR 0055); las
  órdenes anteriores quedan de toda la empresa.
- Alcance de permisos por almacén (WMS-20).
- Traslados entre almacenes con mercancía en tránsito: hechos en WMS-19 (ADR
  0048).
