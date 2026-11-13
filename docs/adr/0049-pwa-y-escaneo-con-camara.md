# ADR 0049 — PWA instalable y escaneo con cámara

Fecha: 2026-11-13 · Estado: aceptada · Pasos: WMS-35 y WMS-36 · Completa
ADR 0004 (interfaz), ADR 0047 (etiquetas) y la CSP con nonce (PLT16-04)

## Contexto

La gente de piso usa el WMS desde el teléfono. Hoy lo abre como una página
más del navegador: no puede ponerla en la pantalla de inicio como una app, y
cuando se va la señal ve la página de error del navegador (un dinosaurio, en
inglés). Para leer códigos necesita un lector de teclado; quien no tiene uno
teclea el código impreso bajo las barras (ADR 0047).

Las instrucciones del fundador dejan **operar sin conexión** para después
(cola local con idempotencia, especificación 4.5): este paso no guarda nada
de una empresa en el dispositivo.

## Flujo

**Instalar (WMS-35).**

1. La persona abre el WMS en su teléfono. El navegador encuentra el
   manifiesto (nombre «WMS», ícono, colores) y, donde lo hace, ofrece
   instalarla.
2. En Configuración › «En tu teléfono» se explica en dos renglones cómo
   instalarla en Android (Chrome: menú ⋮ › «Instalar app») y en iPhone
   (Safari: Compartir › «Agregar a inicio»). Solo si el navegador lo permite
   (evento `beforeinstallprompt`, Chrome y Edge) aparece además el botón
   «Instalar la app». Si ya se está usando la app instalada, solo lo dice.
3. La app instalada abre en `/inicio` sin barra del navegador; sin sesión cae
   en `/ingresar` como siempre.

**Sin conexión (WMS-35).**

1. Se cae la red con la app abierta: arriba aparece «Sin conexión. Lo que
   envíes ahora no se guardará. Espera a que vuelva la conexión.». Al volver,
   desaparece. Los formularios siguen fallando como hoy (la pantalla de error
   de la sección o, en los que confirman movimientos, la verificación por
   clave de INV-22): el aviso no promete guardar nada.
2. La persona abre otra pantalla sin red: en vez del error del navegador ve
   «Sin conexión» con el botón «Reintentar», que vuelve a pedir la misma
   dirección. Con red, la pantalla carga normal.

**Escanear con la cámara (WMS-36).**

1. Junto al campo donde hoy se escanea con lector o se teclea un código
   aparece «Escanear», solo si el navegador puede leer códigos.
2. Al tocarlo se abre un diálogo casi a pantalla completa con la cámara
   trasera, un marco que dice dónde poner el código, el botón grande
   «Cerrar» y, si el teléfono la tiene, «Linterna».
3. **Una lectura** (buscar, ubicación de destino, producto o lote al surtir,
   tarima): al leer, el teléfono vibra, el diálogo se cierra, el texto queda
   en el campo y sigue el camino del Enter de un lector (busca, pasa al
   siguiente campo o envía, lo mismo que hoy con el lector).
4. **Lectura continua** (salida rápida, empaque, series): cada código leído
   entra como una lectura del lector, el diálogo sigue abierto, cuenta
   cuántos van y muestra el último. La misma etiqueta frente a la cámara no
   se lee dos veces seguidas: hay que retirarla un segundo para volver a
   leerla (en salida rápida, eso suma una pieza, como con el lector).
5. Si hay dos códigos a la vista no lee ninguno y pide acercarse solo al que
   se quiere.
6. Si la persona niega el permiso, no hay cámara o la ocupa otra app, el
   diálogo lo dice y recuerda que el código se puede escribir en el campo.

## Decisión

### WMS-35 · PWA

