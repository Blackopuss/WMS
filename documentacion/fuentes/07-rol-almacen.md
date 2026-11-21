---
title: "Guía para el rol Almacén"
subtitle: "Guía 07 · Tareas del día, paso a paso"
---

El rol Almacén administra el catálogo, las ubicaciones, los movimientos y los conteos de Inventario, y arma pedidos y embarques. No opera Compras (no recibe órdenes de compra ni ve proveedores). Antes lee las guías 01 y 02. El Supervisor de almacén hace lo mismo y además recibe mercancía de órdenes de compra y ve el equipo.

## Cómo entras
Correo y contraseña (dos pasos opcionales). Con PIN si la empresa eligió «Piso y supervisión» o «Todos los que no usan verificación en dos pasos».

## Lo que ves en el menú
Inicio, Tareas, Pedidos, Producción (si está contratada, solo lectura de órdenes y recetas), Inventario, Movimientos, Conteos, Incidencias y Configuración. (No hay Recepción ni Compras.)

## Tus tareas del día

### Inventario
- **Agregar producto** y **Editar** (ficha, presentaciones, mínimos), **Importar Excel**, **Descargar en Excel**.
- En la ficha de un producto: **Entrada**, **Salida**, **Cambiar de lugar**, **Corregir existencias**, **Cambiar estado**, **Desechar** (solo lo dañado o rechazado, con motivo; no se reversa) e **Imprimir etiquetas**.
- **Existencias bajas**, **Sin acomodar**, **Por caducar**, **Por inspeccionar** y **En restauración** son listas de lo que necesita atención.
- **Inventario › Sugerencias de reubicación** (pantalla «Sugerencias de reubicación»): lo que conviene mover en tu almacén y en tus zonas, con una línea de por qué: **Acercar a surtido** (lo que sale seguido y no tiene lugar de surtido), **Sacar de surtido** (lo que no se ha movido y ocupa un lugar de surtido) y **Juntar** (el mismo producto y lote repartido en varias ubicaciones de almacenaje). **Crear tarea** hace una tarea de traslado normal con lo que el sistema decide en ese momento; **Ver la tarea** la abre. Lo que ya tiene una tarea en camino no se vuelve a sugerir. Qué se sugiere se ajusta en Configuración › Operación, en «Sugerencias de reubicación».
- **Tarimas y cajas** (si la empresa lo activó) y **Reposición de surtido** (reglas de mínimo y máximo por ubicación de surtido).

### Movimientos
- **Registrar entrada:** busca el producto, escribe cuánto entra y dónde lo guardas, lote y caducidad si aplica, y **Registrar entrada**. Si el sistema avisa de una entrada repetida o falta de capacidad, léelo antes de **Registrar de todos modos**.
- **Registrar salida:** la única forma de sacar. Agrega uno o varios productos, escribe cantidades, elige el **Motivo** y **Registrar salida**.
- **Cambiar de lugar** (reubicar), **Corregir existencias** (con motivo obligatorio; si la empresa lo pide, un ajuste grande espera autorización), **Saldo inicial** (una vez por producto y ubicación) y **Reversar** (con motivo).
- Traslados entre almacenes: **Nuevo traslado** y **Enviar**; recibir y resolver también.

### Conteos
**Iniciar un conteo** por ubicación, capturar con **Guardar captura** y **Aplicar conteo** cuando termines (con motivo si hay diferencias). También **Programas de conteo**.

### Pedidos de salida
**Nuevo pedido**, agregar líneas, **Liberar al almacén** (aparta lo que hay y crea tareas de surtido), o **Importar pedidos** desde Excel. Después: empaque (**Seguir empacando**), **Armar embarque** y **Confirmar salida**, y **Registrar devolución** de lo que regresa un cliente. Si la empresa pide a producción lo que falta (Configuración › Operación, «Lo que le falta a un pedido al liberarlo»), al liberar un pedido con un producto que tiene receta nace su **solicitud de producción** y el pedido muestra el bloque **Producción** («Espera producción»): no queda **Surtido** ni sale hasta que llegue lo producido (se aparta solo para ese pedido, con su tarea de surtido) o hasta que eliges **Dejar de esperar** (con motivo; sale con lo que tiene). Si producción rechaza, cancela o cierra corta, recibes el aviso **Un pedido sigue esperando producción** y puedes **Pedir producción de nuevo**. Si un pedido liberado o en surtido quedó corto y ya hay existencias libres (por ejemplo, llegó una compra), **Apartar lo que ya hay** las aparta para él con sus tareas de surtido. La liberación de una ola también pide a producción.

### Tareas
Puedes crear (**Nueva tarea**), asignar, liberar y cancelar tareas, y revisar las **Abiertas** y **Terminadas**. Cómo se hace una tarea, en Almacenista.

### Ubicaciones, equipos y producción
**Configuración › Ubicaciones** (agregar, mover, archivar, etiquetas) y **Configuración › Equipos del almacén** (**Registrar equipo**, **Registrar mantenimiento**, **Tipos de equipo**). En Producción puedes ver órdenes y recetas y decidir las **solicitudes de producción** (ver Encargado de producción).

### Verificar lo producido
Si la empresa tiene Producción **sin Calidad**, también verificas lo producido: desde **Inventario › Por inspeccionar**, toca el renglón e **Iniciar verificación**; cuenta, reparte lo contado (**Aprobadas**, rechazadas, dañadas, en cuarentena o a restauración) y di qué pasó con lo que falta (con foto). **Con Calidad**, lo hace el Inspector y lo que está en una verificación abierta no se puede cambiar con **Cambiar estado**; lo demás lo sigues liberando como siempre.

## Lo que no puedes hacer (y a quién pedirlo)
Recibir órdenes de compra (Supervisor, Almacenista o Comprador), crear órdenes de compra (Comprador), ver costos, invitar personas o cambiar la configuración de la empresa (Administrador).

## Si algo falla
**Reportar un problema** (guía 02). Gestionas las incidencias abiertas: **Atender**, **Resolver** o **Descartar**.
