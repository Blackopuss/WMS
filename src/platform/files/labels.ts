import { encode as encodeQr } from "uqr";

import { CODE128_QUIET_ZONE, encodeCode128 } from "./code128";
import {
  PdfPageWriter,
  buildPdf,
  textWidth,
  wrapText,
  type PdfFont,
  type PdfRect,
} from "./pdf";

/**
 * Labels as a PDF (WMS-26, ADR 0047): each label has what a person reads
 * and one code, drawn as a Code 128 barcode, a QR code or both, with the
 * code always written under them so it can be typed if the scanner fails.
 * The module that owns the data decides what a label says; this file only
 * draws it on common sizes.
 */

/** Points in a millimeter. */
const MM = 72 / 25.4;
const INCH = 72;

export type LabelFormatSpec = {
  /** What the person chooses, in Spanish. */
  label: string;
  page: { width: number; height: number };
  /** Size of one label and where the first one starts on the page. */
  cell: { width: number; height: number };
  columns: number;
  rows: number;
  origin: { x: number; y: number };
  /** Space between columns and rows. */
  gap: { x: number; y: number };
};

/**
 * Common sizes, no brand: a letter sheet of ten 4 × 2 in labels (two
 * columns, five rows, the usual sheet for an office printer) and single
 * labels of 100 × 50 mm and 100 × 150 mm for a label printer.
 */
export const LABEL_FORMATS = {
  letter_10: {
    label: "Hoja carta, 10 por hoja",
    page: { width: 8.5 * INCH, height: 11 * INCH },
    cell: { width: 4 * INCH, height: 2 * INCH },
    columns: 2,
    rows: 5,
    origin: { x: 0.15625 * INCH, y: 0.5 * INCH },
    gap: { x: 0.1875 * INCH, y: 0 },
  },
  "100x50": {
    label: "Etiqueta de 100 × 50 mm",
    page: { width: 100 * MM, height: 50 * MM },
    cell: { width: 100 * MM, height: 50 * MM },
    columns: 1,
    rows: 1,
    origin: { x: 0, y: 0 },
    gap: { x: 0, y: 0 },
  },
  "100x150": {
    label: "Etiqueta de 100 × 150 mm",
    page: { width: 100 * MM, height: 150 * MM },
    cell: { width: 100 * MM, height: 150 * MM },
    columns: 1,
    rows: 1,
    origin: { x: 0, y: 0 },
    gap: { x: 0, y: 0 },
  },
} as const satisfies Record<string, LabelFormatSpec>;

export type LabelFormat = keyof typeof LABEL_FORMATS;

export const LABEL_FORMAT_IDS = Object.keys(LABEL_FORMATS) as LabelFormat[];

export const isLabelFormat = (value: unknown): value is LabelFormat =>
  typeof value === "string" && Object.hasOwn(LABEL_FORMATS, value);

/** Which symbols a label carries. */
export const LABEL_CODES = {
  both: "Código de barras y QR",
  barcode: "Solo código de barras",
  qr: "Solo QR",
} as const;

export type LabelCodes = keyof typeof LABEL_CODES;

export const LABEL_CODE_IDS = Object.keys(LABEL_CODES) as LabelCodes[];

export const isLabelCodes = (value: unknown): value is LabelCodes =>
  typeof value === "string" && Object.hasOwn(LABEL_CODES, value);

export type LabelContent = {
  /** What the codes hold: exactly what a screen accepts when scanned. */
  code: string;
  /** The big line: a name, an order, a product. */
  title: string;
  /** Smaller lines under it; the ones that do not fit are left out. */
  lines?: readonly string[];
};

/** Thinnest and widest module of the barcode, in points. */
const MIN_MODULE = 0.7;
const MAX_MODULE = 2.5;
/** Light modules around a QR code, as the standard asks. */
const QR_QUIET = 4;

