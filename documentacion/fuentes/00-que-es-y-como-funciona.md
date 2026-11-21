---
title: "Qué es el WMS y cómo funciona"
subtitle: "Guía 00 · Introducción para todas las personas de tu empresa"
---

# Para qué sirve el WMS

El WMS es un sistema de gestión de almacenes. Sirve para saber, en cualquier momento, **qué tienes, en qué cantidad, en qué lugar del almacén, en qué condición está y quién lo movió**. Todo lo que entra, sale o cambia de lugar se registra, de modo que el inventario del sistema coincide con lo que hay en las estanterías.

El sistema no está pensado para un solo giro de negocio. Cada empresa lo adapta a su forma de trabajar mediante ajustes, campos personalizados y módulos, sin que haya que cambiar nada en el sistema mismo.

## Lo que puedes hacer con él

- Llevar un **catálogo de productos** con claves, códigos de barras, presentaciones (por ejemplo caja de 12 piezas), categorías, marcas, mínimos y campos propios de tu empresa.
- Tener **varios almacenes**, cada uno con sus **ubicaciones** organizadas por niveles (zona, pasillo, estante, o los niveles que tú definas).
- **Registrar entradas, salidas, cambios de lugar y correcciones** de existencias, siempre con rastro de quién y cuándo.
- **Controlar por lote y caducidad**, o por **número de serie**, los productos que lo necesiten.
- **Recibir mercancía** de órdenes de compra, rechazar lo que llega mal y devolver al proveedor.
- **Asignar tareas** al personal de piso (traslados, acomodo, surtido, reposición) y seguirlas hasta que se terminan.
- **Surtir, empacar y despachar pedidos**, armar embarques y registrar devoluciones de clientes.
- **Contar el inventario** (conteos generales y cíclicos) y aplicar las diferencias con autorización.
- **Fabricar o ensamblar** productos a partir de recetas, con órdenes de producción (módulo Producción).
- **Verificar la calidad** de lo recibido, lo producido o lo devuelto (módulo Calidad).
- **Consultar indicadores**, exportar a Excel y recibir avisos de lo que requiere atención.

# Cómo está organizado

## Tu empresa, tus almacenes y tus ubicaciones

| Concepto | Qué es |
| --- | --- |
| **Empresa** | Es el espacio de trabajo de tu organización. Los datos de una empresa nunca se mezclan con los de otra. Hay una persona **titular** y las demás se suman con un rol. |
| **Almacén** | Un lugar físico donde guardas mercancía: una bodega, una sucursal, una planta. Una empresa puede tener uno o varios, según su plan. |
| **Ubicación** | Un sitio dentro del almacén donde se guarda algo. Se organizan en niveles (por ejemplo Zona, Pasillo, Estante). Cada ubicación tiene un **código** que se puede imprimir en una etiqueta y escanear. |
| **Producto** | Cada artículo que manejas. Tiene su unidad de medida, sus presentaciones y, si hace falta, control por lote o por serie. |
| **Existencias** | La cantidad de un producto en una ubicación, con su estado y su lote. Es lo que cambia con cada movimiento. |

Además de las ubicaciones normales, el sistema usa algunas con un propósito especial: **General** (donde cae lo que llega sin lugar asignado), **Preparación** (donde espera lo surtido para un pedido), **Cuarentena**, **Restauración** y **Producción**.

## El estado de las existencias

No toda la mercancía está lista para usarse. Cada existencia tiene un estado, y **solo lo que está disponible se puede surtir, vender o producir**:

| Estado | Significado |
| --- | --- |
| **Disponible** | Buena y libre para usarse. |
| **En inspección** | Espera a que alguien decida si está bien (por ejemplo, lo que llega de un proveedor que se revisa al recibir). |
| **Dañado** | Con daño; no se usa. Puede devolverse al proveedor o desecharse. |
| **Rechazado** | No pasó una revisión. |
| **Cuarentena** | Retenida a la espera de una decisión. |
| **En restauración** | En reparación o reacondicionamiento. |
| **Bloqueado** | Detenida a propósito. |
| **En tránsito** | Va en camino a otro almacén de la misma empresa. |

Cambiar el estado de algo exige un **motivo** y deja registro, porque cambia lo que se puede hacer con esa mercancía.

## Lotes y números de serie

- Un **lote** agrupa piezas que comparten origen y, si aplica, fecha de caducidad. El sistema surte primero lo que caduca antes.
- Un **número de serie** identifica una sola pieza. El sistema sabe en todo momento dónde está cada serie y por dónde pasó.
- Cada producto define cuál control usa (ninguno, lote o serie). Se puede rastrear cualquier lote, serie, pedido u orden desde **Inventario › Rastrear lote, serie o pedido**.

