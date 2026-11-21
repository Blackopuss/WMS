# ADR 0047 — Etiquetas e impresión

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-26 · Completa ADR 0019
(PDF propio), ADR 0036 (código de ubicación), ADR 0040 (lotes), ADR 0041
(series), ADR 0043 (contenedores), ADR 0044 (empaque) y ADR 0045 (embarques)

## Contexto

Todo lo que el piso escanea ya tiene un código que las pantallas aceptan: la
ubicación su `location.code` (WMS-22A), el producto su código de barras o su
clave, el lote y la serie su código, la tarima y el bulto su `C-0001`, el
pedido `PS-0001` y el embarque `EM-0001`. Pero no hay forma de **imprimir**
esos códigos: la ficha de una tarima o de un bulto solo ofrece «Copiar
etiqueta» y una ubicación nueva queda sin nada que pegar en el estante. El
plan v3 (WMS-26) pide un PDF de etiquetas con Code 128 y QR, hecho con el
`PdfPageWriter` propio (ADR 0019), en tamaños comunes, y probar que el código
generado se decodifica de vuelta y que el PDF no tiene contenido activo.

Preguntas del paso: qué dice cada código (para que sirva en las pantallas que
ya existen), cómo se dibujan los códigos sin dependencias nuevas, en qué
tamaños, quién puede imprimir qué y dónde está el botón.

## Flujo

1. **Una etiqueta suelta.** En la ficha de lo que se etiqueta (producto,
   lote, tarima, bulto en la pantalla de empaque, pedido, embarque) hay un
   enlace «Imprimir etiqueta». Descarga un PDF listo para la impresora con
   el tamaño y los códigos que la empresa eligió en Configuración ›
   Operación. Nada que llenar.
2. **Varias a la vez.** Lo que más se usa al arrancar: «Imprimir etiquetas»
   en Ubicaciones abre una pantalla con un solo «Qué ubicaciones» (todas las
   del almacén, o una ubicación y todo lo que contiene; una ubicación sin
   nada dentro sale sola: así se imprime la de una sola), el tamaño y los
   códigos, y dice cuántas etiquetas salen y cuáles ubicaciones no tienen
   código (esas no se imprimen: se les pone uno en Ubicaciones). En el
   producto, «Imprimir etiquetas» abre una pantalla igual de corta: cuántas
   copias de la del producto, y si es por lote o por serie, las de sus lotes o
   las de sus series en existencia. En la orden de compra, cada recepción con
   series ofrece las etiquetas de esas series; en el empaque, las de todos los
   bultos del pedido.
3. **Lo que se pega.** Cada etiqueta lleva arriba lo que una persona lee
   (nombre, ruta, pedido, destinatario, caducidad…), el QR a la derecha, el
   Code 128 abajo a todo lo ancho y, siempre, el código en texto bajo las
   barras: si el lector falla, se teclea.
4. **Al escanear.** El lector teclea el código en la pantalla que ya lo pide
   (surtir, acomodar, empacar, rastrear, buscar): la etiqueta no agrega
   ninguna pantalla nueva de lectura.

## Decisión

**Qué dice cada código: lo que el sistema ya sabe leer.** Barras y QR llevan
el mismo texto, sin prefijos ni formatos propios, para que un lector de
teclado sirva en cualquier pantalla actual:

| Etiqueta | Código | Texto legible |
| --- | --- | --- |
| Ubicación | `location.code` | nombre, ruta, almacén |
| Producto | código de barras si tiene; si no, su clave | nombre, clave |
| Lote | código del lote | producto, lote, caducidad |
| Serie | la serie | producto, serie, clave |
| Tarima o contenedor | `C-0001` | tipo, dónde está |
| Bulto | `C-0001` | pedido, destinatario, peso |
| Pedido | `PS-0001` | destinatario, referencia, día de salida |
| Embarque | `EM-0001` | almacén, pedidos, transportista |

Una ubicación **sin código no recibe etiqueta**: no se inventa uno (cambiaría
lo que se escanea sin que nadie lo decidiera) y su ruta no sirve como código
(«›» no existe en Code 128 y una ruta cambia si la ubicación se mueve). La
pantalla dice cuáles faltan.

**Code 128 propio** (`src/platform/files/code128.ts`, puro): conjuntos B
(ASCII imprimible) y C (pares de dígitos), con la elección mínima habitual:
empieza en C si el texto empieza con 4 dígitos o más (o es solo dígitos, par),
cambia a C a mitad del texto en tramos de 6 dígitos o más (4 al final) y
vuelve a B; dígito de control módulo 103; patrón de paro; zona quieta de 10
módulos a cada lado. Devuelve los módulos (barra o espacio) y los valores de
los símbolos. Rechaza con mensaje lo que no es ASCII imprimible (acentos,
«ñ») y más de 48 caracteres. El decodificador (`decodeCode128`, también puro)
lee de vuelta los módulos, comprueba el control y el paro: lo usan las
pruebas para leer lo que quedó **dibujado** en el PDF. Se probó además con un
lector independiente (zxing) sobre la imagen de las páginas.

**QR con `uqr`** (ya instalado para la MFA), corrección M, zona quieta de 4
módulos, dibujado como rectángulos (una tira por cada racha de módulos
oscuros en un renglón).

**El escritor de PDF aprende dos cosas** (`PdfPageWriter`): un tamaño de
página distinto de carta (`new PdfPageWriter({ width, height })`, y
`buildPdf` pone el `MediaBox` de cada página) y `fillRects`, muchos
rectángulos rellenos en una sola operación. Sigue sin contenido activo: no
hay forma de escribir enlaces, acciones, formularios ni JavaScript.

