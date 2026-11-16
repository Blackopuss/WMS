# ADR 0063 — Fotos de evidencia sobre los archivos privados

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-37 (transversal) · Usa
ADR 0014 (archivos privados), ADR 0034 (ajustes de operación), ADR 0038
(alcance), ADR 0049 (app instalable y cámara), ADR 0057 (incidencias),
ADR 0061 (terminales con PIN)

## Contexto

La propuesta de producción y calidad (`docs/flujos/PRODUCCION_CALIDAD.md`,
sección 8, D5 y P4) hace de las fotos un requisito: producción reporta lo que
hizo con foto y Calidad reporta una diferencia con foto y motivo. El plan v3
pide además evidencia fotográfica en incidencias (pendiente del ADR 0057),
devoluciones, lo dañado al recibir, ajustes y tareas con problema.

Hoy `storeFile` solo acepta CSV y XLSX, y todo archivo sale como descarga
(`attachment`). Una foto es otra cosa: un archivo que la gente toma con el
teléfono, que se ve dentro de la página y que, una vez ligado a un registro
inmutable, ya no se puede quitar ni cambiar. Y es una superficie de ataque
conocida: imágenes que son a la vez HTML o un ZIP (polyglots), SVG con
scripts, imágenes enormes que tumban el navegador al dibujarlas, y metadatos
con la ubicación GPS de quien la tomó.

Los pasos de producción, calidad y procesos todavía no existen (WMS-59 está
en curso): este paso deja el mecanismo y lo usa de punta a punta en lo que
ya existe.

## Flujo operativo

1. **Quién y dónde.** Quien hace el registro que lleva la foto, con el
   permiso de escribir ese registro (para una incidencia,
   `inventory.incident.create`: todo el piso, también el Montacarguista).
   Normalmente en el teléfono o la tableta del piso, también en una
   terminal compartida con PIN; en una computadora, el mismo botón abre el
   selector de archivos.
2. **Tomar la foto.** En el formulario, «Tomar foto» abre la cámara trasera
   (`<input type="file" accept="image/*" capture="environment">`; en una
   computadora, el selector de archivos). El navegador la **reduce** (lado
   mayor de 1,600 px) y la **vuelve a codificar** como JPEG con un `canvas`,
   sin dependencias; así viaja poco (≈ 200–400 KB) y ya sin metadatos. Se
   ve en miniatura con «Quitar», que también la borra del servidor si aún
   no se guardó (deja de contar para el tope de fotos sin guardar).
3. **Subir antes de guardar.** Cada foto se sube sola, al tomarla, con una
   Server Action del registro («Las fotos se suben antes de guardar y el
   reporte guarda sus ids», propuesta 5.4). El servidor **comprueba el
   contenido real** (sección «Decisiones»), la guarda como archivo privado de
   la empresa con el propósito del registro y devuelve su id. Mientras no se
   liga, solo quien la subió la puede ver.
4. **Guardar el registro.** El formulario manda los ids. El servicio del
   registro, **dentro de su transacción y después de sus candados**, liga
   las fotos con `attachEvidencePhotos`: comprueba que cada una es de esa
   empresa, de ese propósito, subida por esa persona, sin borrar y sin ligar,
   y que no se pasa del tope. Si algo falla, nada se guarda.
5. **Ver.** La ficha del registro muestra la galería: miniaturas que abren
   la foto completa. Cada enlace es por persona y vence en 5 minutos, como
   las descargas de hoy, así que las miniaturas se cargan de inmediato (sin
   carga diferida); abrir la foto completa pasa por `/api/archivos/<id>/ver`,
   que hace un enlace nuevo en ese momento con las mismas comprobaciones,
   así funciona aunque la ficha lleve rato abierta. Esa ruta solo atiende
   fotos de evidencia: cualquier otro archivo (una hoja de importación, una
   exportación) responde como si no existiera, así conocer su id nunca da
   un enlace. Quien no alcanza el
   registro no recibe enlace y, si lo arma a mano, la foto «no existe».
6. **Qué deja de rastro.** La fila del archivo (`stored_file`: quién, cuándo,
   tamaño, `sha256`, ancho y alto) y la fila del vínculo (`evidence_photo`:
   qué registro, qué nota, en qué orden, quién). Las dos son permanentes para
   una foto ligada: ni el vínculo ni el archivo se cambian o se borran
   (disparadores). La bitácora del registro dice cuántas fotos llevó.
7. **Ninguna foto cambia existencias ni estados.**
8. **Lo que no se ligó** (se tomó y luego se quitó, o el formulario no se
   envió) se borra solo a las 24 horas (ronda `platform.photo_orphans_cleanup`).

### Qué se configura por empresa

