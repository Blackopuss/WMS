/**
 * Code 128 barcodes (WMS-26, ADR 0047), with no dependency: the code sets
 * B (printable ASCII) and C (pairs of digits), the check symbol modulo 103
 * and the stop pattern. What comes out is the row of modules (bar or
 * space) a printer draws; the quiet zones are the drawer's job
 * (`CODE128_QUIET_ZONE` modules each side).
 *
 * `decodeCode128` reads such a row back. It exists so tests can read what
 * was really drawn in a PDF; it accepts only what `encodeCode128` writes
 * (sets B and C, no function characters).
 */

/**
 * Widths of bar, space, bar, space, bar, space of each symbol value 0–105
 * (103, 104 and 105 are «Start A», «Start B» and «Start C»), in modules,
 * as the standard (ISO/IEC 15417) lists them. Each one adds up to 11.
 */
const PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
] as const;

/** The stop pattern: seven elements, 13 modules (bar first). */
const STOP = "2331112";

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;

/** Modules of light space each side, as the standard asks (at least 10). */
export const CODE128_QUIET_ZONE = 10;

/** Longest text a label code takes; longer ones do not fit a label. */
export const CODE128_MAX_LENGTH = 48;

/** The widths table, for tests. */
export const CODE128_PATTERNS: readonly string[] = PATTERNS;
export const CODE128_STOP = STOP;

export type Code128 = {
  /** Symbol values: start, data, check, stop (106). */
  values: number[];
  /** Bar (true) or space (false), one per module, without quiet zones. */
  modules: boolean[];
};

export type Code128Result =
  ({ ok: true } & Code128) | { ok: false; reason: string };

const isDigit = (code: number) => code >= 48 && code <= 57;

/** Digits in a row from `index`. */
function digitsFrom(text: string, index: number): number {
  let end = index;
  while (end < text.length && isDigit(text.charCodeAt(end))) end++;
  return end - index;
}

/** The modules of a pattern of widths, starting with a bar. */
function modulesOf(pattern: string, into: boolean[]) {
  let bar = true;
  for (const width of pattern) {
    for (let i = 0; i < Number(width); i++) into.push(bar);
    bar = !bar;
  }
}

/**
 * Encodes a text as Code 128. Set C takes runs of digits (4 or more at the
 * start or the end, 6 or more in the middle), set B the rest; that is the
 * shortest symbol for the codes of the system.
 */
export function encodeCode128(text: string): Code128Result {
  if (text.length === 0) return { ok: false, reason: "El código está vacío." };
  if (text.length > CODE128_MAX_LENGTH) {
    return {
      ok: false,
      reason: `El código tiene más de ${CODE128_MAX_LENGTH} caracteres.`,
    };
  }
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code > 126) {
      return {
        ok: false,
        reason: `El código de barras no admite «${character}»: solo letras sin acento, números y signos comunes.`,
      };
    }
  }

  const values: number[] = [];
  let set: "B" | "C";
  const leading = digitsFrom(text, 0);
  if (leading >= 4 || (leading === text.length && leading === 2)) {
    set = "C";
    values.push(START_C);
  } else {
    set = "B";
    values.push(START_B);
  }
  let index = 0;
  while (index < text.length) {
    const run = digitsFrom(text, index);
    if (set === "C") {
      if (run >= 2) {
        values.push(Number(text.slice(index, index + 2)));
        index += 2;
        continue;
      }
      set = "B";
      values.push(CODE_B);
      continue;
    }
    // In set B: a long enough run of digits is cheaper in set C.
    const atEnd = index + run === text.length;
    if (run >= 6 || (atEnd && run >= 4)) {
      // An odd run leaves its first digit in set B.
      if (run % 2 === 1) {
        values.push(text.charCodeAt(index) - 32);
        index++;
      }
      set = "C";
      values.push(CODE_C);
      continue;
    }
    values.push(text.charCodeAt(index) - 32);
    index++;
  }
  let sum = values[0]!;
  for (let position = 1; position < values.length; position++) {
    sum += values[position]! * position;
  }
  values.push(sum % 103);

  const modules: boolean[] = [];
  for (const value of values) modulesOf(PATTERNS[value]!, modules);
  modulesOf(STOP, modules);
  values.push(106);
  return { ok: true, values, modules };
}

const VALUE_OF = new Map<string, number>(
  PATTERNS.map((pattern, value) => [pattern, value]),
);

/**
 * Reads a row of modules back as text, or null when it is not a valid
 * Code 128 written by `encodeCode128` (wrong pattern, check or stop).
 * Light modules around it (quiet zones) are ignored.
 */
export function decodeCode128(modules: readonly boolean[]): string | null {
  const first = modules.indexOf(true);
  const last = modules.lastIndexOf(true);
  if (first < 0) return null;
  const widths: number[] = [];
  let current = modules[first];
  let width = 0;
  for (let index = first; index <= last; index++) {
    if (modules[index] === current) {
      width++;
    } else {
      widths.push(width);
      current = modules[index];
      width = 1;
    }
  }
  widths.push(width);
  // Symbols of six elements, then the stop of seven.
  if (widths.length < 6 * 3 + 7 || (widths.length - 7) % 6 !== 0) return null;
  if (widths.slice(-7).join("") !== STOP) return null;
  const values: number[] = [];
  for (let start = 0; start < widths.length - 7; start += 6) {
    const value = VALUE_OF.get(widths.slice(start, start + 6).join(""));
    if (value === undefined) return null;
    values.push(value);
  }
  const check = values.pop()!;
  let sum = values[0]!;
  for (let position = 1; position < values.length; position++) {
    sum += values[position]! * position;
  }
  if (sum % 103 !== check) return null;

  let set: "B" | "C";
  if (values[0] === START_B) set = "B";
  else if (values[0] === START_C) set = "C";
  else return null;
  let text = "";
  for (const value of values.slice(1)) {
    if (set === "C") {
      if (value < 100) text += String(value).padStart(2, "0");
      else if (value === CODE_B) set = "B";
      else return null;
    } else if (value < 95) {
      text += String.fromCharCode(value + 32);
    } else if (value === CODE_C) {
      set = "C";
    } else {
      return null;
    }
  }
  return text;
}
