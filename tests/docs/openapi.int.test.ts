import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { apiRoutes } from "@/app/api/v1/_routes";
import { buildOpenApiDocument } from "@/platform/api";

// WMS-60 (ADR 0058): the published document is the one generated from the
// Zod schemas that validate the routes. After changing a route:
//   WRITE_OPENAPI=1 npx vitest run --project integration tests/docs/openapi.int.test.ts
const FILE = path.join(process.cwd(), "docs/api/openapi.json");

describe("documento OpenAPI publicado", () => {
  it("coincide con el que se genera de las rutas", () => {
    const generated = `${JSON.stringify(buildOpenApiDocument(apiRoutes), null, 2)}\n`;
    if (process.env.WRITE_OPENAPI === "1") writeFileSync(FILE, generated);
    expect(readFileSync(FILE, "utf8")).toBe(generated);
  });

  it("describe cada ruta con su capacidad y sus errores", () => {
    const document = buildOpenApiDocument(apiRoutes);
    for (const route of apiRoutes) {
      const operation = (document.paths[route.path] as Record<string, Record<string, unknown>>)[
        route.method.toLowerCase()
      ];
      expect(operation?.description).toContain(route.capability);
      expect(Object.keys(operation?.responses as object)).toEqual(
        expect.arrayContaining(["401", "403", "404", "429"]),
      );
    }
  });
});
