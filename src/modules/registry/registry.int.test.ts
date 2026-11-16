import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/components";
import { PERMISSIONS } from "@/platform/authorization";

import { moduleRegistry } from "./index";

// MOD-02: the real registry starts, with Inventario, Compras and
// Producción (since WMS-27) available, and Calidad (WMS-59) and CRM
// announced but not contractable (Ventas was removed, WMS-02).

describe("installed modules", () => {
  it("starts with the five modules installed today", () => {
    expect(moduleRegistry.all.map((m) => m.id).sort()).toEqual([
      "crm",
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
    // Producción is available since WMS-27 (recipes, ADR 0066); Calidad
    // stays announced until WMS-30A leaves something to use.
    expect(moduleRegistry.get("production").availability).toBe("available");
    expect(moduleRegistry.get("quality").availability).toBe("unavailable");
    for (const id of ["production", "quality"]) {
      expect(moduleRegistry.get(id).permissions.length, id).toBeGreaterThan(0);
    }
  });

  it("Inventario is the base; Inventario, Compras and Producción can be contracted", () => {
    expect(moduleRegistry.base.id).toBe("inventory");
    expect(moduleRegistry.available.map((m) => m.id).sort()).toEqual([
      "inventory",
      "production",
      "purchasing",
    ]);
  });

  it("CRM cannot be contracted yet", () => {
    expect(moduleRegistry.get("crm")).toMatchObject({
      availability: "unavailable",
    });
    expect(moduleRegistry.get("crm")?.permissions).toEqual([]);
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
    ).toEqual(["production", "purchasing"]);
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
