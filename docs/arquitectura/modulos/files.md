# Plataforma: archivos (`platform/files`)

## Responsabilidad

Archivos privados de una empresa (lo que sube para importar y lo que se genera
para descargar), enlaces temporales de descarga, y escritura y lectura de hojas
de cálculo y PDF sin dependencias externas para el PDF.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Archivos | `files.ts`, `storage.ts` | `storeFile` (con un propósito de `FILE_PURPOSES`), `readStoredFile`, `createFileLink`, `openFileLink`, `deleteFile` |
| Escribir hojas | `spreadsheet.ts` | `buildCsv`, `buildXlsx` (neutralizan fórmulas), `neutralizeFormula` |
| Leer hojas | `spreadsheet-reader.ts` | `readSpreadsheet` (con `READ_LIMITS`; nunca evalúa fórmulas) |
| PDF | `pdf.ts` | `PdfPageWriter`, `buildPdf`, `textWidth`, `wrapText` |

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

0014 (archivos privados), 0019 (PDF propio).
