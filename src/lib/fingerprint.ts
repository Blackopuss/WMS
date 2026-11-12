/**
 * A short, stable mark of some values (FNV-1a, 64 bits as two halves). It
 * tells whether what a form sends now is what a warning was shown for, so
 * an acceptance never travels to different values. Not a secret and not
 * for security: the server decides again every time.
 */
export function fingerprint(parts: readonly string[]): string {
  // Lengths go in too, so ["ab", "c"] and ["a", "bc"] differ.
  const text = parts.map((part) => `${part.length}:${part}`).join("|");
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}