**Manifiesto** en `src/app/manifest.ts` (`/manifest.webmanifest`, convención
de Next): `name`/`short_name` «WMS», `lang` es-MX, `start_url` e `id`
`/inicio`, `scope` `/`, `display: standalone`, `background_color` y
`theme_color` del fondo claro (`--background`, un manifiesto solo admite un
valor; el tema oscuro lo da `viewport.themeColor` con `prefers-color-scheme`,
que ya existía). Los colores viven como literales en `src/lib/pwa.ts`
(`PWA_COLORS`) porque el manifiesto y la página sin conexión no leen CSS;
`src/lib/pwa.test.ts` los compara con `globals.css`.

**Íconos**: la marca que ya usa la app (el ícono «Warehouse» de lucide en
blanco sobre un cuadro redondeado `--primary`, `Brand` de la barra lateral).
`public/icons/icon-192.png` e `icon-512.png` (`purpose: any`),
`icon-maskable-512.png` (fondo completo, dibujo dentro de la zona segura del
80 %, `purpose: maskable`) y `src/app/apple-icon.png` (180 px, sin
transparencia; Next pone el `<link rel="apple-touch-icon">`). Se regeneran con
`node scripts/pwa-icons.mjs` (Playwright, ya instalado, rasteriza el SVG); sin
dependencias nuevas.

**Service worker mínimo** (`/sw.js`, ruta `src/app/sw.js/route.ts`; su código
sale de `serviceWorkerSource` en `src/lib/pwa.ts`):

- Su único trabajo: si una **navegación** `GET` del mismo origen (fuera de
  `/api/`) falla **por red**, responde con su página `/sin-conexion`. Una
  respuesta del servidor, aunque sea un error, pasa tal cual.
- **Solo guarda una cosa**: `/sin-conexion` (`OFFLINE_CACHE_URLS`), pedida al
  instalarse **sin cookies** (`credentials: "omit"`) y solo si llegó bien y
  sin redirección. Nunca guarda páginas de la app, respuestas de `/api`,
  datos de una empresa ni nada de una sesión. Razón: un teléfono se comparte
  entre turnos; si el worker guardara pantallas, sin conexión mostraría a la
  siguiente persona lo que vio la anterior (existencias, pedidos, nombres),
  incluso después de cerrar sesión. Con una página fija y sin datos, cerrar
  sesión no tiene nada que limpiar en el dispositivo.
- No intercepta Server Actions (son `POST`), peticiones de datos de Next
  (RSC, precargas: no son navegaciones), descargas de `/api/…` ni otros
  orígenes. No reintenta nada.
- **Versión del caché**: el nombre del caché lleva un resumen (FNV-1a) del
  código del worker y de la página sin conexión (`pwaVersion`). Si cambian,
  cambian los bytes de `/sw.js`; el navegador instala el nuevo (`/sw.js` va
  con `Cache-Control: no-cache` y se registra con `updateViaCache: "none"`),
  que toma el control de inmediato (`skipWaiting` + `clients.claim`) y borra
  los cachés `wms-` de versiones anteriores. Un despliegue que no los cambia
  deja el mismo worker, que no tiene nada que actualizar.
- Usa la precarga de navegación del navegador (`navigationPreload`) para no
  hacer más lenta la primera carga de cada pantalla.

**Registro sin script en línea**: `PwaSetup` (componente cliente montado en
`Providers`) llama `navigator.serviceWorker.register("/sw.js")` desde el
paquete de la app, que ya lleva el nonce. No se agregó `experimental.useOffline`
de Next: deja pendiente un Server Action sin red y lo reintenta solo al
volver, lo que contradice INV-22 (un envío que no tuvo respuesta se verifica
por su clave antes de dejar reenviarlo) y el «falla con mensaje» de hoy.

**Página sin conexión** (`/sin-conexion`, ruta `src/app/sin-conexion/route.ts`):
HTML fijo sin scripts, estilos en línea (permitidos por `style-src`), la marca
dibujada en SVG en línea, colores de `PWA_COLORS` en claro y oscuro, «Sin
conexión», una línea de explicación y «Reintentar» como enlace a la misma
dirección (`href=""`: sin JavaScript, la CSP no cambia). `noindex`.

