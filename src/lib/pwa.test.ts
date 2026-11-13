import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  CACHE_PREFIX,
  BRAND_ICON_PATHS,
  MANIFEST_ICONS,
  OFFLINE_CACHE_URLS,
  OFFLINE_PATH,
  PWA_COLORS,
  offlinePageHtml,
  pwaVersion,
  serviceWorkerSource,
  shortHash,
} from "./pwa";

const ORIGIN = "https://wms.example.mx";

/** Request as a worker sees it (Node's has no "navigate" mode). */
class FakeRequest {
  url: string;
  mode: string;
  method: string;
  credentials: string;
  constructor(
    input: string,
    init: { mode?: string; method?: string; credentials?: string } = {},
  ) {
    this.url = new URL(input, ORIGIN).href;
    this.mode = init.mode ?? "cors";
    this.method = init.method ?? "GET";
    this.credentials = init.credentials ?? "same-origin";
  }
}

type Listener = (event: FakeEvent) => void;
type FakeEvent = {
  request?: FakeRequest;
  preloadResponse?: Promise<Response | undefined>;
  waitUntil(promise: Promise<unknown>): void;
  respondWith(promise: Promise<Response>): void;
};

/** Runs /sw.js against a fake `self`, `caches` and network. */
function loadWorker(options: {
  network: (request: FakeRequest) => Promise<Response>;
  existingCaches?: string[];
}) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  for (const name of options.existingCaches ?? []) stores.set(name, new Map());
  const fetched: FakeRequest[] = [];
  const put: string[] = [];
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async put(url: string, response: Response) {
          put.push(url);
          store.set(url, response);
        },
        async match(url: string) {
          return store.get(url)?.clone();
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { navigationPreload: { enable: async () => {} } },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
  };
  vm.runInNewContext(serviceWorkerSource(), {
    self,
    caches,
    URL,
    Request: FakeRequest,
    Response,
    Error,
    fetch: (request: FakeRequest) => {
      fetched.push(request);
      return options.network(request);
    },
  });

  async function dispatch(type: string, request?: FakeRequest) {
    const waits: Promise<unknown>[] = [];
    let answer: Promise<Response> | undefined;
    listeners.get(type)!({
      request,
      preloadResponse: Promise.resolve(undefined),
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => {
        answer = promise;
      },
    });
    await Promise.all(waits);
    return answer ? await answer : undefined;
  }
  return { dispatch, stores, fetched, put };
}

const page = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const navigation = (pathname: string, init: { method?: string } = {}) =>
  new FakeRequest(`${ORIGIN}${pathname}`, { mode: "navigate", ...init });

describe("service worker (WMS-35)", () => {
  it("stores only its offline page, fetched without cookies", async () => {
    expect(OFFLINE_CACHE_URLS).toEqual(["/sin-conexion"]);
    const worker = loadWorker({ network: async () => page("sin conexión") });
    await worker.dispatch("install");
    expect(worker.put).toEqual([OFFLINE_PATH]);
    expect(worker.fetched).toHaveLength(1);
    expect(worker.fetched[0]!.credentials).toBe("omit");
    expect([...worker.stores.keys()]).toEqual([
      `${CACHE_PREFIX}${pwaVersion()}`,
    ]);
  });

  it("refuses to install over a redirect or an error", async () => {
    const worker = loadWorker({
      network: async () => new Response("no", { status: 500 }),
    });
    await expect(worker.dispatch("install")).rejects.toThrow();
    expect(worker.put).toEqual([]);
  });

  it("lets navigations through while there is network, storing nothing", async () => {
    const worker = loadWorker({ network: async () => page("inventario") });
    await worker.dispatch("install");
    const answer = await worker.dispatch(
      "fetch",
      navigation("/inventario?q=abc"),
    );
    expect(await answer!.text()).toBe("inventario");
    // An error page of the server is the server's answer, not "offline".
    const failing = loadWorker({
      network: async () => new Response("error", { status: 500 }),
    });
    expect(
      (await failing.dispatch("fetch", navigation("/inicio")))!.status,
    ).toBe(500);
    expect(worker.put).toEqual([OFFLINE_PATH]);
  });

  it("answers a failed navigation with the offline page", async () => {
    let online = true;
    const worker = loadWorker({
      network: (request) =>
        online ? Promise.resolve(page(`real ${request.url}`)) : offline(),
    });
    await worker.dispatch("install");
    online = false;
    const answer = await worker.dispatch("fetch", navigation("/pedidos"));
    expect(await answer!.text()).toBe(`real ${ORIGIN}${OFFLINE_PATH}`);
    // Nothing new stored while offline either.
    expect(worker.put).toEqual([OFFLINE_PATH]);
  });

  it("never intercepts Server Actions, data fetches, /api or other sites", async () => {
    const worker = loadWorker({ network: offline });
    const ignored = [
      // A Server Action or a form post.
      navigation("/movimientos/salida-rapida", { method: "POST" }),
      // Next data fetches and prefetches are not navigations.
      new FakeRequest(`${ORIGIN}/inventario?_rsc=1`, { mode: "cors" }),
      new FakeRequest(`${ORIGIN}/inicio`, { mode: "same-origin" }),
      // Downloads and API routes.
      navigation("/api/exportaciones/productos"),
      navigation("/api"),
      // Another origin.
      new FakeRequest("https://otro.example.com/", { mode: "navigate" }),
    ];
    for (const request of ignored) {
      expect(await worker.dispatch("fetch", request)).toBeUndefined();
    }
    expect(worker.fetched).toEqual([]);
  });

  it("deletes the caches of older versions when it takes over", async () => {
    const worker = loadWorker({
      network: async () => page("x"),
      existingCaches: [`${CACHE_PREFIX}00000000`, "otro-cache"],
    });
    await worker.dispatch("install");
    await worker.dispatch("activate");
    expect([...worker.stores.keys()].sort()).toEqual(
      ["otro-cache", `${CACHE_PREFIX}${pwaVersion()}`].sort(),
    );
  });

  it("changes version only when the worker or the offline page change", () => {
    expect(pwaVersion()).toBe(pwaVersion());
    expect(pwaVersion()).toMatch(/^[0-9a-f]{8}$/);
    expect(serviceWorkerSource()).toContain(`${CACHE_PREFIX}${pwaVersion()}`);
    expect(shortHash("a")).not.toBe(shortHash("b"));
  });
});

