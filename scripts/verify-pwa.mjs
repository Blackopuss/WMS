// Browser checks of the installable app and the camera (WMS-35/36,
// ADR 0049), on a PRODUCTION build (the service worker needs it):
//   npm run build
//   DATABASE_NAME=wms_test BETTER_AUTH_URL=http://localhost:3100 \
//     MAIL_DRIVER=memory npx next start -p 3100
//   npm run test:company -- "<contraseña>" warehouse   (prints the email)
//   PWA_EMAIL=<correo> PWA_PASSWORD=<contraseña> UI_BASE_URL=http://localhost:3100 \
//     node scripts/verify-pwa.mjs
// Creates one product with stock and one exit in that (test) company.
// Chromium has no BarcodeDetector on Linux or Windows, so the camera checks
// put a fake one in the page (it returns the codes the test queues) over a
// fake camera; what is checked is the component and the screens behind it.
import { chromium } from "playwright";

const BASE = process.env.UI_BASE_URL ?? "http://localhost:3100";
const EMAIL = process.env.PWA_EMAIL ?? "";
const PASSWORD = process.env.PWA_PASSWORD ?? "";
if (!EMAIL || !PASSWORD) {
  console.error("Falta PWA_EMAIL o PWA_PASSWORD (npm run test:company).");
  process.exit(1);
}

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
];

