/**
 * Document numbers as a person types or scans them (WMS-66): «PS-0012»,
 * «ps 12», «PS12» → 12. Pure, shared by every source that looks a
 * document up by its number.
 */

/** Longest number a document may have (INT in the database). */
const MAX_NUMBER = 2_147_483_647;

/**
 * The number of a document with that prefix, or null when the text is
 * not one. The prefix is letters only (it goes into a pattern).
 */
export function documentNumber(prefix: string, text: string): number | null {
  if (!/^[A-Za-z]{1,4}$/.test(prefix)) return null;
  const match = new RegExp(`^${prefix}[\\s-]*0*(\\d{1,10})$`, "i").exec(
    String(text ?? "").trim(),
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_NUMBER
    ? value
    : null;
}

/** Digits a document number shows at least («PS-0012»). */
export const DOCUMENT_NUMBER_WIDTH = 4;

/** What an incomplete number may be (fundador, 2026-11-25). */
export type DocumentNumberQuery = {
  /** The number exactly as typed («ps 12» → 12), or null. */
  exact: number | null;
  /**
   * Ranges of numbers whose shown digits («0012») start with what was
   * typed: «INC-000» → 1 to 9; «PS-12» → 1200 to 1299, 12000 to 12999…
   * Empty when every number fits (only the letters were typed).
   */
  ranges: { from: number; to: number }[];
  /** Only the letters: every document of that kind fits. */
  any: boolean;
  /** Complete as printed on the document («PS-0012»): a scanner read. */
  complete: boolean;
};

/**
 * A number of that kind, complete or not, as a person types it: «INC»,
 * «INC-», «INC-000», «ps 12». Null when the text is not one. A single
 * letter alone («T») is not taken: it is too common as a word.
 */
export function documentNumberQuery(
  prefix: string,
  text: string,
  width = DOCUMENT_NUMBER_WIDTH,
): DocumentNumberQuery | null {
  if (!/^[A-Za-z]{1,4}$/.test(prefix)) return null;
  const match = new RegExp(`^${prefix}([\\s-]*)(\\d{0,10})$`, "i").exec(
    String(text ?? "").trim(),
  );
  if (!match) return null;
  const [, separator = "", digits = ""] = match;
  if (digits === "") {
    if (separator === "" && prefix.length < 2) return null;
    return { exact: null, ranges: [], any: true, complete: false };
  }
  const exact = documentNumber(prefix, text);
  const typed = Number(digits);
  const ranges: { from: number; to: number }[] = [];
  // Shown with `shown` digits: «0012» (padded) up to 10 digits.
  for (let shown = Math.max(digits.length, width); shown <= 10; shown++) {
    const lowest = shown === width ? 1 : 10 ** (shown - 1);
    const highest = Math.min(10 ** shown - 1, MAX_NUMBER);
    const scale = 10 ** (shown - digits.length);
    const from = Math.max(typed * scale, lowest);
    const to = Math.min((typed + 1) * scale - 1, highest);
    if (from <= to) ranges.push({ from, to });
  }
  if (exact === null && ranges.length === 0) return null;
  return {
    exact,
    ranges,
    any: false,
    complete: exact !== null && digits.length >= width,
  };
}
