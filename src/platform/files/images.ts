import { crc32 } from "node:zlib";

/**
 * Images a person uploads as evidence (WMS-37, ADR 0063). The server never
 * trusts what the browser says nor that the browser removed the metadata:
 * it walks the structure of the file with offsets and lengths (no regular
 * expressions over the content) and builds a NEW file that keeps only the
 * parts that draw the picture: in a JPEG its frame, tables, scans and the
 * Adobe marker; in a PNG its header, palette, data and the colour and
 * density chunks; in a WebP its canvas, image and alpha. Every known
 * metadata block — Exif with the GPS position, XMP, IPTC, MPF, ICC
 * profiles, comments, thumbnails, texts — and whatever comes after the end
 * is not kept. Each kept part has the size its format allows and the count
 * of parts is bounded, so a hostile file costs as little as a photo. A file
 * that is not a well formed JPEG, PNG or WebP is refused.
 *
 * Pixels are never decoded: the size of the picture is read from its
 * header and bounded, so a browser that draws it is not overwhelmed.
 */

export type ImageFormat = "jpeg" | "png" | "webp";

export const IMAGE_CONTENT_TYPES: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Extensions accepted for images and the format each one must hold. */
export const IMAGE_EXTENSIONS = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  webp: "webp",
} as const satisfies Record<string, ImageFormat>;

export type ImageExtension = keyof typeof IMAGE_EXTENSIONS;

export const isImageExtension = (value: string): value is ImageExtension =>
  Object.hasOwn(IMAGE_EXTENSIONS, value);

/**
 * Size of a photo of evidence. The browser uploads at most 1,600 px on the
 * longest side; these bounds leave room for that and keep what a viewer's
 * browser decodes small (2048 × 2048 × 4 bytes ≈ 16 MB at most), even for
 * a file sent by hand to the Server Action (review of WMS-37, M2).
 */
export const IMAGE_LIMITS = {
  /** Longest side, in pixels. */
  maxSide: 2048,
  /** Width × height. */
  maxPixels: 2048 * 2048,
} as const;

export type SanitizedImage =
  | {
      ok: true;
      format: ImageFormat;
      contentType: string;
      width: number;
      height: number;
      bytes: Uint8Array;
    }
  | { ok: false; reason: "type" | "broken" | "dimensions"; error: string };

const NOT_AN_IMAGE =
  "Ese archivo no es una foto. Toma la foto otra vez con la cámara.";
const NOT_A_PHOTO_KIND =
  "Ese tipo de imagen no se acepta. Toma la foto con la cámara del teléfono.";
const BROKEN = "La foto está incompleta o dañada. Tómala otra vez.";

class Broken extends Error {}
/** Well formed, but a kind that is not accepted (animation, arithmetic). */
class BrokenType extends Broken {}

/** What the first bytes say, without trusting the name. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return bytes[2] === 0xff ? "jpeg" : null;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Checks that the bytes are an image of the expected format (the one of
 * the extension; any of the three when not given) and returns a clean copy
 * of it.
 */
export function sanitizeImage(
  bytes: Uint8Array,
  expected?: ImageFormat,
): SanitizedImage {
  const format = detectImageFormat(bytes);
  if (!format || (expected && format !== expected)) {
    return { ok: false, reason: "type", error: NOT_AN_IMAGE };
  }
  let built: { width: number; height: number; bytes: Uint8Array };
  try {
    built =
      format === "jpeg"
        ? cleanJpeg(bytes)
        : format === "png"
          ? cleanPng(bytes)
          : cleanWebp(bytes);
  } catch (error) {
    if (error instanceof BrokenType) {
      return { ok: false, reason: "type", error: NOT_A_PHOTO_KIND };
    }
    if (error instanceof Broken) {
      return { ok: false, reason: "broken", error: BROKEN };
    }
    throw error;
  }
  const { width, height } = built;
  if (
    width < 1 ||
    height < 1 ||
    width > IMAGE_LIMITS.maxSide ||
    height > IMAGE_LIMITS.maxSide ||
    width * height > IMAGE_LIMITS.maxPixels
  ) {
    return {
      ok: false,
      reason: "dimensions",
      error: `La foto mide ${width} × ${height} píxeles; el máximo es ${IMAGE_LIMITS.maxSide} por lado.`,
    };
  }
  return {
    ok: true,
    format,
    contentType: IMAGE_CONTENT_TYPES[format],
    width,
    height,
    bytes: built.bytes,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i]!);
  }
  return text;
}

