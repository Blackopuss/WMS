# Revisión visual de Compras, Producción y Calidad (WMS-78C)

Fecha: 2026-11-16 y 2026-11-17. Alcance: Compras (órdenes con recibir,
devolver, cerrar con faltante, enviar por correo y PDF; proveedores y sus
productos; solicitudes de compra con la comparación de proveedores;
sugerencias; reportes), Producción (órdenes, solicitudes de producción con la
pantalla de decisión, el bloque «Queda poco» de `/tareas`), la receta y la
inspección de la ficha del producto (`/inventario/[id]/receta`, sus
versiones, «Dónde se produce», `/inventario/[id]/inspeccion` y los bloques
«Receta» e «Inspección» de la ficha) y Calidad en Configuración
(`/configuracion/defectos` y los ajustes de Operación › Producción y
Calidad). Solo interfaz: no cambió ninguna regla de negocio, permiso ni
migración (el único cambio fuera de `src/app` es el texto «lo producido, lo
recibido» de `plans.ts`, ver abajo).

## Cómo se revisó

- **Datos.** La cuenta demo de `wms_dev` con Producción y Calidad activos y
  un script temporal que llamó a los servicios reales: área de producción,
  dos productos con receta vigente y área (uno con borrador de cambio),
  órdenes en borrador, liberada, liberada con faltante («con lo que hay») y
  cancelada; solicitudes por atender, aceptada y rechazada; un plan de
  inspección publicado (cuatro tipos de punto, por muestra) y otro en
  borrador; tres defectos; órdenes de compra en borrador, enviada, recibida
  en parte, recibida (con devolución), cerrada con faltante y cancelada;
  solicitudes de compra en borrador, por atender, rechazada y convertida.
  Personas con los roles Operario (dos: una con orden asignada y otra sin
  nada a su nombre), Encargado de producción, Inspector, Comprador, Almacén y
  Consulta.
- **Roles.** Titular (todo), Operario en teléfono (lo que usa en piso:
  «Queda poco», «Pedir producción», sus órdenes), Encargado, y roles sin
  permiso: Comprador en Producción y Consulta; todos ven «sin acceso» o la
  versión de lectura, nunca un error.
- **Cada pantalla** en claro y oscuro, a 1280 y 390 px, más desbordamiento a
  320, 768 y 1920 px; axe-core con WCAG 2.1 A y AA **más buenas prácticas**
  (no solo las graves); un `h1`; objetivos táctiles de 44 px en teléfono;
  errores de consola; capturas de página completa revisadas a ojo.
- **Diálogos y formularios** con un script aparte: abrir con el teclado, el
  foco queda atrapado (15 tabulaciones), Escape lo devuelve al botón que lo
  abrió; enviar vacío lleva el foco al primer error explicado y ligado.
- **Lighthouse 12.6** (`npx`, sin agregarlo a `package.json`) sobre la app
  compilada (`next start`), con la cookie de la sesión por `--extra-headers`,
  en escritorio y en teléfono.

## Resultado por pantalla

axe completo (A, AA y buenas prácticas): **cero violaciones en las 47 rutas
y en los 19 diálogos y formularios**, antes y después, en los cuatro modos.
Lo que se encontró estaba fuera de axe (objetivos táctiles, foco, KISS,
alineación, textos).

| Pantalla | Antes | Después |
| --- | --- | --- |
| `/compras`, órdenes (6 estados), nueva, editar, línea | axe 0 | axe 0 |
| Recibir, devolver, cerrar, enviar, cancelar (diálogos) | Devolver: el error salía pero el foco se quedaba en el diálogo | Foco al campo con error |
| Proveedores (lista, nuevo, ficha, editar, productos) | axe 0 | axe 0 |
| Solicitudes de compra (lista, nueva, 3 fichas, convertir) | Flecha de «Comprar a» fuera del cuadro | Corregida (el cambio de `NativeSelect` de WMS-78A) |
| `/compras/sugerencias` | axe 0 | axe 0 |
| `/compras/reportes` | Enlaces de 17 px en teléfono; la fila no abría la orden | La fila completa abre la orden |
| `/produccion`, nueva, editar | Aviso de React por `key` en el formulario; enviar vacío no movía el foco | Sin aviso; foco al error |
| `/produccion/[id]` (4 estados) | Enlace del producto y de la solicitud de 17-20 px; «Cancelar orden» y «Cambiar personas» como texto suelto mal alineado | 44 px en teléfono; botones con borde, como en Compras |
| `/produccion/solicitudes` (lista y fichas) | Enlace a la orden de 17 px; «Rechazar» y «Cancelar solicitud» como texto suelto; títulos de sección de tamaños distintos | Corregido |
| Decidir una solicitud («Aceptar») | Error sin campo, sin foco | Error ligado a su campo (`aria-invalid`, `aria-describedby`) y foco |
| `/produccion/solicitudes/nueva` | Sin producto decía «Ese producto no se puede pedir» | Lista lo que se puede pedir o «Nada por pedir» |
| `/tareas` («Queda poco», Operario) | axe 0 | axe 0 |
| Ficha del producto (bloques) | «Inspección» con otro diseño que «Receta»; «Lo producido, Lo recibido» | Mismo encabezado con enlace «Plan de inspección»; «lo recibido» en minúscula |
| `/inventario/[id]/receta` y versiones | Formulario de material con campos desalineados (la ayuda subía el cuadro del producto); enviar vacío no movía el foco | Alineados; foco al error |
| `/inventario/[id]/inspeccion` | Enviar vacío no movía el foco | Foco al error |
| `/configuracion/defectos` | Cada defecto era un formulario abierto (dos campos, dos botones por fila); «Agregar» con estilo secundario | Fila con nombre y gravedad; el cambio va plegado en «Cambiar o archivar»; «Agregar» es la acción principal; foco al error |
| Operación › Producción y Calidad | axe 0 | axe 0 |

