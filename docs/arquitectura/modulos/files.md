# Plataforma: archivos (`platform/files`)

## Responsabilidad

Archivos privados de una empresa (lo que sube para importar y lo que se genera
para descargar), enlaces temporales de descarga, y escritura y lectura de hojas
de cálculo y PDF sin dependencias externas para el PDF, y etiquetas con
Code 128 y QR (WMS-26). Qué dice cada etiqueta lo decide el módulo dueño del
dato (Inventario, `labels.ts`); aquí solo se dibuja.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Archivos | `files.ts`, `storage.ts` | `storeFile` (con un propósito de `FILE_PURPOSES`), `readStoredFile`, `createFileLink`, `openFileLink`, `deleteFile` |
| Escribir hojas | `spreadsheet.ts` | `buildCsv`, `buildXlsx` (neutralizan fórmulas), `neutralizeFormula` |
| Leer hojas | `spreadsheet-reader.ts` | `readSpreadsheet` (con `READ_LIMITS`; nunca evalúa fórmulas) |
| PDF | `pdf.ts` | `PdfPageWriter` (carta u otro tamaño de página; `text`, `line`, `box`, `fillRects`), `buildPdf`, `textWidth`, `wrapText` |
| Códigos de barras | `code128.ts` | `encodeCode128` (conjuntos B y C, control módulo 103; rechaza lo que no es ASCII imprimible o pasa de `CODE128_MAX_LENGTH`), `decodeCode128` (lee de vuelta, para pruebas), `CODE128_QUIET_ZONE` |
| Etiquetas | `labels.ts` | `buildLabelsPdf` (etiquetas con texto, Code 128 y QR de `uqr`), `LABEL_FORMATS` (hoja carta de 10, 100 × 50 mm, 100 × 150 mm), `LABEL_CODES`, `drawCode128`, `drawQr` |

Nunca se escribe en disco desde otro lugar ni se usa el nombre del archivo
como ruta. Los bytes viven en `FILE_STORAGE_DIR` bajo una llave que empieza con
la empresa.

## Permisos

Cada propósito de `FILE_PURPOSES` dice qué permiso escribe y cuál lee:
`import_source` (`inventory.import.create` / `.read`), `outbound_source`
(`inventory.outbound.create` / `.read`), `export` (`inventory.export.create`).
Un módulo que suba o genere archivos agrega aquí su propósito con sus
permisos.

## Tablas

`stored_file`.

## Ajustes y trabajos

Ninguno.

## ADR

0014 (archivos privados), 0019 (PDF propio), 0047 (etiquetas e impresión).

## Pruebas

`pdf.test.ts`, `code128.test.ts` (tabla del estándar, ida y vuelta, casos
rechazados) y `labels.test.ts` (los códigos dibujados se leen de vuelta con
`tests/setup/pdf.ts`; sin contenido activo).
