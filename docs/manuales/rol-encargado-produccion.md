# Manual del Encargado de producción

El Encargado administra recetas y órdenes de su área, y decide las solicitudes de producción. Solo existe con el módulo **Producción** contratado. No corrige existencias, no maneja equipos y no ve costos. Antes lee [lo común](comun.md).

## Cómo entras
Correo y contraseña, o PIN en una terminal compartida si la empresa eligió «Piso y supervisión». Desde una terminal con PIN **no** se cambian recetas ni planes de inspección: eso se hace en tu propio dispositivo. Sí puedes liberar y cancelar órdenes desde la terminal.

## Lo que ves en el menú
Inicio, Tareas, Producción, Inventario, Incidencias y Configuración.

## Qué existe hoy y qué todavía no

**Disponible hoy:** recetas, órdenes (crear, cambiar, liberar, cancelar y **cerrar**), solicitudes de producción, **reportes de producción** (reportar, ver y revertir), **merma de material** y el acomodo de lo aprobado.

**Todavía no disponible:** los turnos. Una orden pasa a **En proceso** con su primer reporte y desde ahí ya no se cancela: se cierra con lo hecho (abajo). Lo producido queda en inspección hasta que se verifica (abajo).

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

### Reportes de producción
- En la orden, **Reportar producción** registra cuánto se hizo (buenas y malas) con su foto; el consumo sale solo de la receta y lo hecho entra **en inspección** al área con su propio lote. Lo mismo lo hace el Operario. Si la orden tiene personas asignadas, reportan ellas y tú.
- La orden muestra el **Avance** (buenas, malas, falta), quién la ejecutó, lo consumido y la lista de reportes (**R-01**, **R-02**…). Abre uno para ver qué materiales usó (con lotes y series), qué lote salió y sus fotos.
- **Revertir reporte** (en el reporte, con motivo) regresa los materiales a donde estaban y saca lo producido de inspección. Solo se puede mientras nadie haya movido ni liberado lo producido.
- **Reportar merma de material** registra material perdido fuera de la receta; no entra al costo de lo producido. Si la empresa enciende la regla **Merma de material de producción** en **Configuración › Reglas de aprobación**, la merma espera tu autorización.
- **Avisar que falta material**: cuando alguien de tu área lo toca, te llega un aviso.
- El nombre del lote de cada reporte lo decide **Configuración › Lotes de lo producido** (lo cambia el Administrador). Sin configurar, se llama como la orden y el reporte: **OP-0001-01**.

### Cerrar la orden
- En una orden **En proceso**, **Cerrar orden** abre el resumen: lo pedido, las buenas y malas, lo que falta, cuánto se aprobó, rechazó o quedó sin verificar de lo producido, y por material lo previsto, lo consumido, la merma y lo apartado sin usar.
- Si faltan piezas, escribe por qué se cierra así (por ejemplo, «faltó material»). Es la forma de terminar una orden que ya no se va a completar.
- Al cerrar, el material que seguía apartado queda libre donde está y se cancelan las tareas de surtir que nadie recogió. No se puede cerrar con material en camino al área ni con una merma esperando autorización.
- Las verificaciones abiertas siguen después del cierre; **Ver el cierre** en la orden muestra el resumen al día.
- Una orden liberada sin reportes no se cierra: se cancela.

### Lo aprobado a su lugar
Si la empresa acomoda con tareas, lo que se aprueba en el área de producción crea su tarea de acomodo hacia donde se guarda. Cuando todo el lote está decidido y su acomodo entregado (o, sin tareas de acomodo, con la última decisión), la etapa **Se guardó** del lote se marca sola, si la empresa la usa en su proceso.

### Solicitudes de producción
En **Producción › Solicitudes de producción** (**Solicitudes por atender (N)**):
1. Abre la solicitud (**SP-0001**). Ves las existencias del producto, lo que hace falta de cada material y para cuánto alcanza.
2. **Aceptar:** confirma cuánto, para cuándo y quién la hace; nace una orden a tu nombre y se apartan los materiales. Si el material no alcanza puedes **Aceptar y apartar lo que hay** o **Aceptar como borrador**.
3. **Rechazar:** escribe el motivo; quien pidió lo recibe en un aviso.
4. **Solicitudes de un pedido:** si la empresa pide a producción lo que le falta a un pedido, la solicitud nace sola al liberar el pedido y dice «Para el pedido …» (o «Para un pedido de un cliente» si no ves pedidos). Se acepta igual, sin personas asignadas de antemano. Lo que apruebes al verificar se aparta para ese pedido; lo que sobre se acomoda. Si el pedido ya no espera, aceptar te pide rechazarla. Si rechazas, cancelas la orden o la cierras con menos, el almacén recibe un aviso de que el pedido sigue esperando.

### Procesos
Si la empresa publicó un proceso para la orden de producción, **Tareas** muestra con la insignia **Etapa** las que te tocan, y puedes asignarlas a otra persona.

### Verificar lo producido (WMS-30B)
- **Con Calidad** contratada, lo producido lo verifica el Inspector de calidad; tú lo ves en el reporte (**Verificación**) y recibes el aviso **Se verificó lo que reportaste** cuando lo reportaste tú.
- **Sin Calidad**, verificas tú: en el reporte, **Iniciar verificación** (o desde **Inventario › Por inspeccionar**); cuentas, repartes lo contado (**Aprobadas**, rechazadas, dañadas, en cuarentena o a restauración) y dices qué pasó con lo que falta (**Merma**, **Eran menos desde el inicio** u **Otra causa**, con foto). Si quitaron Calidad con verificaciones abiertas, puedes cancelarlas para soltar lo retenido.

## Lo que no puedes hacer (y a quién pedirlo)
Corregir existencias (Almacén o Supervisor), administrar equipos o ver costos, ni cambiar la configuración (Administrador).

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8).

Vigente al 2026-11-20 (cierre de la orden: WMS-31; pedido ligado a producción: WMS-79)
