# ADR 0032: el WMS no incluye Ventas

- Estado: aceptada (fundador, 2026-11-09)
- Reemplaza: ADR 0030 en este repositorio

## Contexto

SaaS-Almacen creció hacia punto de venta (caja, ticket, cotizaciones,
pedidos de venta, ventas a plazos). El fundador copió el proyecto a
`Blackopuss/WMS` para enfocarlo en la gestión de almacenes según
`docs/ESPECIFICACION_WMS_v5.md`, y pidió quitar el módulo de Ventas.

## Decisión

- WMS-02 quita del código el módulo `sales`: pantallas `/ventas`, `/ticket`,
  rutas `/api/ventas`, configuración de Ventas, precios de venta del producto,
  servicios, pruebas, permisos `sales.*`, roles Cajero y Encargado de caja, su
  precio en la compra en línea y sus menciones en el sitio y los documentos
  legales (versión 2026-11-09).
- WMS-03 quita sus tablas de la base con una migración. Este repositorio no
  tiene producción, así que la regla de «migraciones solo de expansión» no
  protege datos reales aquí; se aplica de nuevo desde el primer despliegue.
- La importación de salidas de otro sistema (IMP-10) se conserva: sirve para
  descontar lo que sale por un sistema de ventas externo.
- Los pedidos de salida del WMS (surtido y despacho, WMS-09) se diseñarán como
  documentos de almacén, sin precios, caja ni cobro.

## Consecuencias

- El código de Ventas sigue en el historial de git y en SaaS-Almacen.
- Las secciones VEN, COT y PAG de `AGENTS.md` quedan como historial.
