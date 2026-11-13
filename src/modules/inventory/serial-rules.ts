/**
 * Serial numbers (WMS-21B, ADR 0041): the pure rules. No database.
 *
 * A serial is identified inside its product, kept like a lot code: without
 * extra spaces and in capitals, so «sn-01» and «SN-01 » are the same unit.
 * What comes from a form is text with one serial per line (a scanner
 * sends Enter after each reading), or a list.
 */

import { dec } from "@/lib";

export const SERIAL_MAX = 64;

/**
 * Serials one operation takes at most: a reasonable load to scan, and a
 * bound on what one transaction writes. Said on the screen.
 */
export const MAX_SERIALS_PER_OPERATION = 500;

export type SerialResult =
  { ok: true; serial: string } | { ok: false; error: string };

/** The serial as it is kept, or why it cannot be one. */
export function normalizeSerial(value: unknown): SerialResult {
  const text = String(value ?? "");
  if (/[\u0000-\u001f\u007f]/.test(text.trim())) {
    return { ok: false, error: "Quita los saltos de línea o tabuladores." };
  }
  const serial = text.trim().replace(/\s+/g, " ").toUpperCase();
  if (serial === "") return { ok: false, error: "Escribe la serie." };
  if (serial.length > SERIAL_MAX) {
    return {
      ok: false,
      error: `La serie ${serial.slice(0, 20)}… es demasiado larga (máximo ${SERIAL_MAX} caracteres).`,
    };
  }
  return { ok: true, serial };
}

export type SerialListResult =
  { ok: true; serials: string[] } | { ok: false; error: string };

/**
 * The serials of a form: text with one per line (also commas, semicolons
 * or tabs between them) or a list. Empty lines are ignored; a repeated
 * serial is a mistake of the reading, said by name.
 */
export function parseSerialList(input: unknown): SerialListResult {
  const pieces = Array.isArray(input)
    ? input.map((item) => String(item ?? ""))
    : String(input ?? "").split(/[\r\n\t,;]+/);
  const serials: string[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    if (piece.trim() === "") continue;
    const one = normalizeSerial(piece);
    if (!one.ok) return one;
    if (seen.has(one.serial)) {
      return {
        ok: false,
        error: `La serie ${one.serial} está dos veces en la lista.`,
      };
    }
    seen.add(one.serial);
    serials.push(one.serial);
    if (serials.length > MAX_SERIALS_PER_OPERATION) {
      return {
        ok: false,
        error: `Son demasiadas series para un solo movimiento (máximo ${MAX_SERIALS_PER_OPERATION}). Regístralo en partes.`,
      };
    }
  }
  return { ok: true, serials };
}

/** «A1, A2 y A3», «A1, A2, A3 y 4 más»: for messages and summaries. */
export function serialsText(serials: readonly string[], shown = 5): string {
  const head = serials.slice(0, shown);
  const rest = serials.length - head.length;
  if (rest > 0) return `${head.join(", ")} y ${rest} más`;
  if (head.length <= 1) return head.join("");
  return `${head.slice(0, -1).join(", ")} y ${head[head.length - 1]}`;
}

const SINGULAR = {
  entran: "entra",
  salen: "sale",
  "se mueven": "se mueve",
  hay: "hay",
  tomaste: "tomaste",
  regresan: "regresa",
} as const;

/**
 * Whether as many serials as units move: a product by serial moves whole
 * units, one serial each. The sentence for the person, or null.
 */
export function serialCountProblem(
  count: number,
  units: { toString(): string },
  verb: "entran" | "salen" | "se mueven" | "hay" | "tomaste" | "regresan",
): string | null {
  const quantity = dec(units.toString());
  if (!quantity.isInteger()) {
    return "Un producto por serie se mueve en unidades enteras.";
  }
  const wanted = quantity.toNumber();
  if (count === wanted) return null;
  if (count === 0) {
    return wanted === 1
      ? `Escanea o escribe la serie de la unidad que ${SINGULAR[verb]}.`
      : `Escanea o escribe las ${wanted} series de las unidades que ${verb}, una por renglón.`;
  }
  return count < wanted
    ? `Faltan series: son ${wanted} unidades y llevas ${count}.`
    : `Sobran series: son ${wanted} unidades y escribiste ${count}.`;
}
