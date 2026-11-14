import { describe, expect, it } from "vitest";

import {
  OWNER_PERMISSIONS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from "./catalog";
import {
  OWNER_ONLY_PERMISSIONS,
  buildScope,
  can,
  canAll,
  canAny,
  inScope,
  isOwnerOnly,
  knownRoles,
  permissionsOf,
  scopeOf,
  intersectScopes,
  type Subject,
} from "./policy";

// USR-02: one decision function, tested for every role and every action,
// denying by default.

const member = (...roles: string[]) => ({ isOwner: false, roles });
const owner = (...roles: string[]) => ({ isOwner: true, roles });

describe("can: every role against every permission", () => {
  for (const role of ROLES) {
    it(`${role} gets exactly its list`, () => {
      const allowed = new Set<string>(ROLE_PERMISSIONS[role]);
      for (const permission of PERMISSIONS) {
        expect(can(member(role), permission), permission).toBe(
          allowed.has(permission),
        );
      }
    });
  }

  it("titular gets exactly the titular list", () => {
    const allowed = new Set<string>(OWNER_PERMISSIONS);
    for (const permission of PERMISSIONS) {
      expect(can(owner(), permission), permission).toBe(
        allowed.has(permission),
      );
    }
  });
});

describe("deny by default", () => {
  it("a member without roles can do nothing", () => {
    expect(permissionsOf(member()).size).toBe(0);
    for (const permission of PERMISSIONS) {
      expect(can(member(), permission)).toBe(false);
    }
  });

  it.each(["owner", "titular", "Administrador", "ADMINISTRATOR", "admin", ""])(
    "unknown role %j grants nothing",
    (role) => {
      expect(permissionsOf(member(role)).size).toBe(0);
    },
  );

  it.each([
    "inventory.product.delete",
    "inventory.*",
    "*",
    "",
    "INVENTORY.PRODUCT.READ",
    "toString",
    "__proto__",
  ])("unknown permission %j is denied even to the titular", (permission) => {
    expect(can(owner("administrator"), permission as Permission)).toBe(false);
    expect(canAny(owner(), [permission as Permission])).toBe(false);
    expect(canAll(owner(), [permission as Permission])).toBe(false);
  });

  it.each([undefined, null, 1, {}, []])(
    "non-text permission %j is denied",
    (permission) => {
      expect(can(owner(), permission as unknown as Permission)).toBe(false);
    },
  );

  it("a truthy value that is not `true` does not make a titular", () => {
    const fake = { isOwner: "yes" as unknown as boolean, roles: [] };
    expect(permissionsOf(fake).size).toBe(0);
  });

  it("nobody in a company can provision the platform", () => {
    for (const role of ROLES) {
      expect(can(owner(role), "platform.provisioning.manage")).toBe(false);
    }
  });

  it("an empty list is never satisfied", () => {
    expect(canAll(owner(), [])).toBe(false);
    expect(canAny(owner(), [])).toBe(false);
  });
});

describe("support (PIL-12)", () => {
  const support = { isOwner: false, roles: ["viewer"], support: true };

  it("keeps only what reads: no writing, no exports", () => {
    const granted = [...permissionsOf(support)];
    expect(granted.length).toBeGreaterThan(0);
    expect(granted.every((p) => p.endsWith(".read"))).toBe(true);
    expect(can(support, "inventory.product.read")).toBe(true);
    expect(can(support, "inventory.export.create")).toBe(false);
    expect(can(support, "purchasing.report.export")).toBe(false);
    expect(can(support, "purchasing.cost.read")).toBe(false);
  });

  it("does not add anything even with more roles or the titular flag", () => {
    const loaded = { isOwner: true, roles: [...ROLES], support: true };
    expect(can(loaded, "platform.subscription.create")).toBe(false);
    expect(can(loaded, "inventory.adjustment.create")).toBe(false);
  });
});

describe("shared terminal (WMS-38)", () => {
  it("keeps the floor's work and cuts every platform permission but reading the company", () => {
    const supervisor = { isOwner: false, roles: ["supervisor"] };
    const atTerminal = { ...supervisor, terminal: true };
    expect(can(supervisor, "platform.team.read")).toBe(true);
    expect(can(atTerminal, "platform.team.read")).toBe(false);
    expect(can(atTerminal, "platform.organization.read")).toBe(true);
    expect(can(atTerminal, "inventory.task.execute")).toBe(true);
    const everything = { isOwner: true, roles: [...ROLES], terminal: true };
    const platform = [...permissionsOf(everything)].filter((p) =>
      p.startsWith("platform."),
    );
    // Concrete permissions, not the policy's own lists (WMS-38 review).
    // Bulk exports and reports: never, whatever the roles.
    for (const permission of [
      "inventory.export.create",
      "purchasing.order.export",
      "purchasing.report.export",
    ] as const) {
      expect(can(everything, permission)).toBe(false);
    }
    // Documents of one operation without costs: kept for the floor.
    const floor = { isOwner: false, roles: ["warehouse"], terminal: true };
    expect(can(floor, "inventory.shipment.export")).toBe(true);
    expect(can(floor, "inventory.facility_transfer.export")).toBe(true);
    // Reading costs: never. Recording the last cost shows nothing: kept.
    expect(can(everything, "inventory.cost.read")).toBe(false);
    expect(can(everything, "purchasing.cost.read")).toBe(false);
    expect(can(everything, "purchasing.cost.record")).toBe(true);
    // No team, sessions, audit, plan, terminals nor approvals' rules.
    for (const permission of [
      "platform.team.invite",
      "platform.session.revoke",
      "platform.audit.read",
      "platform.plan.read",
      "platform.terminal.manage",
      "platform.organization.update",
    ] as const) {
      expect(can(everything, permission)).toBe(false);
    }
    expect(can(everything, "inventory.task.execute")).toBe(true);
    expect(can(everything, "purchasing.receipt.create")).toBe(true);
    expect(platform.sort()).toEqual(
      [
        "platform.capacity.read",
        "platform.module.read",
        "platform.organization.read",
      ].sort(),
    );
  });

  it("applies on top of an API key's cut, never instead of it (WMS-60)", () => {
    const both: Subject = {
      isOwner: false,
      roles: ["supervisor"],
      terminal: true,
      limit: {
        permissions: new Set([
          "inventory.stock.read",
          "inventory.export.create",
          "platform.team.read",
        ]),
        scope: buildScope([{ facilityId: "B", locationId: null }]),
      },
    };
    // The key drops what it does not name; the terminal drops exports and
    // the team, so only what both keep survives.
    expect([...permissionsOf(both)]).toEqual(["inventory.stock.read"]);
    expect(can(both, "inventory.task.execute")).toBe(false);
    expect(inScope(both, { facilityId: "B" })).toBe(true);
    expect(inScope(both, { facilityId: "A" })).toBe(false);
  });

  it("support and terminal together keep only what both keep", () => {
    const both = {
      isOwner: false,
      roles: ["administrator"],
      support: true,
      terminal: true,
    };
    expect(can(both, "platform.team.read")).toBe(false);
    expect(can(both, "platform.audit.read")).toBe(false);
    expect(can(both, "inventory.cost.read")).toBe(false);
    expect(can(both, "inventory.stock.read")).toBe(true);
    expect(can(both, "inventory.task.execute")).toBe(false);
  });

  it("never manages API keys nor webhooks", () => {
    const titular = { isOwner: true, roles: [...ROLES] };
    expect(can(titular, "platform.api.manage")).toBe(true);
    expect(can({ ...titular, terminal: true }, "platform.api.manage")).toBe(
      false,
    );
  });
});

describe("combined roles", () => {
  it("join their permissions and add nothing else", () => {
    for (const a of ROLES) {
      for (const b of ROLES) {
        const expected = new Set<string>([
          ...ROLE_PERMISSIONS[a],
          ...ROLE_PERMISSIONS[b],
        ]);
        expect(new Set<string>(permissionsOf(member(a, b)))).toEqual(expected);
      }
    }
  });

  it("warehouse + buyer moves stock and buys, but does not manage the team", () => {
    const subject = member("warehouse", "buyer");
    expect(can(subject, "inventory.adjustment.create")).toBe(true);
    expect(can(subject, "purchasing.order.create")).toBe(true);
    expect(can(subject, "platform.team.invite")).toBe(false);
  });

  it("repeated and unknown roles are ignored", () => {
    expect(knownRoles(["viewer", "viewer", "cajero", "buyer"])).toEqual<Role[]>(
      ["buyer", "viewer"],
    );
  });

  it("roles never take anything away from the titular", () => {
    expect(new Set<string>(permissionsOf(owner("viewer")))).toEqual(
      new Set<string>(OWNER_PERMISSIONS),
    );
  });
});

describe("rules of the approved matrix", () => {
  it("viewer never writes", () => {
    for (const permission of permissionsOf(member("viewer"))) {
      expect(permission).toMatch(/\.(read|export|create)$/);
    }
    expect(can(member("viewer"), "inventory.entry.create")).toBe(false);
    expect(can(member("viewer"), "purchasing.cost.read")).toBe(false);
  });

  it("warehouse does not buy, receive or return", () => {
    // WMS-57: asking Compras for goods (a purchase request) is not buying.
    for (const permission of PERMISSIONS) {
      if (
        permission.startsWith("purchasing.") &&
        !permission.startsWith("purchasing.request.")
      ) {
        expect(can(member("warehouse"), permission), permission).toBe(false);
      }
    }
  });

  it("administrator does not charge, contract or transfer", () => {
    for (const permission of [
      "platform.billing.read",
      "platform.billing.manage",
      "platform.subscription.create",
      "platform.subscription.cancel",
      "platform.plan.change",
      "platform.module.activate",
      "platform.module.deactivate",
      "platform.ownership.transfer",
    ] as const) {
      expect(can(member("administrator"), permission), permission).toBe(false);
      expect(can(owner(), permission), permission).toBe(true);
    }
  });

  it("canAll and canAny", () => {
    const buyer = member("buyer");
    expect(
      canAll(buyer, ["purchasing.order.create", "inventory.stock.read"]),
    ).toBe(true);
    expect(
      canAll(buyer, ["purchasing.order.create", "inventory.entry.create"]),
    ).toBe(false);
    expect(
      canAny(buyer, ["inventory.entry.create", "purchasing.order.create"]),
    ).toBe(true);
    expect(canAny(buyer, ["inventory.entry.create"])).toBe(false);
  });
});

// USR-03A: only the titular contracts, cancels and changes the payment method.
describe("actions reserved to the titular", () => {
  it("are the commercial ones, the transfer and support access", () => {
    expect([...OWNER_ONLY_PERMISSIONS].sort()).toEqual([
      "platform.billing.manage",
      "platform.billing.read",
      "platform.module.activate",
      "platform.module.deactivate",
      "platform.ownership.transfer",
      "platform.plan.change",
      "platform.subscription.cancel",
      "platform.subscription.create",
      "platform.support.grant",
    ]);
  });

  it("no combination of roles reaches them", () => {
    const everyRole = member(...ROLES);
    for (const permission of OWNER_ONLY_PERMISSIONS) {
      expect(isOwnerOnly(permission)).toBe(true);
      expect(can(everyRole, permission), permission).toBe(false);
      expect(can(owner(), permission), permission).toBe(true);
    }
  });

  it("what a role can do is not reserved", () => {
    expect(isOwnerOnly("platform.team.invite")).toBe(false);
    expect(isOwnerOnly("inventory.product.read")).toBe(false);
    expect(isOwnerOnly("platform.provisioning.manage")).toBe(false);
  });
});

// WMS-20: where a person may work is part of the same decision.
describe("scope by warehouse and zone", () => {
  const scope = buildScope([
    { facilityId: "B", locationId: null },
    { facilityId: "C", locationId: "zone-1" },
    { facilityId: "C", locationId: "zone-2" },
  ]);
  const limited = { isOwner: false, roles: ["warehouse"], scope };

  it("no rows = no limit", () => {
    expect(buildScope([])).toBeNull();
    expect(inScope(member("warehouse"), { facilityId: "A" })).toBe(true);
    expect(
      inScope(
        { ...member("warehouse"), scope: null },
        { facilityId: "A", path: ["x"] },
      ),
    ).toBe(true);
  });

  it("a warehouse that is not named is closed", () => {
    expect(inScope(limited, { facilityId: "A" })).toBe(false);
    expect(inScope(limited, { facilityId: "A", path: ["zone-1"] })).toBe(false);
    expect(inScope(limited, { facilityId: "B" })).toBe(true);
    expect(inScope(limited, { facilityId: "B", path: ["any"] })).toBe(true);
  });

  it("with zones, only what is inside them", () => {
    // Somewhere in the warehouse: yes. The location itself or an ancestor.
    expect(inScope(limited, { facilityId: "C" })).toBe(true);
    expect(inScope(limited, { facilityId: "C", path: ["zone-1"] })).toBe(true);
    expect(
      inScope(limited, { facilityId: "C", path: ["shelf", "aisle", "zone-2"] }),
    ).toBe(true);
    expect(inScope(limited, { facilityId: "C", path: ["general"] })).toBe(
      false,
    );
    expect(inScope(limited, { facilityId: "C", path: [] })).toBe(false);
    // A zone only counts in its own warehouse.
    expect(inScope(limited, { facilityId: "B", path: ["zone-1"] })).toBe(true);
    expect(inScope(limited, { facilityId: "A", path: ["zone-1"] })).toBe(false);
  });

  it("a row for the whole warehouse wins over its zones, in any order", () => {
    for (const rows of [
      [
        { facilityId: "C", locationId: "zone-1" },
        { facilityId: "C", locationId: null },
      ],
      [
        { facilityId: "C", locationId: null },
        { facilityId: "C", locationId: "zone-1" },
      ],
    ]) {
      expect(buildScope(rows)?.facilities.get("C")).toBeNull();
    }
  });

  it("the titular is never limited", () => {
    const titular = { isOwner: true, roles: [], scope };
    expect(scopeOf(titular)).toBeNull();
    expect(inScope(titular, { facilityId: "A", path: ["x"] })).toBe(true);
  });

  it("can decides permission and place together", () => {
    expect(can(limited, "inventory.stock.read")).toBe(true);
    expect(can(limited, "inventory.stock.read", { facilityId: "B" })).toBe(
      true,
    );
    expect(can(limited, "inventory.stock.read", { facilityId: "A" })).toBe(
      false,
    );
    // Inside the scope, but without the permission: still no.
    expect(
      can(limited, "platform.team.assign_roles", { facilityId: "B" }),
    ).toBe(false);
  });
});

// WMS-60 (ADR 0058): an API key acts for its creator, cut down to the key.
describe("the cut of an API key", () => {
  const onlyB = { facilities: new Map([["B", null]]) };

  it("keeps only the key's permissions the person also holds", () => {
    const viewer: Subject = {
      isOwner: false,
      roles: ["viewer"],
      limit: {
        permissions: new Set([
          "inventory.stock.read",
          "inventory.outbound.create",
        ]),
        scope: null,
      },
    };
    expect([...permissionsOf(viewer)]).toEqual(["inventory.stock.read"]);
    expect(can(viewer, "inventory.outbound.create")).toBe(false);
    expect(can(viewer, "inventory.product.read")).toBe(false);
  });

  it("never gives the titular's own powers", () => {
    const titular: Subject = {
      isOwner: true,
      roles: [],
      limit: { permissions: new Set(["inventory.stock.read"]), scope: null },
    };
    for (const permission of OWNER_ONLY_PERMISSIONS) {
      expect(can(titular, permission)).toBe(false);
    }
  });

  it("limits the titular to the key's warehouse", () => {
    const titular: Subject = {
      isOwner: true,
      roles: [],
      limit: { permissions: new Set(["inventory.stock.read"]), scope: onlyB },
    };
    expect(inScope(titular, { facilityId: "B" })).toBe(true);
    expect(inScope(titular, { facilityId: "A" })).toBe(false);
  });

  it("intersects the person's scope with the key's", () => {
    const zones = buildScope([
      { facilityId: "A", locationId: null },
      { facilityId: "B", locationId: "z1" },
    ]);
    expect(intersectScopes(zones, null)).toBe(zones);
    expect(intersectScopes(null, onlyB)).toBe(onlyB);
    const both = intersectScopes(zones, onlyB);
    expect([...(both?.facilities.keys() ?? [])]).toEqual(["B"]);
    expect([...(both?.facilities.get("B") ?? [])]).toEqual(["z1"]);
    const none = intersectScopes(zones, { facilities: new Map([["C", null]]) });
    expect(none?.facilities.size).toBe(0);
  });
});
