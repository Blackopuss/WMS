# Revisión de amenazas — fotos de evidencia (WMS-37)

Fecha: 2026-11-16. Complementa `REVISION_IMP.md` (archivos privados,
ADR 0014) y el ADR 0063. Hecha por la misma IA que implementó el paso y
corregida tras una revisión independiente (2026-11-16; ver «Hallazgos de la
revisión independiente»).

## Qué se agregó

- Imágenes JPEG, PNG y WebP como archivos privados de una empresa
  (`storeFile`), con un propósito que dice quién las sube y quién las ve
  (`incident_photo`: `inventory.incident.create` / `inventory.incident.read`).
- `sanitizeImage` (`src/platform/files/images.ts`): comprueba la firma y la
  estructura y reconstruye el archivo sin los metadatos conocidos (Exif,
  XMP, IPTC, MPF, ICC, comentarios, textos) ni lo que sigue al final; lo
  conservado (cuadro, tablas, escaneos, marca de Adobe; en PNG y WebP los
  fragmentos de imagen, color y densidad) tiene el tamaño que su formato
  admite.
- Vínculo inmutable de una foto con su registro (`evidence_photo`) y regla
  de lectura del dueño del registro (`EvidenceOwners`).
- `/api/archivos/<id>` sirve imágenes `inline` y todo lo demás como descarga.
- Captura en el navegador (`PhotoCapture`): reduce y vuelve a codificar con
  `canvas`, sube una por una; galería (`PhotoGallery`).
