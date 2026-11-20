# Manual del Supervisor de almacén

El Supervisor hace todo lo del rol [Almacén](rol-almacen.md) (catálogo, movimientos, conteos, pedidos, embarques, tareas) y además recibe mercancía de órdenes de compra, ve proveedores y órdenes, ve las personas del equipo y el resumen del día. Antes lee [lo común](comun.md).

## Cómo entras
Correo y contraseña (dos pasos opcionales). Con PIN si la empresa eligió «Piso y supervisión» o «Todos los que no usan verificación en dos pasos».

## Lo que ves en el menú
Inicio, Tareas, Recepción, Pedidos, Producción (si está contratada), Inventario, Movimientos, Conteos, Incidencias, Compras (solo lectura) y Configuración.

## Lo que se agrega frente a Almacén
- **Inicio:** **Lo que se hizo hoy** y **Quién hizo qué hoy**; el mosaico **Tareas con problema** y **Incidencias abiertas**. En **Lo que se hizo hoy**, **Trabajo abierto por persona** dice cuántas tareas sin terminar tiene cada quien en tu almacén y cuántas con problema; toca una persona para ver sus tareas en **Tareas › Abiertas** (**Ver todas las abiertas** quita el filtro).
- **Recepción:** abre una orden por recibir y toca **Recibir mercancía** (pasos en el manual del [Comprador](rol-comprador.md), sección «Recibir lo que llega»).
- **Compras:** puedes ver proveedores y órdenes; no las creas. **Solicitudes de compra** sí puedes crearlas (**Solicitar compra**).
- **Conteos › Exactitud** y **Programas de conteo**.
- **Inventario › Sugerencias de reubicación** (pantalla «Sugerencias de reubicación»): lo que conviene mover en tu almacén y en tus zonas, con una línea de por qué: **Acercar a surtido** (lo que sale seguido y no tiene lugar de surtido), **Sacar de surtido** (lo que no se ha movido y ocupa un lugar de surtido) y **Juntar** (el mismo producto y lote repartido en varias ubicaciones de almacenaje). **Crear tarea** hace una tarea de traslado normal con lo que el sistema decide en ese momento; **Ver la tarea** la abre. Lo que ya tiene una tarea en camino no se vuelve a sugerir. Qué se sugiere se ajusta en Configuración › Operación, en «Sugerencias de reubicación».
- **Inventario › Indicadores** (pantalla «Indicadores»; también el enlace **Indicadores** junto a **Lo que se hizo hoy** en Inicio): de un periodo (**7 días**, **30 días**, **90 días**, **Este mes**, **Mes anterior**, o fechas en **Más filtros**), pedidos completos y a tiempo, tiempo de surtido, **De recibir a acomodar**, exactitud, **Productos de mayor movimiento** con su rotación y días de inventario, **Sin movimiento**, **Rendimiento por persona** y **Rendimiento por zona**. Toca un producto o una persona para ver solo lo suyo (**Quitar** lo deshace). Con varios almacenes, eliges cuál en **Más filtros**. Desde una terminal con PIN no ves **Rendimiento por persona**. No ves importes (eso es de quien ve costos). Arriba, **Comparado con el periodo anterior** pone cada cifra principal junto a la del periodo anterior y su cambio. Si alcanzas más de un almacén, **Comparar almacenes** los pone lado a lado (**Ver un almacén** regresa); quien ve toda la empresa tiene además la fila **Toda la empresa**. Al pie, **Descargar en Excel** o **Descargar en CSV** baja lo que estás viendo (no desde una terminal con PIN).
- **Configuración › Equipo** (ver las personas y sus roles, no cambiarlos).

## Tus tareas del día
1. **Inicio › Para hoy:** atiende lo que muestre (tareas con problema, incidencias, pedidos por empacar y despachar, traslados por recibir, devoluciones por revisar, conteos de hoy, órdenes por recibir).
2. **Tareas con problema:** en **Tareas › Abiertas**, abre la tarea y elige **Liberar para que otra persona la tome** o **Cancelar tarea** (con motivo). Antes lee qué reportó la persona.
3. **Asignar tareas:** en una tarea, **Asignar**. En una ola, **Repartir** o **Asignar las de <zona> a**.
4. **Incidencias:** abre la incidencia y **Atender**, **Resolver** (di qué se hizo) o **Descartar** (di por qué). Una incidencia nunca cambia existencias: si hace falta, usa **Cambiar estado** o **Corregir existencias**.
5. **Cambios de estado y devoluciones:** libera lo que pasó inspección con **Cambiar estado** (a disponible, dañado, rechazado o a restauración) y decide lo que regresó un cliente en **Pedidos › Devoluciones**.
6. **Autorizaciones:** en **Aprobaciones** (desde Configuración › Solicitudes) autorizas o rechazas solo lo que tu rol puede hacer por sí mismo.
7. **Pedidos y embarques:** libera, cancela, arma embarque y confirma salida.
8. **Solicitudes de producción:** si el módulo está contratado, las puedes decidir (ver [Encargado](rol-encargado-produccion.md)); aceptas como mucho lo que se pidió.

### Verificar lo producido (WMS-30B)
Si la empresa tiene Producción **sin Calidad**, también verificas lo producido: desde **Inventario › Por inspeccionar**, toca el renglón e **Iniciar verificación**; cuenta, reparte lo contado (**Aprobadas**, rechazadas, dañadas, en cuarentena o a restauración) y di qué pasó con lo que falta (con foto). **Con Calidad**, lo hace el Inspector y lo que está en una verificación abierta no se puede cambiar con **Cambiar estado**; lo demás lo sigues liberando como siempre.

## Lo que no puedes hacer
Crear órdenes de compra ni ver costos (Comprador); cambiar la configuración o el equipo (Administrador).

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8).

Vigente al 2026-11-20 (indicadores: WMS-32; tableros: WMS-34; sugerencias de reubicación: WMS-65; verificación: WMS-30B)
