# Revisión de amenazas — fotos de evidencia (WMS-37)

Fecha: 2026-11-16. Complementa `REVISION_IMP.md` (archivos privados,
ADR 0014) y el ADR 0063. Hecha por la misma IA que implementó el paso;
falta la revisión independiente.

## Qué se agregó

- Imágenes JPEG, PNG y WebP como archivos privados de una empresa
  (`storeFile`), con un propósito que dice quién las sube y quién las ve
  (`incident_photo`: `inventory.incident.create` / `inventory.incident.read`).
- `sanitizeImage` (`src/platform/files/images.ts`): comprueba la firma y la
  estructura y reconstruye el archivo solo con lo que lo dibuja.
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
| Bomba de descompresión en el navegador | 5 MB y tope de dimensiones (8,000 px por lado, 40 MP) leídas de la cabecera; el servidor no decodifica píxeles | `images.test.ts` («…más grande de lo que un navegador debe dibujar»), `incident-photos.int.test.ts` («…más de 5 MB») |
| Metadatos con la ubicación GPS, el dispositivo o una miniatura distinta | El navegador vuelve a codificar; el servidor, sin confiar en él, quita todos los APPn salvo el perfil de color y Adobe, los comentarios, los textos y eXIf de PNG y EXIF/XMP de WebP | `images.test.ts` (JPEG, PNG y WebP con GPS), `incident-photos.int.test.ts` («guarda la foto sin la ubicación GPS») |
| Ejecutar algo al abrir la foto en el origen de la app | Tipo decidido por el servidor, `nosniff`, `inline` solo para `image/*`, CSP propia de `/api/archivos` con `default-src 'none'` y `sandbox`, `Cross-Origin-Resource-Policy: same-origin` | Revisión de `route.ts` y `proxy.ts` |
| Adivinar el id de una foto o reutilizar un enlace | UUIDv7; enlace firmado por persona, empresa y vencimiento de 5 minutos; la ruta exige sesión y vuelve a comprobar todo | `incident-photos.int.test.ts` («…otra persona con la misma dirección no obtiene nada») |
| Foto de otra empresa | Toda lectura filtra por empresa; un enlace hecho en una empresa no abre en otra | `incident-photos.int.test.ts` («una foto de otra empresa no existe») |
| Foto de un registro fuera del alcance (almacén o zona) | `openFileLink`/`createFileLink` preguntan al dueño del registro (`reachesIncident`) en cada apertura; si la persona deja de alcanzarlo, su enlace deja de servir; sin la función del dueño, la foto no existe para nadie | `incident-photos.int.test.ts` («fuera del alcance de la persona la foto no existe») |
| Foto sin ligar vista por otra persona | Solo existe para quien la subió | `incident-photos.int.test.ts` («una foto sin ligar solo existe para quien la tomó») |
| Ligar la foto de otra persona, de otra empresa o la misma foto dos veces | Se liga solo lo subido por la misma persona, del mismo propósito, sin borrar y sin ligar, bajo el candado del archivo; único por empresa; disparador que exige archivo vivo y del mismo propósito | `incident-photos.int.test.ts` («no liga la foto de otra persona…», «la base no liga…») |
| Borrar o cambiar evidencia | `deleteFile` rechaza una foto ligada; disparadores: el vínculo no cambia ni se borra y el archivo ligado no cambia | `incident-photos.int.test.ts` («una foto ligada no cambia ni se borra») |
| Llenar el disco subiendo sin guardar | 30 fotos sin ligar por persona en 24 h; la ronda borra lo no ligado a las 24 h | `incident-photos.int.test.ts` («quien sube sin guardar no llena el disco», «se borran solas…») |
| Terminal compartida: lo de una persona visible para la siguiente | `Cache-Control: private, no-store`; el service worker no guarda imágenes (solo `/sin-conexion`, solo navegaciones); las miniaturas `blob:` se liberan al quitar y al salir del formulario | Revisión (ADR 0049) |
| Soporte de plataforma | Solo `.read`: ve las fotos de lo que ve; subir es escritura | Política existente (`policy.test.ts`) |
| Llave de la API | No hay ruta de la API para fotos; `/api/archivos` exige la cookie de sesión, que la API nunca lee | Revisión |
| Plan vencido | Subir pide `inventory.incident.create` (escritura): bloqueado; ver sigue | Guard de módulo existente (MOD-11) |

## Riesgos residuales

- El tope de 30 fotos sin ligar se cuenta antes de guardar, sin candado: con
  muchas subidas simultáneas se puede pasar por unas pocas. Es un freno, no
  una cuota exacta.
- El servidor no decodifica los píxeles: un JPEG con datos de imagen
  inválidos pero estructura correcta se guarda y el navegador lo dibuja roto.
  No ejecuta nada.
- Una foto subida sin volver a codificar (sin JavaScript) pierde su
  orientación Exif al limpiarse.
- Las fotos crecen rápido: almacenamiento externo y respaldos independientes
  antes de operar en producción con fotos (WMS-67).
