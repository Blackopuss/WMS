# Rendimiento en teléfono (WMS-86, 2026-11-19)

Decisión y reglas que quedan: ADR 0080. Aquí, cómo se midió, qué se encontró y
los números de antes y después.

## Cómo se midió

- App compilada (`npm run build` y `next start -p 3100`) sobre `wms_dev` con la
  cuenta demo y los datos de ejemplo (`npm run db:seed` y `db:seed:ejemplo`;
  `db:seed` no corre sobre `wms_test`), con la cookie de la sesión del titular
  por `--extra-headers`.
- Lighthouse 12.6.1 con `npx` (no está en `package.json`) y el Chromium de
  Playwright sin pantalla: perfil de teléfono por omisión (red 4G lenta
  simulada y procesador cuatro veces más lento), **tres corridas por pantalla y
  la mediana**; escritorio con `--preset=desktop`, una corrida.
- Además, el JavaScript que pide la primera carga (suma comprimida de los
  `script`), y qué contiene cada archivo.
- Antes y después en el mismo contenedor y con el mismo método. Los números
  absolutos no se comparan con los de WMS-77 y WMS-78C (otra versión de
  Lighthouse y otra máquina); en este contenedor la partida dio 1 a 5 puntos
  menos que allá en las mismas pantallas.

## Qué se encontró

1. **El índice `@/components` metía todo en todas las páginas.** Un componente
   de servidor que importaba cualquier cosa del índice (el layout raíz con
   `Providers`, el `not-found` raíz con `PageContainer`, cada pantalla con
   `PageHeader`) hacía que su página descargara **todos** los componentes de
   cliente del índice: `AppShell`, la cámara, la captura de fotos, la PWA,
   Sonner y `motion`. Por el layout raíz eso llegaba a todas las páginas,
   también al sitio público, que descargaba el marco de la app (un archivo de
   39 KB comprimidos) y `motion` (44 KB) sin usarlos. Quitar solo `Providers`
   del layout raíz no bastó: la primera prueba **subió** a 306 KB porque el
   `not-found` raíz seguía importando del índice.
2. Después de quitar el índice, lo que queda es React, Next, `next/link`,
   `tailwind-merge`, Radix `Slot` y el marco de la app: unos 195 a 200 KB
   comprimidos, igual en todas las pantallas.
3. **Por qué `/inicio` e `/inventario` no llegan a 95.** Lighthouse estima el
   LCP con todo lo que la página pidió antes de pintarlo. En `/tareas`,
   `/pedidos` o `/produccion` el título llega en el primer envío del HTML (LCP
   observado = primer pintado, 150 ms). En `/inicio` (467 ms) e `/inventario`
   (427 ms) el contenido espera sus consultas y llega en la parte transmitida
   después de `loading.tsx`; mientras tanto Next ya precargó 10 rutas de los
   enlaces visibles (`?_rsc=`, unos 1 KB cada una), y Lighthouse cuenta esas
   peticiones como dependencias del LCP en la red simulada: 3.6 a 3.7 s contra
   2.6 s. Se probó precargar los enlaces del menú solo después del evento
   `load` y no cambió nada (el `load` llega antes que la parte transmitida), así
   que se revirtió. Lo que falta es del servidor (las consultas del Inicio y de
   Inventario) o una decisión sobre la precarga de enlaces; no es de interfaz.

## Resultados

Rendimiento en teléfono (mediana de tres corridas), con su LCP; JavaScript de
la primera carga en KB comprimidos; Accesibilidad / Buenas prácticas después.

| Pantalla | Antes | Después | JavaScript | A / BP |
| --- | --- | --- | --- | --- |
| `/inicio` | 88 (LCP 3.7 s) | **90** (LCP 3.6 s) | 269 → 199 KB | 100 / 100 |
| `/tareas` | 95 (LCP 3.0 s) | **97** (LCP 2.6 s) | 269 → 199 KB | 100 / 100 |
| `/inventario` | 87 (LCP 3.9 s) | **90** (LCP 3.7 s) | 273 → 233 KB | 100 / 100 |
| `/pedidos` | 94 (LCP 3.2 s) | **96** (LCP 2.8 s) | 269 → 199 KB | 100 / 100 |
| `/compras` | 95 (LCP 3.0 s) | **96** (LCP 2.8 s) | 269 → 199 KB | 100 / 100 |
| `/produccion` | 95 (LCP 3.0 s) | **97** (LCP 2.6 s) | 269 → 199 KB | 100 / 100 |
| `/configuracion` | 92 (LCP 3.3 s) | **93** (LCP 3.2 s) | 281 → 283 KB | 100 / 100 |
| `/inventario/[id]` | 93 (LCP 3.3 s) | **95** (LCP 3.0 s) | 281 → 216 KB | 100 / 100 |
| `/produccion/[id]` | 94 (LCP 3.1 s) | **96** (LCP 2.8 s) | 282 → 234 KB | 100 / 100 |
| `/ingresar` | 94 (LCP 3.1 s) | **97** (LCP 2.6 s) | 268 → 194 KB | 100 / 100 |
| `/` | 91 (LCP 3.4 s) | **93** (LCP 3.1 s) | 289 → 220 KB | 100 / 100 |
| `/funciones` | 93 (LCP 3.2 s) | **95** (LCP 2.9 s) | 278 → 208 KB | 100 / 100 |
| `/precios` | 94 (LCP 3.1 s) | **96** (LCP 2.8 s) | 281 → 210 KB | 100 / 100 |
| `/nosotros` | 94 (LCP 3.1 s) | **96** (LCP 2.8 s) | 278 → 208 KB | 100 / 100 |
| `/privacidad` | 93 (LCP 3.2 s) | **95** (LCP 2.9 s) | 278 → 208 KB | 100 / 100 |
| `/terminos` | 93 (LCP 3.2 s) | **95** (LCP 2.9 s) | 278 → 208 KB | 100 / 100 |

Escritorio: 99 a 100 antes y después en las 16 páginas (LCP 0.5 a 0.9 s),
Accesibilidad y Buenas prácticas 100.

## Lo que no llegó a 95 y por qué

- `/inicio` (90) e `/inventario` (90): ver «Qué se encontró», punto 3. Su
  contenido espera las consultas (unos 300 ms más que el marco) y las
  precargas de enlaces que Next lanza en ese tiempo entran en el LCP simulado.
- `/configuracion` (93): el contenido sí llega en el primer envío, pero la
  pantalla descarga 283 KB: además del marco, sus paneles (dos pasos, sesiones
  activas con `motion`, instalar la app, Radix `Dialog`). Es una pantalla de
  uso ocasional; partir sus paneles sería un paso aparte.
- `/` (93): el contenido llega en el primer envío; pesa anime.js, el menú del
  sitio (Radix) y el hero. La ilustración quieta del hero ya se dibuja en el
  servidor (no viaja como JavaScript).

## Qué quedó

- Medir la consulta del Inicio y de Inventario (servidor) para que su
  contenido llegue en el primer envío, o decidir si los enlaces del menú dejan
  de precargarse (más lento al tocar una sección en red lenta).
- Partir los paneles de `/configuracion` si se vuelve de uso diario.
- Medir con un teléfono real; Lighthouse simula red y procesador.
