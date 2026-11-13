import { decodeCode128 } from "../../src/platform/files/code128";

/**
 * Readers of the PDF files the system writes (WMS-26), for tests: the
 * texts, the barcodes and the QR codes as they were drawn on each page.
 */

const decoder = new TextDecoder("windows-1252");

/** The content stream of each page, in order. */
export function streamsOf(file: Buffer): string[] {
  const raw = file.toString("latin1");
  return [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(
    (stream) => stream[1]!,
  );
}

/** The texts drawn on each page, one per line, as a person reads them. */
export function textsOf(file: Buffer): string[] {
  return streamsOf(file).map((stream) =>
    [...stream.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((text) =>
        decoder.decode(Buffer.from(text[1]!.replace(/\\(.)/g, "$1"), "latin1")),
      )
      .join("\n"),
  );
}

/** Every object of the file is where its cross-reference table says. */
export function objectsAreWhereTheTableSays(file: Buffer): boolean {
  const text = file.toString("latin1");
  if (!text.startsWith("%PDF-1.4\n") || !text.endsWith("%%EOF\n")) return false;
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  const table = text.slice(start).split("\n");
  if (table[0] !== "xref") return false;
  const size = Number(table[1]!.split(" ")[1]);
  for (let id = 1; id < size; id++) {
    const offset = Number(table[2 + id]!.slice(0, 10));
    if (!text.slice(offset).startsWith(`${id} 0 obj\n`)) return false;
  }
  return true;
}

/** Names that would make a PDF do something when opened or clicked. */
export const ACTIVE_CONTENT =
  /\/(JavaScript|JS|OpenAction|AA|Launch|URI|Annots|AcroForm|EmbeddedFile|SubmitForm|ImportData|RichMedia|GoToR)\b/;

/** The names a PDF holds outside its text strings. */
export function namesOutsideText(file: Buffer): string {
  return file.toString("latin1").replace(/\((?:\\.|[^\\)])*\)/g, "()");
}

type Rect = { x: number; y: number; w: number; h: number };

/** The groups of boxes drawn with `fillRects`, in drawing order. */
function rectGroups(stream: string): Rect[][] {
  return [
    ...stream.matchAll(
      /[\d.]+ g\n((?:[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ re\n)+)f/g,
    ),
  ].map((group) =>
    group[1]!
      .trim()
      .split("\n")
      .map((line) => {
        const [x, y, w, h] = line.split(" ").map(Number);
        return { x: x!, y: y!, w: w!, h: h! };
      }),
  );
}

const isBarcode = (rects: Rect[]) =>
  rects.every((rect) => rect.y === rects[0]!.y && rect.h === rects[0]!.h) &&
  rects[0]!.h > rects[0]!.w * 3;

/** Reads a barcode back from its bars: null when it is not a valid one. */
function readBars(rects: Rect[]): string | null {
  const bars = [...rects].sort((a, b) => a.x - b.x);
  // The stop pattern has a bar of one module: the thinnest bar is one.
  const cell = Math.min(...bars.map((bar) => bar.w));
  const modules: boolean[] = [];
  let end = bars[0]!.x;
  for (const bar of bars) {
    const gap = Math.round((bar.x - end) / cell);
    for (let i = 0; i < gap; i++) modules.push(false);
    const width = Math.round(bar.w / cell);
    for (let i = 0; i < width; i++) modules.push(true);
    end = bar.x + bar.w;
  }
  return decodeCode128(modules);
}

/** A QR code back as its matrix of modules, top row first. */
function readQr(rects: Rect[]): boolean[][] {
  const cell = rects[0]!.h;
  const left = Math.min(...rects.map((rect) => rect.x));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y));
  const size = Math.round((right - left) / cell);
  const matrix = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );
  for (const rect of rects) {
    // PDF counts y upwards: the top row has the largest y.
    const row = Math.round((top - rect.y) / cell);
    const from = Math.round((rect.x - left) / cell);
    const to = Math.round((rect.x + rect.w - left) / cell);
    for (let column = from; column < to; column++) matrix[row]![column] = true;
  }
  return matrix;
}

/** What each page has drawn as codes: barcodes read back, QR matrices. */
export function codesOf(
  file: Buffer,
): { barcodes: (string | null)[]; qrs: boolean[][][] }[] {
  return streamsOf(file).map((stream) => {
    const barcodes: (string | null)[] = [];
    const qrs: boolean[][][] = [];
    for (const group of rectGroups(stream)) {
      if (isBarcode(group)) barcodes.push(readBars(group));
      else qrs.push(readQr(group));
    }
    return { barcodes, qrs };
  });
}

/** The MediaBox of each page: [width, height] in points. */
export function pageSizesOf(file: Buffer): [number, number][] {
  return [
    ...file
      .toString("latin1")
      .matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g),
  ].map((box) => [Number(box[1]), Number(box[2])]);
}
