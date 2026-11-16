import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  OWNER_PERMISSIONS,
  PERMISSIONS,
  ROLE_MODULE,
  ROLE_PERMISSIONS,
  ROLES,
  isPermission,
  isRole,
  type Permission,
} from "./catalog";

// USR-01: the catalog in code is exactly the matrix approved by the founder
// (docs/MATRIZ_ROLES_PERMISOS.md, FUN-07), and the founder's decisions hold.

const doc = readFileSync(
  path.join(process.cwd(), "docs/MATRIZ_ROLES_PERMISOS.md"),
  "utf8",
);
const COLUMNS = [
  "owner",
  "administrator",
  "warehouse",
  "buyer",
  "viewer",
  "supervisor",
  "operator",
  "forklift",
  "manager",
  "production_operator",
  "production_supervisor",
  "quality_inspector",
];
const rows = [
  ...doc.matchAll(
    /^\| `([a-z_.]+)` \|[^\n]*?\| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \|$/gm,
  ),
].map(([, id, ...cells]) => ({ id: id!, cells: cells as string[] }));

function granted(column: string): string[] {
  const index = COLUMNS.indexOf(column);
  return rows
    .filter((r) => r.cells[index] === "Sí")
    .map((r) => r.id)
    .sort();
}

const of = (role: keyof typeof ROLE_PERMISSIONS) =>
  new Set<string>(ROLE_PERMISSIONS[role]);

describe("catalog = approved matrix", () => {
  it("has every permission of the document, once", () => {
    expect(rows.length).toBeGreaterThan(70);
    expect([...PERMISSIONS].sort()).toEqual(rows.map((r) => r.id).sort());
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it.each(["owner", ...ROLES])("%s matches its column", (column) => {
    const code =
      column === "owner"
        ? OWNER_PERMISSIONS
        : ROLE_PERMISSIONS[column as keyof typeof ROLE_PERMISSIONS];
    expect([...code].sort()).toEqual(granted(column));
  });

  it("uses stable module.resource.action identifiers", () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(
        /^(platform|inventory|purchasing|production|quality)\.[a-z_]+\.[a-z_]+$/,
      );
    }
  });
});

describe("founder decisions (FUN-07)", () => {
  it("Consulta never writes: it only reads and downloads what it can see", () => {
    for (const permission of of("viewer")) {
      expect(permission).toMatch(
        /\.(read|export)$|^inventory\.export\.create$/,
      );
    }
  });

  it("Consulta does not see prices or costs, not even in the order PDF (4)", () => {
    expect(of("viewer").has("purchasing.cost.read")).toBe(false);
    expect(of("viewer").has("purchasing.order.export")).toBe(false);
  });

  it("Almacén does not buy, receive or return goods (2)", () => {
    // WMS-57: it may ask Compras for goods (a purchase request), which is
    // not buying: it sees no orders, suppliers nor costs.
    for (const permission of of("warehouse")) {
      if (permission.startsWith("purchasing.request.")) continue;
      expect(permission.startsWith("purchasing.")).toBe(false);
    }
    expect(of("warehouse").has("purchasing.request.create")).toBe(true);
  });

  it("Almacén adjusts, reverses and applies counts (with a reason, 1)", () => {
    for (const p of [
      "inventory.adjustment.create",
      "inventory.movement.reverse",
      "inventory.count.apply",
    ] as Permission[]) {
      expect(of("warehouse").has(p)).toBe(true);
    }
  });

  it("Comprador runs its orders without extra approval (3)", () => {
    for (const p of [
      "purchasing.order.submit",
      "purchasing.order.cancel",
      "purchasing.order.close",
      "purchasing.receipt.create",
      "purchasing.return.create",
    ] as Permission[]) {
      expect(of("buyer").has(p)).toBe(true);
    }
    expect(isPermission("purchasing.order.approve")).toBe(false);
  });

  it("Administrador never pays, contracts, cancels or transfers ownership", () => {
    for (const p of [
      "platform.billing.read",
      "platform.billing.manage",
      "platform.subscription.create",
      "platform.subscription.cancel",
      "platform.plan.change",
      "platform.module.activate",
      "platform.module.deactivate",
      "platform.ownership.transfer",
    ] as Permission[]) {
      expect(of("administrator").has(p)).toBe(false);
      expect(OWNER_PERMISSIONS).toContain(p);
    }
  });

  it("the full audit log is for titular and administrators only (7)", () => {
    expect(OWNER_PERMISSIONS).toContain("platform.audit.read");
    expect(of("administrator").has("platform.audit.read")).toBe(true);
    for (const role of [
      "warehouse",
      "buyer",
      "viewer",
      "supervisor",
      "operator",
      "forklift",
    ] as const) {
      expect(of(role).has("platform.audit.read")).toBe(false);
    }
  });

  it("nobody in a company, not even the titular, provisions plans", () => {
    expect(OWNER_PERMISSIONS).not.toContain("platform.provisioning.manage");
    for (const role of ROLES) {
      expect(of(role).has("platform.provisioning.manage")).toBe(false);
    }
  });
});

