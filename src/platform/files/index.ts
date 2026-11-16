// Public API of platform/files: private files of a company and their
// temporary download links (IMP-02).
export {
  FILE_LINK_SECONDS,
  FILE_PURPOSES,
  PENDING_PHOTOS_HOURS,
  PENDING_PHOTOS_MAX,
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
// WMS-37 (ADR 0063): photos as evidence of a record.
export {
  attachEvidencePhotos,
  evidencePhotoLinks,
  purgeOrphanPhotos,
} from "./evidence";
export type { AttachPhotosResult, EvidencePhotoLink } from "./evidence";
export { EVIDENCE_OWNER_KINDS } from "./purposes";
export type {
  EvidenceOwner,
  EvidenceOwnerKind,
  EvidenceOwners,
} from "./purposes";
// WMS-67 (ADR 0070): where the bytes live (disk or S3/R2) and what is left.
export { STORAGE_CLEANUP_AFTER_MS, processStorageCleanup } from "./cleanup";
export type { StorageCleanupRound } from "./cleanup";
export { configuredDriver, pingStorage } from "./storage";
export type { StorageProbe } from "./storage";
export { IMAGE_LIMITS, sanitizeImage } from "./images";
export type { SanitizedImage } from "./images";
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
