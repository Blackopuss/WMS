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
| Archivos | `files.ts`, `storage.ts` | `storeFile` (con un propósito de `FILE_PURPOSES`), `readStoredFile`, `createFileLink`, `openFileLink`, `deleteFile` |
| Fotos de evidencia | `images.ts`, `evidence.ts`, `purposes.ts` | `sanitizeImage` (comprueba JPEG, PNG o WebP y reconstruye el archivo sin metadatos ni cola; `IMAGE_LIMITS`), `attachEvidencePhotos` (liga fotos subidas por la misma persona dentro de la transacción del registro), `evidencePhotoLinks` (fotos de un registro con su enlace), `purgeOrphanPhotos` (ronda), `EVIDENCE_OWNER_KINDS`, `EvidenceOwners` |
| Escribir hojas | `spreadsheet.ts` | `buildCsv`, `buildXlsx` (neutralizan fórmulas), `neutralizeFormula` |
| Leer hojas | `spreadsheet-reader.ts` | `readSpreadsheet` (con `READ_LIMITS`; nunca evalúa fórmulas) |
| PDF | `pdf.ts` | `PdfPageWriter` (carta u otro tamaño de página; `text`, `line`, `box`, `fillRects`), `buildPdf`, `textWidth`, `wrapText` |
| Códigos de barras | `code128.ts` | `encodeCode128` (conjuntos B y C, control módulo 103; rechaza lo que no es ASCII imprimible o pasa de `CODE128_MAX_LENGTH`), `decodeCode128` (lee de vuelta, para pruebas), `CODE128_QUIET_ZONE` |
| Etiquetas | `labels.ts` | `buildLabelsPdf` (etiquetas con texto, Code 128 y QR de `uqr`), `LABEL_FORMATS` (hoja carta de 10, 100 × 50 mm, 100 × 150 mm), `LABEL_CODES`, `drawCode128`, `drawQr` |

Nunca se escribe en disco desde otro lugar ni se usa el nombre del archivo
como ruta. Una imagen se sirve `inline` (todo lo demás, `attachment`), con
`nosniff`, `no-store` y la política de contenido estricta que `src/proxy.ts`
pone a `/api/archivos`. Una foto de evidencia ligada solo se abre si la
persona alcanza su registro: `createFileLink` y `openFileLink` reciben las
funciones del dueño (`evidenceOwners` de `src/modules/registry/evidence.ts`)
y, sin ellas, la foto no existe; una sin ligar solo existe para quien la
subió. Los bytes viven en `FILE_STORAGE_DIR` bajo una llave que empieza con
la empresa.

## Permisos

Cada propósito de `FILE_PURPOSES` dice qué permiso escribe y cuál lee:
`import_source` (`inventory.import.create` / `.read`), `outbound_source`
(`inventory.outbound.create` / `.read`), `export` (`inventory.export.create`)
e `incident_photo` (`inventory.incident.create` / `.read`; 5 MB; 5 fotos a la
vez y 30 por incidencia).
Un módulo que suba o genere archivos agrega aquí su propósito con sus
permisos.

## Tablas

`stored_file` (con `width` y `height` de una imagen) y `evidence_photo`
(vínculo inmutable de una foto con su registro: una columna por clase de
registro, hoy `incidentId` e `incidentNoteId`).

## Ajustes y trabajos

Ronda `platform.photo_orphans_cleanup` (registrada en
`src/modules/registry/rounds.ts`): borra las fotos que nunca se ligaron a
las 24 horas. Si una foto es obligatoria lo decide el módulo del registro
(`inventory.incident.photo`).

## Agregar fotos a otro registro

Pasos del ADR 0063 («Cómo agrega su propósito un paso futuro»): columna en
`evidence_photo` y `CHECK` de un solo dueño, entrada en
`EVIDENCE_OWNER_KINDS`, propósito en `FILE_PURPOSES` con `evidence`, función
del dueño en `src/modules/registry/evidence.ts`, `attachEvidencePhotos` en
la transacción del registro y `PhotoCapture`/`PhotoGallery` en la pantalla.

## ADR

0014 (archivos privados), 0019 (PDF propio), 0047 (etiquetas e impresión),
0063 (fotos de evidencia).

## Pruebas

`pdf.test.ts`, `code128.test.ts` (tabla del estándar, ida y vuelta, casos
rechazados) y `labels.test.ts` (los códigos dibujados se leen de vuelta con
`tests/setup/pdf.ts`; sin contenido activo), `images.test.ts` (formatos,
archivos falsos, GPS, polyglots, dimensiones) y
`tests/inventory/incident-photos.int.test.ts` (de punta a punta con las
incidencias).
