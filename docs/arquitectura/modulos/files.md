# Plataforma: archivos (`platform/files`)

## Responsabilidad

Archivos privados de una empresa (lo que sube para importar y lo que se genera
para descargar), enlaces temporales de descarga, y escritura y lectura de hojas
de cálculo y PDF sin dependencias externas para el PDF, etiquetas con
Code 128 y QR (WMS-26), y fotos de evidencia ligadas a un registro (WMS-37). Qué dice cada etiqueta lo decide el módulo dueño del
dato (Inventario, `labels.ts`); aquí solo se dibuja.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Archivos | `files.ts`, `storage.ts` | `storeFile` (con un propósito de `FILE_PURPOSES`; toma el cupo `file_storage_kib`), `readStoredFile`, `createFileLink`, `openFileLink`, `deleteFile` (devuelve el cupo) |
| Almacenamiento (WMS-67) | `storage.ts`, `s3-client.ts`, `sigv4.ts`, `cleanup.ts`, `storage-copy.ts` | Controlador `disk` o `s3` por `FILE_STORAGE_DRIVER` (`configuredDriver`); cliente S3 propio (PUT, GET, HEAD, DELETE, ListObjectsV2; firma SigV4 probada con los vectores públicos); `pingStorage` (salud, la llama el worker); `processStorageCleanup` y `organizationsWithStorageCleanup` (ronda); `copyStoredFiles` y `auditStorage` (solo para `scripts/storage-copy.mts`, no van en `index.ts`) |
| Fotos de evidencia | `images.ts`, `evidence.ts`, `purposes.ts` | `sanitizeImage` (comprueba JPEG, PNG o WebP y reconstruye el archivo sin los metadatos conocidos ni cola, con tamaños y cuentas de segmentos acotados; `IMAGE_LIMITS`: 2,048 px), `attachEvidencePhotos` (liga fotos subidas por la misma persona dentro de la transacción del registro), `evidencePhotoLinks` (fotos de un registro con su enlace), `purgeOrphanPhotos` (ronda); `deleteFile` borra bajo el candado del archivo, `EVIDENCE_OWNER_KINDS`, `EvidenceOwners` |
| Escribir hojas | `spreadsheet.ts` | `buildCsv`, `buildXlsx` (neutralizan fórmulas), `neutralizeFormula` |
| Leer hojas | `spreadsheet-reader.ts` | `readSpreadsheet` (con `READ_LIMITS`; nunca evalúa fórmulas) |
| PDF | `pdf.ts` | `PdfPageWriter` (carta u otro tamaño de página; `text`, `line`, `box`, `fillRects`), `buildPdf`, `textWidth`, `wrapText` |
| Códigos de barras | `code128.ts` | `encodeCode128` (conjuntos B y C, control módulo 103; rechaza lo que no es ASCII imprimible o pasa de `CODE128_MAX_LENGTH`), `decodeCode128` (lee de vuelta, para pruebas), `CODE128_QUIET_ZONE` |
| Etiquetas | `labels.ts` | `buildLabelsPdf` (etiquetas con texto, Code 128 y QR de `uqr`), `LABEL_FORMATS` (hoja carta de 10, 100 × 50 mm, 100 × 150 mm), `LABEL_CODES`, `drawCode128`, `drawQr` |

Nunca se escribe en disco desde otro lugar ni se usa el nombre del archivo
como ruta. Una imagen se sirve `inline` (todo lo demás, `attachment`), con
`nosniff`, `no-store` y la política de contenido estricta que `src/proxy.ts`
pone a `/api/archivos` (cabeceras y política en `src/lib/file-response.ts`). La
galería abre la foto completa por `/api/archivos/<id>/ver`, que hace un
enlace nuevo con las mismas comprobaciones. Una foto de evidencia ligada solo se abre si la
persona alcanza su registro: `createFileLink` y `openFileLink` reciben las
funciones del dueño (`evidenceOwners` de `src/modules/registry/evidence.ts`)
y, sin ellas, la foto no existe; una sin ligar solo existe para quien la
subió. Los bytes viven en `FILE_STORAGE_DIR` (controlador `disk`) o en un
bucket compatible con S3, pensado para Cloudflare R2 (`s3`, ADR 0070), bajo
una llave `<empresa>/<archivo>`; antes de leer se comprueba que la llave
empieza con la empresa de quien pide y, al leer, que el `sha256` coincide con
el de la fila. Los bytes salen siempre por la aplicación: no hay enlaces
prefirmados ni bucket público.