- Ronda que borra a las 24 horas las fotos que nunca se ligaron.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Archivo que no es imagen con extensión de imagen (HTML, script, ejecutable, SVG) | Extensión de imagen **y** firma y estructura válidas del mismo formato; SVG y GIF no se aceptan | `images.test.ts` («rechaza un archivo que no es imagen…»), `incident-photos.int.test.ts` («rechaza un archivo falso…») |
| Imagen real con la extensión de otro formato | Se rechaza: el formato detectado debe ser el de la extensión | `images.test.ts`, `incident-photos.int.test.ts` |
| Polyglot (imagen + HTML/ZIP en un comentario, un APPn, un fragmento auxiliar o al final) | El archivo se reconstruye: solo se copian los segmentos que dibujan; lo que sigue a EOI, IEND o el tamaño RIFF se descarta | `images.test.ts` («descarta lo que viene después del final») |
| Archivo dañado o con longitudes falsas que haga leer fuera del búfer | Cada longitud se comprueba contra lo que queda; CRC de PNG comprobado; sin expresiones regulares sobre el contenido | `images.test.ts` («rechaza una foto incompleta», «…alterado (CRC)») |
| Bomba de descompresión en el navegador | 5 MB y tope de dimensiones (2,048 px por lado y 2,048 × 2,048; el navegador sube 1,600) leídas de la cabecera; el servidor no decodifica píxeles | `images.test.ts` («…más grande de lo que un navegador debe dibujar»), `incident-photos.int.test.ts` («…más de 5 MB») |
| Archivo hostil que agota memoria o CPU del servidor (un JPEG de 5 MB hecho de tablas o segmentos vacíos; un PNG con cientos de miles de pHYs) | Mínimo de tamaño por tipo de segmento, cada fragmento auxiliar una sola vez, topes de segmentos (1,024), tablas (32), escaneos (64) y fragmentos (4,096 en PNG, 64 en WebP) | `images.test.ts` («un archivo hostil cuesta lo que una foto»: menos de 150 ms y 25 MB) |
| Metadatos con la ubicación GPS, el dispositivo o una segunda imagen | El navegador vuelve a codificar; el servidor, sin confiar en él, quita todos los APPn salvo la marca de Adobe (tamaño fijo), los comentarios, los perfiles ICC, los textos y eXIf de PNG y EXIF/XMP/ICCP de WebP, y todo lo que sigue al final (la segunda imagen de MPF) | `images.test.ts` (Exif TIFF real con `GPSInfo` en JPEG, PNG y WebP; MPF con segunda imagen), `incident-photos.int.test.ts` («guarda la foto sin la ubicación GPS») |
| Texto arbitrario escondido en lo que se conserva (tablas, VP8X largo) | VP8X de exactamente 10 bytes y con el lienzo de la imagen; tablas con tamaño mínimo y tope de cuenta; ICC quitado. Lo que queda no se ejecuta | `images.test.ts` («rechaza un VP8X de otro tamaño…») |
| Ejecutar algo al abrir la foto en el origen de la app | Tipo decidido por el servidor, `nosniff`, `inline` solo para `image/*`, CSP propia de `/api/archivos` con `default-src 'none'` y `sandbox`, `Cross-Origin-Resource-Policy: same-origin` | `src/lib/file-response.test.ts` (cabeceras y política de la ruta) |
| Adivinar el id de una foto o reutilizar un enlace | UUIDv7; enlace firmado por persona, empresa y vencimiento de 5 minutos; la ruta exige sesión y vuelve a comprobar todo | `incident-photos.int.test.ts` («…otra persona con la misma dirección no obtiene nada») |
| Foto de otra empresa | Toda lectura filtra por empresa: un enlace firmado correctamente para alguien de la otra empresa no encuentra nada | `incident-photos.int.test.ts` («una foto de otra empresa no existe») |
| Foto de un registro fuera del alcance (almacén o zona) | `openFileLink`/`createFileLink` preguntan al dueño del registro (`reachesIncident`) en cada apertura; si la persona deja de alcanzarlo, su enlace deja de servir; sin la función del dueño, la foto no existe para nadie | `incident-photos.int.test.ts` («fuera del alcance…», «limitado a otra zona…») |
| Enlace vencido en una ficha abierta mucho tiempo | Miniaturas sin carga diferida; la foto completa se abre por `/api/archivos/<id>/ver`, que vuelve a comprobar todo y hace un enlace nuevo | `incident-photos.int.test.ts` («redirige a un enlace fresco…») |
| Convertir el id de un archivo ajeno (una hoja de importación) en un enlace propio por `/ver` | `/ver` atiende solo propósitos de evidencia (`onlyEvidence`); lo demás responde 404 como lo inexistente | `incident-photos.int.test.ts` («para todo lo demás responde como si no existiera»: fuera de alcance, otra empresa, sin permiso, foto ajena sin ligar, hoja de importación, id inválido; «sin sesión no da nada») |
| Carga arbitraria dentro de tablas DQT o DHT | Cada segmento debe ser exactamente sus tablas (ITU T.81 B.2.4): 1 a 4, con su precisión, clase y destino válidos, y cuentas de códigos que suman lo que trae | `images.test.ts` («las tablas de un JPEG son solo tablas») |
| Interbloqueo entre subir una foto y un cambio de equipo | Orden de candados empresa → membresía en los dos caminos: la fila se escribe primero (candado compartido de la empresa por su llave foránea) y luego se bloquea la membresía. Con el orden anterior (membresía y luego empresa) el ciclo era posible en teoría (subida con la membresía bloqueada esperando la empresa; cambio de equipo con la empresa bloqueada esperando la membresía al escribir `membership_role`); no se reprodujo en pruebas con retrasos forzados, pero el orden nuevo lo descarta por construcción | `incident-photos.int.test.ts` («no se bloquean entre sí») |
| Foto sin ligar vista por otra persona | Solo existe para quien la subió | `incident-photos.int.test.ts` («una foto sin ligar solo existe para quien la tomó») |
| Ligar la foto de otra persona, de otra empresa o la misma foto dos veces | Se liga solo lo subido por la misma persona, del mismo propósito, sin borrar y sin ligar, bajo el candado del archivo; único por empresa; disparador que exige archivo vivo y del mismo propósito | `incident-photos.int.test.ts` («no liga la foto de otra persona…», «la base no liga…») |
| Borrar o cambiar evidencia | `deleteFile` bloquea la fila, la relee y borra bytes solo si marcó esa fila (una foto que se liga a la vez no se pierde); rechaza una foto ligada; disparadores: el vínculo no cambia ni se borra y el archivo ligado no cambia; `CHECK` que ata la columna de dueño a su propósito | `incident-photos.int.test.ts` («una foto ligada no cambia ni se borra», «Quitar borra la foto propia sin ligar…») |
| Llenar el disco subiendo sin guardar | 30 fotos sin ligar por persona en 24 h, contadas bajo el candado de su membresía; «Quitar» la borra; la ronda borra lo no ligado a las 24 h en todas las empresas, también con el plan vencido | `incident-photos.int.test.ts` («quien sube sin guardar…», «subidas a la vez no pasan del tope…», «se borran solas…», «con el plan vencido…») |
| Llenar el disco con fotos ligadas | Pendiente: no hay cupo total por empresa (30 por incidencia); se decide con el almacenamiento externo (WMS-67) | — |
| Terminal compartida: lo de una persona visible para la siguiente | `Cache-Control: private, no-store`; el service worker no guarda imágenes (solo `/sin-conexion`, solo navegaciones); las miniaturas `blob:` se liberan al quitar y al salir del formulario | Revisión (ADR 0049) |
| Soporte de plataforma | Solo `.read`: ve las fotos de lo que ve; subir y escribir notas es escritura | `incident-photos.int.test.ts` («soporte de plataforma ve las fotos de lo que ve y no sube», con una entrada real de soporte) |
| Sesión de PIN en una terminal | Sube y ve con el permiso del piso; lo recortado (exportaciones, plataforma) sigue fuera | `terminals.int.test.ts` («fotos de evidencia en la terminal») |
| Llave de la API | No hay ruta de la API para fotos; `/api/archivos` exige la cookie de sesión, que la API nunca lee | Revisión |
| Plan vencido | Subir pide `inventory.incident.create` (escritura): bloqueado; ver sigue | `incident-photos.int.test.ts` («con el plan vencido…») |

