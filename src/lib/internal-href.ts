/**
 * True when the text is a path of this application and nothing else
 * (WMS-39: where a notice leads): it starts with one «/», never «//» or
 * «/\» (the browser would read another host), and has no scheme, spaces,
 * control characters or other odd characters. Query and fragment are
 * allowed with plain characters.
 */
export function isInternalHref(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 300) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  return /^\/[A-Za-z0-9\-._~/?=&%#+]*$/.test(value) && !value.includes(":");
}
