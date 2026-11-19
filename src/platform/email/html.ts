/**
 * The HTML of a mail (WMS-88, ADR 0084). One fixed layout that escapes
 * every text and attribute: no remote images, no scripts, no styles from
 * outside. Texts written by a customer arrive already flattened to one
 * line (`oneLine`) and are escaped here too. Pure: no database.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** A text ready to go inside HTML, in an element or an attribute. */
export function escapeHtml(value: string): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** Only links of the app (http or https) become links; others are text. */
function safeHref(url: string): string | null {
  const text = String(url ?? "");
  return /^https?:\/\/[^\s"<>]+$/.test(text) ? text : null;
}

export type HtmlBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "items"; items: { text: string; url?: string }[] }
  | { kind: "link"; text: string; url: string }
  | { kind: "note"; text: string };

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function link(text: string, url: string): string {
  const href = safeHref(url);
  if (!href) return escapeHtml(text);
  return `<a href="${escapeHtml(href)}" style="color:#1d4ed8;text-decoration:underline">${escapeHtml(text)}</a>`;
}

function block(each: HtmlBlock): string {
  switch (each.kind) {
    case "paragraph":
      return `<p style="margin:0 0 16px">${escapeHtml(each.text)}</p>`;
    case "heading":
      return `<h2 style="margin:24px 0 8px;font-size:16px">${escapeHtml(each.text)}</h2>`;
    case "items":
      return `<ul style="margin:0 0 16px;padding-left:20px">${each.items
        .map(
          (item) =>
            `<li style="margin:0 0 8px">${item.url ? link(item.text, item.url) : escapeHtml(item.text)}</li>`,
        )
        .join("")}</ul>`;
    case "link":
      return `<p style="margin:0 0 16px">${link(each.text, each.url)}</p>`;
    case "note":
      return `<p style="margin:24px 0 0;font-size:13px;color:#52525b">${escapeHtml(each.text)}</p>`;
  }
}

/**
 * A whole HTML mail. `footer` lines go small at the end (why the person
 * gets it and how to stop it), each one a text and an optional link.
 */
export function htmlEmail(input: {
  title: string;
  blocks: HtmlBlock[];
  footer: { text: string; url?: string; linkText?: string }[];
}): string {
  const footer = input.footer
    .map(
      (line) =>
        `<p style="margin:8px 0 0;font-size:13px;color:#52525b">${escapeHtml(line.text)}${
          line.url ? ` ${link(line.linkText ?? line.url, line.url)}` : ""
        }</p>`,
    )
    .join("");
  return [
    '<!doctype html><html lang="es-MX"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#ffffff;color:#18181b;${FONT};font-size:15px;line-height:1.5">`,
    '<div style="max-width:560px;margin:0 auto">',
    input.blocks.map(block).join(""),
    `<div style="margin-top:32px;border-top:1px solid #e4e4e7;padding-top:8px">${footer}</div>`,
    "</div></body></html>",
  ].join("");
}
