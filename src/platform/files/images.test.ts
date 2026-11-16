import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  GPS_MARK,
  TEST_IMAGE_SIZE,
  TEST_JPEG,
  TEST_PNG,
  TEST_WEBP,
  cameraJpeg,
  exifWithGps,
  jpegSegment,
} from "../../../tests/setup/images";
import { IMAGE_LIMITS, detectImageFormat, sanitizeImage } from "./images";

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const join = (...parts: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const has = (haystack: Uint8Array, needle: string | Uint8Array) =>
  Buffer.from(haystack).includes(
    typeof needle === "string"
      ? Buffer.from(needle, "latin1")
      : Buffer.from(needle),
  );
const clean = (bytes: Uint8Array) =>
  Buffer.from((sanitizeImage(bytes) as { bytes: Uint8Array }).bytes);

/** A PNG chunk with its length and checksum. */
function pngChunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return join(head, data, crc);
}

/** A WebP chunk with its length and padding. */
function webpChunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(0, 4);
  head.writeUInt32LE(data.length, 4);
  return join(
    head,
    data,
    data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0),
  );
}

function riff(body: Uint8Array) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return join(bytesOf("RIFF"), size, body);
}

/** The chunks of the browser's WebP: VP8X, ICCP and VP8. */
function webpChunks() {
  const out: { type: string; bytes: Uint8Array }[] = [];
  let at = 12;
  while (at < TEST_WEBP.length) {
    const type = Buffer.from(TEST_WEBP.subarray(at, at + 4)).toString("latin1");
    const length = Buffer.from(TEST_WEBP).readUInt32LE(at + 4);
    const end = at + 8 + length + (length % 2);
    out.push({ type, bytes: TEST_WEBP.subarray(at, end) });
    at = end;
  }
  return out;
}

/** Time and memory of one call: a hostile file must cost like a photo. */
function cost(bytes: Uint8Array) {
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = sanitizeImage(bytes);
  return {
    result,
    ms: performance.now() - start,
    mb: (process.memoryUsage().heapUsed - heap) / 1024 / 1024,
  };
}

const FIVE_MB = 5 * 1024 * 1024;

