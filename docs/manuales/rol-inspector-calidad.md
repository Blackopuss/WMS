# Manual del Inspector de calidad

El Inspector de calidad revisa y decide sobre lo producido o recibido. Solo existe con el módulo **Calidad** contratado (que depende de Producción). Antes lee [lo común](comun.md).

## Cómo entras
Correo y contraseña, o PIN en una terminal compartida (el Inspector está entre los roles que pueden usar PIN por omisión). No ve costos.

## Lo que ves en el menú
Inicio, Tareas (para las etapas de proceso), Producción (solo lectura), Inventario, Incidencias y Configuración.

## Qué existe hoy y qué todavía no

**Todavía no disponible:** registrar la inspección (anotar los puntos de un plan, liberar o rechazar lo producido o recibido eligiendo un defecto). Aunque tu rol incluya esos permisos, hoy no hay pantalla para ellos.

**Disponible hoy:**
- Ver los **planes de inspección** de los productos.
- Ver el **catálogo de defectos**.
- Hacer las **etapas de proceso** que te asignen.
- Reportar incidencias.

## Tus tareas del día

### Consultar el plan de un producto
**Inventario › <producto>:** en el bloque **Inspección** está el enlace **Plan de inspección** con su versión, o **Sin plan de inspección** (entonces la calidad se revisa como dice el ajuste de la empresa: completa o por muestra). Toca **Plan de inspección** para ver:
- **Revisión de calidad:** **Completa**, o **Por muestra** (cuántas se revisan, o un porcentaje con mínimo y tope).
- A qué aplica: producido, recibido o devuelto.
- Los **puntos**: qué se revisa y qué se anota (sí o no, número con mínimo y máximo, opción de lista, texto), si es **Obligatorio** u **Opcional** y si **Pide foto**.
- **Versiones anteriores**.
No puedes crear ni cambiar planes: lo hace Administración o el titular.

### Ver los defectos
**Configuración › Defectos:** el catálogo con su gravedad (**Menor**, **Mayor** o **Crítica**, solo informativa). Hoy ninguna pantalla los usa para rechazar algo.

### Lo que llegó «En inspección»
Cuando un producto está marcado como **Inspeccionar al recibir**, lo sano de una recepción entra **En inspección** y no está disponible. La lista **Por inspeccionar** la ven quienes pueden decidir, no tu rol. **Decidir** (liberar, mandar a dañado, a rechazado o a restauración) se hace con **Cambiar estado**, y requiere permisos que el rol Inspector no tiene hoy: pídeselo al [Supervisor de almacén](rol-supervisor-almacen.md) o a [Almacén](rol-almacen.md).

### Etapas de proceso
Si tu empresa publicó etapas con tu área, aparecen en **Tareas** con la insignia **Etapa**: toma la etapa, sube la nota o foto que pida y termínala.

## Lo que no puedes hacer (y a quién pedirlo)
Producir, crear órdenes, corregir existencias, cambiar planes o ver costos: [Encargado de producción](rol-encargado-produccion.md), [Almacén](rol-almacen.md) o [Administrador](rol-administrador.md).

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8).

Vigente al 2026-11-19