describe("operational roles (WMS-05)", () => {
  it("Almacenista receives and moves goods but never corrects stock", () => {
    for (const p of [
      "purchasing.receipt.create",
      "inventory.entry.create",
      "inventory.exit.create",
      "inventory.transfer.create",
      "inventory.count.update",
    ] as Permission[]) {
      expect(of("operator").has(p)).toBe(true);
    }
    for (const p of [
      "inventory.adjustment.create",
      "inventory.movement.reverse",
      "inventory.count.apply",
      "inventory.product.create",
      "inventory.cost.read",
      "purchasing.cost.read",
      "inventory.status.change",
      "inventory.status.release",
    ] as Permission[]) {
      expect(of("operator").has(p)).toBe(false);
    }
    // WMS-11: the floor reports damage; it does not quarantine or release.
    expect(of("operator").has("inventory.damage.report")).toBe(true);
  });

  it("Montacarguista reads and does its tasks: it never types quantities freely", () => {
    // WMS-39: reporting a problem of the floor (an incident) moves nothing
    // and types no quantity.
    for (const permission of of("forklift")) {
      expect(permission).toMatch(
        /\.read$|^inventory\.task\.execute$|^inventory\.incident\.create$/,
      );
    }
    expect(of("forklift").has("inventory.task.execute")).toBe(true);
    expect(of("forklift").has("inventory.transfer.create")).toBe(false);
  });

  it("Supervisor de almacén is Almacén plus receiving and the team list", () => {
    for (const permission of of("warehouse")) {
      expect(of("supervisor").has(permission)).toBe(true);
    }
    expect(of("supervisor").has("purchasing.receipt.create")).toBe(true);
    expect(of("supervisor").has("platform.team.read")).toBe(true);
    expect(of("supervisor").has("platform.team.assign_roles")).toBe(false);
    expect(of("supervisor").has("purchasing.cost.read")).toBe(false);
  });
});

describe("Gerencia (WMS-50)", () => {
  it("reads and exports everything operational, and never writes", () => {
    for (const permission of of("manager")) {
      expect(permission).toMatch(
        /\.(read|export)$|^inventory\.export\.create$/,
      );
    }
    for (const permission of PERMISSIONS) {
      if (
        /^(inventory|purchasing|production|quality)\.[a-z_]+\.(read|export)$/.test(
          permission,
        )
      ) {
        expect(of("manager").has(permission)).toBe(true);
      }
    }
    expect(of("manager").has("inventory.cost.read")).toBe(true);
    expect(of("manager").has("platform.audit.read")).toBe(true);
    expect(of("manager").has("platform.billing.read")).toBe(false);
    expect(of("manager").has("platform.organization.update")).toBe(false);
  });
});

