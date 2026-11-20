# Manual del Administrador

El Administrador opera todo lo contratado y configura la empresa y el equipo, pero **no** contrata, cancela, cambia el método de pago ni transfiere la titularidad (eso es del [titular](rol-titular.md)). Antes lee [lo común](comun.md).

## Cómo entras
Correo y contraseña, con **verificación en dos pasos obligatoria**. Nunca con PIN.

## Lo que ves en el menú
Inicio, Tareas, Recepción, Pedidos, Producción (si está contratada), Inventario, Movimientos, Conteos, Incidencias, Compras y Configuración.

## Tus tareas de administración (Configuración)

En una empresa nueva, **Configuración › Configuración inicial** (y **Configura tu empresa** en Inicio, hasta el primer movimiento) te lleva paso a paso por almacén, ubicaciones, equipo, cómo trabaja tu almacén, productos y existencias; cada paso abre la pantalla de siempre y se puede saltar. Detalle en el manual del [titular](rol-titular.md#primeros-pasos-con-una-empresa-nueva).

### Equipo (`Configuración › Equipo`)
- **Invitar persona:** correo, roles (casillas) y, si quieres, almacenes o zonas. Le llega un enlace que vence en 7 días. Cuenta como un lugar del plan aunque esté pendiente.
- **Cambiar roles de <nombre>** (aplica al instante) y **Cambiar almacenes de <nombre>** (limita a una persona a ciertos almacenes o zonas: fuera de eso no ve nada).
- **Desactivar a <nombre>:** pierde el acceso y se cierran sus sesiones en esta empresa. Tiene **Reactivar**.
- **Reenviar** o **Cancelar** invitaciones.
- Abre una persona para ver sus **sesiones abiertas**, cerrarlas (**Cerrar sesión**, **Cerrar todas sus sesiones**) y ver su **Historial de accesos**.
- Reglas que te protegen y al titular: no cambias al titular, no te cambias tus propios roles y los roles de otro administrador solo los cambia el titular.

### Almacenes y ubicaciones
- **Configuración › Almacenes:** **Crear almacén** (nombre, código corto sin espacios, dirección). **Archivar almacén** solo si está vacío (sin existencias, pedidos sin terminar ni tareas). Un almacén archivado no recibe nada. Los archivados aparecen al pie, en **Archivados** (con **Tiene existencias** si quedó algo dentro); al abrir uno, **Reactivar almacén** lo devuelve con las ubicaciones que tenía al archivarse, si cabe en tu plan. No vuelven las terminales, los equipos ni las llaves de la API que se quitaron. No se hace desde una terminal con PIN.
- **Configuración › Ubicaciones:** **Agregar ubicación** (nivel, nombre, **Código** que se escanea, **Uso**, capacidad y restricciones opcionales), **Cambiar niveles**, **Imprimir etiquetas**, mover, archivar y reactivar. Una ubicación solo se archiva vacía.

### Operación (`Configuración › Operación`)
Aquí eliges cómo trabaja tu empresa; lo que no cambies queda en su valor por omisión. Los principales:
- **Surtido:** de dónde se surte primero (más existencias, menos existencias o el lote más antiguo; lo que caduca antes siempre sale primero), si se surten lotes caducados, y si es **Pedido por pedido** o **Por olas**.
- **Acomodo:** si cada quien reubica lo que llega o se crean **tareas de acomodo**; qué lugar se recomienda; si lo que llega para un pedido que espera va directo a preparación.
- **Tarimas y cajas**, **Verificar y empacar pedidos**, **Datos del transporte al despachar**, **Devoluciones sin pedido**.
- **Entradas** (aviso de entrada repetida), **Ubicaciones** (qué pasa al pasar la capacidad), **Lotes** (avisar de lotes por caducar).
- **Fotos:** al reportar un problema y al entregar una tarea (sin foto, opcional u obligatoria).
- **Conteos:** clasificación ABC y cuándo pedir revisión de un conteo con diferencias grandes.
- **Reposición de surtido**, **Etiquetas**, **Avisos** (hora del resumen diario y si hay avisos por correo), **Equipos**, y, con módulos contratados, **Producción** y **Calidad**.
Cada cambio queda en la bitácora.

### Otras pantallas de Configuración
- **Autorizaciones › Reglas de aprobación:** por cada tipo (ajuste de existencias, aplicar conteo, solicitud de compra) activas **Pide autorización**, eliges **Quién autoriza** y si quien lo pide puede autorizarlo él mismo. Las solicitudes se ven en **Configuración › Solicitudes** (`Aprobaciones`).
- **Campos personalizados:** datos propios de productos, ubicaciones y proveedores (texto, número, fecha, lista, sí o no). Nada se borra: se archiva.
- **Procesos:** etapas que sigue cada documento (hoy el embarque y la orden de producción) y qué áreas las hacen; **Guardar borrador** y **Publicar**.
- **Equipos del almacén:** montacargas y demás equipos, con mantenimiento; **Tipos de equipo** los nombras tú.
- **Terminales compartidas:** para registrar una tableta del piso, entra desde ese mismo dispositivo y toca **Registrar este dispositivo**. Ahí también se elige quién puede entrar con PIN, el largo del PIN y el tiempo de inactividad.
- **API y webhooks:** llaves para otros sistemas (se muestran una sola vez, nunca tienen más permisos que tú) y destinos de avisos.
- **Bitácora:** quién cambió qué y cuándo (no se puede editar).
- **Mi plan:** solo consulta (cupos, módulos, vigencia).

### Datos del catálogo
En **Inventario**: **Agregar producto**, **Importar Excel**, **Descargar en Excel**, **Cambiar estado**, **Desechar** (solo lo dañado o rechazado, con motivo; no se reversa), tarimas, etiquetas, reposición. En **Movimientos**: **Corregir existencias**, **Saldo inicial** y **Reversar** (siempre con motivo).

## Sugerencias de reubicación
**Inventario › Sugerencias de reubicación** (pantalla «Sugerencias de reubicación»): lo que conviene mover en tu almacén y en tus zonas, con una línea de por qué: **Acercar a surtido** (lo que sale seguido y no tiene lugar de surtido), **Sacar de surtido** (lo que no se ha movido y ocupa un lugar de surtido) y **Juntar** (el mismo producto y lote repartido en varias ubicaciones de almacenaje). **Crear tarea** hace una tarea de traslado normal con lo que el sistema decide en ese momento; **Ver la tarea** la abre. Lo que ya tiene una tarea en camino no se vuelve a sugerir. Qué se sugiere se ajusta en Configuración › Operación, en «Sugerencias de reubicación».

## Indicadores del almacén
**Inventario › Indicadores** (pantalla «Indicadores»; también el enlace **Indicadores** junto a **Lo que se hizo hoy** en Inicio): de un periodo (**7 días**, **30 días**, **90 días**, **Este mes**, **Mes anterior**, o fechas en **Más filtros**), pedidos completos y a tiempo, tiempo de surtido, **De recibir a acomodar**, exactitud, **Productos de mayor movimiento** con su rotación y días de inventario, **Sin movimiento**, **Rendimiento por persona** y **Rendimiento por zona**. Toca un producto o una persona para ver solo lo suyo (**Quitar** lo deshace). Con varios almacenes, eliges cuál en **Más filtros**. Desde una terminal con PIN no ves **Rendimiento por persona**. Con costos ves además el valor de lo que salió y de lo que no se mueve.

## Lo que no puedes hacer
- Contratar módulos, cambiar de plan, cancelar, cambiar el método de pago, dar acceso a soporte: es del [titular](rol-titular.md). Transferir la titularidad todavía no está disponible en la app; se pide por el correo de contacto de **Mi plan**.
- Entrar con PIN.
- Cambiar al titular o tus propios roles.

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8). Para el sistema mismo (servidor, respaldos), ver los manuales de [instalación](instalacion.md), [actualización](actualizacion.md) y [respaldo y restauración](respaldo-y-restauracion.md).

Vigente al 2026-11-20 (configuración inicial: WMS-43; indicadores: WMS-32; reactivar un almacén: WMS-85; sugerencias de reubicación: WMS-65)