# Las reglas que hacen confiable al sistema

1. **Las existencias solo cambian con un movimiento.** Nadie escribe una cantidad "a mano" sobre el saldo: se registra una entrada, una salida, un cambio de lugar, un ajuste o un conteo, y el saldo se actualiza solo.
2. **Nada se borra ni se edita después de registrarse.** Los movimientos y la bitácora son permanentes. Un error se corrige con otro movimiento (una **reversa** o un **ajuste**), que también queda registrado.
3. **Todo lleva nombre y fecha.** Cada movimiento, tarea y decisión guarda quién la hizo y cuándo. Por eso no se comparten contraseñas.
4. **No se saca lo que no hay ni lo que está apartado.** Si un pedido ya reservó mercancía, otra operación no puede tomarla.
5. **Cada persona ve solo lo que le corresponde.** El rol decide qué secciones ves y qué puedes hacer. Además, se puede limitar a una persona a ciertos almacenes o zonas.
6. **Lo importante se autoriza.** Una empresa puede exigir que ajustes grandes, desechos, conteos con diferencias o solicitudes de compra pasen por la aprobación de otra persona.

# Los módulos

El WMS se compone de un núcleo y de módulos que la empresa contrata según lo que necesita.

| Módulo | Para qué sirve |
| --- | --- |
| **Inventario** (base) | Catálogo, ubicaciones, movimientos, tareas, conteos, pedidos de salida, surtido, empaque, embarques, devoluciones, traslados entre almacenes, etiquetas, lotes, series, indicadores. |
| **Compras** | Proveedores, solicitudes y órdenes de compra, recepción de mercancía (parcial o total), rechazo y devolución al proveedor, sugerencias de qué pedir y reportes. |
| **Producción** | Recetas, órdenes de producción, solicitudes de producción, reporte de lo producido con su consumo de materiales, merma y cierre de la orden. |
| **Calidad** | Planes de inspección, catálogo de defectos y verificación de lo producido, recibido o devuelto. Requiere el módulo Producción. |

Si una sección dice que **no está activa en tu empresa**, ese módulo no está contratado. Si dice **solo lectura**, el plan venció o el módulo se quitó: puedes consultar y descargar, pero no registrar cambios.

# Un recorrido típico

Así viaja la mercancía en un almacén que usa todo el sistema:

1. **Se compra.** El comprador crea una orden de compra y la envía al proveedor.
2. **Se recibe.** El personal de recepción abre la orden y registra lo que llegó. Lo dañado se marca como tal; lo que no cuadra se rechaza con una nota. Si la empresa lo decide, lo recibido pasa antes por inspección.
3. **Se acomoda.** Lo recibido espera en un lugar de paso y, con acomodo por tareas, el sistema recomienda dónde guardarlo y crea una tarea para el montacarguista o el almacenista.
4. **Se almacena.** Queda disponible en su ubicación. Si baja de su mínimo o de su regla de reposición, el sistema avisa o crea tareas de reposición.
5. **Llega un pedido.** Al liberarlo, el sistema aparta lo necesario y crea las tareas de surtido, indicando de qué ubicación tomar cada producto.
6. **Se surte y se empaca.** El almacenista junta lo pedido en la ubicación de preparación y, si la empresa lo usa, lo verifica y lo empaca en bultos.
7. **Se despacha.** Se agrupan pedidos en un **embarque**, se anotan transportista y datos del envío y se confirma la salida. Solo en ese momento se descuentan las existencias.
8. **Si algo regresa**, se registra una **devolución de cliente** que entra en inspección y se decide qué hacer con ella.
9. **Se cuenta.** Los conteos cíclicos comparan lo que hay con lo que dice el sistema; las diferencias se aplican con la autorización que la empresa elija.

Una empresa que fabrica agrega a este recorrido las recetas, las órdenes de producción y la verificación de calidad de lo producido.

# Cómo usar estas guías

| Guía | Contenido |
| --- | --- |
| **00** Qué es el WMS y cómo funciona | Este documento. |
| **01** Cómo iniciar sesión y cuidar tu cuenta | Registro, contraseña, verificación en dos pasos, PIN en terminales compartidas. |
| **02** Cómo moverte por el sistema | Menú, Inicio, avisos, búsqueda, escaneo, cambio de almacén, app en el teléfono. |
| **03** Roles y permisos | Qué hace cada rol y qué ve cada quien. |
| **04 a 15** Una guía por rol | Las tareas del día de cada rol, paso a paso. |

Lee primero las guías 01 y 02, y después la de tu rol. Si tienes varios roles, lee la de cada uno.