- **Si la foto es obligatoria** en cada registro es un ajuste del módulo que
  lo dueña, con valor por omisión. Para las incidencias:
  `inventory.incident.photo` (`optional` por omisión, `required`), en
  Configuración › Operación. Producción y calidad ya tienen previstos los
  suyos (`production.report.photo`, `quality.evidence.photo`, propuesta
  sección 10).
- Tamaño máximo (5 MB), fotos por registro y dimensiones son límites de la
  plataforma por propósito, no de la empresa: protegen al servidor y a los
  navegadores, no son una forma de trabajar.

## Decisiones

### Formatos y comprobación del contenido (`images.ts`)

- **Se aceptan JPEG, PNG y WebP; nunca SVG, GIF, HEIC ni nada más.** La
  extensión debe ser de imagen **y** coincidir con lo que dicen los bytes
  (`.jpg` con contenido PNG se rechaza). El tipo de contenido lo decide el
  formato detectado, nunca el navegador.
- **El servidor no confía en que el navegador quitó los metadatos: los quita
  él, reconstruyendo el archivo.** `sanitizeImage` recorre la estructura con
  índices y longitudes (sin expresiones regulares sobre el contenido,
  convención «Lectores de archivos de clientes») y arma un archivo nuevo.
  **Se quitan todos los metadatos conocidos** (Exif con GPS, XMP, IPTC, MPF
  y la segunda imagen que describe, perfiles ICC, miniaturas, comentarios,
  textos) y **se conserva** solo lo que sigue, cada parte con el tamaño que
  su formato admite:
  - **JPEG:** SOI, tablas de cuantización y Huffman recorridas tabla por
    tabla como las define ITU T.81 (B.2.4): el segmento debe ser
    exactamente sus tablas (DQT de 67 a 518 bytes, DHT de 20 a 1,094, de 1
    a 4 tablas cada uno), y de reinicio (exactamente 4), hasta 32 en total; un solo SOF
    baseline, extendido o progresivo con su tamaño exacto; hasta 64 SOS,
    cada uno con su tamaño exacto y sus datos; `APP14 Adobe` una vez y con
    su tamaño fijo (cambia cómo se decodifican los colores); EOI. Todos los
    demás APPn y los comentarios se quitan. Otros SOF (aritméticos, sin
    pérdida, jerárquicos) y marcas desconocidas se rechazan. Se recorren a
    lo más 1,024 segmentos.
  - **PNG:** firma, IHDR primero, y solo PLTE, IDAT, IEND, tRNS, gAMA, cHRM,
    sRGB, sBIT, bKGD y pHYs, cada uno con su CRC y el tamaño que el formato
    admite, todos una sola vez salvo IDAT. Se quitan iCCP, tEXt, zTXt, iTXt,
    eXIf, tIME, la animación y todo lo auxiliar desconocido; un fragmento
    crítico desconocido se rechaza. Se recorren a lo más 4,096 fragmentos.
  - **WebP:** RIFF con VP8, VP8L o VP8X de exactamente 10 bytes cuyo lienzo
    coincide con el de la imagen (+ ALPH una vez). Se quitan ICCP, EXIF y
    XMP y se apagan sus banderas; la animación se rechaza.
  - Lo conservado (tablas, la marca de Adobe) puede llevar bytes arbitrarios
    acotados; no se ejecutan (tipo del servidor, `nosniff`, CSP `sandbox`) y
    una cámara no guarda ahí su ubicación.
  - Un archivo hostil (millones de segmentos diminutos) se rechaza antes de
    gastar memoria: cuesta lo que una foto (revisión independiente, M1).
  - **Todo lo que viene después del final** (EOI, IEND o el tamaño RIFF) se
    descarta: un polyglot pierde la parte que no es imagen.
- **Dimensiones** leídas de la cabecera: de 1 a 2,048 px por lado y hasta
  2,048 × 2,048. El navegador sube como mucho 1,600 px; el tope deja ese
  margen y acota lo que decodifica quien ve la ficha (unos 16 MB por foto)
  aunque alguien llame a la Server Action a mano. El servidor nunca
  decodifica píxeles (no hay librería de imágenes).
- **5 MB** por foto (la foto reducida pesa mucho menos; el tope cubre una
  computadora que sube un archivo sin reducir).
- Lo guardado son los bytes reconstruidos; `sha256`, tamaño, ancho y alto
  son de esos bytes.
- No se recodifica en el servidor (haría falta una librería nativa o un
  decodificador propio). Lo que se acepta es lo que el navegador ya sabe
  dibujar y la orientación ya la aplicó el `canvas` al recodificar; una foto
  subida sin recodificar (sin JavaScript) pierde su orientación Exif, y una
  con perfil de color distinto de sRGB se ve con colores un poco distintos
  (el perfil se quita).

### Servir la foto

