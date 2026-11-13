import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import manifest from "@/app/manifest";
import { GET as offlinePage } from "@/app/sin-conexion/route";
import { GET as serviceWorker } from "@/app/sw.js/route";
import { OFFLINE_PATH, PWA_COLORS, pwaVersion } from "@/lib";
import proxy from "@/proxy";

// WMS-35/36 (ADR 0049): what the installable app serves, with which
// headers, and that it loads without a session.

const request = (path: string) =>
  new NextRequest(new URL(path, "https://wms.example.mx"));

describe("installable app", () => {
  it("serves the worker as fresh JavaScript with its cache version", async () => {
    const response = serviceWorker();
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body = await response.text();
    expect(body).toContain(`wms-sin-conexion-${pwaVersion()}`);
    // It stores only the offline page; no page of the app, no /api.
    expect(body).toContain(`const KEEP = ["${OFFLINE_PATH}"];`);
    expect(body).not.toMatch(/cache\.put\(request|cache\.add\(request/);
  });

  it("serves the offline page as fixed HTML without scripts", async () => {
    const response = offlinePage();
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("Sin conexión");
    expect(html).not.toContain("<script");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("describes the app in Spanish with the brand colors and icons", () => {
    const app = manifest();
    expect(app).toMatchObject({
      name: "WMS",
      short_name: "WMS",
      lang: "es-MX",
      start_url: "/inicio",
      scope: "/",
      display: "standalone",
      background_color: PWA_COLORS.light.background,
      theme_color: PWA_COLORS.light.background,
    });
    expect(app.icons?.map((icon) => icon.purpose)).toContain("maskable");
    expect(app.icons?.every((icon) => icon.type === "image/png")).toBe(true);
  });

  it("loads worker, manifest, icons and offline page without a session", () => {
    for (const path of [
      "/sw.js",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/apple-icon.png",
      OFFLINE_PATH,
    ]) {
      const response = proxy(request(path));
      expect(response.headers.get("location"), path).toBeNull();
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy, path).toContain("worker-src 'self' blob:");
      expect(policy, path).toContain("manifest-src 'self'");
      expect(policy, path).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
    // The app itself still asks for a session.
    expect(proxy(request("/inicio")).headers.get("location")).toContain(
      "/ingresar",
    );
  });

  it("allows the camera only for this site and keeps the rest off", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((rule) => rule.source === "/:path*")!;
    const policy = all.headers.find(
      (header) => header.key === "Permissions-Policy",
    )!.value;
    expect(policy).toContain("camera=(self)");
    expect(policy).not.toMatch(/camera=\*|camera=\(\s*\*/);
    for (const off of ["microphone=()", "geolocation=()", "payment=()"]) {
      expect(policy).toContain(off);
    }
  });
});
