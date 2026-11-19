# ADR 0080 — Rendimiento en teléfono: JavaScript compartido más chico

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-86 (solo interfaz) ·
Origen: pendientes de WMS-77 (sitio) y WMS-78C (app)

## Contexto

Lighthouse sobre la app compilada, con sesión, en teléfono (4G lenta
simulada y procesador cuatro veces más lento) daba rendimiento de 84 a 97 en
las pantallas medidas por WMS-78C; en escritorio, 99 a 100. El LCP en
teléfono (2.9 a 4.1 s) no depende de la pantalla: lo pone el JavaScript que
toda pantalla con sesión descarga y ejecuta antes de quedar lista, que sale
del layout raíz (`Providers`: `motion`, `sonner`, la PWA) y del layout de la
app (`AppShell`, la campana, el selector de empresa y almacén). El sitio
público daba 93 a 99 en teléfono porque también hereda `Providers` del layout
raíz aunque no use `motion` ni avisos con Sonner.

Además, con un rol de tres secciones la barra inferior del teléfono quedaba
cargada a la izquierda: la lista era siempre una cuadrícula de cinco columnas
aunque hubiera menos botones.

## Qué se mide y cómo

El mismo método de WMS-78C, para que antes y después sean comparables:

- App compilada (`npm run build` y `next start`) contra `wms_test`, con una
  empresa de prueba con datos de ejemplo y la cookie de sesión de la cuenta
  por `--extra-headers`.
- Lighthouse 12.6 con `npx` (no se agrega a `package.json`), con la
  configuración de teléfono por omisión y con `--preset=desktop`; tres
  corridas por pantalla y se anota la mediana del rendimiento.
- Además del puntaje, el JavaScript que se descarga en la primera carga
  (suma de los `script` de la página, comprimidos), para saber qué parte del
  cambio viene de cada pieza.
- Pantallas: las de WMS-78C con peor nota en teléfono, Inicio, Tareas,
  Inventario, `/ingresar` y las seis páginas del sitio público.

Los números de antes y después quedan en `docs/ux/RENDIMIENTO_TELEFONO.md`.

## Decisión

1. **El layout raíz deja de montar proveedores de cliente.** `Providers`
   desaparece del layout raíz; cada grupo monta lo que usa:
   - App con sesión (`(app)`), cuentas (`(auth)`), terminal, consola interna y
     `/sistema-visual`: el `Toaster` de Sonner y `PwaSetup` (registro del
     service worker), en un componente `AppProviders` que se monta en su
     layout.
   - Sitio público (`(sitio)`): solo `PwaSetup` (la app instalable debe
     poder registrarse desde la portada); ni `motion` ni Sonner.
   El `THEME_SCRIPT` sigue en el layout raíz, antes de pintar, con su nonce.
2. **`motion` solo donde hay animación de verdad.** La barra lateral (indicador
   de la sección activa) y el interruptor de tema pasan a transiciones de CSS
   (`transition-*` con `motion-reduce:transition-none`), con el mismo aspecto
   final. `MotionConfig reducedMotion="user"` ya no es global: lo pone cada
   componente que sigue usando `motion` (`FadeIn`, `WarehouseCard`,
   `WarehouseScene`) para seguir respetando «reducir movimiento». Así `motion`
   se descarga solo en las pantallas de cuentas y en `/sistema-visual`.
3. **Sonner se queda donde hay avisos.** Toda pantalla que llama `toast`
   está bajo un layout que monta el `Toaster`; el sitio no lo descarga.
4. **Lo que se usa poco se carga al usarse.** La hoja de avisos de la campana,
   el menú «Más» y los selectores de empresa y almacén se cargan con
   `import()` (`next/dynamic`) la primera vez que se abren o en reposo; el
   botón y la cuenta de avisos se pintan desde el principio, sin consultas
   nuevas.
5. **Barra inferior:** la lista usa tantas columnas como botones (de dos a
   cinco), así tres secciones y «Más» se reparten a lo ancho.

## Qué no cambia

Reglas de negocio, permisos, textos, menú, colores, el tema antes de pintar,
la CSP con nonce de `src/proxy.ts`, la PWA (`npm run verify:pwa`),
`OfflineNotice`, la barra de terminal con PIN, que el layout de la app haga
una sola consulta de avisos (`countUnreadNotifications`), y que las
animaciones que dependen de «reducir movimiento» se elijan con CSS. No se
agregan dependencias.

## Consecuencias

- Una pantalla nueva que use `toast` debe estar bajo un layout que monte
  `AppProviders` (todas las de la app, cuentas, terminal e interno ya lo
  están); en el sitio público no hay avisos con Sonner.
- Un componente nuevo con `motion` envuelve su animación en `MotionConfig
  reducedMotion="user"` (o usa `FadeIn`, que ya lo hace) y no se pone en el
  `AppShell` ni en el sitio.
- Si un paso necesita volver a meter algo en el JavaScript compartido de la
  app, lo mide primero con Lighthouse en teléfono.
