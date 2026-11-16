import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  TEST_IMAGE_SIZE,
  TEST_JPEG,
  TEST_PNG,
  TEST_WEBP,
} from "../../../tests/setup/images";
import { IMAGE_LIMITS, detectImageFormat, sanitizeImage } from "./images";

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const join = (...parts: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const has = (haystack: Uint8Array, needle: string) =>
  Buffer.from(haystack).includes(Buffer.from(needle, "latin1"));

/** A JPEG segment with its marker and length. */
function segment(marker: number, payload: Uint8Array) {
  const length = payload.length + 2;
  return join(Uint8Array.of(0xff, marker, length >> 8, length & 0xff), payload);
}

/** An Exif block that says where the photo was taken. */
const EXIF_WITH_GPS = bytesOf(
  "Exif\u0000\u0000MM\u0000*\u0000\u0000\u0000\bGPSLatitude 19.4326 N GPSLongitude 99.1332 W",
);

/** A PNG chunk with its length and checksum. */
function pngChunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return join(head, data, crc);
}

describe("sanitizeImage", () => {
  it.each([
    ["jpeg", TEST_JPEG, "image/jpeg"],
    ["png", TEST_PNG, "image/png"],
    ["webp", TEST_WEBP, "image/webp"],
  ] as const)("acepta una foto %s y lee su tamaño", (format, bytes, type) => {
    const result = sanitizeImage(bytes, format);
    expect(result).toMatchObject({
      ok: true,
      format,
      contentType: type,
      ...TEST_IMAGE_SIZE,
    });
  });

  it("detecta el formato por el contenido, no por el nombre", () => {
    expect(detectImageFormat(TEST_JPEG)).toBe("jpeg");
    expect(detectImageFormat(TEST_PNG)).toBe("png");
    expect(detectImageFormat(TEST_WEBP)).toBe("webp");
    expect(detectImageFormat(bytesOf("<html><script>"))).toBeNull();
  });

  it("rechaza un archivo que no es imagen aunque se llame .jpg", () => {
    for (const fake of [
      bytesOf("<html><body><script>alert(1)</script></body></html>"),
      bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      bytesOf("GIF89a\u0001\u0000\u0001\u0000"),
      bytesOf("MZ\u0090\u0000"),
      new Uint8Array(0),
    ]) {
      expect(sanitizeImage(fake, "jpeg")).toMatchObject({
        ok: false,
        reason: "type",
      });
      expect(sanitizeImage(fake)).toMatchObject({ ok: false, reason: "type" });
    }
  });

  it("rechaza una imagen real con la extensión de otro formato", () => {
    expect(sanitizeImage(TEST_PNG, "jpeg")).toMatchObject({
      ok: false,
      reason: "type",
    });
    expect(sanitizeImage(TEST_JPEG, "webp")).toMatchObject({
      ok: false,
      reason: "type",
    });
  });

  it("rechaza una foto incompleta", () => {
    for (const bytes of [TEST_JPEG, TEST_PNG, TEST_WEBP]) {
      const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
      expect(sanitizeImage(cut)).toMatchObject({ ok: false, reason: "broken" });
    }
  });

  it("quita el Exif con la ubicación GPS de un JPEG y conserva la foto", () => {
    const withGps = join(
      TEST_JPEG.subarray(0, 2),
      segment(0xe1, EXIF_WITH_GPS),
      segment(0xfe, bytesOf("Tomada en la bodega de Juan")),
      TEST_JPEG.subarray(2),
    );
    expect(has(withGps, "GPSLatitude")).toBe(true);
    const result = sanitizeImage(withGps, "jpeg");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(has(result.bytes, "GPS")).toBe(false);
    expect(has(result.bytes, "Exif")).toBe(false);
    expect(has(result.bytes, "Juan")).toBe(false);
    // The colour profile stays: it changes how the photo looks.
    expect(has(result.bytes, "ICC_PROFILE")).toBe(true);
    // Same picture as the one without metadata.
    expect(Buffer.from(result.bytes)).toEqual(
      Buffer.from((sanitizeImage(TEST_JPEG) as { bytes: Uint8Array }).bytes),
    );
    // Starts and ends as a JPEG.
    expect([...result.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...result.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("descarta lo que viene después del final (polyglot)", () => {
    const tail = bytesOf("<html><script>alert(document.cookie)</script>");
    for (const bytes of [TEST_JPEG, TEST_PNG]) {
      const result = sanitizeImage(join(bytes, tail));
      expect(result.ok).toBe(true);
      if (result.ok) expect(has(result.bytes, "<script>")).toBe(false);
    }
  });

  it("quita textos, Exif y fecha de un PNG", () => {
    const withText = join(
      TEST_PNG.subarray(0, 33),
      pngChunk("tEXt", bytesOf("Comment\u0000GPS 19.43 -99.13")),
      pngChunk("eXIf", EXIF_WITH_GPS),
      pngChunk("tIME", Uint8Array.of(7, 234, 11, 16, 9, 0, 0)),
      TEST_PNG.subarray(33),
    );
    const result = sanitizeImage(withText, "png");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(has(result.bytes, "GPS")).toBe(false);
    expect(has(result.bytes, "tIME")).toBe(false);
    expect(Buffer.from(result.bytes)).toEqual(
      Buffer.from((sanitizeImage(TEST_PNG) as { bytes: Uint8Array }).bytes),
    );
  });

  it("rechaza un PNG con un fragmento alterado (CRC)", () => {
    const altered = new Uint8Array(TEST_PNG);
    altered[20] = altered[20]! ^ 0xff; // inside IHDR
    expect(sanitizeImage(altered)).toMatchObject({
      ok: false,
      reason: "broken",
    });
  });

  it("quita el EXIF y el XMP de un WebP y apaga sus banderas", () => {
    // The browser's file has an extended header (VP8X) and a colour
    // profile; here it also announces Exif and XMP and carries both.
    const chunk = (type: string, data: Uint8Array) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, "latin1");
      head.writeUInt32LE(data.length, 4);
      return join(
        head,
        data,
        data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0),
      );
    };
    const original = TEST_WEBP.subarray(12);
    const announced = new Uint8Array(original);
    expect(Buffer.from(announced.subarray(0, 4)).toString("latin1")).toBe(
      "VP8X",
    );
    announced[8] = announced[8]! | 0x0c;
    const body = join(
      bytesOf("WEBP"),
      announced,
      chunk("EXIF", EXIF_WITH_GPS),
      chunk("XMP ", bytesOf("<x:xmpmeta>GPS 19.43</x:xmpmeta>")),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length, 0);
    const withExif = join(bytesOf("RIFF"), size, body);
    const result = sanitizeImage(withExif, "webp");
    expect(result).toMatchObject({ ok: true, ...TEST_IMAGE_SIZE });
    if (!result.ok) return;
    expect(has(result.bytes, "GPS")).toBe(false);
    expect(has(result.bytes, "EXIF")).toBe(false);
    expect(has(result.bytes, "XMP")).toBe(false);
    expect(result.bytes[20]! & 0x0c).toBe(0);
    expect(Buffer.from(result.bytes)).toEqual(
      Buffer.from((sanitizeImage(TEST_WEBP) as { bytes: Uint8Array }).bytes),
    );
    expect(Buffer.from(result.bytes).readUInt32LE(4)).toBe(
      result.bytes.length - 8,
    );
  });

  it("rechaza una foto más grande de lo que un navegador debe dibujar", () => {
    const ihdr = Buffer.from(TEST_PNG.subarray(16, 29));
    ihdr.writeUInt32BE(IMAGE_LIMITS.maxSide + 1, 0);
    const huge = join(
      TEST_PNG.subarray(0, 8),
      pngChunk("IHDR", ihdr),
      TEST_PNG.subarray(33),
    );
    expect(sanitizeImage(huge)).toMatchObject({
      ok: false,
      reason: "dimensions",
    });
  });
});