- **Imágenes `inline`, todo lo demás `attachment`**, decidido por el tipo de
  contenido guardado (que decidió el servidor). Con `nosniff`,
  `Cross-Origin-Resource-Policy: same-origin` y `Cache-Control: private,
  no-store` (en una terminal compartida no queda copia en la caché).
- La ruta `/api/archivos/*` lleva una política de contenido propia y
  estricta (`default-src 'none'; img-src 'self'; sandbox`), puesta por
  `src/proxy.ts`: aunque un archivo lograra hacerse pasar por HTML, no
  ejecuta nada.
- El service worker solo responde a navegaciones que fallan por red y solo
  guarda `/sin-conexion` (ADR 0049): una `<img>` no es navegación y no se
  guarda. La política de imágenes de la app ya admite `'self'` y `blob:`
  (la miniatura antes de subir).

### Vínculo con el registro (`evidence_photo`)

- **Una tabla de vínculos para toda la plataforma**, con **una columna de
  referencia por clase de registro** y llave compuesta (como
  `custom_field_value`, ADR 0056): hoy `incidentId` y, para una foto que
  llegó con una nota, `incidentNoteId`. Un `CHECK` exige exactamente un
  dueño y otro ata cada columna de dueño a su propósito
  (`incidentId` → `incident_photo`; cada propósito nuevo extiende los dos);
  un disparador exige que la nota sea de esa incidencia y que el archivo
  exista, sin borrar, del mismo propósito. Un archivo se liga una sola vez
  (único por empresa).
- **Inmutable:** el vínculo no se cambia ni se borra, y un archivo ligado no
  se marca borrado ni se cambia (disparadores; `deleteFile` lo rechaza antes).
- **El dueño decide quién ve.** El propósito dice el permiso de lectura; el
  alcance lo dice el módulo: `openFileLink` y `createFileLink` reciben las
  funciones `EvidenceOwners` (registro de módulos,
  `src/modules/registry/evidence.ts`) y, para una foto ligada, preguntan si
  la persona alcanza su registro; sin función, o si no lo alcanza, la foto
  «no existe» (falla cerrado). Una foto sin ligar solo existe para quien la
  subió. La plataforma no importa módulos: recibe las funciones.
- **Topes por propósito:** fotos por registro (5 por incidencia y 5 por
  nota) y por dueño (30 por incidencia). Fotos sin ligar por persona: 30 en
  24 horas (quien sube sin guardar no llena el disco); «Quitar» libera el
  lugar. Se cuentan después de escribir la fila, bajo el candado de la
  membresía de la persona y contando la propia: subidas simultáneas cuentan
  una tras otra. El orden de candados es empresa (el `INSERT` toma un
  candado compartido de la empresa por su llave foránea) → membresía, el
  mismo que un cambio de equipo (`withTeamChange`), así que los dos nunca
  se esperan en círculo.
- **Borrar** una foto sin ligar (`deleteFile`) bloquea su fila, la vuelve a
  leer y borra los bytes solo si marcó esa fila: una foto que se está
  ligando en ese momento no se pierde.
- **La limpieza corre para todas las empresas** (`allOrganizations`), sin
  importar módulos ni plan: una empresa con el plan vencido también limpia.

### Dónde se usa en este paso

- **Incidencias** (pendiente del ADR 0057): al reportar y con cada nota de
  seguimiento (una nota puede ser solo fotos), mientras está abierta.
  Propósito `incident_photo` (escribe `inventory.incident.create`, lee
  `inventory.incident.read`), ajuste `inventory.incident.photo`.
- **Quedan pendientes**, cada una como una entrada más cuando se retome:
  - *Devoluciones de clientes y lo dañado al recibir:* sus servicios son del
    corazón (candados productos → ubicaciones → documento, movimientos
    inmutables) y sus formularios ya son largos; ligar fotos ahí es una
    columna más y su prueba, pero toca transacciones de existencias que van
    una tras otra. Mientras, quien lo necesite reporta una incidencia con
    foto que nombra el producto.
  - *Ajustes y sus solicitudes de aprobación:* el efecto de la aprobación
    vuelve a validar un payload (ADR 0053); la foto debería verla quien
    autoriza antes de decidir, lo que cambia la pantalla de aprobaciones y
    el resumen fijo. Es un paso propio.
  - *Tareas con problema:* `blockTask` es de la tarea; hoy basta con
    «Reportar un problema» desde la tarea (`?tarea=`), que ya lleva fotos.

### Cómo agrega su propósito un paso futuro

Producción (`production_report_photo`), calidad (`quality_inspection_photo`)
y procesos (`process_step_photo`) hacen, cada uno en su paso:

1. Una migración que agrega la columna de su registro a `evidence_photo`
   (llave compuesta hacia su tabla), rehace el `CHECK` de un solo dueño
   sumando esa columna y agrega el `CHECK` que la ata a su propósito
   (expansión: nada existente cambia).