describe("offline page", () => {
  it("is Spanish, has no script and retries the same address", () => {
    const html = offlinePageHtml();
    expect(html).toContain('lang="es-MX"');
    expect(html).toContain("<h1>Sin conexión</h1>");
    expect(html).toContain('<a href="">Reintentar</a>');
    expect(html).not.toMatch(/<script|\son[a-z]+=|javascript:/i);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe("PWA colors", () => {
  /** Reads `--name: #hex;` of a block (`:root` or `.dark`) of globals.css. */
  const css = readFileSync(
    path.join(process.cwd(), "src/app/globals.css"),
    "utf8",
  );
  const block = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    return css.slice(start, css.indexOf("\n}", start));
  };
  const token = (selector: string, name: string) =>
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i").exec(block(selector))?.[1];

  it("are the design tokens, in light and dark", () => {
    const names = {
      background: "background",
      foreground: "foreground",
      mutedForeground: "muted-foreground",
      primary: "primary",
      primaryForeground: "primary-foreground",
      primaryHover: "primary-hover",
      ring: "ring",
    } as const;
    for (const [key, name] of Object.entries(names)) {
      const k = key as keyof typeof names;
      expect(PWA_COLORS.light[k], name).toBe(token(":root", name));
      expect(PWA_COLORS.dark[k], name).toBe(token(".dark", name));
    }
  });
});

describe("app icons", () => {
  it("draw the brand mark of the app (lucide «Warehouse»)", () => {
    const lucide = readFileSync(
      path.join(
        process.cwd(),
        "node_modules/lucide-react/dist/esm/icons/warehouse.mjs",
      ),
      "utf8",
    );
    for (const d of BRAND_ICON_PATHS) expect(lucide).toContain(`d: "${d}"`);
  });

  it("exist in the sizes Android asks for, one of them maskable", () => {
    const png = (src: string) =>
      readFileSync(path.join(process.cwd(), "public", src));
    for (const icon of MANIFEST_ICONS) {
      const file = png(icon.src);
      // PNG signature, then the IHDR width and height.
      expect(file.subarray(1, 4).toString()).toBe("PNG");
      const [width] = icon.sizes.split("x").map(Number);
      expect(file.readUInt32BE(16)).toBe(width);
      expect(file.readUInt32BE(20)).toBe(width);
    }
    expect(MANIFEST_ICONS.some((icon) => icon.purpose === "maskable")).toBe(
      true,
    );
    expect(MANIFEST_ICONS.map((icon) => icon.sizes)).toContain("192x192");
    expect(MANIFEST_ICONS.map((icon) => icon.sizes)).toContain("512x512");
  });
});
