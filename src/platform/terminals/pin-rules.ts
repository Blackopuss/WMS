/**
 * Rules of a PIN (WMS-38, ADR 0061 §3). Pure: no database.
 */

export const PIN_MIN_LENGTH = 4;
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

/** Easy to guess: «000000», «123456», «654321», «890123», «121212», «123123». */
export function isTrivialPin(pin: string): boolean {
  return isRepeatedBlock(pin) || isStaircase(pin, 1) || isStaircase(pin, -1);
}

/**
 * What is wrong with a new PIN of the company's length, ready to show, or
 * null when it is fine.
 */
export function pinProblem(pin: string, length: number): string | null {
  if (!/^\d+$/.test(pin)) return "El PIN lleva solo números.";
  if (pin.length !== length) return `El PIN lleva ${length} números.`;
  if (isTrivialPin(pin)) {
    return "Ese PIN es muy fácil de adivinar: evita números repetidos o seguidos.";
  }
  return null;
}

/** A PIN typed on a terminal: 4 to 6 digits (the length may have changed). */
export function isPinShape(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}
