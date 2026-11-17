# Revisión visual de acceso y Configuración (WMS-78A)

Fecha: 2026-11-16. Rama `wms-78a-revision-acceso-configuracion`, desde
`pruebas` (`d3ac64e`). Solo interfaz: no cambia reglas de negocio, servicios,
permisos ni migraciones.

## Alcance y método

Pantallas revisadas (55 rutas distintas):

- **Acceso y cuenta:** `/ingresar`, `/registro`, `/recuperar-contrasena`,
  `/restablecer-contrasena` (sin enlace y con uno inventado), `/verificar-codigo`,
  `/verifica-tu-correo`, `/correo-verificado` y `/confirmar-correo` (ambas
  llevan a Ingresar), `/invitacion` (sin enlace y con uno inventado),
  `/acepta-terminos`, `/crear-empresa`, `/activa-dos-pasos`, `/terminal`,
  `/sin-conexion`, el 404 (fuera y dentro de la app) y `/correos` (solo desarrollo).
- **Configuración:** `/configuracion`, accesos, avisos que recibo, equipo y
  ficha de la persona (con sus accesos), almacenes y su ficha, Operación,
  reglas de aprobación, campos personalizados, API y webhooks, terminales y su
  ficha, Mi PIN, equipos del almacén (lista, tipos, registrar), procesos y su
  editor, defectos, Mi plan, bitácora, `/ubicaciones` (niveles, etiquetas).
- **Transversales:** `AppShell` (barra lateral, barra inferior, «Más», tema,
  selector de almacén), campana y `/avisos`, `/aprobaciones` (las dos vistas).
- **Consola interna:** `/interno` y la ficha de una empresa.

Cada pantalla se abrió con Playwright (Chromium) en modo claro y oscuro, a
1280 px y 390 px, y además se midió el desbordamiento horizontal a 320, 768 y
1920 px. Por pantalla:

1. **axe-core** con WCAG 2.1 A y AA **más buenas prácticas** (`best-practice`),
   contando todas las violaciones, no solo las graves.
2. **Objetivos táctiles** en teléfono (alto < 44 px o ancho < 24 px), con la
   misma excepción de `verify:a11y` para enlaces dentro de una oración.
3. **Capturas** de página completa en los cuatro casos, revisadas una por una
   (contraste, Inter aplicada, alineación, rejilla, KISS, textos).
4. **Rendimiento y buenas prácticas** sobre la app compilada (`next start`):
   errores de consola, peticiones fallidas, LCP y CLS (ver «Lighthouse»).

Estados revisados: empresa vacía (titular recién creado), empresa con datos
(dos almacenes, tipos de equipo, tres defectos, un campo personalizado, una
llave de API, una terminal, zonas), la cuenta demo con datos de ejemplo, y
roles sin permiso (Consulta y Almacenista de piso): todas las pantallas
restringidas muestran su estado «sin acceso», nunca un error.

## Resultado por pantalla

«Antes» es la rama `pruebas` sin cambios; «Después», esta rama. Las columnas
de axe cuentan violaciones de cualquier impacto en los cuatro casos (claro y
oscuro, 1280 y 390).

