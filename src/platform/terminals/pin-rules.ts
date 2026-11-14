/**
 * Rules of a PIN (WMS-38, ADR 0061 §3). Pure: no database.
 */

export const PIN_MIN_LENGTH = 5;
export const PIN_MAX_LENGTH = 6;

/** True when every digit is one more (or one less) than the one before. */
function isStaircase(pin: string, step: 1 | -1): boolean {
  for (let i = 1; i < pin.length; i++) {
    if ((Number(pin[i - 1]) + step + 10) % 10 !== Number(pin[i])) return false;
  }
  return true;
}

/** True when the PIN is a block of 1, 2 or 3 digits repeated. */
function isRepeatedBlock(pin: string): boolean {
  for (const size of [1, 2, 3]) {
    if (pin.length % size !== 0 || pin.length === size) continue;
    const block = pin.slice(0, size);
    if (block.repeat(pin.length / size) === pin) return true;
  }
  return false;
}

/** A year people pick: 1930 to 2039. */
function isYear(digits: string): boolean {
  const year = Number(digits);
  return digits.length === 4 && year >= 1930 && year <= 2039;
}

/** A day of the calendar written as two digits each: day, month, year. */
function isDate(day: string, month: string): boolean {
  const d = Number(day);
  const m = Number(month);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/**
 * A date or a year in the PIN: starts or ends with a year («198512»,
 * «041987», «20251»), or six digits that read as a date in the usual
 * orders (DDMMAA, MMDDAA, AAMMDD).
 */
function isDateLike(pin: string): boolean {
  if (isYear(pin.slice(0, 4)) || isYear(pin.slice(-4))) return true;
  if (pin.length !== 6) return false;
  const [a, b, c] = [pin.slice(0, 2), pin.slice(2, 4), pin.slice(4, 6)];
  return isDate(a, b) || isDate(b, a) || isDate(c, b);
}

/**
 * Lines of three keys on a keypad (1-2-3 on top, 0 below 8): rows,
 * columns and diagonals, both ways.
 */
const KEYPAD_LINES: readonly string[] = (() => {
  const lines = ["123", "456", "789", "147", "258", "369", "159", "357", "580"];
  return [...lines, ...lines.map((line) => [...line].reverse().join(""))];
})();

/**
 * Drawn on the keypad: two lines of three keys one after the other
 * («147258», «159753», «789456»), or the first five keys of such a shape.
 */
function isKeypadShape(pin: string): boolean {
  for (const first of KEYPAD_LINES) {
    for (const second of KEYPAD_LINES) {
      if ((first + second).startsWith(pin)) return true;
    }
  }
  return false;
}

/**
 * Each digit typed twice (or three times) along a staircase: «112233»,
 * «998877», «111222».
 */
function isDoubledStaircase(pin: string): boolean {
  for (const size of [2, 3]) {
    if (pin.length % size !== 0) continue;
    let doubled = true;
    let single = "";
    for (let i = 0; i < pin.length; i += size) {
      const block = pin.slice(i, i + size);
      if (block !== block[0]!.repeat(size)) doubled = false;
      single += block[0];
    }
    if (doubled && (isStaircase(single, 1) || isStaircase(single, -1))) {
      return true;
    }
  }
  return false;
}

/**
 * Easy to guess: «000000», «123456», «654321», «890123», «121212»,
 * «123123», «112233», shapes on the keypad («147258», «159753»), a year
 * or a date.
 */
export function isTrivialPin(pin: string): boolean {
  return (
    isRepeatedBlock(pin) ||
    isStaircase(pin, 1) ||
    isStaircase(pin, -1) ||
    isDoubledStaircase(pin) ||
    isKeypadShape(pin) ||
    isDateLike(pin)
  );
}

/**
 * What is wrong with a new PIN of the company's length, ready to show, or
 * null when it is fine.
 */
export function pinProblem(pin: string, length: number): string | null {
  if (!/^\d+$/.test(pin)) return "El PIN lleva solo números.";
  if (pin.length !== length) return `El PIN lleva ${length} números.`;
  if (isTrivialPin(pin)) {
    return "Ese PIN es muy fácil de adivinar: evita números repetidos o seguidos, figuras del teclado, años y fechas.";
  }
  return null;
}

/** A PIN typed on a terminal: 5 to 6 digits (the length may have changed). */
export function isPinShape(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}
