# Manual de Almacén

El rol Almacén administra el catálogo, las ubicaciones, los movimientos y los conteos de Inventario, y arma pedidos y embarques. No opera Compras (no recibe órdenes de compra ni ve proveedores). Antes lee [lo común](comun.md). El [Supervisor de almacén](rol-supervisor-almacen.md) hace lo mismo y además recibe mercancía de órdenes de compra y ve el equipo.

## Cómo entras
Correo y contraseña (dos pasos opcionales). Con PIN si la empresa eligió «Piso y supervisión» o «Todos los que no usan verificación en dos pasos».

## Lo que ves en el menú
Inicio, Tareas, Pedidos, Producción (si está contratada, solo lectura de órdenes y recetas), Inventario, Movimientos, Conteos, Incidencias y Configuración. (No hay Recepción ni Compras.)

## Tus tareas del día

### Inventario
- **Agregar producto** y **Editar** (ficha, presentaciones, mínimos), **Importar Excel**, **Descargar en Excel**.
- En la ficha de un producto: **Entrada**, **Salida**, **Cambiar de lugar**, **Corregir existencias**, **Cambiar estado**, **Desechar** (solo lo dañado o rechazado, con motivo; no se reversa) e **Imprimir etiquetas**.
- **Existencias bajas**, **Sin acomodar**, **Por caducar**, **Por inspeccionar** y **En restauración** son listas de lo que necesita atención.
- **Tarimas y cajas** (si la empresa lo activó) y **Reposición de surtido** (reglas de mínimo y máximo por ubicación de surtido).

### Movimientos
- **Registrar entrada:** busca el producto, escribe cuánto entra y dónde lo guardas, lote y caducidad si aplica, y **Registrar entrada**. Si el sistema avisa de una entrada repetida o falta de capacidad, léelo antes de **Registrar de todos modos**.
- **Registrar salida:** la única forma de sacar. Agrega uno o varios productos, escribe cantidades, elige el **Motivo** y **Registrar salida**.
- **Cambiar de lugar** (reubicar), **Corregir existencias** (con motivo obligatorio; si la empresa lo pide, un ajuste grande espera autorización), **Saldo inicial** (una vez por producto y ubicación) y **Reversar** (con motivo).
- Traslados entre almacenes: **Nuevo traslado** y **Enviar**; recibir y resolver también.

### Conteos
**Iniciar un conteo** por ubicación, capturar con **Guardar captura** y **Aplicar conteo** cuando termines (con motivo si hay diferencias). También **Programas de conteo**.

### Pedidos de salida
**Nuevo pedido**, agregar líneas, **Liberar al almacén** (aparta lo que hay y crea tareas de surtido), o **Importar pedidos** desde Excel. Después: empaque (**Seguir empacando**), **Armar embarque** y **Confirmar salida**, y **Registrar devolución** de lo que regresa un cliente.

### Tareas
Puedes crear (**Nueva tarea**), asignar, liberar y cancelar tareas, y revisar las **Abiertas** y **Terminadas**. Cómo se hace una tarea, en [Almacenista](rol-almacenista.md).

### Ubicaciones, equipos y producción
**Configuración › Ubicaciones** (agregar, mover, archivar, etiquetas) y **Configuración › Equipos del almacén** (**Registrar equipo**, **Registrar mantenimiento**, **Tipos de equipo**). En Producción puedes ver órdenes y recetas y decidir las **solicitudes de producción** (ver [Encargado de producción](rol-encargado-produccion.md)).

## Lo que no puedes hacer (y a quién pedirlo)
Recibir órdenes de compra (Supervisor, Almacenista o Comprador), crear órdenes de compra (Comprador), ver costos, invitar personas o cambiar la configuración de la empresa (Administrador).

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8). Gestionas las incidencias abiertas: **Atender**, **Resolver** o **Descartar**.

Vigente al 2026-11-19
