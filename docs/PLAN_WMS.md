# Plan WMS

Actualizado: 2026-11-09.

En este repositorio (`Blackopuss/WMS`) el producto se enfoca en la gestión de
almacenes según `docs/ESPECIFICACION_WMS_v5.md` (especificación del fundador).

Se conserva lo esencial: inicio de sesión, MFA, registro, sitio público,
empresas (multiempresa), roles y permisos, bitácora, configuración, productos y
unidades, ubicaciones jerárquicas, existencias y movimientos inmutables,
conteos, importación y exportación, compras y recepciones, compra en línea del
plan y la consola interna. Cambian las pestañas y la interfaz autenticada.

Decisiones del fundador (2026-11-09):

- Ventas (punto de venta, caja, ticket, cotizaciones, pedidos de venta, ventas
  a plazos) **se quita** del producto.
- Se implementa por pasos, sin pedir confirmación en cada uno.

## Reglas de trabajo

- Un paso a la vez; cada paso cierra con `npm run check` y `npm run build` en
  verde y un commit en español con su ID (`WMS-xx`).
- Ramas: el trabajo va en `pruebas` (CI en cada push) y `main` se mantiene al
  día con ella. Nada se despliega: este repositorio no tiene servidor
  ni secretos de despliegue todavía.
- Las convenciones de `AGENTS.md` siguen vigentes (tenencia, permisos,
  movimientos inmutables, decimales exactos, KISS de pantalla).

## Pasos

> Los pasos pendientes de esta tabla (WMS-09..12) se reemplazaron por `docs/PLAN_WMS_V2.md` (2026-11-09), con otra numeración a partir de WMS-09. Los pasos WMS-01..08 quedan como están.

| ID | Paso | Listo cuando | Estado |
| --- | --- | --- | --- |
| WMS-01 | Plan, especificación en `docs/` e identidad del repositorio | Este plan y la especificación están en `docs/`; `AGENTS.md` y `README.md` hablan del WMS | Hecho |
| WMS-02 | Quitar Ventas del código | No quedan pantallas, rutas, servicios, pruebas, permisos `sales.*`, roles Cajero/Encargado de caja ni precio de Ventas; el sitio y la compra en línea ya no lo ofrecen | Hecho (ADR 0032) |
| WMS-03 | Quitar Ventas de la base | Los modelos `Sale*`/`SalesQuote*`… salen de `schema.prisma` y una migración borra sus tablas y disparadores; movimientos `SALE`/`SALE_RETURN` dejan de aceptarse | Hecho (además, bases locales propias `wms_dev`/`wms_test`/`wms_shadow` para no mezclarlas con otros proyectos) |
| WMS-04 | Menú por tareas de almacén y marca WMS | El menú se organiza por tarea (Inicio, Inventario, Recepción, Movimientos, Conteos, Compras, Configuración) y la app y el sitio se presentan como WMS | Hecho: sección «Recepción» (órdenes por llegar, la más antigua primero) en el menú y en la barra móvil; marca «WMS» |
| WMS-05 | Roles operativos (sección 4.2) | Existen Supervisor de almacén, Almacenista y Montacarguista en la matriz y el catálogo, con permisos acotados | Hecho: `supervisor`, `operator` y `forklift` en la matriz, el catálogo y la base |
| WMS-06 | Tareas de traslado (sección 5.3) | Tabla de tareas con estados `pending → assigned → accepted → picked_up → delivered` (+ `blocked`, `cancelled`), con concurrencia e idempotencia; la entrega genera el movimiento de traslado | Hecho: `warehouse_task` con disparadores, `tasks.ts`, permisos `inventory.task.*` |
| WMS-07 | Bandeja de tareas móvil | Pantalla «Tareas» mobile-first: tareas disponibles y mías, botones grandes para aceptar, recoger y entregar, reportar bloqueo | Hecho: `/tareas`, `/tareas/[id]`, `/tareas/nueva` |
| WMS-08 | Inicio por rol (sección 4.3/4.4) | El Inicio muestra primero lo que cada rol ejecuta: tareas para operación, excepciones y tareas abiertas para supervisión, indicadores para administración | Hecho: bloque «Para hoy» (mis tareas, disponibles, con problema, por recibir) antes de existencias y movimientos |
| WMS-09 | Pedidos de salida y surtido (sección 5.2) | Pedido de salida con reserva (no descuenta), tareas de picking, confirmación por ubicación y despacho que genera la salida | Pendiente |
| WMS-10 | Estados de inventario (sección 6.2) | Disponible, reservado, en cuarentena, dañado, bloqueado, separados de la ubicación física | Pendiente |
| WMS-11 | Producción y calidad (secciones 5.4–5.6) | Órdenes de producción, consumos, lotes, inspecciones y liberaciones | Pendiente |
| WMS-12 | Analítica (sección 7) | Tablero e indicadores de almacén por periodo, almacén y usuario | Pendiente |

Los pasos posteriores (PWA, escaneo con cámara, terminales compartidas con PIN,
integraciones) se agregan cuando los anteriores estén cerrados.
