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

0. **Se importa cada componente por su archivo y desaparece el índice
   `src/components/index.ts`.** La medición mostró la causa principal: un
   componente de servidor que importaba cualquier cosa del índice (el layout
   raíz con `Providers`, el `not-found` raíz con `PageContainer`, cada
   pantalla con `PageHeader`) metía en esa página **todos** los componentes de
   cliente que el índice exportaba: `AppShell`, la cámara, la captura de
   fotos, `motion`, Sonner. Como el layout raíz y el `not-found` raíz lo
   importaban, eso llegaba a todas las páginas, también al sitio público. Se
   cambiaron los 213 archivos que lo usaban (un import por archivo, cambio
   mecánico) y se borró el índice, así que un `import … from "@/components"`
   ya no compila. Las reglas de capas no cambian: la app y los módulos ya
   podían importar cualquier archivo de `src/components`.
1. **El layout raíz deja de montar proveedores de cliente.** `Providers`
   desaparece; el layout raíz solo monta `THEME_SCRIPT` (antes de pintar, con
   su nonce) y `PwaSetup` (registro del service worker, ahora en su propio
   archivo `pwa-setup.tsx`, aparte de los paneles de la PWA). Los avisos de
   Sonner (`Toasts`, `src/components/providers.tsx`) los montan los layouts de
   la app, de las cuentas y `/sistema-visual`, y el `Toaster` se descarga
   después de que la página queda lista (`next/dynamic` sin SSR): un aviso
   siempre sigue a algo que la persona hizo.
2. **`motion` solo donde hay animación de verdad.** La barra lateral
   (indicador de la sección activa), el interruptor de tema, la tarjeta de las
   pantallas de cuenta (techo y persiana) y la entrada del texto de las
   cuentas pasan a CSS (`motion-reduce` y la regla global de «reducir
   movimiento» siguen valiendo). `MotionConfig reducedMotion="user"` ya no es
   global: lo lleva cada componente que sigue usando `motion` (`FadeIn`,
   `WarehouseScene`, la lista de sesiones activas). La ilustración animada de
   las cuentas se descarga solo en pantallas anchas (`AccountScene`): en el
   teléfono está oculta. El sitio dibuja la ilustración quieta con
   `WarehouseSceneStill` (`warehouse-scene-art.tsx`, sin `motion`).
3. **Lo que se usa poco se carga al usarse.** La hoja de avisos de la campana,
   el menú «Más» y el diálogo para cambiar de empresa o almacén se descargan la
   primera vez que se abren; el botón, la cuenta de avisos y su región
   anunciada se pintan desde el principio, sin consultas nuevas. Como ya no
   hay disparador de Radix, cada uno devuelve el foco a su botón al cerrarse.
4. **Barra inferior:** la lista reparte el ancho entre los botones que haya
   (`flex-1`), así tres secciones y «Más» ocupan toda la barra.

## Qué no cambia

Reglas de negocio, permisos, textos, menú, colores, el tema antes de pintar,
la CSP con nonce de `src/proxy.ts`, la PWA (`npm run verify:pwa`),
`OfflineNotice`, la barra de terminal con PIN, que el layout de la app haga
una sola consulta de avisos (`countUnreadNotifications`), y que las
animaciones que dependen de «reducir movimiento» se elijan con CSS. No se
agregan dependencias.

## Consecuencias

- Un componente se importa por su archivo (`@/components/states`,
  `@/components/form-field`…); no hay índice. Volver a crear uno reintroduce
  el problema.
- Una pantalla nueva que use `toast` debe estar bajo un layout que monte
  `Toasts` (todas las de la app, cuentas y `/sistema-visual` ya lo están); en
  el sitio público, la consola interna y la terminal no hay avisos con Sonner.
- Un componente nuevo con `motion` envuelve su animación en `MotionConfig
  reducedMotion="user"` (o usa `FadeIn`, que ya lo hace) y no se pone en el
  `AppShell` ni en el sitio.
- Si un paso necesita volver a meter algo en el JavaScript compartido de la
  app, lo mide primero con Lighthouse en teléfono.