function need(bytes: Uint8Array, end: number) {
  if (end > bytes.length) throw new Broken();
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;

function startsWith(
  bytes: Uint8Array,
  at: number,
  end: number,
  text: string,
): boolean {
  if (at + text.length > end) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ── JPEG ─────────────────────────────────────────────────────────────────

/**
 * Bounds of the walk: a 5 MB file made of thousands of tiny segments must
 * cost as little as a photo (review of WMS-37, M1). A browser's JPEG has a
 * handful of tables and up to ~10 scans.
 */
const JPEG_LIMITS = { segments: 1024, tables: 32, scans: 64 } as const;

/** Baseline, extended and progressive: what every browser draws. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

function cleanJpeg(bytes: Uint8Array) {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let at = 2;
  let size: { width: number; height: number } | null = null;
  let scans = 0;
  let tables = 0;
  let segments = 0;
  let adobe = false;
  for (;;) {
    if (++segments > JPEG_LIMITS.segments) throw new Broken();
    need(bytes, at + 2);
    if (bytes[at] !== 0xff) throw new Broken();
    // Fill bytes before a marker are allowed.
    while (at + 1 < bytes.length && bytes[at + 1] === 0xff) at++;
    need(bytes, at + 2);
    const marker = bytes[at + 1]!;
    if (marker === 0xd9) {
      // End of image: what follows (a second picture, a ZIP…) is not kept.
      if (!size || scans === 0) throw new Broken();
      parts.push(Uint8Array.of(0xff, 0xd9));
      return { ...size, bytes: concat(parts) };
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    ) {
      throw new Broken();
    }
    need(bytes, at + 4);
    const length = u16be(bytes, at + 2);
    if (length < 2) throw new Broken();
    const end = at + 2 + length;
    need(bytes, end);
    const segment = bytes.subarray(at, end);
    const data = at + 4;

    if (JPEG_FRAMES.has(marker)) {
      if (size || length < 8) throw new Broken();
      const components = bytes[data + 5]!;
      if (components < 1 || components > 4 || length !== 8 + 3 * components) {
        throw new Broken();
      }
      const height = u16be(bytes, data + 1);
      const width = u16be(bytes, data + 3);
      if (height === 0 || width === 0) throw new Broken();
      size = { width, height };
      parts.push(segment);
    } else if (
      marker >= 0xc3 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // Lossless, hierarchical or arithmetic frames: not accepted.
      throw new BrokenType();
    } else if (marker === 0xdb || marker === 0xc4 || marker === 0xdd) {
      // Quantization (one 8-bit table at least: 1 + 64), Huffman (class
      // and id, 16 counts and one code at least) and restart interval
      // (exactly 2 bytes).
      const fits =
        marker === 0xdb
          ? length >= 2 + 65
          : marker === 0xc4
            ? length >= 2 + 18
            : length === 4;
      if (!fits || ++tables > JPEG_LIMITS.tables) throw new Broken();
      parts.push(segment);
    } else if (marker === 0xee) {
      // Adobe's marker changes how colours are decoded: kept once, with
      // its fixed size and nothing else in it.
      if (!adobe && length === 14 && startsWith(bytes, data, end, "Adobe")) {
        adobe = true;
        parts.push(segment);
      }
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      // Exif (GPS), XMP, IPTC, MPF (second pictures), ICC profiles, JFIF
      // thumbnails, comments: dropped.
    } else if (marker === 0xda) {
      if (!size) throw new Broken();
      const components = bytes[data]!;
      if (components < 1 || components > 4 || length !== 6 + 2 * components) {
        throw new Broken();
      }
      if (++scans > JPEG_LIMITS.scans) throw new Broken();
      parts.push(segment);
      // Entropy-coded data up to the next marker that is not a stuffed
      // byte (FF 00) or a restart (FF D0..D7).
      let scan = end;
      for (;;) {
        need(bytes, scan + 2);
        if (bytes[scan] === 0xff) {
          const next = bytes[scan + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            scan += 2;
            continue;
          }
          break;
        }
        scan++;
      }
      parts.push(bytes.subarray(end, scan));
      at = scan;
      continue;
    } else {
      throw new Broken();
    }
    at = end;
  }
}

// ── PNG ──────────────────────────────────────────────────────────────────

/**
 * Chunks kept, with the sizes the format allows; all but IDAT once. Any
 * other ancillary chunk (texts, eXIf, tIME, ICC profiles, animation…) is
 * dropped.
 */
const PNG_KEEP: Record<string, { min: number; max: number; once: boolean }> = {
  IHDR: { min: 13, max: 13, once: true },
  PLTE: { min: 3, max: 768, once: true },
  IDAT: { min: 1, max: 0x7fffffff, once: false },
  IEND: { min: 0, max: 0, once: true },
  tRNS: { min: 1, max: 256, once: true },
  gAMA: { min: 4, max: 4, once: true },
  cHRM: { min: 32, max: 32, once: true },
  sRGB: { min: 1, max: 1, once: true },
  sBIT: { min: 1, max: 4, once: true },
  bKGD: { min: 1, max: 6, once: true },
  pHYs: { min: 9, max: 9, once: true },
};

/** Chunks walked in all (a browser writes a few; libpng one per 8 KB). */
const PNG_MAX_CHUNKS = 4096;

function cleanPng(bytes: Uint8Array) {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const seen = new Set<string>();
  let at = 8;
  let size: { width: number; height: number } | null = null;
  let hasData = false;
  for (let count = 0; ; count++) {
    if (count >= PNG_MAX_CHUNKS) throw new Broken();
    need(bytes, at + 12);
    const length = u32be(bytes, at);
    if (length > 0x7fffffff) throw new Broken();
    const type = ascii(bytes, at + 4, 4);
    for (let i = 0; i < 4; i++) {
      const code = type.charCodeAt(i);
      const letter =
        (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
      if (!letter) throw new Broken();
    }
    const end = at + 12 + length;
    need(bytes, end);
    const expected = u32be(bytes, end - 4);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== expected) {
      throw new Broken();
    }
    if (!size && type !== "IHDR") throw new Broken();
    const rule = Object.hasOwn(PNG_KEEP, type) ? PNG_KEEP[type]! : null;
    if (rule) {
      if (length < rule.min || length > rule.max) throw new Broken();
      if (rule.once && seen.has(type)) throw new Broken();
      if (type === "PLTE" && length % 3 !== 0) throw new Broken();
      seen.add(type);
      if (type === "IHDR") {
        size = { width: u32be(bytes, at + 8), height: u32be(bytes, at + 12) };
      }
      if (type === "IDAT") hasData = true;
      parts.push(bytes.subarray(at, end));
    } else if (type.charCodeAt(0) < 0x61) {
      // An unknown critical chunk: the picture cannot be drawn without it.
      throw new Broken();
    }
    if (type === "IEND") {
      if (!hasData) throw new Broken();
      // What follows the end is not kept.
      return { ...size!, bytes: concat(parts) };
    }
    at = end;
  }
}

// ── WebP ─────────────────────────────────────────────────────────────────

/** Chunks walked in all: a still WebP has three at most. */
const WEBP_MAX_CHUNKS = 64;

function cleanWebp(bytes: Uint8Array) {
  const riffEnd = 8 + u32le(bytes, 4);
  need(bytes, riffEnd);
  if (riffEnd < 20) throw new Broken();
  const chunks: Uint8Array[] = [];
  let at = 12;
  let canvas: { width: number; height: number } | null = null;
  let extended: Uint8Array | null = null;
  let size: { width: number; height: number } | null = null;
  let alpha = false;
  let first = true;
  for (let count = 0; at < riffEnd; count++) {
    if (count >= WEBP_MAX_CHUNKS) throw new Broken();
    need(bytes, at + 8);
    const type = ascii(bytes, at, 4);
    const length = u32le(bytes, at + 4);
    const data = at + 8;
    const end = data + length;
    if (end > riffEnd) throw new Broken();
    const padded = end + (length % 2);
    if (padded > riffEnd) throw new Broken();
    if (first && type !== "VP8 " && type !== "VP8L" && type !== "VP8X") {
      throw new Broken();
    }
    first = false;
    if (type === "VP8X") {
      // Exactly its 10 bytes: flags, reserved and the canvas.
      if (extended || length !== 10) throw new Broken();
      if (bytes[data]! & 0x02) throw new BrokenType(); // animation
      extended = bytes.slice(at, padded);
      // No ICC (0x20), Exif (0x08) nor XMP (0x04) in the clean file.
      extended[8] = extended[8]! & ~0x2c;
      canvas = {
        width: 1 + u24le(bytes, data + 4),
        height: 1 + u24le(bytes, data + 7),
      };
    } else if (type === "VP8 ") {
      if (size || length < 10) throw new Broken();
      if (
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      ) {
        throw new Broken();
      }
      size = {
        width: u16le(bytes, data + 6) & 0x3fff,
        height: u16le(bytes, data + 8) & 0x3fff,
      };
      chunks.push(bytes.subarray(at, padded));
    } else if (type === "VP8L") {
      if (size || length < 5 || bytes[data] !== 0x2f) throw new Broken();
      const bits = u32le(bytes, data + 1);
      size = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
      chunks.push(bytes.subarray(at, padded));
    } else if (type === "ALPH") {
      if (!extended || alpha || size || length < 1) throw new Broken();
      alpha = true;
      chunks.push(bytes.subarray(at, padded));
    } else if (type === "ANIM" || type === "ANMF") {
      throw new BrokenType();
    }
    // ICCP, EXIF, XMP and anything unknown: dropped.
    at = padded;
  }
  if (!size) throw new Broken();
  if (
    canvas &&
    (canvas.width !== size.width || canvas.height !== size.height)
  ) {
    throw new Broken();
  }
  const body = concat([...(extended ? [extended] : []), ...chunks]);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  const riffSize = body.length + 4;
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >>> 8) & 0xff;
  header[6] = (riffSize >>> 16) & 0xff;
  header[7] = (riffSize >>> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return { ...size, bytes: concat([header, body]) };
}
