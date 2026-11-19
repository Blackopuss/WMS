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