**Aviso dentro de la app**: `OfflineNotice` en `AppShell`, con los eventos
`online`/`offline` del navegador; `role="status"`, visible arriba del
contenido mientras no hay red.

**Instalar**: `InstallAppPanel` en Configuración. El evento
`beforeinstallprompt` se guarda en cuanto llega (en `PwaSetup`, en cualquier
pantalla) y se le llama `preventDefault()`, así el navegador no insiste con
su barra propia; el botón solo aparece en Configuración y solo mientras el
navegador lo ofrezca.

**Cabeceras y CSP**:

- CSP de páginas (`src/lib/csp.ts`): se agrega `manifest-src 'self'` (antes
  salía de `default-src 'self'`; ahora es explícito y se prueba). `worker-src
  'self' blob:` ya existía y basta para `/sw.js`. Nada de `unsafe-inline` ni
  `unsafe-eval` en scripts.
- `/sw.js` responde `text/javascript` con `Cache-Control: no-cache` desde su
  ruta; `/sin-conexion`, `text/html` sin cookies. Las cabeceras comunes de
  `next.config.ts` (nosniff, marcos, referrer, HSTS) les aplican igual; no
  hizo falta `Service-Worker-Allowed` (el worker vive en la raíz).
- `Permissions-Policy` ya tenía `camera=(self)` (se abrió en INV-34 para el
  lector); se conserva y ahora lo cubre una prueba. Micrófono, ubicación,
  pagos y USB siguen apagados.
- `src/proxy.ts` no cambia: manifiesto, íconos, `/sw.js` y `/sin-conexion`
  no están en `PROTECTED`, se cargan sin sesión y no dicen nada de nadie.

### WMS-36 · Escaneo con cámara

**Un solo componente**, `CameraScanButton` (`src/components/camera-scan.tsx`),
que se pone junto al campo con el id de ese campo (`target`). No conoce la
pantalla ni decide nada: **la cámara es otra forma de teclear**. Al leer,
escribe el texto en el campo como lo haría el teclado (valor + evento
`input`, que React ve como lo tecleado) y luego:

- en un campo de una línea, manda el **Enter** de un lector (`keydown`
  Enter): lo atiende el mismo manejador que ya existe (`enqueue` de salida
  rápida y empaque, buscar en conteos, pasar al siguiente campo al surtir o
  mover una tarima). Si nadie lo atiende, hace lo que el navegador haría con
  ese Enter: enviar el formulario (`requestSubmit`; así buscan Inventario y
  Rastrear y se confirma el destino del acomodo, igual que con el lector);
- en un renglón de series (`textarea`), agrega la lectura en un renglón nuevo
  (el Enter del lector ahí es un salto de renglón);
- con `then="fill"` solo llena el campo: en formularios largos donde el Enter
  enviaría todo antes de tiempo (el lote al recibir, el producto al agregarlo
  a un pedido, que todavía pide la cantidad).

El servidor valida igual que siempre; nada nuevo llega a una Server Action.

**API del navegador, sin dependencias**: `BarcodeDetector` (Shape Detection
API). Formatos que pide, si el navegador los tiene (`scanFormats`): Code 128
(lo que imprime WMS-26), EAN-13, EAN-8, UPC-A, UPC-E, QR (WMS-26) y, por los
productos y cajas de cualquier giro, Code 39, ITF y Data Matrix. Donde no hay
`BarcodeDetector`, cámara (`getUserMedia`) o contexto seguro, **el botón no se
pinta** (nada deshabilitado sin explicación) y el campo de siempre sirve: ese
es el respaldo de captura manual.

**Dónde funciona hoy de verdad**: Chrome y Edge en Android (y en macOS y
ChromeOS); Samsung Internet. **No** funciona en Safari (iPhone, iPad, Mac),
en ningún navegador de iPhone (todos usan el motor de Safari), en Firefox ni
en Chrome de Windows o Linux de escritorio: ahí el botón no aparece.

