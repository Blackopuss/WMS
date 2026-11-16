/**
 * Headers of the answer that gives a private file to its person (IMP-02;
 * photos WMS-37, ADR 0063). Only an image — its type decided by the server
 * from its content — is shown inside the page; anything else is always a
 * download. The browser never guesses the type, another site never embeds
 * it, and nothing is kept (a shared device keeps no copy).
 */
export function fileResponseHeaders(file: {
  name: string;
  contentType: string;
  size: number;
}): Record<string, string> {
  const inline = file.contentType.startsWith("image/");
  // Only plain characters in the fallback name; the real one goes encoded.
  const fallback = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    "content-type": file.contentType,
    "content-length": String(file.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "private, no-store",
  };
}

/**
 * Content-Security-Policy of the answers under /api/archivos (WMS-37): a
 * file runs nothing and loads nothing, whatever it pretends to be.
 */
export const FILE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";
