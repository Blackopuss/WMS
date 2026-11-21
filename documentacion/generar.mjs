import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const dir = dirname(fileURLToPath(import.meta.url));
const src = join(dir, "fuentes");
const tmp = join(dir, ".tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);
const css = readFileSync(join(dir, "estilo.css"), "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const browser = await chromium.launch();
for (const f of readdirSync(src).filter((n) => n.endsWith(".md")).sort()) {
  const md = readFileSync(join(src, f), "utf8");
  const title = /^title:\s*"(.*)"/m.exec(md)[1];
  const subtitle = /^subtitle:\s*"(.*)"/m.exec(md)[1];
  const body = md.replace(/^---[\s\S]*?---\n/, "");
  writeFileSync(join(tmp, "b.md"), body);
  const html = execFileSync("pandoc", [join(tmp, "b.md"), "-f", "markdown-smart", "-t", "html5"], { encoding: "utf8" });
  const doc = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>
<section class="cover"><div class="tag">WMS · Documentación para clientes</div><h1>${esc(title)}</h1><div class="bar"></div><div class="sub">${esc(subtitle)}</div><div class="foot">Versión noviembre 2026</div></section>
<main>${html}</main></body></html>`;
  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: "load" });
  const name = f.replace(/\.md$/, ".pdf");
  await page.pdf({
    path: join(dir, name), format: "Letter", printBackground: true,
    displayHeaderFooter: true,
    margin: { top: "0.9in", bottom: "1in", left: "0.9in", right: "0.9in" },
    headerTemplate: `<div style="font-size:8px;color:#71717a;width:100%;padding:0 0.9in;font-family:Arial">${esc(title)}</div>`,
    footerTemplate: `<div style="font-size:8px;color:#71717a;width:100%;padding:0 0.9in;text-align:right;font-family:Arial">Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`,
  });
  await page.close();
  console.log("PDF", name);
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });
