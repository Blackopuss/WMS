// Public API of platform/files: private files of a company and their
// temporary download links (IMP-02).
export {
  FILE_LINK_SECONDS,
  FILE_PURPOSES,
  createFileLink,
  deleteFile,
  openFileLink,
  readStoredFile,
  storeFile,
} from "./files";
export type {
  FileActor,
  FileLinkResult,
  FilePurpose,
  OpenFileLinkResult,
  StoreFileResult,
  StoredFileContent,
} from "./files";
export { buildCsv, buildXlsx, neutralizeFormula } from "./spreadsheet";
export type { Cell, Sheet } from "./spreadsheet";
export { READ_LIMITS, readSpreadsheet } from "./spreadsheet-reader";
export type {
  ReadSpreadsheetResult,
  SpreadsheetContent,
} from "./spreadsheet-reader";
export {
  PDF_PAGE,
  PdfPageWriter,
  buildPdf,
  pdfText,
  textWidth,
  wrapText,
} from "./pdf";
export type { PdfFont, PdfRect, PdfTextOptions } from "./pdf";
export {
  CODE128_MAX_LENGTH,
  CODE128_QUIET_ZONE,
  decodeCode128,
  encodeCode128,
} from "./code128";
export type { Code128, Code128Result } from "./code128";
export {
  LABEL_CODES,
  LABEL_CODE_IDS,
  LABEL_FORMATS,
  LABEL_FORMAT_IDS,
  buildLabelsPdf,
  drawCode128,
  drawQr,
  isLabelCodes,
  isLabelFormat,
} from "./labels";
export type {
  LabelCodes,
  LabelContent,
  LabelFormat,
  LabelFormatSpec,
} from "./labels";
