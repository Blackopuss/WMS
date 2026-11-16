# Revisión visual del sitio público (WMS-77, 2026-11-16)

Revisión del sitio público (`src/app/(sitio)/`) con Lighthouse 13.6 y axe-core
sobre la aplicación compilada (`npm run build` + `next start`, puerto 3100,
base `wms_test`), con el Chromium de Playwright en modo sin pantalla. Además del
contenido puesto al día (módulos Producción y Calidad, precios de 3,000 pesos
al mes cada uno), se corrigió lo que impedía las notas y lo que se encontró a
ojo en las capturas.

## Lighthouse

Notas en orden: Rendimiento, Accesibilidad, Buenas prácticas y SEO. «Teléfono»
es el perfil móvil por omisión de Lighthouse (CPU 4× más lenta y red 4G
simulada); «escritorio» es `--preset=desktop`.

| Página | Teléfono antes | Teléfono después | Escritorio antes | Escritorio después |
| --- | --- | --- | --- | --- |
| `/` | 51 · 100 · 100 · 100 | **93** · 100 · 100 · 100 | 92 · 100 · 100 · 100 | **100** · 100 · 100 · 100 |
| `/funciones` | 87 · 100 · 100 · 100 | **98** · 100 · 100 · 100 | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| `/precios` | 90 · 100 · 100 · 100 | **99** · 100 · 100 · 100 | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| `/nosotros` | 90 · 100 · 100 · 100 | **99** · 100 · 100 · 100 | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| `/privacidad` | 90 · 100 · 100 · 100 | **98** · 100 · 100 · 100 | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| `/terminos` | 88 · 100 · 100 · 100 | **99** · 100 · 100 · 100 | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |

Entre corridas el rendimiento en teléfono varía uno o dos puntos (en una
corrida intermedia `/privacidad` y `/terminos` dieron 100).

## axe-core

WCAG 2.0/2.1/2.2 A y AA más buenas prácticas, todas las gravedades, en modo
claro y oscuro, a 1280 y 390 px, después de recorrer la página y esperar a que
termine cada animación de entrada.

| Página | Antes | Después |
| --- | --- | --- |
| `/` | contraste (hasta 27 nodos) | 0 |
| `/funciones` | contraste (hasta 48 nodos) | 0 |
| `/precios` | contraste (hasta 13 nodos) | 0 |
| `/nosotros` | contraste (hasta 8 nodos) | 0 |
| `/privacidad` | 0 | 0 |
| `/terminos` | 0 | 0 |

Las fallas de contraste «antes» no eran de los colores: eran textos que se
quedaban a media animación (ver «Animaciones de entrada»). Lighthouse no las
veía porque no recorre la página.

## Qué se corrigió

- **Hero del inicio (rendimiento).** El almacén 3D (three.js) se cargaba al
  pintar la página y su ciclo de dibujo ocupaba el hilo principal: 5.2 s de
  bloqueo y LCP de 5.1 s en teléfono. Ahora la ilustración 2D se pinta con la
  página (también se ve sin JavaScript y aparta el mismo espacio, sin saltos),
  quieta (`WarehouseScene still`), y el 3D la reemplaza cuando la página ya
  está en reposo (`requestIdleCallback` después de `load`) y solo si WebGL
  corre con tarjeta gráfica: sin ella (`failIfMajorPerformanceCaveat` o un
  renderizador por software como SwiftShader o llvmpipe) three.js ni se
  descarga. Sigue pausándose fuera de pantalla y respetando «reducir
  movimiento».
- **LCP de todas las páginas.** El título y el texto del encabezado entraban
  con `fade-in` (opacidad 0): el LCP esperaba a la animación y, en la
  simulación, a todo el JavaScript (3.6 s en `/terminos`). Se dejó solo el
  deslizamiento, sin desvanecer.
- **Animaciones de entrada (`SiteMotion`).** Con `onScroll` de anime.js, un
  desplazamiento rápido, la tecla Fin o un salto a un ancla
  (`/nosotros#contacto`) dejaban tarjetas a 0–86 % de opacidad para siempre:
  texto con contraste insuficiente. Ahora un `IntersectionObserver` dispara la
  animación la primera vez que el elemento aparece y siempre termina.
- **Objetivos táctiles.** El índice de `/privacidad` y `/terminos` tenía
  enlaces de 36 px en teléfono: ahora 44 px (36 px desde `lg`).
- **Tabla de precios.** Se desplaza a lo ancho en teléfono: ahora es una región
  con nombre que se alcanza con el teclado y muestra el foco.
- **Calculadora.** «+ $3,000» se partía en dos renglones en teléfono.
- **Ilustración del inicio en teléfono.** Las dos tarjetas flotantes se
  encimaban: con menos de 448 px de ancho se oculta la primera (consulta de
  contenedor en `WarehouseScene`).
- **Textos de un solo giro.** «Pija 8 × 1"» y «Cable THW» cambiaron por un
  artículo genérico; «Roles listos: … caja …» (Ventas ya no existe) y «si
  alguien vende mientras cuentas» se corrigieron.
- **Encabezado.** `ThemeToggle` se importa directo en vez del barril
  `@/components`.

## Revisión a ojo y con script

Con un script de Playwright (no se agregó al repositorio) y capturas en claro
y oscuro:

- Sin desbordamiento horizontal a 320, 390, 768, 1280 y 1920 px.
- Un solo `h1` por página y sin saltos de nivel en los encabezados.
- Todo el texto en Inter (cargada), salvo la cifra monoespaciada de la demo de
  presentaciones, que es a propósito.
- Objetivos táctiles de 44 px o más en teléfono (salvo enlaces dentro de una
  oración, excepción de WCAG 2.5.8).
- Todos los enlaces internos responden y todas las anclas existen.
- Sin JavaScript no queda texto oculto; con «reducir movimiento» no corre
  ninguna animación ni queda nada oculto.
- `scripts/verify-a11y.mjs` agrega las seis páginas del sitio a `PUBLIC`.

## Qué no llegó a 100 y por qué

- **Rendimiento en teléfono: 93 en `/` y 98–99 en las demás.** Lo que queda es
  la hidratación de React y del layout raíz (el fragmento con `react-dom`
  suma unos 0.6–0.8 s de CPU con la CPU 4× más lenta, y cada página carga
  también `motion`, `sonner` y el registro de la app instalable por los
  `Providers` del layout raíz, que el sitio no usa). En `/` se suman los
  componentes cliente de la página (demos con anime.js, la ilustración).
  Bajarlo más pide sacar esos proveedores del sitio (un layout raíz por
  grupo, o cargar `Providers` solo en la app), un cambio compartido que no se
  hizo en este paso porque otros chats revisan la app al mismo tiempo.
- **El 3D en un teléfono con tarjeta gráfica no se pudo medir aquí:** el
  contenedor no tiene GPU, así que Lighthouse ve la ilustración 2D. Con GPU el
  3D carga después de `load` y en reposo, sin afectar LCP ni CLS, pero sí usa
  CPU mientras está en pantalla.
- Sin `robots.txt` ni `sitemap.xml`: SEO ya da 100 y un mapa del sitio necesita
  el dominio definitivo, que aún no existe.