/** A JPEG start followed by the same segment until it fills 5 MB. */
function jpegFilledWith(segment: Uint8Array) {
  const times = Math.floor((FIVE_MB - 4) / segment.length);
  const out = new Uint8Array(2 + times * segment.length + 2);
  out.set([0xff, 0xd8], 0);
  for (let i = 0; i < times; i++) out.set(segment, 2 + i * segment.length);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

describe("sanitizeImage", () => {
  it.each([
    ["jpeg", TEST_JPEG, "image/jpeg"],
    ["png", TEST_PNG, "image/png"],
    ["webp", TEST_WEBP, "image/webp"],
  ] as const)("acepta una foto %s y lee su tamaño", (format, bytes, type) => {
    expect(sanitizeImage(bytes, format)).toMatchObject({
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

  it("quita el Exif con GPS de un JPEG, el perfil, los comentarios y la segunda imagen (MPF)", () => {
    const withGps = join(
      cameraJpeg(),
      // What MPF describes: a second picture after the end, with its own GPS.
      cameraJpeg(),
    );
    const withMpf = join(
      withGps.subarray(0, 2),
      jpegSegment(0xe2, join(bytesOf("MPF\u0000"), exifWithGps())),
      jpegSegment(0xfe, bytesOf("Tomada en la bodega de Juan")),
      withGps.subarray(2),
    );
    expect(has(withMpf, GPS_MARK)).toBe(true);
    const result = sanitizeImage(withMpf, "jpeg");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(has(result.bytes, GPS_MARK)).toBe(false);
    expect(has(result.bytes, "MM\u0000*")).toBe(false);
    expect(has(result.bytes, "Exif")).toBe(false);
    expect(has(result.bytes, "MPF")).toBe(false);
    expect(has(result.bytes, "ICC_PROFILE")).toBe(false);
    expect(has(result.bytes, "Juan")).toBe(false);
    // Only one picture: one start and one end.
    expect(
      Buffer.from(result.bytes).indexOf(Buffer.from([0xff, 0xd8]), 2),
    ).toBe(-1);
    expect(Buffer.from(result.bytes)).toEqual(clean(TEST_JPEG));
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

  it("quita textos, eXIf con GPS, fecha y perfil de un PNG", () => {
    const withText = join(
      TEST_PNG.subarray(0, 33),
      pngChunk("tEXt", bytesOf("Comment\u0000Bodega de Juan")),
      pngChunk("eXIf", exifWithGps()),
      pngChunk("tIME", Uint8Array.of(7, 234, 11, 16, 9, 0, 0)),
      pngChunk("iCCP", bytesOf("perfil\u0000\u0000xyz")),
      TEST_PNG.subarray(33),
    );
    const result = sanitizeImage(withText, "png");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(has(result.bytes, GPS_MARK)).toBe(false);
    for (const gone of ["Juan", "tIME", "eXIf", "iCCP"]) {
      expect(has(result.bytes, gone)).toBe(false);
    }
    expect(Buffer.from(result.bytes)).toEqual(clean(TEST_PNG));
  });

  it("rechaza un PNG con un fragmento alterado (CRC) o repetido", () => {
    const altered = new Uint8Array(TEST_PNG);
    altered[20] = altered[20]! ^ 0xff; // inside IHDR
    expect(sanitizeImage(altered)).toMatchObject({
      ok: false,
      reason: "broken",
    });
    const twice = join(
      TEST_PNG.subarray(0, 33),
      pngChunk("gAMA", Uint8Array.of(0, 0, 0xb1, 0x8f)),
      pngChunk("gAMA", Uint8Array.of(0, 0, 0xb1, 0x8f)),
      TEST_PNG.subarray(33),
    );
    expect(sanitizeImage(twice)).toMatchObject({ ok: false, reason: "broken" });
  });

  it("quita EXIF con GPS, XMP y perfil de un WebP y apaga sus banderas", () => {
    const [vp8x, iccp, image] = webpChunks();
    expect([vp8x!.type, iccp!.type, image!.type]).toEqual([
      "VP8X",
      "ICCP",
      "VP8 ",
    ]);
    const announced = new Uint8Array(vp8x!.bytes);
    announced[8] = announced[8]! | 0x2c;
    const withExif = riff(
      join(
        bytesOf("WEBP"),
        announced,
        iccp!.bytes,
        image!.bytes,
        webpChunk("EXIF", exifWithGps()),
        webpChunk("XMP ", bytesOf("<x:xmpmeta>Bodega de Juan</x:xmpmeta>")),
      ),
    );
    const result = sanitizeImage(withExif, "webp");
    expect(result).toMatchObject({ ok: true, ...TEST_IMAGE_SIZE });
    if (!result.ok) return;
    expect(has(result.bytes, GPS_MARK)).toBe(false);
    for (const gone of ["EXIF", "XMP", "ICCP", "Juan"]) {
      expect(has(result.bytes, gone)).toBe(false);
    }
    expect(result.bytes[20]! & 0x2c).toBe(0);
    expect(Buffer.from(result.bytes)).toEqual(clean(TEST_WEBP));
    expect(Buffer.from(result.bytes).readUInt32LE(4)).toBe(
      result.bytes.length - 8,
    );
  });

  it("rechaza un VP8X de otro tamaño o con un lienzo que no es el de la imagen", () => {
    const [vp8x, , image] = webpChunks();
    const longer = join(
      webpChunk("VP8X", join(vp8x!.bytes.subarray(8), bytesOf("texto oculto"))),
      image!.bytes,
    );
    expect(sanitizeImage(riff(join(bytesOf("WEBP"), longer)))).toMatchObject({
      ok: false,
      reason: "broken",
    });
    const other = new Uint8Array(vp8x!.bytes);
    other[12] = other[12]! + 5; // canvas wider than the picture
    expect(
      sanitizeImage(riff(join(bytesOf("WEBP"), other, image!.bytes))),
    ).toMatchObject({ ok: false, reason: "broken" });
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
    // The bound leaves room for what the browser uploads (1,600 px).
    expect(IMAGE_LIMITS.maxSide).toBeGreaterThanOrEqual(1600);
  });
});

describe("un archivo hostil cuesta lo que una foto", () => {
  const BOUNDS = { ms: 150, mb: 25 };

  it.each([
    ["tablas Huffman vacías", Uint8Array.of(0xff, 0xc4, 0x00, 0x02)],
    ["tablas de cuantización vacías", Uint8Array.of(0xff, 0xdb, 0x00, 0x02)],
    [
      "tablas Huffman mínimas repetidas",
      jpegSegment(0xc4, new Uint8Array(18).fill(1)),
    ],
    ["segmentos APP vacíos", Uint8Array.of(0xff, 0xef, 0x00, 0x02)],
    [
      "perfiles ICC repetidos",
      jpegSegment(0xe2, bytesOf("ICC_PROFILE\u0000\u0001\u0001")),
    ],
  ])("JPEG de 5 MB con %s", (_name, segment) => {
    const { result, ms, mb } = cost(jpegFilledWith(segment));
    expect(result).toMatchObject({ ok: false });
    expect(ms).toBeLessThan(BOUNDS.ms);
    expect(mb).toBeLessThan(BOUNDS.mb);
  });

  it("PNG de 5 MB con cientos de miles de pHYs", () => {
    const phys = pngChunk("pHYs", new Uint8Array(9));
    const head = TEST_PNG.subarray(0, 33);
    const times = Math.floor((FIVE_MB - head.length) / phys.length);
    const out = new Uint8Array(
      head.length + times * phys.length + TEST_PNG.length - 33,
    );
    out.set(head, 0);
    for (let i = 0; i < times; i++)
      out.set(phys, head.length + i * phys.length);
    out.set(TEST_PNG.subarray(33), head.length + times * phys.length);
    const { result, ms, mb } = cost(out);
    expect(result).toMatchObject({ ok: false });
    expect(ms).toBeLessThan(BOUNDS.ms);
    expect(mb).toBeLessThan(BOUNDS.mb);
  });

  it("PNG de 5 MB con miles de fragmentos auxiliares desconocidos", () => {
    const junk = pngChunk("zzZz", new Uint8Array(0));
    const head = TEST_PNG.subarray(0, 33);
    const times = Math.floor((FIVE_MB - head.length) / junk.length);
    const out = new Uint8Array(
      head.length + times * junk.length + TEST_PNG.length - 33,
    );
    out.set(head, 0);
    for (let i = 0; i < times; i++)
      out.set(junk, head.length + i * junk.length);
    out.set(TEST_PNG.subarray(33), head.length + times * junk.length);
    const { result, ms, mb } = cost(out);
    expect(result).toMatchObject({ ok: false });
    expect(ms).toBeLessThan(BOUNDS.ms);
    expect(mb).toBeLessThan(BOUNDS.mb);
  });
});