/** One line of text that fits a width, cut with «…» when it does not. */
function fitLine(
  value: string,
  width: number,
  size: number,
  font: PdfFont,
): string {
  const text = value.trim();
  if (textWidth(text, size, font) <= width) return text;
  let cut = text.length - 1;
  while (cut > 0 && textWidth(`${text.slice(0, cut)}…`, size, font) > width) {
    cut--;
  }
  return cut > 0 ? `${text.slice(0, cut).trimEnd()}…` : "";
}

/** The module width a barcode can use in a width, or null if it does not fit. */
function barcodeModule(code: string, width: number): number | null {
  const encoded = encodeCode128(code);
  if (!encoded.ok) return null;
  const total = encoded.modules.length + 2 * CODE128_QUIET_ZONE;
  const unit = Math.min(MAX_MODULE, Math.floor((width / total) * 100) / 100);
  return unit >= MIN_MODULE ? unit : null;
}

/**
 * Draws a Code 128 barcode centered in a width: one filled box per bar,
 * all in one operation. Returns false (and draws nothing) when the text
 * cannot be a Code 128 or does not fit.
 */
export function drawCode128(
  page: PdfPageWriter,
  box: PdfRect,
  code: string,
): boolean {
  const encoded = encodeCode128(code);
  const unit = barcodeModule(code, box.width);
  if (!encoded.ok || unit === null) return false;
  const total = (encoded.modules.length + 2 * CODE128_QUIET_ZONE) * unit;
  const left = box.x + (box.width - total) / 2 + CODE128_QUIET_ZONE * unit;
  const bars: PdfRect[] = [];
  let index = 0;
  while (index < encoded.modules.length) {
    if (!encoded.modules[index]) {
      index++;
      continue;
    }
    let end = index;
    while (end < encoded.modules.length && encoded.modules[end]) end++;
    bars.push({
      x: left + index * unit,
      y: box.y,
      width: (end - index) * unit,
      height: box.height,
    });
    index = end;
  }
  page.fillRects(bars);
  return true;
}

/**
 * Draws a QR code (error correction M) in a square of `side` points, its
 * quiet zone included: one box per run of dark modules in a row.
 */
export function drawQr(
  page: PdfPageWriter,
  x: number,
  y: number,
  side: number,
  code: string,
) {
  const qr = encodeQr(code, { ecc: "M", border: 0 });
  const unit = side / (qr.size + 2 * QR_QUIET);
  const left = x + QR_QUIET * unit;
  const top = y + QR_QUIET * unit;
  const boxes: PdfRect[] = [];
  qr.data.forEach((row, rowIndex) => {
    let column = 0;
    while (column < qr.size) {
      if (!row[column]) {
        column++;
        continue;
      }
      let end = column;
      while (end < qr.size && row[end]) end++;
      boxes.push({
        x: left + column * unit,
        y: top + rowIndex * unit,
        width: (end - column) * unit,
        height: unit,
      });
      column = end;
    }
  });
  page.fillRects(boxes);
}

