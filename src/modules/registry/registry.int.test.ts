import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/components";
import { PERMISSIONS } from "@/platform/authorization";

import { moduleRegistry } from "./index";

// MOD-02: the real registry starts, with Inventario, Compras, Producción
// and Calidad (WMS-30A) available (Ventas was removed, WMS-02; CRM, WMS-81).

describe("installed modules", () => {
  it("starts with the four modules installed today", () => {
    expect(moduleRegistry.all.map((m) => m.id).sort()).toEqual([
      "inventory",
      "production",
      "purchasing",
      "quality",
    ]);
  });

  it("Calidad needs Producción, which needs Inventario (D9, ADR 0062)", () => {
    expect(moduleRegistry.dependenciesOf("quality").map((m) => m.id)).toEqual([
      "inventory",
      "production",
    ]);
    expect(moduleRegistry.dependentsOf("production").map((m) => m.id)).toEqual([
      "quality",
    ]);
    // Available since their first steps (WMS-27, WMS-30A).
    for (const id of ["production", "quality"]) {
      expect(moduleRegistry.get(id).availability, id).toBe("available");
      expect(moduleRegistry.get(id).permissions.length, id).toBeGreaterThan(0);
    }
  });

  it("Inventario is the base; Inventario, Compras, Producción and Calidad can be contracted", () => {
    expect(moduleRegistry.base.id).toBe("inventory");
    expect(moduleRegistry.available.map((m) => m.id).sort()).toEqual([
      "inventory",
      "production",
      "purchasing",
      "quality",
    ]);
  });

  it("Compras needs Inventario; removing it would break it", () => {
    expect(
      moduleRegistry.dependenciesOf("purchasing").map((m) => m.id),
    ).toEqual(["inventory"]);
    expect(
      moduleRegistry
        .dependentsOf("inventory")
        .filter((m) => m.availability === "available")
        .map((m) => m.id)
        .sort(),
    ).toEqual(["production", "purchasing", "quality"]);
  });

  it("every business permission of the catalog belongs to exactly one module", () => {
    for (const permission of PERMISSIONS) {
      const owner = moduleRegistry.moduleOfPermission(permission);
      if (permission.startsWith("platform.")) {
        expect(owner, permission).toBeNull();
      } else {
        expect(owner?.id, permission).toBe(permission.split(".")[0]);
      }
    }
    const owned = moduleRegistry.all.flatMap((m) => m.permissions);
    expect(owned.length).toBe(
      PERMISSIONS.filter((p) => !p.startsWith("platform.")).length,
    );
  });

  it("every menu section names a registered module", () => {
    for (const item of NAV_ITEMS) {
      if (item.module !== null) {
        expect(moduleRegistry.has(item.module), item.href).toBe(true);
      }
    }
  });

  it("the base declares the product quota", () => {
    expect(moduleRegistry.base.limits.map((l) => l.key)).toEqual([
      "active_products",
    ]);
  });
});