## Hallazgos de la revisión independiente (2026-11-16) y cómo quedaron

- M1 (memoria y CPU con archivos de miles de segmentos): mínimos de tamaño,
  una vez por fragmento auxiliar y topes de cuenta; prueba con tiempo y
  memoria.
- M2 (bomba de memoria para quien ve la ficha): tope bajado a 2,048 px.
- B1 (disco): tope de pendientes bajo candado; «Quitar» borra; cupo total
  pendiente para WMS-67.
- B2 (nota de solo espacios aceptada por la intercalación): el `CHECK`
  compara la longitud; prueba contra MySQL.
- B3 (`deleteFile` sin candado): igual que la purga.
- B4 (limpieza solo en empresas con el módulo vigente): corre en todas.
- B5 (texto en lo conservado): ICC quitado, VP8X exacto y con su lienzo,
  documentos corregidos («se quitan los metadatos conocidos»).
- B6 (enlaces vencidos en la galería): sin carga diferida y enlace nuevo al
  abrir.
- Notas: el componente muestra el error del navegador y el del servidor a
  la vez; `CHECK` que ata dueño y propósito.

Segunda vuelta (2026-11-16): `/ver` solo para evidencia; tablas DQT y DHT
validadas por dentro; orden de candados empresa → membresía; pruebas reales
con sesión de PIN y con soporte.

## Riesgos residuales
- El servidor no decodifica los píxeles: un JPEG con datos de imagen
  inválidos pero estructura correcta se guarda y el navegador lo dibuja roto.
  No ejecuta nada.
- Una foto subida sin volver a codificar (sin JavaScript) pierde su
  orientación Exif al limpiarse; una con un perfil de color distinto de sRGB
  se ve con colores un poco distintos (el perfil se quita).
- Quien ve una incidencia con 30 fotos de 2,048 px decodifica hasta unos
  500 MB en el peor caso (fotos armadas a mano); con lo que sube el
  navegador (1,600 px) son unos 300 MB. Las miniaturas no se generan en el
  servidor (no hay librería de imágenes).
