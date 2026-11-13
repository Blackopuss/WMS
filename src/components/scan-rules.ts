/**
 * Rules of reading codes with the camera (WMS-36, ADR 0049), pure so they
 * can be tested without a browser. The camera is one more way of typing:
 * these rules only decide WHICH text to type, never what it means.
 */

/**
 * Formats asked of BarcodeDetector, when the browser has them: what WMS-26
 * prints (Code 128 and QR), what products carry (EAN/UPC) and what boxes of
 * any trade often carry (Code 39, ITF, Data Matrix).
 */
export const SCAN_FORMATS = [
  "code_128",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "qr_code",
  "code_39",
  "itf",
  "data_matrix",
] as const;

/** The formats to ask for, among those this browser reads, in our order. */
export function scanFormats(supported: readonly string[]): string[] {
  return SCAN_FORMATS.filter((format) => supported.includes(format));
}

/** Longest text a field takes from one reading (the fields cut at 100–200). */
const MAX_READ = 200;

/**
 * The one code in view, or why none is taken: two different codes in view
 * is ambiguous (the camera may be seeing the neighbouring label), so the
 * person is asked to get closer to the one they want.
 */
export function singleCode(
  texts: readonly string[],
): { code: string } | { none: "nothing" | "several" } {
  const distinct = [
    ...new Set(
      texts.map((text) => text.trim().slice(0, MAX_READ)).filter(Boolean),
    ),
  ];
  if (distinct.length === 0) return { none: "nothing" };
  if (distinct.length > 1) return { none: "several" };
  return { code: distinct[0]! };
}

/**
 * Remembers what was read so the same label in front of the camera is
 * delivered once: it is delivered again only after it has been out of view
 * for `gapMs` (taking it away and back, which in a quick exit adds one, as
 * scanning it twice with a reader does).
 */
export function createReadFilter(gapMs = 1000) {
  const lastSeen = new Map<string, number>();
  return function accept(code: string, now: number): boolean {
    for (const [text, at] of lastSeen) {
      if (now - at >= gapMs) lastSeen.delete(text);
    }
    const fresh = !lastSeen.has(code);
    lastSeen.set(code, now);
    return fresh;
  };
}

export type CameraProblem = "denied" | "no_camera" | "busy" | "failed";

/** What went wrong opening the camera, from the DOMException name. */
export function cameraProblem(errorName: string | undefined): CameraProblem {
  switch (errorName) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no_camera";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "failed";
  }
}

/** Each problem in words for the floor, ending with the manual way. */
export const CAMERA_PROBLEMS: Record<CameraProblem, string> = {
  denied:
    "No hay permiso para usar la cámara. Permítelo en los ajustes del navegador para este sitio, o escribe el código en el campo.",
  no_camera:
    "No encontramos una cámara en este dispositivo. Escribe el código en el campo.",
  busy: "Otra app está usando la cámara. Ciérrala y vuelve a intentarlo, o escribe el código en el campo.",
  failed:
    "No pudimos abrir la cámara. Vuelve a intentarlo o escribe el código en el campo.",
};
