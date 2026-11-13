// App icons of the installable app (WMS-35, ADR 0049), drawn from the brand
// the app already shows (the lucide «Warehouse» mark in white on a rounded
// --primary square, `Brand` in the sidebar) and rasterized with Playwright,
// which is already installed. No new dependency.
// Usage: node scripts/pwa-icons.mjs   (UI_BROWSER=msedge to use Edge)
// Writes public/icons/icon-192.png, icon-512.png, icon-maskable-512.png and
// src/app/apple-icon.png. Run it again when the brand or --primary change.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const css = readFileSync("src/app/globals.css", "utf8");
const root = css.slice(css.indexOf("\n:root {"), css.indexOf("\n.dark {"));
const token = (name) => {
  const found = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i").exec(root);
  if (!found) throw new Error(`Falta --${name} en globals.css`);
  return found[1];
};
const primary = token("primary");
const onPrimary = token("primary-foreground");

// The mark's paths, from the same list the offline page draws.
const source = readFileSync("src/lib/pwa.ts", "utf8");
const list = source.slice(
  source.indexOf("BRAND_ICON_PATHS = ["),
  source.indexOf("] as const", source.indexOf("BRAND_ICON_PATHS = [")),
);
const paths = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
if (paths.length === 0) throw new Error("No se encontró BRAND_ICON_PATHS");

/**
 * One icon as SVG. `radius` and `mark` are fractions of the size: the
 * sidebar draws a 32 px square with 12 px corners and an 18 px mark.
 */
function svg(size, { radius, mark }) {
  const markSize = size * mark;
  const offset = (size - markSize) / 2;
  const scale = markSize / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * radius}" fill="${primary}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${onPrimary}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${paths.map((d) => `<path d="${d}"/>`).join("")}
  </g>
</svg>`;
}

const ICONS = [
  // Any shape: the brand as the sidebar shows it, transparent corners.
  {
    file: "public/icons/icon-192.png",
    size: 192,
    radius: 12 / 32,
    mark: 18 / 32,
  },
  {
    file: "public/icons/icon-512.png",
    size: 512,
    radius: 12 / 32,
    mark: 18 / 32,
  },
  // Maskable: the system cuts the shape, so the square fills everything and
  // the mark stays inside the safe zone (a circle of 80% of the size).
  {
    file: "public/icons/icon-maskable-512.png",
    size: 512,
    radius: 0,
    mark: 0.5,
  },
  // iPhone rounds the corners itself and shows transparency as black.
  { file: "src/app/apple-icon.png", size: 180, radius: 0, mark: 18 / 32 },
];

mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch(
  process.env.UI_BROWSER ? { channel: process.env.UI_BROWSER } : {},
);
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg(icon.size, icon)}</body></html>`,
    );
    const png = await page.locator("svg").screenshot({ omitBackground: true });
    writeFileSync(icon.file, png);
    console.log(`${icon.file} (${icon.size}×${icon.size})`);
  }
} finally {
  await browser.close();
}