2. Su dueño en `EVIDENCE_OWNER_KINDS` (`src/platform/files/evidence.ts`:
   clase → columna).
3. Su propósito en `FILE_PURPOSES` con extensiones de imagen, 5 MB, sus
   permisos de la matriz (escribir: quien hace el registro; leer: quien lo
   ve) y su `evidence` (dueño y topes).
4. La función que dice si una persona alcanza su registro, en
   `src/modules/registry/evidence.ts`.
5. En su servicio, `attachEvidencePhotos` dentro de la transacción del
   registro y, si la foto puede ser obligatoria, su ajuste.
6. En su pantalla, `PhotoCapture` y `PhotoGallery`.

## Modelo de amenazas

| Amenaza | Defensa |
| --- | --- |
| Archivo que dice ser imagen y no lo es (HTML, script, ejecutable) | Extensión de imagen **y** firma y estructura válidas; si no, se rechaza (`type`/`broken`) |
| SVG con scripts | SVG no se acepta |
| Polyglot (JPEG + ZIP/HTML al final o en un comentario) | El archivo se reconstruye: los metadatos conocidos (comentarios, APPn, perfiles, fragmentos auxiliares) y la cola no se guardan; lo conservado tiene tamaños acotados; `nosniff` y CSP `sandbox` al servir |
| Imagen enorme (bomba de descompresión en el navegador) | 5 MB y 2,048 px por lado leídos de la cabecera |
| Archivo hostil que agota memoria o CPU del servidor (miles de segmentos diminutos) | Mínimos de tamaño por segmento, cada parte auxiliar una sola vez y tope de segmentos, tablas y escaneos |
| Metadatos (GPS, modelo, fecha, miniatura con otra imagen) | Se quitan en el navegador y, sin confiar en él, en el servidor al reconstruir |
| Adivinar ids o reutilizar un enlace | UUIDv7 + enlace firmado por persona, empresa y vencimiento (5 min); la ruta exige sesión |
| Foto de otra empresa o fuera del alcance | Toda lectura filtra por empresa; el dueño responde si la persona alcanza el registro; si no, «no existe» (404 igual) |
| Ligar la foto de otra persona o de otro registro | Solo se liga lo que subió la misma persona, sin ligar y del mismo propósito; único por empresa |
| Borrar o cambiar evidencia | Vínculo y archivo ligado inmutables (disparadores) |
| Llenar el disco subiendo sin guardar | 30 fotos sin ligar por persona en 24 h, bajo candado; «Quitar» las borra; ronda que borra lo no ligado a las 24 h en todas las empresas. Sin cupo total de fotos ligadas (pendiente, WMS-67) |
| Terminal compartida | Sin caché (`no-store`), el service worker no guarda imágenes, las miniaturas `blob:` se liberan al quitar o salir; la sesión de PIN sube con el permiso del piso y no ve más de lo que ve |
| Soporte de plataforma | Solo permisos `.read`: ve las fotos de lo que puede ver, nunca sube |
| Llaves de la API | No hay ruta de la API para fotos; `/api/archivos` exige la cookie de sesión, que la API nunca lee |
| Plan vencido | Subir es escritura (`*.create`): queda bloqueado; ver sigue (`.read`) |

## Consecuencias

- Las fotos crecen rápido: antes de operar en producción con fotos hace
  falta el almacenamiento externo y respaldos independientes (WMS-67).
- **Pendiente para WMS-67:** no hay cupo total de fotos ligadas por empresa
  (30 por incidencia sin límite de incidencias). Se decidirá con el
  almacenamiento externo, junto con su precio por plan.
- `stored_file` gana `width` y `height` (opcionales: solo imágenes).
- Una prueba que necesite una foto usa las de `tests/setup/images.ts`
  (JPEG, PNG y WebP reales hechos con Chromium).

## Alternativas descartadas

- **Recodificar en el servidor** (sharp u otra librería nativa): dependencia
  nueva y superficie de decodificación en el servidor; la reconstrucción
  estructural quita lo mismo que importa (metadatos y cola) sin decodificar.
- **Confiar en que el navegador quitó el GPS:** cualquier cliente puede
  mandar otros bytes.
- **Una tabla de vínculos por registro:** cada paso repetiría disparadores,
  topes y reglas de lectura; una sola con columnas por dueño es lo mismo que
  hicieron los campos personalizados.
- **Vínculo polimórfico (tipo + id de texto):** sin llave foránea, una foto
  podría apuntar a un registro de otra empresa o inexistente.
- **Subir las fotos con el formulario del registro:** una Server Action con
  varias fotos crece sin control y se pierde todo si falla; subir una por una
  deja ver el avance y reintentar solo la que falló.
