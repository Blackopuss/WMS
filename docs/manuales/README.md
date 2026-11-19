# Manuales del WMS

Manuales para usar, instalar, actualizar y respaldar el WMS. Todos dicen solo lo que existe hoy en el sistema; lo que falta se marca como «todavía no disponible». Cada manual termina con la fecha hasta la que está vigente, para saber cuándo revisarlo.

## Por dónde empezar

Si eres usuario del sistema, lee primero **[Lo que todas las personas necesitan saber](comun.md)** (entrar, avisos, almacén, escaneo, app en el teléfono) y después el manual de tu rol. Si administras el servidor, ve a los tres manuales de abajo.

## Manuales por rol

Los nombres son los que muestra la app. Una persona puede tener varios roles a la vez: lee el de cada uno.

| Si eres… | Manual | En una línea |
| --- | --- | --- |
| Titular de la empresa | [rol-titular.md](rol-titular.md) | Todo, más el plan, soporte y la titularidad |
| Administrador | [rol-administrador.md](rol-administrador.md) | Configura la empresa y el equipo, y opera todo |
| Gerencia | [rol-gerencia.md](rol-gerencia.md) | Consulta y exporta todo, incluidos costos; no cambia nada |
| Almacén | [rol-almacen.md](rol-almacen.md) | Catálogo, movimientos, conteos, pedidos y embarques |
| Supervisor de almacén | [rol-supervisor-almacen.md](rol-supervisor-almacen.md) | Lo de Almacén, más recibir órdenes de compra y supervisar |
| Almacenista | [rol-almacenista.md](rol-almacenista.md) | Piso: recibe, mueve, cuenta, surte y empaca |
| Montacarguista | [rol-montacarguista.md](rol-montacarguista.md) | Ejecuta tareas de traslado |
| Comprador | [rol-comprador.md](rol-comprador.md) | Proveedores, órdenes de compra y recepciones |
| Consulta | [rol-consulta.md](rol-consulta.md) | Ve y descarga, sin cambiar nada |
| Operario de producción | [rol-operario-produccion.md](rol-operario-produccion.md) | Ve órdenes y recetas, pide producción (módulo Producción) |
| Encargado de producción | [rol-encargado-produccion.md](rol-encargado-produccion.md) | Recetas, órdenes y solicitudes de su área (módulo Producción) |
| Inspector de calidad | [rol-inspector-calidad.md](rol-inspector-calidad.md) | Consulta planes de inspección y defectos (módulo Calidad) |

## Para quien administra el servidor

| Manual | Para qué |
| --- | --- |
| [instalacion.md](instalacion.md) | Qué se instala, qué se necesita antes y los pasos en orden |
| [actualizacion.md](actualizacion.md) | Llevar una versión nueva, regresar a la anterior y actualizar los scripts |
| [respaldo-y-restauracion.md](respaldo-y-restauracion.md) | Cómo se respalda, cómo se restaura y qué pasa si pierdes una llave |

Aviso importante: **hoy el WMS no tiene servidor de producción**, y lo de **Cloudflare R2** (archivos fuera del servidor) está construido pero **no probado contra una cuenta real**. Los manuales de servidor se apoyan en [docs/DESPLIEGUE.md](../DESPLIEGUE.md), donde está el detalle completo.

## Producción y Calidad

Existen hoy: recetas, órdenes de producción (crear, liberar y cancelar), solicitudes de producción, planes de inspección y el catálogo de defectos. **Todavía no están disponibles**: el reporte de lo producido, el cierre de la orden y registrar la inspección de Calidad. Los manuales de Producción y Calidad lo repiten donde importa.

## Cómo mantener estos manuales

Un manual se revisa cuando cambia una pantalla, un botón o un permiso de lo que describe, y se actualiza la línea final «Vigente al…». Si algo del manual no coincide con la app, la app manda: corrige el manual.

Vigente al 2026-11-19
