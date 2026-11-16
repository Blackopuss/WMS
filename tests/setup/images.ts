/**
 * Real images for tests (WMS-37), made once with Chromium from a 24 × 16
 * canvas (`canvas.toBlob`). The JPEG carries an ICC profile, like what a
 * phone browser produces.
 */

const decode = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export const TEST_JPEG = decode(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdC" +
    "IFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAA" +
    "AADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlk" +
    "ZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAA" +
    "ABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAA" +
    "AAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAA" +
    "AABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEA" +
    "AAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAA" +
    "ACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYI" +
    "ChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcH" +
    "BwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCj/wAARCAAQABgDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAQG/8QAIRAAAQIE" +
    "BwAAAAAAAAAAAAAAEgARAQYTFAcVFiVDYqH/xAAXAQADAQAAAAAAAAAAAAAAAAAEBQYH/8QAHhEA" +
    "AQMEAwAAAAAAAAAAAAAAABQkMRFRgZFiY/D/2gAMAwEAAhEDEQA/AKsN5F1pmO42VpT4KhmXaDMP" +
    "qYkSLovLtxvbupwUwAe0XcvEw3nrReY7de3dPnpgBdYu5eJiRPWtMu26ytKnPUMx6wZh9Whvl3Ti" +
    "259Qm26fnm+oMUiImwGf/9k=",
);

export const TEST_PNG = decode(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAAUUlEQVR4AeyQwQkAIAwDgzO4gi6m" +
    "YzmZK+gO+u+jpUj7KBbyKASSXCptHUslGF/AgDkyOGmJBkSkRSD5PyKJEPwR1b7BSaxMDP4LSIHn" +
    "13zBBQAA//9dw7Y0AAAABklEQVQDAL+RUtF2+zrxAAAAAElFTkSuQmCC",
);

export const TEST_WEBP = decode(
  "UklGRmACAABXRUJQVlA4WAoAAAAgAAAAFwAADwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdC" +
    "IFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAA" +
    "AADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlk" +
    "ZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAA" +
    "ABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAA" +
    "AAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAA" +
    "AABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEA" +
    "AAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAA" +
    "ACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggcgAAABAFAJ0BKhgAEAA+" +
    "bSyRRaQioZgEAEAGxLUATplCMAUQDYALn/9ADdqv2A+CD/bghVAA/orf/pI7/9IZT//owi/899mb" +
    "2OgBP233RbDCn+Qi+p51/fF/mtx9f//WBr4kNlycgPGpE+Zc7v/tP5HM+hF4AA==",
);

export const TEST_IMAGE_SIZE = { width: 24, height: 16 } as const;

/**
 * A real Exif block as a camera writes it (big-endian TIFF): IFD0 with a
 * GPSInfo pointer and a GPS IFD with latitude «N 19° 25′ 57.36″». The
 * rational 5736/100 is easy to look for in a file (`GPS_MARK`).
 */
export function exifWithGps(): Uint8Array {
  const tiff = Buffer.alloc(80);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 at 8
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x8825, 10); // GPSInfo
  tiff.writeUInt16BE(4, 12); // LONG
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18); // GPS IFD at 26
  tiff.writeUInt32BE(0, 22); // no next IFD
  tiff.writeUInt16BE(2, 26); // two entries
  tiff.writeUInt16BE(0x0001, 28); // GPSLatitudeRef
  tiff.writeUInt16BE(2, 30); // ASCII
  tiff.writeUInt32BE(2, 32);
  tiff.write("N\u0000", 36, "latin1");
  tiff.writeUInt16BE(0x0002, 40); // GPSLatitude
  tiff.writeUInt16BE(5, 42); // RATIONAL
  tiff.writeUInt32BE(3, 44);
  tiff.writeUInt32BE(56, 48); // its values at 56
  tiff.writeUInt32BE(0, 52);
  tiff.writeUInt32BE(19, 56);
  tiff.writeUInt32BE(1, 60);
  tiff.writeUInt32BE(25, 64);
  tiff.writeUInt32BE(1, 68);
  tiff.writeUInt32BE(5736, 72);
  tiff.writeUInt32BE(100, 76);
  return new Uint8Array(tiff);
}

/** Bytes of the GPS rational above (5736/100): absent from a clean file. */
export const GPS_MARK = new Uint8Array([0, 0, 0x16, 0x68, 0, 0, 0, 100]);

/** A JPEG segment: marker, length and payload. */
export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, marker, length >> 8, length & 0xff]),
      Buffer.from(payload),
    ]),
  );
}

/** A photo as a phone leaves it: Exif with GPS right after the start. */
export function cameraJpeg(): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(TEST_JPEG.subarray(0, 2)),
      Buffer.from(
        jpegSegment(
          0xe1,
          new Uint8Array(
            Buffer.concat([
              Buffer.from("Exif\u0000\u0000", "latin1"),
              Buffer.from(exifWithGps()),
            ]),
          ),
        ),
      ),
      Buffer.from(TEST_JPEG.subarray(2)),
    ]),
  );
}
