import type { MetadataRoute } from "next";

import { MANIFEST_ICONS, PWA_COLORS } from "@/lib";

/**
 * Web app manifest (WMS-35, ADR 0049): installs as «WMS» and opens the app
 * (without a session /inicio sends people to /ingresar). One color only:
 * the light background; the dark one comes from viewport.themeColor.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/inicio",
    name: "WMS",
    short_name: "WMS",
    description: "Gestión de almacenes.",
    lang: "es-MX",
    dir: "ltr",
    start_url: "/inicio",
    scope: "/",
    display: "standalone",
    background_color: PWA_COLORS.light.background,
    theme_color: PWA_COLORS.light.background,
    categories: ["business", "productivity"],
    icons: MANIFEST_ICONS.map((icon) => ({ ...icon, type: "image/png" })),
  };
}