describe("production and quality roles (WMS-59, ADR 0062)", () => {
  const ofModule = (prefix: string) =>
    PERMISSIONS.filter((p) => p.startsWith(prefix));
  const production = ofModule("production.");
  const quality = ofModule("quality.");

  it("each new role is tied to its module", () => {
    expect(ROLE_MODULE).toEqual({
      production_operator: "production",
      production_supervisor: "production",
      quality_inspector: "quality",
    });
  });

  it("titular and Administrador get every permission of both modules", () => {
    for (const p of [...production, ...quality]) {
      expect(OWNER_PERMISSIONS).toContain(p);
      expect(of("administrator").has(p)).toBe(true);
    }
  });

  it("no new role reads costs, writes the catalog, corrects stock or manages the team", () => {
    for (const role of [
      "production_operator",
      "production_supervisor",
      "quality_inspector",
    ] as const) {
      for (const p of of(role)) {
        expect(p, role).not.toMatch(/\.cost\./);
        expect(p, role).toMatch(
          /^(platform\.(organization|module)\.read|inventory\.[a-z_]+\.read|inventory\.(task\.execute|incident\.create)|production\.|quality\.)/,
        );
      }
      expect(of(role).has("inventory.adjustment.create")).toBe(false);
      expect(of(role).has("inventory.movement.reverse")).toBe(false);
    }
  });

  it("Operario reports and asks; it never runs orders, verifies or decides", () => {
    for (const p of [
      "production.report.create",
      "production.request.create",
      "production.scrap.create",
      "inventory.task.execute",
    ] as Permission[]) {
      expect(of("production_operator").has(p)).toBe(true);
    }
    for (const p of [
      "production.order.create",
      "production.order.release",
      "production.order.cancel",
      "production.order.close",
      "production.recipe.manage",
      "production.request.decide",
      "production.output.verify",
      "production.report.reverse",
      "inventory.status.release",
    ] as Permission[]) {
      expect(of("production_operator").has(p)).toBe(false);
    }
    for (const p of quality) {
      expect(of("production_operator").has(p)).toBe(false);
    }
  });

  it("Encargado runs production and decides with the stock in sight (P7)", () => {
    for (const p of production) {
      expect(of("production_supervisor").has(p)).toBe(true);
    }
    expect(of("production_supervisor").has("inventory.stock.read")).toBe(true);
    expect(of("production_supervisor").has("inventory.minimum.read")).toBe(
      true,
    );
    expect(of("production_supervisor").has("inventory.task.execute")).toBe(
      false,
    );
  });

  it("Inspector inspects and releases; it never reports or runs orders", () => {
    for (const p of [
      "quality.inspection.read",
      "quality.inspection.create",
      "quality.inspection.decide",
      "quality.lot.release",
      "quality.plan.read",
    ] as Permission[]) {
      expect(of("quality_inspector").has(p)).toBe(true);
    }
    expect(of("quality_inspector").has("quality.plan.manage")).toBe(false);
    for (const p of production) {
      expect(of("quality_inspector").has(p)).toBe(
        p === "production.order.read",
      );
    }
  });

  it("Almacén and Supervisor de almacén decide requests but get no power over orders (P7c, P7d)", () => {
    for (const role of ["warehouse", "supervisor"] as const) {
      expect(
        [...of(role)].filter((p) => p.startsWith("production.")).sort(),
      ).toEqual([
        "production.order.read",
        "production.recipe.read",
        "production.request.decide",
        "production.request.read",
      ]);
      for (const p of quality) expect(of(role).has(p)).toBe(false);
    }
  });

  it("Almacenista, Montacarguista and Comprador get nothing of either module", () => {
    for (const role of ["operator", "forklift", "buyer"] as const) {
      for (const p of [...production, ...quality]) {
        expect(of(role).has(p), `${role} ${p}`).toBe(false);
      }
    }
  });

  it("Consulta and Gerencia only read both modules", () => {
    for (const role of ["viewer", "manager"] as const) {
      for (const p of [...production, ...quality]) {
        expect(of(role).has(p), `${role} ${p}`).toBe(p.endsWith(".read"));
      }
    }
  });
});

describe("guards", () => {
  it("recognizes only catalog roles and permissions", () => {
    expect(isRole("warehouse")).toBe(true);
    expect(isRole("owner")).toBe(false); // the titular is not a role
    expect(isRole("Administrador")).toBe(false);
    expect(isPermission("inventory.product.read")).toBe(true);
    expect(isPermission("inventory.*")).toBe(false);
  });
});
