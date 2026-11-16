import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_ITEMS, visibleNavItems } from "@/components";
import {
  ROLES,
  can,
  isPermission,
  type Permission,
  type Subject,
} from "@/platform/authorization";

// USR-09: the menu hides what the person's roles do not allow, and every
// screen asks the server for the same permission before showing anything.

const menuOf = (subject: Subject) =>
  visibleNavItems((permission) => can(subject, permission as Permission)).map(
    (item) => item.label,
  );

// Every module contracted (WMS-59): roles tied to a module need it.
const EVERY_MODULE = new Map([
  ["inventory", "active"],
  ["purchasing", "active"],
  ["production", "active"],
  ["quality", "active"],
] as const);
const member = (...roles: string[]): Subject => ({
  isOwner: false,
  roles,
  modules: EVERY_MODULE,
});

describe("menu by role", () => {
  it("every item names a permission of the catalog", () => {
    for (const item of NAV_ITEMS) {
      if (item.permission !== null) {
        expect(isPermission(item.permission), item.href).toBe(true);
      }
    }
  });

  it("titular and administrator see every section", () => {
    const all = NAV_ITEMS.map((item) => item.label);
    expect(menuOf({ isOwner: true, roles: [] })).toEqual(all);
    expect(menuOf(member("administrator"))).toEqual(all);
  });

  it("Almacén does not see Compras; it runs the tasks (WMS-07)", () => {
    expect(menuOf(member("warehouse"))).toEqual([
      "Inicio",
      "Tareas",
      "Pedidos",
      "Inventario",
      "Movimientos",
      "Conteos",
      // WMS-39: the floor reports problems; supervision attends them.
      "Incidencias",
      "Configuración",
    ]);
  });

  it("Comprador does not see Conteos; it receives at the dock (WMS-04)", () => {
    expect(menuOf(member("buyer"))).toEqual([
      "Inicio",
      "Recepción",
      "Inventario",
      "Movimientos",
      "Compras",
      "Configuración",
    ]);
  });

  it("Consulta sees every section it can read", () => {
    expect(menuOf(member("viewer"))).toEqual(
      NAV_ITEMS.map((item) => item.label),
    );
  });

  it("Gerencia sees every section, to read (WMS-50)", () => {
    expect(menuOf(member("manager"))).toEqual(
      NAV_ITEMS.map((item) => item.label),
    );
  });

  it("Montacarguista sees its tasks and the stock (WMS-07)", () => {
    expect(menuOf(member("forklift"))).toEqual([
      "Inicio",
      "Tareas",
      "Inventario",
      "Incidencias",
      "Configuración",
    ]);
  });

  it("a member without roles only sees Inicio and Configuración", () => {
    expect(menuOf(member())).toEqual(["Inicio", "Configuración"]);
    expect(menuOf(member("cajero"))).toEqual(["Inicio", "Configuración"]);
  });

  it("combined roles see the union", () => {
    expect(menuOf(member("warehouse", "buyer"))).toEqual(
      NAV_ITEMS.map((item) => item.label),
    );
    expect(ROLES.length).toBe(11);
  });

  // WMS-59: production and quality have no section yet (each step adds its
  // own); their roles see what they read of Inventario, with their module.
  it("Operario de producción sees its tasks, the stock and incidents", () => {
    expect(menuOf(member("production_operator"))).toEqual([
      "Inicio",
      "Tareas",
      "Inventario",
      "Incidencias",
      "Configuración",
    ]);
  });

  it("Encargado de producción and Inspector de calidad see the stock and incidents", () => {
    for (const role of ["production_supervisor", "quality_inspector"]) {
      expect(menuOf(member(role)), role).toEqual([
        "Inicio",
        "Inventario",
        "Incidencias",
        "Configuración",
      ]);
    }
  });

  it("without their module the new roles see only Inicio and Configuración", () => {
    const onlyInventory = new Map([["inventory", "active"]] as const);
    for (const role of [
      "production_operator",
      "production_supervisor",
      "quality_inspector",
    ]) {
      expect(menuOf({ isOwner: false, roles: [role] }), role).toEqual([
        "Inicio",
        "Configuración",
      ]);
      expect(
        menuOf({ isOwner: false, roles: [role], modules: onlyInventory }),
        role,
      ).toEqual(["Inicio", "Configuración"]);
    }
    // Calidad without Producción does not happen (dependsOn), and even
    // then the production roles stay asleep.
    expect(
      menuOf({
        isOwner: false,
        roles: ["production_operator"],
        modules: new Map([["quality", "active"]] as const),
      }),
    ).toEqual(["Inicio", "Configuración"]);
  });

  it("Almacén and Supervisor de almacén keep their menu with Producción", () => {
    expect(menuOf(member("supervisor"))).toEqual(
      menuOf({ isOwner: false, roles: ["supervisor"] }),
    );
  });
});

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [full] : [];
  });
}

describe("screens check on the server", () => {
  const root = path.join(process.cwd(), "src/app/(app)");

  it("every screen of the app resolves the person's access itself", () => {
    const found = pages(root);
    expect(found.length).toBeGreaterThanOrEqual(NAV_ITEMS.length);
    for (const file of found) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(
        /await (getAccess|getModuleAccess|requirePermission|requireModulePermission)\(/,
      );
    }
  });

  it("every section screen asks for the permission its menu item names", () => {
    for (const item of NAV_ITEMS) {
      if (item.permission === null) continue;
      const source = readFileSync(
        path.join(root, item.href.slice(1), "page.tsx"),
        "utf8",
      );
      expect(source, item.href).toContain(
        `if (!access.can("${item.permission}"))`,
      );
      expect(source, item.href).toContain("<NoAccessState");
      // …and for the module the company must have (MOD-05).
      expect(source, item.href).toContain(
        `access.moduleState("${item.module}")`,
      );
      expect(item.permission.startsWith(`${item.module}.`), item.href).toBe(
        true,
      );
    }
  });
});