/** One label in its box of the page. */
function drawLabel(
  page: PdfPageWriter,
  cell: { x: number; y: number; width: number; height: number },
  label: LabelContent,
  codes: LabelCodes,
) {
  const tall = cell.height >= 300;
  const pad = tall ? 14 : 8;
  const inner = {
    x: cell.x + pad,
    y: cell.y + pad,
    width: cell.width - 2 * pad,
    height: cell.height - 2 * pad,
  };
  const titleSize = tall ? 18 : 11;
  const lineSize = tall ? 11 : 8;
  const codeSize = tall ? 14 : 10;
  const barHeight = tall ? 70 : codes === "barcode" ? 48 : 34;
  // A code the barcode cannot hold (accents, too long) goes as QR only.
  const withBar =
    codes !== "qr" && barcodeModule(label.code, inner.width) !== null;
  const withQr = codes !== "barcode" || !withBar;
  const bottom = inner.y + inner.height;

  // Bottom: the bars across the whole width and the code under them.
  let topHeight = inner.height;
  if (withBar) {
    const codeLine = bottom - 2;
    page.text(
      inner.x + inner.width / 2,
      codeLine,
      fitLine(label.code, inner.width, codeSize, "bold"),
      { size: codeSize, font: "bold", align: "center" },
    );
    const barTop = codeLine - codeSize - barHeight + 1;
    drawCode128(
      page,
      { x: inner.x, y: barTop, width: inner.width, height: barHeight },
      label.code,
    );
    topHeight = barTop - inner.y - 6;
  }

  // Top: the texts, and the QR beside them (below them on a tall label).
  const qrSide = withQr
    ? tall
      ? Math.min(inner.width * 0.75, 190)
      : Math.min(topHeight, inner.width * 0.42)
    : 0;
  const textWidthLeft =
    withQr && !tall ? inner.width - qrSide - 8 : inner.width;
  let y = inner.y + titleSize * 0.8;
  const textBottom =
    withQr && tall ? inner.y + topHeight - qrSide - 8 : inner.y + topHeight;
  // The title in up to two lines (three on a tall label), the last one cut.
  const wrapped = wrapText(
    label.title,
    textWidthLeft,
    titleSize,
    "bold",
  ).filter(Boolean);
  const most = tall ? 3 : 2;
  const titleLines =
    wrapped.length > most
      ? [
          ...wrapped.slice(0, most - 1),
          fitLine(
            wrapped.slice(most - 1).join(" "),
            textWidthLeft,
            titleSize,
            "bold",
          ),
        ]
      : wrapped;
  for (const part of titleLines) {
    page.text(inner.x, y, part, { size: titleSize, font: "bold" });
    y += titleSize * 1.2;
  }
  const lines = [...(label.lines ?? [])];
  // Without bars the code is written here, so it can always be typed.
  if (!withBar) {
    page.text(
      inner.x,
      y + 2,
      fitLine(label.code, textWidthLeft, codeSize, "bold"),
      {
        size: codeSize,
        font: "bold",
      },
    );
    y += codeSize * 1.3 + 2;
  }
  y += 2;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (y > textBottom) break;
    page.text(inner.x, y, fitLine(line, textWidthLeft, lineSize, "regular"), {
      size: lineSize,
    });
    y += lineSize * 1.3;
  }

  if (withQr) {
    if (tall) {
      const space = inner.y + topHeight - y;
      const side = Math.max(0, Math.min(qrSide, space));
      drawQr(
        page,
        inner.x + (inner.width - side) / 2,
        y + (space - side) / 2,
        side,
        label.code,
      );
    } else {
      drawQr(page, inner.x + inner.width - qrSide, inner.y, qrSide, label.code);
    }
  }
}

/**
 * Puts labels on the pages of a format, in reading order. At least one
 * label; the caller bounds how many.
 */
export function buildLabelsPdf(
  labels: readonly LabelContent[],
  options: {
    format: LabelFormat;
    codes: LabelCodes;
    title: string;
    createdAt?: Date;
  },
): Buffer {
  if (labels.length === 0) throw new Error("A label sheet needs a label");
  const format: LabelFormatSpec = LABEL_FORMATS[options.format];
  const perPage = format.columns * format.rows;
  const pages: PdfPageWriter[] = [];
  labels.forEach((label, index) => {
    const slot = index % perPage;
    if (slot === 0) pages.push(new PdfPageWriter(format.page));
    const column = slot % format.columns;
    const row = Math.floor(slot / format.columns);
    drawLabel(
      pages.at(-1)!,
      {
        x: format.origin.x + column * (format.cell.width + format.gap.x),
        y: format.origin.y + row * (format.cell.height + format.gap.y),
        width: format.cell.width,
        height: format.cell.height,
      },
      label,
      options.codes,
    );
  });
  return buildPdf(pages, {
    title: options.title,
    createdAt: options.createdAt,
  });
}