**Tamaños comunes** (`LABEL_FORMATS`, plataforma): hoja carta con 10
etiquetas de 4 × 2 pulgadas (2 columnas × 5 renglones, para impresora
normal), etiqueta de 100 × 50 mm y de 100 × 150 mm (impresora de
etiquetas). Sin medidas ni marcas de un proveedor. Una etiqueta grande
(100 × 150) usa letra, QR y barras más grandes; las demás comparten diseño.
El ancho del módulo de las barras se calcula para que quepa el código
(entre 0.7 y 2.5 puntos): si no cabe, o el código no es ASCII, esa etiqueta
lleva solo el QR (que sí admite cualquier texto) y el texto.

**Ajustes de la empresa** (regla 11, sin tabla nueva): `inventory.labels.format`
(hoja carta por omisión: cualquiera tiene una impresora normal) e
`inventory.labels.codes` (barras y QR por omisión; solo barras; solo QR). Las
pantallas de varias etiquetas permiten cambiarlos para esa impresión; el
enlace de una sola usa los de la empresa.

**Rutas y permisos.** Una sola ruta `GET /api/etiquetas/[tipo]` (prefijo nuevo
en `PROTECTED`), con `requireOrganizationContext()` y respuesta `attachment` +
`nosniff` + `no-store`, como los otros PDF. **No hay permiso nuevo:** imprimir
la etiqueta de algo pide el permiso de **lectura** de ese algo
(`inventory.location.read`, `inventory.product.read`, `inventory.stock.read`
para lotes, series y tarimas, `inventory.outbound.read` para pedidos y bultos,
`inventory.shipment.read` para embarques, y además `purchasing.receipt.read`
para las series de una recepción). La etiqueta no dice nada que la pantalla
no muestre. Se lee con los mismos servicios que las fichas (`listLocations`,
`getLot`, `getContainer`, `getOutboundOrder`, `getShipment`) o con su misma
condición de alcance: algo de fuera del almacén o las zonas de la persona «no
existe» (404, igual que otra empresa) y una impresión de varias trae solo lo
que la persona alcanza.

**Tope:** 500 etiquetas por archivo (`LABELS_MAX`), dicho en las pantallas de
varias; con más, la pantalla pide elegir una zona y la ruta responde con el
mismo mensaje sin armar nada. Las copias de una etiqueta van de 1 a 100.

**Bitácora:** como los demás PDF, cada archivo deja **una** línea
(`inventory.labels_printed`, qué se imprimió y cuántas etiquetas), nunca una
por etiqueta.

## Dónde se aplica

- Plataforma: `src/platform/files/code128.ts` (codificar y decodificar),
  `src/platform/files/labels.ts` (`LABEL_FORMATS`, `buildLabelsPdf`, dibujo de
  barras y QR), `pdf.ts` (tamaño de página y `fillRects`).
- Inventario: `src/modules/inventory/labels.ts` (`buildLabels`,
  `previewLocationLabels`, `productLabelOptions`, `labelDefaults`,
  `LABELS_MAX`, `LABEL_COPIES_MAX`) y los ajustes `LABEL_FORMAT`
  (`inventory.labels.format`) y `LABEL_CODES_SETTING`
  (`inventory.labels.codes`).
- Ruta `src/app/api/etiquetas/[tipo]/route.ts`; pantallas
  `/ubicaciones/etiquetas` e `/inventario/[id]/etiquetas`; enlaces en las
  fichas de lote, tarima, empaque, pedido, embarque y orden de compra.
- Pruebas: `src/platform/files/code128.test.ts`, `labels.test.ts`,
  `pdf.test.ts` y `tests/inventory/labels.int.test.ts`.

## Etiqueta de un bulto suelto (WMS-99, 2026-11-21)

La etiqueta de tipo `contenedor` de un bulto de empaque imprimía el número
y el destinatario del pedido con solo `inventory.stock.read`. Ahora pide lo
mismo que la de tipo `bultos`: `inventory.outbound.read` y el almacén del
pedido dentro del alcance; si no, el bulto «no existe» para esa persona. La
etiqueta de una tarima sigue igual.

## Lo que quedó fuera

- Impresión directa a una impresora de etiquetas (ZPL, EPL u otro lenguaje de
  impresora): hoy se descarga un PDF y se imprime al tamaño real.
- Otros tamaños o diseños por empresa (logotipo, campos elegidos): se agregan
  a `LABEL_FORMATS` cuando una empresa lo pida.
- Conjunto A de Code 128 (caracteres de control) y GS1-128 (FNC1, campos de
  aplicación): ningún código del sistema los usa.
- Imprimir al recibir sin pasar por la orden (etiquetas de lote al recibir) y
  etiquetas de tareas: se hacen desde la ficha del lote o del producto.
- La etiqueta de una sola ubicación que contiene otras (hoy sale con lo que
  contiene) y un enlace en el diálogo de cada ubicación: Ubicaciones no tiene
  ficha por ubicación.
- Etiquetas de una serie suelta desde su rastreo (la ruta ya acepta
  `series?id=`; falta el enlace).

## Consecuencias

- Cualquier código del sistema se puede imprimir y pegar sin otra
  herramienta, y lo que se escanea es exactamente lo que las pantallas ya
  aceptan.
- Un código nuevo que se escanee (otro documento) agrega su etiqueta en
  `labels.ts` con el permiso de lectura de su ficha, su caso en
  `tests/inventory/labels.int.test.ts` y su enlace en la ficha.
- El escritor de PDF sigue siendo el único que escribe bytes de PDF.