### Lighthouse (app compilada)

Escritorio, 23 pantallas (18 del área y 5 de WMS-78A): **Accesibilidad 100 y
Buenas prácticas 100 en todas**; Rendimiento 99 a 100 (LCP 0.6 a 0.9 s, CLS
0). Las de WMS-78A (`/configuracion`, `/configuracion/equipo`,
`/ubicaciones`, `/avisos`) también 100/100; `/ingresar` sin sesión en la
tabla de abajo.

| Pantalla | Escritorio (R / A / BP) | Teléfono (R / A / BP) |
| --- | --- | --- |
| `/compras` | 99 / 100 / 100 (LCP 0.9 s) | 86 / 100 / 100 (LCP 3.9 s) |
| `/compras/ordenes/[id]` | 100 / 100 / 100 (LCP 0.7 s) | 92 / 100 / 100 (LCP 3.3 s) |
| `/compras/ordenes/nueva` | 100 / 100 / 100 (LCP 0.8 s) | 94 / 100 / 100 (LCP 3.1 s) |
| `/compras/proveedores` | 100 / 100 / 100 (LCP 0.6 s) | 97 / 100 / 100 (LCP 2.5 s) |
| `/compras/proveedores/[id]` | 100 / 100 / 100 (LCP 0.6 s) | 93 / 100 / 100 (LCP 3.2 s) |
| `/compras/solicitudes` | 100 / 100 / 100 (LCP 0.6 s) | 95 / 100 / 100 (LCP 2.9 s) |
| `/compras/solicitudes/[id]` | 99 / 100 / 100 (LCP 0.9 s) | 87 / 100 / 100 (LCP 3.9 s) |
| `/compras/sugerencias` | 100 / 100 / 100 (LCP 0.6 s) | 93 / 100 / 100 (LCP 3.1 s) |
| `/compras/reportes` | 100 / 100 / 100 (LCP 0.7 s) | 87 / 100 / 100 (LCP 3.9 s) |
| `/produccion` | 100 / 100 / 100 (LCP 0.6 s) | 88 / 100 / 100 (LCP 3.9 s) |
| `/produccion/nueva` | 100 / 100 / 100 (LCP 0.6 s) | 93 / 100 / 100 (LCP 3.1 s) |
| `/produccion/[id]` | 100 / 100 / 100 (LCP 0.6 s) | 87 / 100 / 100 (LCP 3.9 s) |
| `/produccion/solicitudes` | 100 / 100 / 100 (LCP 0.6 s) | 94 / 100 / 100 (LCP 2.9 s) |
| `/produccion/solicitudes/[id]` | 99 / 100 / 100 (LCP 0.9 s) | 84 / 100 / 100 (LCP 4.1 s) |
| `/inventario/[id]` | 99 / 100 / 100 (LCP 0.9 s) | 85 / 100 / 100 (LCP 4.1 s) |
| `/inventario/[id]/receta` | 99 / 100 / 100 (LCP 0.9 s) | 87 / 100 / 100 (LCP 4.0 s) |
| `/inventario/[id]/receta/versiones` | 100 / 100 / 100 (LCP 0.6 s) | 95 / 100 / 100 (LCP 2.9 s) |
| `/inventario/[id]/inspeccion` | 100 / 100 / 100 (LCP 0.6 s) | 86 / 100 / 100 (LCP 3.9 s) |
| `/configuracion/defectos` | 100 / 100 / 100 (LCP 0.6 s) | 93 / 100 / 100 (LCP 3.1 s) |
| `/configuracion` | 100 / 100 / 100 (LCP 0.7 s) | 92 / 100 / 100 (LCP 3.3 s) |
| `/configuracion/equipo` | 100 / 100 / 100 (LCP 0.6 s) | 94 / 100 / 100 (LCP 3.0 s) |
| `/ubicaciones` | 99 / 100 / 100 (LCP 0.9 s) | 92 / 100 / 100 (LCP 3.2 s) |
| `/avisos` | 100 / 100 / 100 (LCP 0.6 s) | 95 / 100 / 100 (LCP 2.9 s) |
| `/ingresar` (sin sesión) | 100 / 100 / 100 (LCP 0.7 s) | 94 / 100 / 100 (LCP 3.1 s) |

