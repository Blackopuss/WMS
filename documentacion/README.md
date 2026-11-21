# Documentación para clientes

Guías en PDF para enseñar a usar el WMS. Entrega a cada persona la 01, la 02 y la de su rol.

| Archivo | Contenido |
| --- | --- |
| 00-que-es-y-como-funciona.pdf | Qué es el sistema, conceptos, reglas, módulos y recorrido típico |
| 01-iniciar-sesion-y-cuidar-tu-cuenta.pdf | Registro, contraseña, dos pasos, PIN en terminal, seguridad |
| 02-moverte-por-el-sistema.pdf | Menú, Inicio, avisos, búsqueda, escaneo, app en el teléfono |
| 03-roles-y-permisos.pdf | Qué hace cada rol, quién ve costos, cómo asignar roles |
| 04 a 15 | Una guía por rol (titular, administrador, gerencia, almacén, supervisor, almacenista, montacarguista, comprador, consulta, operario de producción, encargado de producción, inspector de calidad) |

## Cómo actualizarlas

Edita el texto en `fuentes/*.md` y corre `bash documentacion/generar.sh` (necesita pandoc y playwright). Las guías de rol (04 a 15) se derivan de `docs/manuales/`; si cambia una pantalla, corrige primero el manual allí y copia el cambio. Si algo no coincide con la app, la app manda.
