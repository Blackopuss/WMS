# Revisión visual de la operación de almacén (WMS-78B)

Fecha: 2026-11-16. Alcance: Inicio, Tareas (con olas y el bloque de etapas de
procesos), `/procesos/[id]`, Recepción, Pedidos (nuevo, ficha, importar,
empaque, olas, embarques, devoluciones), Inventario y todo lo que cuelga de él
(salvo los bloques y páginas de «Receta» e «Inspección» de la ficha, que son
de WMS-78C), Movimientos (con traslados entre almacenes), Conteos e
Incidencias. Solo interfaz: no cambió ninguna regla de negocio, servicio,
permiso ni migración.

## Cómo se revisó

- **Datos.** Una base propia, `wms_vis_dev`, con la cuenta demo
  (`npm run db:seed`), los datos de ejemplo (`npm run db:seed:ejemplo`) y un
  script temporal que, con los servicios reales, encendió acomodo por tareas,
  tarimas, empaque, olas y cross-docking, y creó: reposición con su tarea,
  algo sin acomodar, un producto por serie, una tarima armada, existencias en
  inspección, restauración y dañadas, una recepción parcial con lote, un
  pedido surtido, empacado y despachado y otro empacado en un embarque por
  confirmar, una devolución de cliente sin decidir, una ola, un segundo
  almacén con un traslado enviado y otro en borrador, un programa de conteo
  cíclico con capturas, dos incidencias (una con nota) y tareas aceptadas,
  con problema y entregadas. Además personas de piso (`operador`,
  Almacenista; `montacargas`, Montacarguista) y una sin permisos del área
  (`compras`, Comprador). La reconciliación quedó en cero.
- **Pantallas.** 47 rutas fijas más 42 fichas con datos (pedidos en cada
  estado, empaque, embarques, devolución, tareas de traslado, surtido,
  acomodo y reposición en cada estado, ola, traslados, conteos, programa,
  incidencias, productos normal, por lote, por serie y con varios estados,
  editar, estado, desechar, etiquetas, lotes, tarima, regla de reposición,
  reubicar con lote, ajuste con series y el rastreo de una serie y un lote):
  **89 pantallas**. También vacías (antes de los datos y con los ajustes
  apagados).
- **Por pantalla:** modo claro y oscuro, 1280 px y 390 px (356 cargas), más
  desbordamiento horizontal en 320, 768 y 1920 px; con el titular, con el
  Almacenista y el Montacarguista en teléfono, y con el Comprador.
  1. **axe-core 4** con Playwright (Chromium incluido), etiquetas WCAG 2.0,
     2.1 y 2.2 A/AA **y buenas prácticas**, todas las gravedades.
  2. Consola del navegador: errores, avisos de React y respuestas 4xx/5xx.
  3. Un `h1`, jerarquía de encabezados, tipografía aplicada (Inter en todo
     `main`), objetivos táctiles en teléfono.
  4. **A ojo**: captura completa de cada pantalla en los dos temas y los dos
     tamaños (más de 600 capturas), revisadas una por una.
  5. Formularios enviados vacíos: el foco debe caer en un error explicado.
  6. Cuadro del lector de «Registrar salida»: con un código desconocido y
     Enter sigue con el foco y nunca se deshabilita (INV-29).

## Resultado

| | Antes | Después |
| --- | --- | --- |
| Violaciones de axe (A/AA + buenas prácticas), 356 cargas | 2 (`page-has-heading-one`, «Nueva ola» con olas apagadas, claro y oscuro) | **0** |
| Desbordamiento horizontal en 320, 390, 768, 1280 y 1920 px | 0 | 0 |
| Errores o avisos en la consola | 4 pantallas (aviso de React por `key` en `NativeSelect`: Nuevo pedido, Nuevo producto, Editar producto, ficha de la devolución) | **0** |
| Formularios vacíos que llevan el foco a un error explicado (Reportar un problema, Nuevo pedido, Nuevo programa de conteo, Nueva regla de reposición) | 0 de 4 (Incidencias llevaba el foco, pero sin `aria-invalid` ni el error ligado) | **4 de 4** |
| Pantallas sin `h1` | 1 con datos; en solo lectura, «Registrar entrada» medida y otras 16 pantallas con el mismo código | **0** |
| Objetivos táctiles < 44 px en teléfono | 0 | 0 |
| Almacenista y Montacarguista en teléfono (89 pantallas cada uno) | 0 violaciones | 0 |
| Rol sin permiso (Comprador) y lo que el piso no puede | «No tienes acceso a esta sección», sin errores | igual |
| Módulo Inventario en solo lectura (44 pantallas) | sin `h1` en las de escritura (solo el aviso) | **0** |

Por área (axe en claro/oscuro, escritorio/teléfono; antes → después):