| Pantalla | axe antes | axe después | Táctiles < 44 px antes → después | Notas |
| --- | --- | --- | --- | --- |
| `/ingresar` | 0 | 0 | «Crea una» 17 px → enlace en oración de 25 px | Enlaces en oración sin subrayado: en oscuro solo los distinguía el peso. Ahora subrayados. |
| `/registro` | 0 | 0 | 3 enlaces de 17 px → 25 px | Igual que arriba («términos y condiciones», «aviso de privacidad», «Inicia sesión»). |
| `/recuperar-contrasena` | 0 | 0 | 1 → 0 | Igual. |
| `/restablecer-contrasena` (ambas) | 0 | 0 | 0 | — |
| `/verificar-codigo` | 0 | 0 | 1 → 0 | Igual. |
| `/verifica-tu-correo` | 0 | 0 | 0 | La etiqueta larga quedaba en dos renglones encimados (`leading-none`). |
| `/correo-verificado`, `/confirmar-correo` | 0 | 0 | 1 → 0 | Redirigen a Ingresar. |
| `/invitacion` (ambas) | 0 | 0 | 0 | — |
| `/acepta-terminos` | 0 | 0 | enlaces en oración de 25 px | Subrayados. |
| `/crear-empresa`, `/activa-dos-pasos` | 0 | 0 | 0 | — |
| `/terminal` | 0 | 0 | 0 | — |
| `/correos` (solo desarrollo) | 2 (`landmark-one-main`, `region`) | 0 | 0 | Ahora tiene su `main`. |
| `/sin-conexion` | 0 | 0 | 0 | Sigue el tema del sistema, no el de la app (página estática del service worker, sin scripts; a propósito). |
| 404 fuera de la app | 2 (`landmark-one-main`, `region`) | 0 | 0 | Ahora tiene su `main`. |
| 404 dentro de la app (`notFound()`) | 0 | 0 | 0 | Tiene su propio `not-found.tsx` sin `main` (el marco ya lo tiene). |
| `/configuracion` | 0 | 0 | 0 | En teléfono el texto de «Soporte» quedaba en una columna angosta junto al botón; ahora el botón baja a su renglón. |
| `/configuracion/operacion` | 0 | 0 | 0 | La flecha del selector «Ubicación de preparación» quedaba lejos del campo en escritorio (ver `NativeSelect`). |
| `/configuracion/equipos-del-almacen/nuevo` | 0 | 0 | «Tipos de equipo» 20 px → botón de 44 px | — |
| `/ubicaciones/etiquetas` | 0 | 0 | «Ubicaciones» 17 px → enlace en oración de 25 px | Era la falla conocida de `verify:a11y` («objetivos táctiles» en teléfono). |
| `/interno` | 0 | 0 | ícono solo (20 px) → «Consola interna» con texto | En teléfono el enlace de la marca era solo un ícono. |
| `/configuracion/equipo` (diálogo «Invitar a tu equipo») | 0 | 0 | 0 | Con Producción y Calidad la lista de roles creció y el botón «Enviar invitación» quedaba fuera de la pantalla sin poder desplazarse (a 800 px de alto). Ahora el diálogo se desplaza. |
| Resto de Configuración, Ubicaciones, Avisos, Aprobaciones, fichas e `/interno/empresas/[id]` | 0 | 0 | 0 | Sin hallazgos de axe. |
| `AppShell` | 0 | 0 | 0 | Ver «Transversales». |

Desbordamiento horizontal: 0 px en todas las pantallas a 320, 390, 768, 1280
y 1920 px, antes y después. Un solo `h1` en todas.

### Transversales (`AppShell`)

- **Cerrar sesión** era un botón de solo ícono (regla KISS). Ahora dice
  «Cerrar sesión» con su ícono, en su propio renglón bajo la persona.
- **Interruptor de tema:** usaba colores sueltos (degradados `sky`, `amber`,
  `zinc`) y el sol ámbar sobre blanco tenía 2.1:1 (WCAG 1.4.11 pide 3:1 para
  lo que dice el estado). Ahora solo tokens: pista `bg-accent`/`bg-secondary`
  con anillo `ring-input` (≥ 3:1, ya lo comprueba `design-tokens.test.ts`), sol
  `text-warning` y luna `text-background` sobre `bg-foreground`.
- **Título del encabezado en teléfono:** en `/avisos`, `/aprobaciones` y
  `/procesos` decía «WMS»; ahora dice el nombre de la pantalla.
- **Barra lateral:** con muchas secciones y poca altura (o zoom) la lista no
  se podía desplazar y empujaba el pie fuera; ahora se desplaza dentro.

## Lighthouse

**No se pudo correr Lighthouse:** la descarga con `npx lighthouse` fue
rechazada por los permisos de la sesión, y la regla 9 impide agregarlo a
`package.json`. Lo que se midió en su lugar, sobre la app compilada:

- **Accesibilidad:** la auditoría de Lighthouse es axe-core; aquí se corrió
  axe completo (A, AA y buenas prácticas) con cero violaciones en todas las
  pantallas.
