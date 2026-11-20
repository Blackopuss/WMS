# Manual del Operario de producción

El Operario produce desde el teléfono o una tableta compartida. Solo existe si la empresa tiene contratado el módulo **Producción**. Antes lee [lo común](comun.md).

## Cómo entras
Con correo y contraseña, o con PIN en una terminal compartida del piso (el Operario está entre los roles que pueden usar PIN por omisión). No ve costos.

## Lo que ves en el menú
Inicio, Tareas, Producción, Inventario, Incidencias y Configuración.

## Qué existe hoy y qué todavía no

**Disponible hoy:** ver recetas y órdenes, **reportar lo que produjiste** con su foto, **reportar merma de material**, avisar que falta material, pedir producción cuando no tienes nada que hacer, hacer las tareas que te asignen y reportar incidencias.

**Todavía no disponible:** registrar turnos o paros.

Cuando una orden se cierra (lo hace el Encargado, también si quedó con faltante), ya no admite reportes ni merma; si estabas asignado o la pediste, te llega el aviso **Se cerró una orden de producción**.

## Tus tareas del día

### Ver lo que te toca
- **Producción:** lista de órdenes. La pestaña **Mías** muestra las asignadas a ti; **Abiertas** y **Todas** muestran las demás. Abre una orden (**OP-0001**) para ver los **Materiales**, **Lo que sale** y **Quién la hace**. No puedes crearla, cambiarla, liberarla ni cancelarla.
- **Inventario › <producto producido> › Receta:** qué materiales lleva y cuánto sale, **Para cuánto** es y las versiones (**Ver versiones**). Solo lectura.

### Reportar lo que produjiste
En la orden (**Producción › OP-0001**), toca **Reportar producción**.
1. Escribe **Hice (buenas)**: nunca más de lo que **Falta** de la orden.
2. Si salieron piezas malas, escribe **Piezas malas (opcional)** y **Por qué salieron malas**. No entran al almacén, pero su material sí se descuenta.
3. Si un material es por serie, escanea sus series; si lo que haces es por serie, escanea las series de lo que hiciste. Si el lote lleva caducidad, escríbela.
4. Toma la **Foto de lo que hiciste** (tu empresa decide si es obligatoria).
5. Toca **Guardar reporte**.

El sistema descuenta solo lo que dice la receta (no capturas el consumo) y lo hecho queda **en inspección** en el área, con su propio lote, hasta que alguien lo revise. Si el material no alcanza, no se guarda nada: la pantalla dice qué falta y para cuánto alcanza. Puedes reportar lo que sí alcanza y tocar **Avisar que falta material** en la orden; le llega a quien decide en tu área. Si la orden tiene personas asignadas, solo ellas reportan.

### Merma de material
Si un material se rompió o se perdió (no una pieza mala), en la orden toca **Reportar merma de material**: elige el **Material**, escribe **Cuánto se perdió** y **Qué pasó**, y **Reportar merma**. No entra al costo de lo producido. Si tu empresa pide autorizarla, queda pendiente hasta que alguien la autorice.

### Tareas del piso
Si la orden usa **Se surten al área de producción**, aparecen en **Tareas** tareas **Surtir a producción OP-…**. Se hacen con tres pasos (**Tomar tarea**, **Ya recogí la carga**, **Ya la dejé en…**) como en el manual del [Montacarguista](rol-montacarguista.md). Si tu empresa pidió foto al entregar, tómala.

### Pedir producción cuando no tienes tareas
Si lo que produces está por acabarse, en **Tareas** aparece el bloque **Queda poco** con el botón **Pedir producción** (o **Producción › Solicitudes de producción › Pedir producción**).
1. Escribe **Cuánto quieres producir**, elige **Dónde se produce** si hay varias áreas y, si quieres, **Por qué**.
2. Toca **Enviar solicitud**. Quien decide en tu área la recibe; te avisan cuando responde.

Condiciones: **no debes tener nada a tu nombre** (órdenes liberadas asignadas, etapas de proceso tomadas o tareas sin terminar), el producto debe tener receta vigente y estar cerca de su mínimo. No ves cifras de existencias. No puedes tener dos solicitudes por atender del mismo producto. Si no cumples, la pantalla dice **Ahora no puedes pedir producción**. Puedes **Cancelar solicitud** si todavía está por atender.

### Etapas de un proceso
Si tu empresa publicó etapas para la orden de producción, en **Tareas** ves con la insignia **Etapa** las que te tocan por tu área.

## Lo que no puedes hacer (y a quién pedirlo)
Crear o cambiar recetas y órdenes, decidir solicitudes, corregir existencias o ver costos: [Encargado de producción](rol-encargado-produccion.md) o [Administrador](rol-administrador.md).

## Si algo falla
**Reportar un problema** (**Inicio** o **Incidencias**; ver [común](comun.md), sección 8). Si el material no está, toca **Avisar que falta material** en la orden o repórtalo como incidencia.

Vigente al 2026-11-20 (cierre de la orden: WMS-31)