- Las fotos crecen rápido: almacenamiento externo y respaldos independientes
  antes de operar en producción con fotos (WMS-67).

## Fotos al entregar una tarea (WMS-37B, ADR 0076, 2026-11-16)

Tercer dueño de una foto: la tarea del almacén (`evidence_photo.warehouseTaskId`,
propósito `task_photo`: escribe `inventory.task.execute`, lee
`inventory.task.read`, 3 por tarea). Amenazas revisadas:

- **Ligar una foto ajena o ya usada.** `attachEvidencePhotos` en la
  transacción de la entrega, al final y bajo el candado de cada archivo
  (misma persona, mismo propósito, sin ligar, sin borrar; único por
  empresa). Prueba con fotos de otra persona, de otra empresa, de una
  incidencia, ya ligadas y un id inventado: la entrega se revierte entera.
- **Foto en una tarea ajena o abierta.** Además del servicio, el disparador
  `evidence_photo_task_rules` exige tarea `DELIVERED` y que la ligue quien
  la tenía asignada; el `CHECK` ata la columna a su propósito.
- **Subir sin estar entregando.** `uploadTaskPhoto` exige la tarea propia,
  en alcance (`taskScope`) y «Por entregar», y el ajuste distinto de «Sin
  foto»; si no, no guarda nada. Esto solo limita **cuándo** se sube.
- **Usar las fotos de una tarea para entregar otra (hallazgo medio de la
  revisión independiente, corregido).** Antes, con una tarea en curso se
  podían subir fotos de cualquier cosa y usarlas durante 24 horas para
  entregar otras tareas sin fotografiar dónde quedó la mercancía. Ahora
  la foto queda atada al subirla a la tarea para la que se tomó
  (`stored_file.pendingOwnerId`, propósito `boundToOwner`, inmutable por
  disparador) y solo se liga a esa tarea (`attachEvidencePhotos` y el
  disparador `evidence_photo_owner_rules`). Probado: tres fotos de T1
  ofrecidas a T2 y T3 se rechazan y revierten la entrega; las dos
  entregas a la vez con la foto de una solo pasan en la suya; insertar el
  vínculo a mano también se rechaza. Incidencias y pasos de proceso no
  cambian (su registro nace con las fotos).
- **Ver la foto fuera del alcance.** `reachesTask` (en `evidenceOwners`)
  usa la misma condición que `getTask`; con el enlace armado a mano la
  ruta `/ver` responde 404 igual que un archivo que no existe. Probado con
  una persona limitada a otra zona, a otro almacén y con otra empresa.
- **Saltarse la foto obligatoria.** El ajuste se lee bajo los candados de
  la entrega y se rechaza antes de escribir; la entrega en grupo de las
  olas se rechaza con el ajuste en «Obligatoria».
- **Concurrencia.** Dos entregas a la vez con la misma foto: una la liga y
  la otra no mueve nada; la misma tarea dos veces: una entrega y un
  `repeated`, sin fotos de más (pruebas con `Promise.all`).
- **Terminal con PIN.** El Montacarguista sube y entrega con su sesión de
  PIN (`inventory.task.execute` se conserva en la terminal) y ve la foto.

Bajos de la revisión, corregidos: `discardTaskPhotoAction` atrapa el plan
vencido como la subida; el error de la foto se muestra junto al campo y
lleva el foco ahí; el disparador nuevo compara quién subió el archivo con
quién lo liga (antes solo lo hacía el servicio, también para incidencias y
procesos).

Riesgos que quedan: el ajuste se lee sin candado frente a un cambio de
ajuste simultáneo (como todos los ajustes); con el código anterior a este
paso las fotos `task_photo` sin ligar no se purgan hasta volver a esta
versión. Las fotos de una entrega repetida (respuesta perdida y
reintento con fotos nuevas) quedan sin ligar hasta que la ronda de limpieza
las borra a las 24 horas, y cuentan mientras tanto en el tope de 30 fotos
sin ligar por persona.
