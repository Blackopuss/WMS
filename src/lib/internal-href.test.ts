import { describe, expect, it } from "vitest";

import { isInternalHref } from "./internal-href";

describe("isInternalHref (WMS-39)", () => {
  it("accepts paths of the app", () => {
    for (const href of [
      "/",
      "/tareas/0190a1b2-0000-7000-8000-000000000001",
      "/pedidos?estado=por-empacar",
      "/tareas?vista=mine&pagina=2",
      "/inventario/lotes/abc#detalle",
    ]) {
      expect(isInternalHref(href), href).toBe(true);
    }
  });

  it("rejects other hosts, schemes and odd text", () => {
    for (const href of [
      "",
      "tareas",
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/a b",
      "/a\nb",
      "/a:b",
      "/<script>",
      `/${"a".repeat(300)}`,
      null,
      42,
    ]) {
      expect(isInternalHref(href), String(href)).toBe(false);
    }
  });
});
