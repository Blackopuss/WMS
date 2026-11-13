/**
 * Installable app (WMS-35, ADR 0049): what the manifest, the offline page
 * and the service worker say. Pure, so tests can run the worker and
 * compare the colors with the design tokens.
 *
 * The worker keeps ONE thing on the device: its own offline page. Never
 * pages of the app, /api answers or anything of a company or a session —
 * a shared phone would show the next person what the previous one saw.
 */

/** Page shown when a navigation fails for lack of network. */
export const OFFLINE_PATH = "/sin-conexion";

/** Where the service worker is served (scope "/"). */
export const SERVICE_WORKER_PATH = "/sw.js";

/**
 * Everything the worker may store. Growing this list is a security
 * decision (ADR 0049): pwa.test.ts fails if it changes unreviewed.
 */
export const OFFLINE_CACHE_URLS = [OFFLINE_PATH] as const;

/** Prefix of the worker's caches; older versions are deleted. */
export const CACHE_PREFIX = "wms-sin-conexion-";

/**
 * Colors of the manifest and the offline page, which cannot read CSS.
 * Taken from src/app/globals.css (`:root` and `.dark`); pwa.test.ts
 * compares them.
 */
export const PWA_COLORS = {
  light: {
    background: "#f8fafc",
    foreground: "#1e293b",
    mutedForeground: "#475569",
    primary: "#2563eb",
    primaryForeground: "#ffffff",
    primaryHover: "#1d4ed8",
    ring: "#2563eb",
  },
  dark: {
    background: "#0f0f10",
    foreground: "#f4f4f5",
    mutedForeground: "#a1a1aa",
    primary: "#f4f4f5",
    primaryForeground: "#18181b",
    primaryHover: "#d4d4d8",
    ring: "#a1a1aa",
  },
} as const;

/** The brand mark (lucide «Warehouse», as in the sidebar), 24×24. */
export const BRAND_ICON_PATHS = [
  "M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11",
  "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z",
  "M6 13h12",
  "M6 17h12",
] as const;

/** Icons the manifest names (files in public/icons, scripts/pwa-icons.mjs). */
export const MANIFEST_ICONS = [
  { src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" },
  {
    src: "/icons/icon-maskable-512.png",
    sizes: "512x512",
    purpose: "maskable",
  },
] as const;

/** The offline page: fixed HTML, no script, inline styles only. */
export function offlinePageHtml(): string {
  const { light, dark } = PWA_COLORS;
  const paths = BRAND_ICON_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Sin conexión · WMS</title>
<style>
:root{--bg:${light.background};--fg:${light.foreground};--muted:${light.mutedForeground};--primary:${light.primary};--on-primary:${light.primaryForeground};--hover:${light.primaryHover};--ring:${light.ring}}
@media (prefers-color-scheme:dark){:root{--bg:${dark.background};--fg:${dark.foreground};--muted:${dark.mutedForeground};--primary:${dark.primary};--on-primary:${dark.primaryForeground};--hover:${dark.primaryHover};--ring:${dark.ring}}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{display:grid;place-items:center;min-height:100dvh;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:22rem;text-align:center}
.mark{display:inline-grid;place-items:center;width:56px;height:56px;border-radius:14px;background:var(--primary);color:var(--on-primary)}
h1{margin:20px 0 8px;font-size:1.5rem;line-height:1.25;font-weight:600}
p{margin:0;color:var(--muted)}
a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;min-width:12rem;margin-top:24px;padding:0 20px;border-radius:12px;background:var(--primary);color:var(--on-primary);font-weight:500;text-decoration:none}
a:hover{background:var(--hover)}
a:focus-visible{outline:3px solid var(--ring);outline-offset:3px}
</style>
</head>
<body>
<main>
<span class="mark"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg></span>
<h1>Sin conexión</h1>
<p>Este dispositivo no tiene internet y WMS lo necesita para trabajar. Cuando vuelva la conexión, toca «Reintentar».</p>
<a href="">Reintentar</a>
</main>
</body>
</html>
`;
}

/**
 * The service worker. Its only job: when a same-origin GET navigation
 * (outside /api) fails for lack of network, answer with the offline page.
 * Server answers pass untouched; Server Actions (POST), Next data fetches
 * and prefetches (not navigations) are never intercepted or retried.
 */
const WORKER_BODY = `
const OFFLINE = __OFFLINE__;
const KEEP = __KEEP__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const url of KEEP) {
        // Without cookies: nothing of a session can end up stored.
        const response = await fetch(
          new Request(url, { cache: "reload", credentials: "omit" }),
        );
        if (!response.ok || response.redirected) {
          throw new Error("Página sin conexión no disponible");
        }
        await cache.put(url, response);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      }
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(OFFLINE)) ?? Response.error();
      }
    })(),
  );
});
`;

/** FNV-1a, 32 bits, as 8 hex digits: a short, stable summary. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Version of the worker's cache: changes whenever the worker or the
 * offline page change, so a new deployment replaces the old worker (its
 * bytes change) and deletes the old cache. Same code, same version.
 */
export function pwaVersion(): string {
  return shortHash(
    WORKER_BODY + JSON.stringify(OFFLINE_CACHE_URLS) + offlinePageHtml(),
  );
}

/** Source of /sw.js. */
export function serviceWorkerSource(version = pwaVersion()): string {
  const header = [
    "// WMS service worker (WMS-35, ADR 0049). Generated by src/lib/pwa.ts.",
    `const PREFIX = ${JSON.stringify(CACHE_PREFIX)};`,
    `const CACHE = ${JSON.stringify(CACHE_PREFIX + version)};`,
  ].join("\n");
  return (
    header +
    WORKER_BODY.replace("__OFFLINE__", JSON.stringify(OFFLINE_PATH)).replace(
      "__KEEP__",
      JSON.stringify(OFFLINE_CACHE_URLS),
    )
  );
}