## Archivos compartidos que se tocaron

- `src/components/ui/native-select.tsx`: **el mismo cambio de WMS-78A**
  (traído tal cual de su rama, ya unido en `pruebas`), sin nada propio.
- Ninguno más: `globals.css`, `states.tsx`, `motion.tsx`, `app-shell` y el
  layout quedaron igual. Se reutilizó `focus-first-error.ts` de WMS-78B.
- Fuera de `src/app`: `src/modules/quality/plans.ts` (solo cómo se une el
  texto «Lo producido, lo recibido»); `scripts/seed-dev.mts` (la demo trae
  Producción y Calidad) y `scripts/seed-sample.mts` (ubicación de surtido,
  área, kit con receta, orden liberada, plan publicado y un defecto), para que
  `verify-a11y` vea las pantallas con datos.

## Scripts de verificación

- `verify-a11y.mjs`, bloque «WMS-78C»: 7 pantallas, 2 formularios vacíos y 7
  fichas (proveedor, solicitud de compra, orden y solicitud de producción,
  receta, versiones, inspección). **Pasa: 850 comprobaciones.**
- `verify-ui.mjs`, bloque «WMS-78C»: 9 pantallas a 320 px sin desbordamiento
  y con un solo `h1`, «Pedir producción» sin producto, la fila de compras
  pendientes y «Cambiar o archivar» de un defecto. **Pasa: 118 comprobaciones.**
- `verify-pwa.mjs`: pasa (62).
- **Ojo:** `verify-a11y` falla en modo desarrollo por el indicador de Next
  («1 Insight», aviso de seguridad de next 16.4.3, dentro de `nextjs-portal`),
  que roba el foco del teclado en cada pantalla: se corre contra la app
  compilada (`npm run build` y `next start`). `verify-ui` sí necesita
  `npm run dev` porque abre `/sistema-visual`.

## Lo que queda

- **Rendimiento en teléfono de 84 a 97** (Lighthouse simula una red 4G lenta
  y un procesador cuatro veces más lento): el LCP de 2.9 a 4.1 s lo pone el
  JavaScript compartido de la app (layout, `AppShell`, `Providers`), igual en
  todas las pantallas con sesión; `/ingresar` llega a 94. No es de una
  pantalla del área ni se corrige en ella: sería un paso propio (partir los
  componentes cliente del layout, cargar `motion` y `sonner` solo donde se
  usan), en archivos de WMS-78A. Accesibilidad y Buenas prácticas quedan en
  100 también en teléfono.
- **Campos de fecha en el idioma del navegador** («mm/dd/yyyy» en Chromium en
  inglés): lo decide el navegador, no la página (ya anotado por WMS-78A).
- Los datos de la demo con «Remisión 1188» se ven «Remisión Remisión 1188»:
  es el dato de prueba, no la pantalla.
- `/compras/ordenes/[id]/linea`, `/compras/proveedores/[id]/productos/nuevo`
  y `/compras/solicitudes/nueva` piden el producto antes de mostrar el
  formulario; su foco al error ya lo hacían por su cuenta y no se probó
  enviándolos vacíos con producto elegido.
- No se revisó `/procesos/[id]` de una orden de producción con un proceso
  publicado (no había ninguno en los datos).

## Visto en otras áreas

- `/inventario/reposicion/nueva` (WMS-78B): su caso de `verify-a11y` («Guardar
  regla») detenía todo el script con la demo porque no había ubicación de
  surtido; ahora los datos de ejemplo la traen (en una demo ya sembrada hay que
  crearla a mano o volver a sembrar).
- En modo desarrollo el indicador «1 Insight» de Next tapa la esquina inferior
  izquierda (el nombre de la persona en la barra lateral y «Inicio» de la
  barra inferior del teléfono); no existe en la app compilada.
