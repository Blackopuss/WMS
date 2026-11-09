import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  OWNER_PERMISSIONS,
  PERMISSIONS,
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
];
const rows = [
  ...doc.matchAll(
    /^\| `([a-z_.]+)` \|[^\n]*?\| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \| (Sí|No) \|$/gm,
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
        /^(platform|inventory|purchasing)\.[a-z_]+\.[a-z_]+$/,
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
    for (const permission of of("warehouse")) {
      expect(permission.startsWith("purchasing.")).toBe(false);
    }
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
    ] as Permission[]) {
      expect(of("operator").has(p)).toBe(false);
    }
  });

  it("Montacarguista reads and does its tasks: it never types quantities freely", () => {
    for (const permission of of("forklift")) {
      expect(permission).toMatch(/\.read$|^inventory\.task\.execute$/);
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

describe("guards", () => {
  it("recognizes only catalog roles and permissions", () => {
    expect(isRole("warehouse")).toBe(true);
    expect(isRole("owner")).toBe(false); // the titular is not a role
    expect(isRole("Administrador")).toBe(false);
    expect(isPermission("inventory.product.read")).toBe(true);
    expect(isPermission("inventory.*")).toBe(false);
  });
});
