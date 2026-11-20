# Manual del Inspector de calidad

El Inspector de calidad revisa y decide sobre lo producido o recibido. Solo existe con el módulo **Calidad** contratado (que depende de Producción). Antes lee [lo común](comun.md).

## Cómo entras
Correo y contraseña, o PIN en una terminal compartida (el Inspector está entre los roles que pueden usar PIN por omisión). No ve costos.

## Lo que ves en el menú
Inicio, Tareas (para las etapas de proceso), Producción (solo lectura), Inventario, Incidencias y Configuración.

## Qué existe hoy y qué todavía no

**Disponible hoy:**
- **Verificar** lo producido, lo recibido en inspección, lo devuelto por un cliente y lo que está en cuarentena: contar, contestar el plan, anotar defectos y decidir cada parte.
- Ver los **planes de inspección** y el **catálogo de defectos**.
- Hacer las **etapas de proceso** que te asignen.
- Reportar incidencias.

Lo que apruebas en el área de producción sale con su tarea de acomodo si la empresa acomoda con tareas; si lo mandas directo a un lugar donde se guarda, no lleva tarea.

## Tus tareas del día

### Lo que espera verificación
**Inicio** te avisa «N renglones por inspeccionar». Ábrelo, o ve a **Inventario › Por inspeccionar**. Cada renglón es un producto en un lugar (y lote). Tócalo para **Iniciar verificación**:
1. Elige **¿De dónde viene?**: lo producido (orden y reporte), lo recibido de un proveedor, lo devuelto por un cliente u **Otro** (por ejemplo, lo que regresó de restauración). Con **Otro** escribe cuánto verificas.
2. Toca **Iniciar verificación**. Lo que vas a revisar queda **retenido**: nadie más lo cambia mientras la verificación esté abierta.

Si lo producido tiene una etapa anterior sin terminar (por ejemplo «Lijado»), la pantalla dice **Esperando…** y no se puede verificar hasta que termine.

### Decidir
En la verificación:
- Contesta los **Puntos del plan** (si el producto tiene plan para ese origen).
- En **Lo que se contó**, escribe cuántas son **Aprobadas** y, si hace falta, abre **Rechazadas, dañadas, en cuarentena o a restauración** y reparte el resto, cada una con **Por qué**. En **Dónde quedan** puedes moverlas a otro lugar del mismo almacén.
- Si contaste menos de lo esperado, abre **Falta algo de lo esperado** y di qué pasó: **Merma**, **Eran menos desde el inicio** (solo en lo producido) u **Otra causa**, con lo que pasó. **Pide foto.**
- Si la revisión es **por muestra** sin tamaño, escribe **Cuántas revisaste**.
- **Defectos encontrados** (opcional) y **Fotos**.
- Toca **Confirmar**. Contadas más lo que falta debe ser exactamente lo esperado; no se puede contar de más.

Si la empresa pide autorizar las pérdidas, la decisión queda **pendiente de autorización** y no se aplica nada hasta que alguien la autorice; mientras tanto no se puede decidir otra vez ni cancelar.

Si el lugar no admite nada disponible (por ejemplo, un área dentro de una cuarentena), elige en **Dónde quedan** a dónde van las aprobadas.

### Ver y cancelar verificaciones
**Inventario › Por inspeccionar › Verificaciones**: las abiertas y las terminadas. **Cancelar verificación** (con su porqué) suelta lo retenido sin mover nada.

### Consultar el plan de un producto
**Inventario › <producto>:** en el bloque **Inspección** está el enlace **Plan de inspección** con su versión, o **Sin plan de inspección** (entonces la calidad se revisa como dice el ajuste de la empresa: completa o por muestra). No puedes crear ni cambiar planes: lo hace Administración o el titular.

### Ver los defectos
**Configuración › Defectos:** el catálogo con su gravedad (**Menor**, **Mayor** o **Crítica**, solo informativa).

### Etapas de proceso
Si tu empresa publicó etapas con tu área, aparecen en **Tareas** con la insignia **Etapa**: toma la etapa, sube la nota o foto que pida y termínala.

## Lo que no puedes hacer (y a quién pedirlo)
Producir, crear órdenes, corregir existencias, cambiar planes o ver costos: [Encargado de producción](rol-encargado-produccion.md), [Almacén](rol-almacen.md) o [Administrador](rol-administrador.md).

## Si algo falla
**Reportar un problema** ([común](comun.md), sección 8).

Vigente al 2026-11-20 (WMS-31)