| Área | Pantallas | axe | Consola | A ojo (antes) | Corregido |
| --- | --- | --- | --- | --- | --- |
| Inicio | 1 | 0 → 0 | 0 | etiquetas de «Lo que se hizo hoy» a distinta altura; tres avisos sueltos | sí |
| Tareas, olas, procesos | 15 | 0 → 0 | 0 | «Guardar» deshabilitado sin explicación en Supervisión; el número de cada pestaña se anunciaba pegado («Disponibles5») | sí |
| Recepción | 1 | 0 → 0 | 0 | — | — |
| Pedidos, empaque, embarques, devoluciones, olas | 22 | 2 → 0 | 2 → 0 | «PS-» y «0004» partidos en el título; cantidades desalineadas en teléfono; enlace dentro de una frase con 44 px de alto; «—» en datos de transporte vacíos; «Producto» y «Cantidad» a distinta altura | sí |
| Inventario | 30 | 0 → 0 | 2 → 0 | hasta cinco avisos sueltos antes de la lista; cantidades y flechas sueltas al partir el renglón en teléfono; botones del encabezado de Tarimas más altos y con la acción principal al final | sí |
| Movimientos y traslados | 12 | 0 → 0 | 0 | «Reversar» encogía el texto del historial en teléfono | sí |
| Conteos | 8 | 0 → 0 | 0 | — | — |
| Incidencias | 4 | 0 → 0 | 0 | los botones de «¿Qué pasó?» no decían que tenían error | sí |

## Qué se corrigió

1. **`h1` en «Nueva ola»** con el surtido por olas apagado.
2. **Avisos de React por `key`** en opciones fijas de `NativeSelect` dentro de
   `FormField` (Nuevo pedido, producto, devolución): cada opción fija lleva su
   `key`, como ya pedía `AGENTS.md` (IMP-04).
3. **Foco al primer error** tras un envío rechazado: gancho nuevo
   `useFocusFirstError` (`src/components/focus-first-error.ts`), aplicado a
   Nuevo pedido, Nuevo programa de conteo y Nueva regla de reposición (medido)
   y también a Nueva tarea, Nuevo traslado y Registrar devolución (sus primeros
   pasos son búsquedas, así que no se midieron vacíos); en Reportar un problema los
   botones de «¿Qué pasó?» llevan `aria-invalid` y `aria-describedby`.
4. **Renglones de lista en teléfono:** al partirse el renglón, la cantidad y la
   flecha quedaban a la izquierda o centradas. Ahora se quedan a la derecha
   (`ml-auto`) en Inventario, ficha del producto, Sin acomodar, Por caducar,
   Por inspeccionar, En restauración, Tarimas, Reposición, Pedidos, empaque,
   Tareas, olas, Recepción, embarques, devoluciones, traslados, saldo inicial,
   Conteos, programas e Incidencias.
5. **Avisos agrupados** (`src/components/pending-notices.tsx`): en Inicio e
   Inventario, «por inspeccionar», «en restauración», «sin acomodar» y «por
   caducar» son una sola tarjeta con un renglón por aviso; antes eran hasta
   cinco tarjetas que bajaban la lista de productos fuera de la pantalla del
   teléfono. «Existencias bajas» sigue aparte, con su color de aviso.
6. **Historial de Movimientos en teléfono:** «Reversar» pasa debajo del
   movimiento; antes ocupaba una columna y el texto se partía en tres o
   cuatro renglones.
7. **Números de documento** (`PS-0004`, `EM-0001`, `INC-0002`…) ya no se parten
   en el guion en los títulos (`PageHeader`).
8. **«Lo que se hizo hoy»**: número y etiqueta alineados arriba en todos los
   recuadros.
9. **Supervisión de una tarea:** «Guardar» aparece solo cuando se eligió a
   otra persona, en vez de estar deshabilitado sin explicación (regla KISS).
10. **Embarque:** los datos de transporte muestran solo los que existen
    (antes «—» en cada uno); sin ninguno dice «Sin datos de transporte».
11. **Ficha del pedido:** «Producto» y «Cantidad» del formulario para agregar
    quedan a la misma altura; el enlace a la ola dentro de la frase ya no
    mide 44 px de alto (excepción de WCAG 2.5.8 para enlaces en texto) y va
    subrayado.
12. **Tarimas:** encabezado con la acción principal primero y el tamaño de
    botón de todos los encabezados.
13. **Solo lectura:** las pantallas de escritura (entrada, salida, ajuste,
    reubicar, saldo inicial, nuevo producto, editar, estado, desechar,
    importar, nueva tarea, nuevo pedido, armar embarque, registrar
    devolución, mover y armar tarima, nueva regla, nuevo traslado, nuevo
    programa) muestran su título además del aviso «en solo lectura».
14. **Lectores de pantalla:** «Existencias bajas: 2» y «Disponibles: 5» en
    lugar de «bajas2» y «Disponibles5».
15. **Foco visible** en la fila de «Programas de conteo» (el anillo estaba en
    el seudoelemento y no en el enlace) y enlaces de 20 px con anillo de foco
    en la ficha de una tarea («Pedido PS-0001», «OP-…») y en la revisión de
    una importación.