**Reglas puras** (`src/components/scan-rules.ts`, con prueba unitaria):
formatos pedidos, el filtro de lecturas repetidas (`createReadFilter`: la
misma etiqueta no se vuelve a entregar mientras siga a la vista o hasta un
segundo después de dejar de verla), la regla de un solo código a la vista
(`singleCode`) y los mensajes de cada problema de cámara (`cameraProblem`).

**Privacidad y cámara**: el video se dibuja en un `<video>` local y solo lo
lee `BarcodeDetector` en el dispositivo; no se sube, no se guarda ni se
copia a un lienzo. La cámara se apaga (cada pista `stop()`) al cerrar el
diálogo, al leer en modo de una lectura, al ocultarse la pestaña o la app y
al salir de la pantalla (el componente se desmonta).

**Accesibilidad**: diálogo de Radix (foco atrapado, Escape cierra, título y
descripción), botones con texto («Escanear», «Cerrar», «Linterna» con
`aria-pressed`), avisos en `aria-live`, objetivos de 44 px o más, la línea
animada del marco se detiene con «reducir movimiento» (`motion-reduce:`).

**Dónde se aplica**: búsqueda de Inventario, Rastrear, salida rápida
(producto y series), surtido (producto, ubicación, lote, series), acomodo
(«¿Dónde lo dejaste?»), mover tarima (etiqueta y destino), empaque, recepción
(lote y series), agregar producto a un pedido, captura de conteos, y todo
formulario con `SerialsField` (traslados, cambio de estado, salida, ajuste…).

## Lo que quedó fuera

- **Operar sin conexión** (cola local, sincronización): paso posterior,
  después de WMS-35 y WMS-36 y solo para lo que permite la especificación
  4.5.
- **iPhone y Firefox** no leen con la cámara: Safari no trae
  `BarcodeDetector`. **Decisión del fundador**: si el piso usará iPhone, la
  opción sería un decodificador en JavaScript/WebAssembly cargado solo al
  abrir la cámara. La que se recomendaría es el *polyfill*
  `barcode-detector` 3.2.3 (MIT, 260 kB sin empaquetar), que da la misma API
  que usa el componente sobre `zxing-wasm` 3.1.6 (MIT, motor ZXing-C++; el
  paquete pesa 3.7 MB sin empaquetar con todas sus variantes y la de solo
  lectura descarga alrededor de 1 MB de WebAssembly, solo al abrir la
  cámara): el componente no cambiaría. Exigiría servir el `.wasm` desde el
  propio origen y agregar `'wasm-unsafe-eval'` a `script-src` (no
  `unsafe-eval`). No se instaló.
- Notificaciones, actualización en segundo plano y accesos directos del
  manifiesto: sin uso hoy.
- Leer con la cámara en formularios de captura de escritorio (alta de
  producto, código de barras del catálogo): se agrega con el mismo
  componente si se pide.

## Consecuencias

- El WMS se instala como app en Android e iPhone y, sin red, lo dice en
  español en vez del error del navegador, sin guardar datos en el teléfono.
- Un campo nuevo que reciba lecturas agrega `CameraScanButton` con su
  `target`; no lleva lógica propia: si el campo ya funciona con un lector,
  funciona con la cámara.
- Un cambio al worker o a la página sin conexión cambia solo su versión; lo
  que el worker puede guardar es la lista `OFFLINE_CACHE_URLS` y una prueba
  falla si crece sin revisarla.
- Pruebas: `src/lib/pwa.test.ts` (worker ejecutado con un `self` simulado:
  qué guarda, qué intercepta, versión), `src/components/scan-rules.test.ts`,
  `src/lib/csp.test.ts`, `tests/platform/pwa.int.test.ts` (rutas, manifiesto,
  cabeceras) y la comprobación en navegador `scripts/verify-pwa.mjs`.

## Decisión del fundador (2026-11-13)

Se escanea con lector USB y con la cámara en Android desde Chrome. El iPhone no es requisito: no se agrega una librería de decodificación (`barcode-detector` queda descartada).
