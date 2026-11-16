import { crc32 } from "node:zlib";

/**
 * Images a person uploads as evidence (WMS-37, ADR 0063). The server never
 * trusts what the browser says nor that the browser removed the metadata:
 * it walks the structure of the file with offsets and lengths (no regular
 * expressions over the content) and builds a NEW file with only what is
 * needed to draw the picture. Everything else — Exif with the GPS
 * position, XMP, comments, thumbnails, text chunks, whatever comes after
 * the end — is not kept. A file that is not a well formed JPEG, PNG or
 * WebP is refused.
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

export const IMAGE_LIMITS = {
  /** Longest side, in pixels. */
  maxSide: 8000,
  /** Width × height. */
  maxPixels: 40_000_000,
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

/** Baseline, extended and progressive: what every browser draws. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]);
/** Tables needed to decode. */
const JPEG_TABLES = new Set([0xc4, 0xdb, 0xdd]);

function cleanJpeg(bytes: Uint8Array) {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let at = 2;
  let size: { width: number; height: number } | null = null;
  let scans = 0;
  for (;;) {
    need(bytes, at + 2);
    if (bytes[at] !== 0xff) throw new Broken();
    // Fill bytes before a marker are allowed.
    while (at + 1 < bytes.length && bytes[at + 1] === 0xff) at++;
    need(bytes, at + 2);
    const marker = bytes[at + 1]!;
    if (marker === 0xd9) {
      // End of image: what follows is not kept (polyglots lose it).
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
    } else if (JPEG_TABLES.has(marker)) {
      parts.push(segment);
    } else if (marker === 0xe2) {
      if (startsWith(bytes, data, end, "ICC_PROFILE\u0000"))
        parts.push(segment);
    } else if (marker === 0xee) {
      if (startsWith(bytes, data, end, "Adobe")) parts.push(segment);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      // Exif (GPS), XMP, IPTC, JFIF thumbnails, comments: dropped.
    } else if (marker === 0xda) {
      if (!size) throw new Broken();
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
      scans++;
      at = scan;
      continue;
    } else {
      throw new Broken();
    }
    at = end;
  }
}

// ── PNG ──────────────────────────────────────────────────────────────────

/** Chunks needed to draw the picture; any other ancillary one is dropped. */
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "bKGD",
  "pHYs",
]);

function cleanPng(bytes: Uint8Array) {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  let size: { width: number; height: number } | null = null;
  let hasData = false;
  for (;;) {
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
    if (type === "IHDR") {
      if (size || length !== 13) throw new Broken();
      size = { width: u32be(bytes, at + 8), height: u32be(bytes, at + 12) };
    }
    if (type === "IDAT") hasData = true;
    if (PNG_KEEP.has(type)) {
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

function cleanWebp(bytes: Uint8Array) {
  const riffEnd = 8 + u32le(bytes, 4);
  need(bytes, riffEnd);
  if (riffEnd < 20) throw new Broken();
  const chunks: Uint8Array[] = [];
  let at = 12;
  let extended: Uint8Array | null = null;
  let size: { width: number; height: number } | null = null;
  let hasImage = false;
  let first = true;
  while (at < riffEnd) {
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
      if (extended || length < 10) throw new Broken();
      if (bytes[data]! & 0x02) throw new BrokenType(); // animation
      extended = bytes.slice(at, padded);
      // No Exif (0x08) nor XMP (0x04) in the clean file.
      extended[8] = extended[8]! & ~0x0c;
      size = {
        width: 1 + u24le(bytes, data + 4),
        height: 1 + u24le(bytes, data + 7),
      };
    } else if (type === "VP8 ") {
      if (hasImage || length < 10) throw new Broken();
      if (
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      ) {
        throw new Broken();
      }
      const own = {
        width: u16le(bytes, data + 6) & 0x3fff,
        height: u16le(bytes, data + 8) & 0x3fff,
      };
      size ??= own;
      hasImage = true;
      chunks.push(bytes.subarray(at, padded));
    } else if (type === "VP8L") {
      if (hasImage || length < 5 || bytes[data] !== 0x2f) throw new Broken();
      const bits = u32le(bytes, data + 1);
      const own = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
      size ??= own;
      hasImage = true;
      chunks.push(bytes.subarray(at, padded));
    } else if (type === "ALPH" || type === "ICCP") {
      if (!extended) throw new Broken();
      chunks.push(bytes.subarray(at, padded));
    } else if (type === "ANIM" || type === "ANMF") {
      throw new BrokenType();
    }
    // EXIF, XMP and anything unknown: dropped.
    at = padded;
  }
  if (!hasImage || !size) throw new Broken();
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
