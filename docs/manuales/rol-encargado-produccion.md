# Manual del Encargado de producción

El Encargado administra recetas y órdenes de su área, y decide las solicitudes de producción. Solo existe con el módulo **Producción** contratado. No corrige existencias, no maneja equipos y no ve costos. Antes lee [lo común](comun.md).

## Cómo entras
Correo y contraseña, o PIN en una terminal compartida si la empresa eligió «Piso y supervisión». Desde una terminal con PIN **no** se cambian recetas ni planes de inspección: eso se hace en tu propio dispositivo. Sí puedes liberar y cancelar órdenes desde la terminal.

## Lo que ves en el menú
Inicio, Tareas, Producción, Inventario, Incidencias y Configuración.

## Qué existe hoy y qué todavía no

**Disponible hoy:** recetas, órdenes (crear, cambiar, liberar y cancelar) y solicitudes de producción.

**Todavía no disponible:** el reporte de lo producido (cuánto se consumió, cuánto salió, merma), la verificación de lo producido, el **cierre de la orden** y los turnos. Por eso una orden liberada hoy se queda en **Liberada**: todavía no pasa a «En proceso» ni a «Cerrada», y no se consumen materiales ni se da de alta producto terminado. Una orden ya empezada no se cancela (hoy ninguna empieza).

## Tus tareas del día

### Recetas
En **Inventario › <producto> › Receta** (**Agregar receta** la primera vez, **Cambiar receta** después):
1. **Para cuánto** es la receta (cantidad base).
2. **Materiales:** producto, cantidad, en qué unidad y **Merma esperada (%)** (solo informativa).
3. **Lo que sale:** producto y cuánto sale, y **Parte del costo (%)** (las partes deben sumar 100).
4. **Activar <versión>:** a partir de ahí las órdenes nuevas usan esa versión; la anterior queda retirada. **Descartar borrador** si te equivocaste. Una versión activada no se cambia: para modificarla, **Cambiar receta** crea la siguiente.
5. **Dónde se produce:** elige el área de producción por omisión de la receta (**Guardar área**).
El sistema rechaza activar si hay un ciclo (no puedes armar y desarmar el mismo kit).

### Órdenes de producción
1. **Producción › Nueva orden:** busca un producto con receta, escribe **Cuánto**, el **Área de producción**, **Para cuándo**, **Prioridad**, **Quién la hace** e **Indicaciones**, y **Crear orden**. Queda en **Borrador** copiando los materiales de la receta vigente (no mueve ni aparta nada todavía). Si la receta cambió, usa **Usar la receta vigente**.
2. **Cambiar la orden** mientras sea borrador.
3. **Liberar orden:** aparta los materiales (lo que caduca antes primero). Si falta algo, según el ajuste de la empresa avisa y te ofrece **Liberar con lo que hay** o no deja liberar. Con «Se surten al área de producción», se crean tareas de surtido para el piso.
4. **Cambiar personas** (quién hace la orden) o **Cancelar orden** (con motivo; lo apartado vuelve a estar libre).
Una orden necesita un área: una ubicación con uso **Producción** (la crea en **Ubicaciones** quien administra o el rol [Almacén](rol-almacen.md); tú no puedes). Sin área, el sistema avisa **No hay áreas de producción**.

### Solicitudes de producción
En **Producción › Solicitudes de producción** (**Solicitudes por atender (N)**):
1. Abre la solicitud (**SP-0001**). Ves las existencias del producto, lo que hace falta de cada material y para cuánto alcanza.
2. **Aceptar:** confirma cuánto, para cuándo y quién la hace; nace una orden a tu nombre y se apartan los materiales. Si el material no alcanza puedes **Aceptar y apartar lo que hay** o **Aceptar como borrador**.
3. **Rechazar:** escribe el motivo; quien pidió lo recibe en un aviso.

### Procesos
Si la empresa publicó un proceso para la orden de producción, **Tareas › Etapas de procesos** muestra las que te tocan, y puedes asignarlas a otra persona.

## Lo que no puedes hacer (y a quién pedirlo)
Corregir existencias (Almacén o Supervisor), administrar equipos o ver costos, ni cambiar la configuración (Administrador).

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8).

Vigente al 2026-11-19