/** A detector that returns, frame by frame, the codes the test queues. */
function fakeDetector() {
  window.__scanQueue = [];
  window.__streams = [];
  class FakeBarcodeDetector {
    static async getSupportedFormats() {
      return ["code_128", "ean_13", "qr_code", "aztec"];
    }
    constructor(options) {
      window.__formats = options.formats;
    }
    async detect() {
      const next = window.__scanQueue.shift();
      return next ? next.map((rawValue) => ({ rawValue })) : [];
    }
  }
  window.BarcodeDetector = FakeBarcodeDetector;
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (window.__denyCamera) {
      throw new DOMException("denied", "NotAllowedError");
    }
    const stream = await real(constraints);
    window.__streams.push(stream);
    return stream;
  };
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(`${BASE}/ingresar`, { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL(/\/(inicio|acepta-terminos)/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  // /inicio may still send to the terms: settle on where it lands.
  await page.goto(`${BASE}/inicio`, { waitUntil: "networkidle" });
  // A fresh test account still has to accept the terms once.
  if (page.url().includes("/acepta-terminos")) {
    await page.check("#acceptLegal");
    await page.getByRole("button", { name: "Aceptar y continuar" }).click();
    await page.waitForURL("**/inicio", { timeout: 20000 });
  }
  return page;
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const stamp = Date.now().toString(36).toUpperCase();
const sku = `CAM-${stamp}`;
const barcode = `750${Date.now().toString().slice(-10)}`;
try {
  // Does this Chromium bring a real detector? (Linux and Windows: no.)
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/sin-conexion`);
    const real = await page.evaluate(() => "BarcodeDetector" in window);
    console.log(
      `INFO  BarcodeDetector real en este Chromium: ${real ? "sí" : "no (se usa uno simulado)"}`,
    );
    await context.close();
  }

  // 1. Manifest, icons, service worker, offline page.
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await signIn(context);
    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    check(
      manifestHref === "/manifest.webmanifest",
      `${viewport.name}: link rel=manifest`,
    );
    const manifest = await page.evaluate(async (href) => {
      const response = await fetch(href);
      return {
        type: response.headers.get("content-type"),
        body: await response.json(),
      };
    }, manifestHref);
    check(
      manifest.type?.startsWith("application/manifest+json") &&
        manifest.body.name === "WMS" &&
        manifest.body.display === "standalone",
      `${viewport.name}: manifest válido (${manifest.type})`,
    );
    const icons = await page.evaluate(
      async (list) =>
        Promise.all(
          list.map(
            (icon) =>
              new Promise((resolve) => {
                const image = new Image();
                image.onload = () =>
                  resolve(`${image.naturalWidth}x${image.naturalHeight}`);
                image.onerror = () => resolve("error");
                image.src = icon.src;
              }),
          ),
        ),
      manifest.body.icons,
    );
    check(
      icons.every((size, i) => size === manifest.body.icons[i].sizes),
      `${viewport.name}: íconos cargan con su tamaño (${icons.join(", ")})`,
    );
    const apple = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    check(Boolean(apple), `${viewport.name}: apple-touch-icon (${apple})`);

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "networkidle" });
    const controlled = await page.evaluate(
      () => navigator.serviceWorker.controller?.scriptURL ?? null,
    );
    check(
      controlled?.endsWith("/sw.js") === true,
      `${viewport.name}: service worker registrado y en control`,
    );
    const stored = await page.evaluate(async () => {
      const out = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys())
          out.push(new URL(request.url).pathname);
      }
      return out;
    });
    check(
      stored.length === 1 && stored[0] === "/sin-conexion",
      `${viewport.name}: el worker solo guarda /sin-conexion (${stored.join(", ")})`,
    );

    await context.setOffline(true);
    const notice = page.getByText("Sin conexión.", { exact: true });
    await notice.waitFor({ timeout: 5000 }).catch(() => {});
    check(
      await notice.isVisible(),
      `${viewport.name}: aviso «Sin conexión» dentro de la app`,
    );
    await page.goto(`${BASE}/inventario`).catch(() => {});
    const heading = await page
      .locator("h1")
      .first()
      .textContent()
      .catch(() => null);
    check(
      heading === "Sin conexión",
      `${viewport.name}: sin red, una navegación muestra «Sin conexión» (${heading})`,
    );
    check(
      new URL(page.url()).pathname === "/inventario",
      `${viewport.name}: la dirección sigue siendo la pedida`,
    );
    check(
      (await overflow(page)) <= 0,
      `${viewport.name}: página sin conexión sin desbordamiento`,
    );
    const retry = page.getByRole("link", { name: "Reintentar" });
    const box = await retry.boundingBox();
    check(box && box.height >= 44, `${viewport.name}: «Reintentar» ≥ 44 px`);
    // Still offline: retrying shows the same page, nothing else.
    await retry.click();
    await page.waitForLoadState();
    check(
      (await page.locator("h1").first().textContent()) === "Sin conexión",
      `${viewport.name}: reintentar sin red sigue diciendo «Sin conexión»`,
    );
    await context.setOffline(false);
    await page.getByRole("link", { name: "Reintentar" }).click();
    await page.waitForLoadState("networkidle");
    const back = await page.locator("h1").first().textContent();
    check(
      back === "Inventario",
      `${viewport.name}: con red, «Reintentar» carga la pantalla (${back})`,
    );
    check(
      !(await page.getByText("Sin conexión.", { exact: true }).isVisible()),
      `${viewport.name}: el aviso se quita al volver la red`,
    );
    // Signing out leaves nothing of the session in the worker's cache.
    await context.close();
  }

  // 2. Camera with a (fake) detector, over a fake camera.
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    await context.grantPermissions(["camera"], { origin: BASE });
    await context.addInitScript(fakeDetector);
    const page = await signIn(context);
    const first = viewport.name === "390";

    if (first) {
      // A product with stock to work with (test company).
      await page.goto(`${BASE}/inventario/nuevo`, { waitUntil: "networkidle" });
      await page.fill("#sku", sku);
      await page.fill("#barcode", barcode);
      await page.fill("#name", `Producto cámara ${stamp}`);
      await page.getByRole("button", { name: "Guardar producto" }).click();
      await page.waitForURL("**/inventario?creado=**");
      await page.goto(`${BASE}/movimientos/entrada?q=${sku}`, {
        waitUntil: "networkidle",
      });
      await page.fill("#quantity", "10");
      await page.getByRole("button", { name: "Registrar entrada" }).click();
      await page.waitForURL("**/movimientos?**", { timeout: 15000 });
    }

    // Search: one reading, then the GET form goes as with a reader.
    await page.goto(`${BASE}/inventario`, { waitUntil: "networkidle" });
    const scan = page.getByRole("button", {
      name: "Buscar producto con la cámara",
    });
    const scanBox = await scan.boundingBox();
    check(
      scanBox && (viewport.width > 767 || scanBox.height >= 44),
      `${viewport.name}: botón «Escanear» visible y de 44 px en móvil (${scanBox?.height})`,
    );
    await scan.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    check(
      (await dialog.getByRole("heading").textContent()) ===
        "Buscar producto con la cámara",
      `${viewport.name}: diálogo con título`,
    );
    const formats = await page.evaluate(() => window.__formats);
    check(
      JSON.stringify(formats) === '["code_128","ean_13","qr_code"]',
      `${viewport.name}: pide solo los formatos que usa (${formats})`,
    );
    check(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          .contains(document.activeElement),
      ),
      `${viewport.name}: el foco queda en el diálogo`,
    );
    check(
      (await overflow(page)) <= 0,
      `${viewport.name}: diálogo de cámara sin desbordamiento`,
    );
    const close = dialog.getByRole("button", { name: "Cerrar" });
    const closeBox = await close.boundingBox();
    check(
      closeBox && closeBox.height >= 44,
      `${viewport.name}: «Cerrar» ≥ 44 px`,
    );
    // Two codes in view: nothing is read.
    await page.evaluate(() => window.__scanQueue.push(["A-01", "A-02"]));
    await dialog
      .getByText("Hay más de un código a la vista", { exact: false })
      .waitFor({ timeout: 3000 });
    check(true, `${viewport.name}: con dos códigos a la vista no lee ninguno`);
    await page.evaluate((code) => window.__scanQueue.push([code]), barcode);
    // The search form may add its other filters (WMS-87: «existencias»).
    await page.waitForURL(
      (url) =>
        url.pathname === "/inventario" && url.searchParams.get("q") === barcode,
      { timeout: 5000 },
    );
    check(
      await page.getByText(`Producto cámara ${stamp}`).first().isVisible(),
      `${viewport.name}: la lectura buscó como el lector (encontró el producto)`,
    );
    check(
      await page.evaluate(() =>
        window.__streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ),
      ),
      `${viewport.name}: la cámara se apaga al leer`,
    );

    // Escape closes and turns the camera off.
    await page
      .getByRole("button", { name: "Buscar producto con la cámara" })
      .click();
    await page.getByRole("dialog").waitFor();
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    check(
      await page.evaluate(() =>
        window.__streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ),
      ),
      `${viewport.name}: Escape cierra y apaga la cámara`,
    );

    // Quick exit: continuous; the same label in view counts once.
    await page.goto(`${BASE}/movimientos/salida-rapida`, {
      waitUntil: "networkidle",
    });
    await page
      .getByRole("button", { name: "Escanear productos que salen" })
      .click();
    await page.getByRole("dialog").waitFor();
    await page.waitForTimeout(300);
    await page.evaluate((code) => {
      for (let i = 0; i < 4; i++) window.__scanQueue.push([code]);
    }, sku);
    await page
      .getByRole("dialog")
      .getByText("· 1 código", { exact: false })
      .waitFor({ timeout: 5000 });
    await page.waitForTimeout(1300);
    await page.evaluate((code) => window.__scanQueue.push([code]), sku);
    await page
      .getByRole("dialog")
      .getByText("· 2 códigos", { exact: false })
      .waitFor({ timeout: 5000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cerrar" })
      .click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const notice = await page
      .getByRole("status")
      .filter({ hasText: sku.length > 0 ? "ahora van" : "" })
      .first()
      .textContent()
      .catch(() => "");
    check(
      /ahora van 2/.test(notice ?? ""),
      `${viewport.name}: continuo: misma etiqueta a la vista cuenta una vez, retirada y vuelta suma (${notice})`,
    );
    await page.getByRole("button", { name: "Registrar salida" }).click();
    await page.waitForURL("**/movimientos?registrado=**", { timeout: 15000 });
    check(
      true,
      `${viewport.name}: la salida escaneada se registró por su camino normal`,
    );

    // Permission denied: said clearly, the field still works.
    await page.evaluate(() => {
      window.__denyCamera = true;
    });
    await page.goto(`${BASE}/inventario/rastrear`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => {
      window.__denyCamera = true;
    });
    await page.getByRole("button", { name: "Rastrear con la cámara" }).click();
    const denied = page.getByRole("alert").filter({ hasText: "permiso" });
    await denied.waitFor({ timeout: 5000 });
    check(true, `${viewport.name}: permiso negado: lo dice y ofrece escribir`);
    await page.keyboard.press("Escape");
    await context.close();
  }

  // 3. Without BarcodeDetector: no button in the way, the field works.
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await signIn(context);
    await page.goto(`${BASE}/movimientos/salida-rapida`, {
      waitUntil: "networkidle",
    });
    check(
      (await page.getByRole("button", { name: /Escanear/ }).count()) === 0,
      `${viewport.name}: sin BarcodeDetector no aparece «Escanear»`,
    );
    await page.fill("#buscar-producto", sku);
    await page.press("#buscar-producto", "Enter");
    await page
      .getByText(`Agregaste Producto cámara ${stamp}.`)
      .waitFor({ timeout: 5000 });
    check(true, `${viewport.name}: el campo manual sigue funcionando`);
    check(
      (await overflow(page)) <= 0,
      `${viewport.name}: salida rápida sin desbordamiento`,
    );
    await page.goto(`${BASE}/configuracion`, { waitUntil: "networkidle" });
    check(
      await page.getByText("Instala WMS para abrirla").isVisible(),
      `${viewport.name}: Configuración explica cómo instalar`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nTodo bien." : `\n${failures} fallas.`);
process.exit(failures === 0 ? 0 : 1);