- **Buenas prácticas:** cero errores de consola en todas las pantallas (el
  único es el 404 propio de la página que no existe), sin peticiones fallidas
  salvo precargas de enlaces que el navegador cancela al navegar, todo por
  HTTPS en producción y con las cabeceras de seguridad que ya comprueba
  `verify:ui`.
- **Rendimiento** (escritorio, red local): LCP entre 32 y 388 ms (el más alto,
  `/ubicaciones` con su árbol), CLS 0.000 en todas, carga completa entre 0.5
  y 1.1 s. No se encontró nada barato que corregir (sin imágenes pesadas; Inter
  sale de `next/font` con `display: swap` y precarga).

Queda pendiente correr Lighthouse de verdad cuando haya permiso para
descargarlo (por ejemplo en CI o en el equipo del fundador).

## Archivos compartidos que se tocaron

- `src/components/ui/native-select.tsx`: un `max-w-*` pasado en `className` se
  aplica al contenedor y no al `select`, para que la flecha quede dentro del
  campo. Afecta para bien a `tareas/olas/[id]/wave-controls.tsx` y
  `compras/solicitudes/[id]/convert-form.tsx` (mismo defecto).
- `src/components/ui/dialog.tsx`: `max-h-[calc(100dvh-2rem)]` y
  `overflow-y-auto` por omisión; ningún diálogo largo deja botones fuera.
- `src/components/ui/label.tsx`: `leading-none` → `leading-snug` (una
  etiqueta de dos renglones ya no se encima; las de un renglón crecen 3.5 px).
- `src/components/theme-toggle.tsx` (también lo usa el sitio público).
- `src/components/legal-consent.tsx` (enlaces subrayados).
- `src/components/app-shell/app-shell.tsx`.
- `src/app/correos/page.tsx`, `src/app/not-found.tsx`, nuevo `src/app/not-found-content.tsx` y nuevo
  `src/app/(app)/not-found.tsx`.

## Scripts de verificación

- `scripts/verify-a11y.mjs`: se agregaron (bloque «WMS-78A») accesos,
  bitácora, procesos y su editor, defectos y el 404 a `SCREENS`;
  restablecer contraseña, «Revisa tu correo», invitación y el 404 a `PUBLIC`;
  y las fichas de accesos de una persona, de un almacén y de una terminal.
  El criterio no se endureció (sigue «graves y críticas»): en mi área ya no
  hay ninguna violación de ningún impacto, pero no comprobé todas las demás
  pantallas que lista.
- `scripts/verify-ui.mjs`: bloque «WMS-78A» (enlaces en oración subrayados,
  «Cerrar sesión» con texto, anillo del interruptor de tema, título del
  encabezado en teléfono, flecha del selector angosto). Además se pusieron al
  día cuatro comprobaciones que ya fallaban en `pruebas` por pasos anteriores:
  el enlace «Equipo» ahora es ambiguo con «Equipos del almacén» (WMS-42); el
  diálogo de invitar ofrece más de 4 roles (WMS-59); «Mi plan» tiene tres
  barras (Archivos, WMS-67) y ningún módulo «Próximamente» de los de antes; y
  las filas de sesiones se contaban con `section ul > li`, que ahora también
  toma otras listas de Configuración.
- Resultado con `UI_BROWSER=chromium`: `verify:a11y` «Todo pasó» (con la app
  compilada y la cuenta demo), `verify:ui` 96 comprobaciones sin fallas (con
  `npm run dev`, porque usa `/sistema-visual`) y `verify:pwa` «Todo bien».

## Lo que queda y por qué

- **Lighthouse** no se corrió (ver arriba).
- **Fechas** (`input type=date`) muestran el formato del navegador; en un
  Chromium en inglés sale «mm/dd/yyyy». En un navegador en español sale
  «dd/mm/aaaa». No se cambia: es el control nativo.
- `/sin-conexion` sigue el tema del sistema y no el elegido en la app (no
  tiene scripts, a propósito: ADR 0049).
- `global-error.tsx` usa la fuente del sistema, no Inter: reemplaza al layout
  raíz, que es quien carga la fuente. Solo se ve si falla el layout raíz.
- El título de la pestaña del 404 de `/interno` para quien no es personal de
  plataforma dice «Empresas · WMS» (toma la plantilla de su layout). Menor.
