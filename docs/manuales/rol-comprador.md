# Manual del Comprador

El Comprador administra proveedores, órdenes de compra, recepciones y devoluciones al proveedor, y consulta inventario. Ve costos. Antes lee [lo común](comun.md). Requiere el módulo **Compras**.

## Cómo entras
Correo y contraseña (dos pasos opcionales).

## Lo que ves en el menú
Inicio, Recepción, Inventario, Movimientos (solo lectura), Compras y Configuración. (No ves Tareas, Pedidos, Conteos ni Incidencias.)

## Tus tareas del día

### Saber qué pedir
1. **Compras › Qué pedir:** lo que está en su mínimo y no viene en camino, por proveedor. En un proveedor, toca **Crear borrador** para armar una orden. Los que no tienen proveedor aparecen en **Sin proveedor**: lígalos desde la ficha del proveedor.
2. **Compras › Solicitudes de compra:** lo que pidió el almacén, filtrado en **Por atender**. Abre una solicitud y elige **A quién comprarle** (por línea o **Comprar todo a**) y toca **Crear orden** (crea un borrador por proveedor). Si no se va a comprar, **Rechazar solicitud** con el motivo.

### Proveedores
**Compras › Proveedores › Agregar proveedor** (nombre y RFC). Si ya existe uno parecido, el sistema avisa y puedes **Guardar de todos modos**. Abre el proveedor para **Vincular producto** (su código, cómo se compra, último costo; el último costo se anota solo al registrar una compra).

### Una orden de compra
1. **Compras › Nueva orden:** elige proveedor (no cambia después), almacén donde se recibe, fecha esperada y notas; toca **Empezar orden**.
2. **Agregar producto** (cantidad con su presentación y costo). Puedes cambiar o quitar líneas mientras sea borrador.
3. **Confirmar orden:** la da por enviada al proveedor (no manda correo solo).
4. **Enviar por correo** (si el proveedor tiene correo): manda la orden con su PDF; el panel **Envío por correo** dice cómo va. También hay **Descargar PDF**.
5. **Cancelar orden** (borrador o enviada) pide el motivo y queda guardada como cancelada.

### Recibir lo que llega
- **Recepción** lista las órdenes por recibir (la más antigua primero); la fila abre la orden. Ahí toca **Recibir mercancía**. Escribe lo que llegó de cada producto (lo que no llegó, déjalo en 0), elige **¿Dónde lo guardas?**, anota la remisión o factura y, si aplica, lote, caducidad, series o **De eso, dañado**. Toca **Confirmar recepción**. Si el sistema avisa que algo no cabe, léelo antes de **Recibir de todos modos**.
- Si llega solo una parte, la orden queda **Recibida en parte**. Para dejar de esperar lo que falta: **Cerrar con faltante** (con motivo).

### Devolver al proveedor
En la orden, en la recepción correspondiente, toca **Devolver al proveedor**, escribe cuánto regresa, de dónde sale y **¿Por qué se devuelve?**, y **Confirmar devolución**. Nunca más de lo recibido.

### Reportes
**Compras › Reportes:** **Pendientes por recibir** y **Compras por proveedor**, con rango de fechas y **Descargar**.

## Lo que no puedes hacer (y a quién pedirlo)
Registrar entradas o salidas de inventario manuales, ajustes, conteos o tareas: lo hace [Almacén](rol-almacen.md) o [Supervisor](rol-supervisor-almacen.md). Cambiar roles o configuración: [Administrador](rol-administrador.md). Para devolver algo que llegó por otro motivo que una recepción, pide ayuda a quien supervisa.

## Si ves algo raro
Avisa a quien supervisa el almacén; **Reportar un problema** no está en tu rol.

Vigente al 2026-11-19