## Scripts de verificación

- `scripts/verify-a11y.mjs`: bloque «WMS-78B» con las pantallas del área que
  faltaban en `SCREENS` (vistas de Tareas, Existencias bajas, Por
  inspeccionar, En restauración, Importar salidas, Registrar salida, Cambiar
  de lugar, Corregir existencias, Saldo inicial), fichas nuevas (tarea,
  editar, estado y desechar un producto, incidencia, programa de conteo,
  tarima, regla de reposición) y cuatro formularios en `FORMS`.
- `scripts/verify-ui.mjs`: bloque «WMS-78B» (a 320 px: un `h1` y sin
  desbordamiento en las siete secciones; avisos pendientes en renglones de
  44 px; el cuadro del lector de «Registrar salida» conserva el foco; modo
  oscuro). Además se corrigió un selector de Configuración que dejó de ser
  único con WMS-42 (`/Equipo/` encontraba también «Equipos del almacén»).
- Resultado con `UI_BROWSER=chromium` sobre la base de revisión:
  - `verify:a11y` (app compilada): 686 comprobaciones pasan; fallan 2 de
    otra área: objetivos táctiles en `/configuracion/equipos-del-almacen/nuevo`
    («Tipos de equipo») y `/ubicaciones/etiquetas` («Ubicaciones», ya anotado
    en el relevo). Las dos de esta área que salieron en la primera corrida
    (foco visible en la fila de «Programas de conteo» y el enlace «PS-0001»
    de la ficha de una tarea) quedaron corregidas.
  - `verify:pwa` (app compilada sobre `wms_test`): 62 de 62.
  - `verify:ui` (desarrollo): se detiene en Configuración › Equipo, en el
    diálogo «Invitar a tu equipo» («Enviar invitación» fuera de la pantalla),
    antes de llegar al bloque de esta área; ese bloque, corrido aparte,
    pasa 10 de 10.

## Archivos compartidos que se tocaron

- `src/components/states.tsx`: `PageHeader` envuelve los números de documento
  del título en `whitespace-nowrap` (función `keepCodesTogether`). Sin cambio
  de firma; se comprobó en Configuración, Compras y la ficha de una orden de
  compra («Orden OC-0001»).
- Archivos nuevos en `src/components/` (no tocan nada existente):
  `pending-notices.tsx` y `focus-first-error.ts`.
- Ni tokens de color, ni `src/components/ui/*`, ni `motion.tsx`, ni el
  `AppShell`.

## Lo que no llegó a 100 o no se pudo medir

- **Lighthouse no se pudo correr:** descargarlo con `npx lighthouse` fue
  rechazado por los permisos del contenedor y no está entre las
  dependencias. Su categoría de accesibilidad es un subconjunto de axe-core,
  que pasó sin ninguna violación (incluidas buenas prácticas); de «Buenas
  prácticas» se comprobó lo que se puede sin él: consola sin errores, sin
  respuestas fallidas y sin desbordamiento. Rendimiento no se midió sobre la
  app compilada por la misma razón. Pendiente correrlo donde se pueda
  instalar.
- **Campos nativos de archivo y fecha** («Choose File», «mm/dd/yyyy») salen en
  el idioma del navegador: en un navegador en español se ven en español. No se
  reemplazaron por controles propios.
- **Textos cortados en selectores nativos** en teléfono («Qué existencias» de
  Desechar y Cambiar estado, «De dónde sale y de qué lote»): el `<select>`
  nativo no parte renglones; el texto completo se ve al abrirlo.
- **Marcadores de búsqueda cortados** en teléfono («Nombre, clave o código de
  b…»): la etiqueta real del campo sigue completa para lectores de pantalla.
- **Filtros de estado de Pedidos** ocupan cuatro renglones en teléfono; no se
  plegaron porque se usan a diario.
- **`/procesos/[id]`** no se pudo ver con datos: no hay ningún proceso
  publicado en la empresa de prueba (vacío, sin violaciones).

## Visto en otras áreas (no se corrigió aquí)

- **WMS-78A:** `verify:ui` se detiene en el diálogo «Invitar a tu equipo» y
  `verify:a11y` falla en objetivos táctiles de «Nuevo equipo del almacén» y
  «Etiquetas de ubicaciones» (ver «Scripts de verificación»).

- **WMS-78A (`AppShell`):** con un rol de tres secciones (Montacarguista), la
  barra inferior del teléfono deja un hueco a la derecha en vez de repartir
  el ancho.
- **WMS-78A/lógica:** «Embarques» dice «1 pedido listo para salir» mientras
  «Armar embarque» dice que no hay ninguno: el pedido ya está en un embarque
  por confirmar y el contador lo sigue contando.
- La herramienta `next dev` avisa de una vulnerabilidad conocida en la versión
  instalada de Next.js; no se actualizó (no se agregan ni cambian
  dependencias en este paso).