**Consistencia (ADR 0070):** antes de subir se anota la llave en
`storage_cleanup`; la fila del archivo nace después de los bytes y, en la
misma transacción, se toma el cupo y se borra la anotación. Borrar marca la
fila, devuelve el cupo y anota la llave en una transacción; los bytes se
quitan después. Lo que queda anotado (una subida que no terminó, unos bytes
que no se pudieron quitar) lo resuelve la ronda `platform.storage_cleanup`.
Nunca hay una fila sin bytes; todo objeto sin fila tiene su anotación.

## Permisos

Cada propósito de `FILE_PURPOSES` dice qué permiso escribe y cuál lee:
`import_source` (`inventory.import.create` / `.read`), `outbound_source`
(`inventory.outbound.create` / `.read`), `export` (`inventory.export.create`)
e `incident_photo` (`inventory.incident.create` / `.read`; 5 MB; 5 fotos a la
vez y 30 por incidencia).
Un módulo que suba o genere archivos agrega aquí su propósito con sus
permisos.

## Tablas

`stored_file` (con `width` y `height` de una imagen), `evidence_photo`
(vínculo inmutable de una foto con su registro: una columna por clase de
registro, hoy `incidentId` e `incidentNoteId`) y `storage_cleanup` (llaves
cuyos bytes pueden haber quedado sin archivo vivo, WMS-67). El cupo de
almacenamiento es el contador `file_storage_kib` de `quota_usage` (KiB por
archivo, hacia arriba), limitado por el derecho `file_storage_gb` del plan
(5 GB sin derecho, hasta 2,000).

## Ajustes y trabajos

Ronda `platform.photo_orphans_cleanup` (registrada en
`src/modules/registry/rounds.ts`, para todas las empresas con
`allOrganizations` de `platform/jobs`): borra las fotos que nunca se ligaron
a las 24 horas. Si una foto es obligatoria lo decide el módulo del registro
(`inventory.incident.photo`). Ronda `platform.storage_cleanup` (WMS-67, solo
empresas con anotaciones): quita los bytes de las anotaciones de más de 15
minutos sin archivo vivo. El worker prueba el almacenamiento cada 5 minutos
(`pingStorage`) y deja el resultado para `/api/salud` (`storage`).

Variables: `FILE_STORAGE_DRIVER`, `FILE_STORAGE_DIR`, `FILE_STORAGE_S3_*`
(extremo, bucket, región `auto`, llaves, prefijo opcional, tiempo por intento)
y `FILE_BACKUP_S3_*` (bucket de respaldo). Script `scripts/storage-copy.mts`
(`storage:copy`): copiar de disco a R2, volver, respaldar y restaurar;
`--audit` lista sobrantes.

## Agregar fotos a otro registro

Pasos del ADR 0063 («Cómo agrega su propósito un paso futuro»): columna en
`evidence_photo` y `CHECK` de un solo dueño, entrada en
`EVIDENCE_OWNER_KINDS`, propósito en `FILE_PURPOSES` con `evidence`, función
del dueño en `src/modules/registry/evidence.ts`, `attachEvidencePhotos` en
la transacción del registro y `PhotoCapture`/`PhotoGallery` en la pantalla.

## ADR

0014 (archivos privados), 0019 (PDF propio), 0047 (etiquetas e impresión),
0063 (fotos de evidencia), 0070 (almacenamiento externo).

## Pruebas

`pdf.test.ts`, `code128.test.ts` (tabla del estándar, ida y vuelta, casos
rechazados) y `labels.test.ts` (los códigos dibujados se leen de vuelta con
`tests/setup/pdf.ts`; sin contenido activo), `images.test.ts` (formatos,
archivos falsos, GPS, polyglots, dimensiones) y
`tests/inventory/incident-photos.int.test.ts` (de punta a punta con las
incidencias). Almacenamiento (WMS-67): `sigv4.test.ts` (vectores públicos de
AWS) y `tests/platform/file-storage.int.test.ts` contra un servidor S3 falso
(`tests/setup/fake-s3.ts`) que verifica cada firma por su cuenta; con
`TEST_FILE_STORAGE=s3`, cualquier prueba de integración corre contra ese
servidor en vez del disco.
