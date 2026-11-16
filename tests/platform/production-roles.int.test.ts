import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import {
  PERMISSIONS,
  assignRoles,
  createInvitation,
  isAllowed,
  offerOwnershipTransfer,
  type Permission,
  type Role,
} from "@/platform/authorization";
import {
  activateModule,
  assertModulePermission,
  createModuleRegistry,
  deactivateModule,
} from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import { notify } from "@/platform/notifications";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

import { grantSeats } from "../setup/plan";

// WMS-59 (ADR 0062): roles of Producción and Calidad. Calidad is never
// active without Producción; a tied role gives nothing without its module;
// and the negative cases NEG-27 to NEG-31 and NEG-33 of the matrix, with
// real members, through the same guards services use.

const stamp = Date.now();
let counter = 0;

// Calidad is announced today (unavailable; Producción is available since
// WMS-27). The same contracts, marked available, prove their dependency
// rules.
const registry = createModuleRegistry(
  moduleRegistry.all.map((contract) =>
    contract.id === "production" || contract.id === "quality"
      ? { ...contract, availability: "available" as const }
      : contract,
  ),
);

async function newUser(label: string) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: label,
      email: `${label}.${++counter}.prod.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function newCompany(name: string, modules: string[]) {
  const owner = await newUser("titular");
  const created = await createOrganization(owner, { name, timeZone: "" });
  if (!created.ok) throw new Error("company setup failed");
  await grantSeats(created.organizationId);
  for (const moduleId of ["inventory", ...modules]) {
    const result = await activateModule(registry, {
      organizationId: created.organizationId,
      moduleId,
      actorUserId: null,
    });
    if (!result.ok && result.reason !== "unchanged") {
      throw new Error(`could not activate ${moduleId}`);
    }
  }
  return { org: created.organizationId, owner };
}

async function addMember(organizationId: string, roles: Role[]) {
  const userId = await newUser(roles.join("-"));
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId, status: "ACTIVE" },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  return userId;
}

const change = (organizationId: string, moduleId: string) => ({
  organizationId,
  moduleId,
  actorUserId: null,
});

async function expectGrants(
  org: string,
  userId: string,
  permissions: readonly Permission[],
  expected: boolean,
) {
  for (const permission of permissions) {
    expect(await isAllowed(org, userId, permission), permission).toBe(expected);
  }
}

const ofModule = (prefix: string) =>
  PERMISSIONS.filter((permission) => permission.startsWith(prefix));

afterEach(() => invalidateEntitlements());

afterAll(async () => {
  await db.$disconnect();
});

describe("Calidad depends on Producción (D9, NEG-31)", () => {
  it("Calidad is announced: nothing activates it yet; Producción is available (WMS-27)", async () => {
    const { org } = await newCompany("Empresa anunciada", []);
    expect(
      await activateModule(moduleRegistry, change(org, "quality")),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(
      await activateModule(moduleRegistry, change(org, "production")),
    ).toMatchObject({ ok: true });
  });

  it("Calidad is refused without Producción, then works with it", async () => {
    const { org } = await newCompany("Empresa sin producción", []);
    expect(
      await activateModule(registry, change(org, "quality")),
    ).toMatchObject({
      ok: false,
      reason: "missing_dependencies",
      modules: ["Producción"],
    });
    expect(await activateModule(registry, change(org, "production"))).toEqual({
      ok: true,
    });
    expect(await activateModule(registry, change(org, "quality"))).toEqual({
      ok: true,
    });
  });

  it("Producción is not removed while Calidad is active", async () => {
    const { org } = await newCompany("Empresa con calidad", [
      "production",
      "quality",
    ]);
    expect(
      await deactivateModule(registry, change(org, "production")),
    ).toMatchObject({
      ok: false,
      reason: "has_dependents",
      modules: ["Calidad"],
    });
    expect(await deactivateModule(registry, change(org, "quality"))).toEqual({
      ok: true,
    });
    expect(await deactivateModule(registry, change(org, "production"))).toEqual(
      { ok: true },
    );
  });
});

describe("roles with their modules", () => {
  let org = "";
  let other = { org: "", owner: "" };
  const people: Record<string, string> = {};

  beforeAll(async () => {
    ({ org } = await newCompany("Planta Norte", ["production", "quality"]));
    other = await newCompany("Planta Ajena", ["production", "quality"]);
    for (const role of [
      "production_operator",
      "production_supervisor",
      "quality_inspector",
      "warehouse",
      "supervisor",
      "operator",
      "forklift",
      "buyer",
      "viewer",
      "manager",
    ] as const) {
      people[role] = await addMember(org, [role]);
    }
  });

  it("Operario reports and asks, and nothing more (NEG-27)", async () => {
    const userId = people.production_operator!;
    await expectGrants(
      org,
      userId,
      [
        "production.report.create",
        "production.request.create",
        "production.scrap.create",
        "inventory.stock.read",
        "inventory.task.execute",
      ],
      true,
    );
    await expectGrants(
      org,
      userId,
      [
        "production.order.create",
        "production.order.release",
        "production.order.cancel",
        "production.order.close",
        "production.recipe.manage",
        "production.request.decide",
        "production.output.verify",
        "quality.lot.release",
        "inventory.status.release",
        "inventory.adjustment.create",
        "inventory.cost.read",
        "purchasing.cost.read",
      ],
      false,
    );
    await expect(
      assertModulePermission(org, userId, "production.report.create"),
    ).resolves.toBeUndefined();
  });

  it("Almacén and Supervisor de almacén decide requests, never orders (NEG-28)", async () => {
    for (const role of ["warehouse", "supervisor"]) {
      const userId = people[role]!;
      await expectGrants(
        org,
        userId,
        ["production.request.decide", "production.request.read"],
        true,
      );
      await expectGrants(
        org,
        userId,
        [
          "production.order.create",
          "production.order.release",
          "production.order.cancel",
          "production.order.close",
          "production.recipe.manage",
          "production.output.verify",
        ],
        false,
      );
      await expect(
        assertModulePermission(org, userId, "production.request.decide"),
      ).resolves.toBeUndefined();
    }
  });

  it("Almacenista, Montacarguista and Comprador do not decide requests (NEG-29)", async () => {
    for (const role of ["operator", "forklift", "buyer"]) {
      await expectGrants(
        org,
        people[role]!,
        [...ofModule("production."), ...ofModule("quality.")],
        false,
      );
    }
  });

  it("Inspector inspects and never reports or runs orders (NEG-30)", async () => {
    const userId = people.quality_inspector!;
    await expectGrants(
      org,
      userId,
      [
        "quality.inspection.create",
        "quality.inspection.decide",
        "quality.lot.release",
      ],
      true,
    );
    await expectGrants(
      org,
      userId,
      [
        "production.report.create",
        "production.order.create",
        "inventory.adjustment.create",
        "inventory.cost.read",
      ],
      false,
    );
  });

  it("Encargado decides with the stock in sight, without costs", async () => {
    const userId = people.production_supervisor!;
    await expectGrants(
      org,
      userId,
      [
        ...ofModule("production."),
        "inventory.stock.read",
        "inventory.minimum.read",
      ],
      true,
    );
    await expectGrants(
      org,
      userId,
      [
        "inventory.cost.read",
        "purchasing.cost.read",
        "inventory.adjustment.create",
        "platform.team.assign_roles",
      ],
      false,
    );
  });

  it("Consulta and Gerencia only read both modules", async () => {
    for (const role of ["viewer", "manager"]) {
      for (const permission of [
        ...ofModule("production."),
        ...ofModule("quality."),
      ]) {
        expect(
          await isAllowed(org, people[role]!, permission),
          `${role} ${permission}`,
        ).toBe(permission.endsWith(".read"));
      }
    }
  });

  it("a role of one company gives nothing in another (NEG-33)", async () => {
    for (const role of [
      "production_operator",
      "production_supervisor",
      "quality_inspector",
    ]) {
      await expectGrants(
        other.org,
        people[role]!,
        ["inventory.stock.read", "production.order.read"],
        false,
      );
    }
  });

  it("the same person and role in two companies follows each one's modules (NEG-33)", async () => {
    // Member with the tied role in a company with Producción and in one
    // without it: each company decides with its own modules.
    const userId = people.production_supervisor!;
    const plain = await newCompany("Almacén vecino", []);
    const membership = await db.membership.create({
      data: {
        id: newId(),
        organizationId: plain.org,
        userId,
        status: "ACTIVE",
      },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: plain.org,
        membershipId: membership.id,
        role: "production_supervisor",
      },
    });
    expect(await isAllowed(org, userId, "inventory.stock.read")).toBe(true);
    expect(await isAllowed(org, userId, "production.request.decide")).toBe(
      true,
    );
    await expectGrants(
      plain.org,
      userId,
      ["inventory.stock.read", "production.request.decide"],
      false,
    );
  });
});

describe("a tied role without its module gives nothing (NEG-31)", () => {
  it("not even the Inventario reads it carries", async () => {
    const { org } = await newCompany("Almacén sin producción", []);
    const boss = await addMember(org, ["production_supervisor"]);
    const inspector = await addMember(org, ["quality_inspector"]);
    for (const userId of [boss, inspector]) {
      await expectGrants(
        org,
        userId,
        [
          "inventory.stock.read",
          "inventory.product.read",
          "platform.organization.read",
          "production.request.decide",
          "quality.inspection.read",
        ],
        false,
      );
    }
    // Almacén keeps its own work; production permissions stop at the
    // module guard.
    const warehouse = await addMember(org, ["warehouse"]);
    expect(await isAllowed(org, warehouse, "inventory.stock.read")).toBe(true);
    await expect(
      assertModulePermission(org, warehouse, "production.request.decide"),
    ).rejects.toMatchObject({ code: "module_not_contracted" });
  });

  it("with Producción but not Calidad the inspector stays asleep", async () => {
    const { org } = await newCompany("Planta sin calidad", ["production"]);
    const inspector = await addMember(org, ["quality_inspector"]);
    await expectGrants(
      org,
      inspector,
      ["inventory.stock.read", "production.order.read"],
      false,
    );
    const operator = await addMember(org, ["production_operator"]);
    expect(await isAllowed(org, operator, "inventory.stock.read")).toBe(true);
  });

  it("with the module removed, the role keeps only the reads of that module", async () => {
    const { org } = await newCompany("Planta que dejó calidad", [
      "production",
      "quality",
    ]);
    const inspector = await addMember(org, ["quality_inspector"]);
    expect(await isAllowed(org, inspector, "quality.inspection.decide")).toBe(
      true,
    );
    expect(await deactivateModule(registry, change(org, "quality"))).toEqual({
      ok: true,
    });
    await expectGrants(
      org,
      inspector,
      ["quality.inspection.read", "quality.plan.read"],
      true,
    );
    // Its Inventario, Producción and platform reads go with the module.
    await expectGrants(
      org,
      inspector,
      [
        "quality.inspection.decide",
        "quality.lot.release",
        "inventory.stock.read",
        "inventory.product.read",
        "inventory.incident.read",
        "inventory.incident.create",
        "production.order.read",
        "platform.organization.read",
      ],
      false,
    );
    // …and it is not handed out again while the module is read-only,
    // though the person keeps it when other roles change.
    const admin = await addMember(org, ["administrator"]);
    const worker = await addMember(org, ["viewer"]);
    expect(
      await assignRoles(org, admin, {
        userId: worker,
        roles: ["quality_inspector"],
      }),
    ).toMatchObject({ ok: false, reason: "module_missing" });
    expect(
      await assignRoles(org, admin, {
        userId: inspector,
        roles: ["quality_inspector", "viewer"],
      }),
    ).toEqual({ ok: true });
  });

  it("the titular keeps a tied role after a transfer only with its module", async () => {
    const { org, owner } = await newCompany("Almacén que se transfiere", []);
    const heir = await addMember(org, ["viewer"]);
    expect(
      await offerOwnershipTransfer(org, owner, {
        toUserId: heir,
        previousOwnerRoles: ["production_supervisor"],
      }),
    ).toMatchObject({ ok: false, reason: "module_missing" });
    const withModule = await newCompany("Planta que se transfiere", [
      "production",
    ]);
    const heir2 = await addMember(withModule.org, ["viewer"]);
    expect(
      await offerOwnershipTransfer(withModule.org, withModule.owner, {
        toUserId: heir2,
        previousOwnerRoles: ["production_supervisor"],
      }),
    ).toMatchObject({ ok: true });
  });

  it("the team rules refuse handing it out without the module", async () => {
    const { org, owner } = await newCompany("Almacén solo", []);
    const admin = await addMember(org, ["administrator"]);
    const worker = await addMember(org, ["viewer"]);
    for (const actor of [owner, admin]) {
      expect(
        await assignRoles(org, actor, {
          userId: worker,
          roles: ["production_operator"],
        }),
      ).toMatchObject({ ok: false, reason: "module_missing" });
      expect(
        await createInvitation(org, actor, {
          email: `nuevo.${++counter}.${stamp}@example.test`,
          roles: ["quality_inspector"],
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: {
          roles:
            "Ese rol necesita un módulo que tu empresa no tiene contratado.",
        },
      });
    }
  });

  it("with the module an administrator hands it out", async () => {
    const { org } = await newCompany("Planta Sur", ["production"]);
    const admin = await addMember(org, ["administrator"]);
    const worker = await addMember(org, ["viewer"]);
    expect(
      await assignRoles(org, admin, {
        userId: worker,
        roles: ["production_operator", "production_supervisor"],
      }),
    ).toEqual({ ok: true });
    expect(await isAllowed(org, worker, "production.order.create")).toBe(true);
    expect(
      await createInvitation(org, admin, {
        email: `operario.${++counter}.${stamp}@example.test`,
        roles: ["production_operator"],
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("notices reach a tied role only with its module (ADR 0062)", () => {
  const TYPE = { key: "inventory.test_notice", defaultEnabled: true };

  async function noticeTo(org: string, key: string) {
    return forOrganization(org).$transaction((tx) =>
      notify(tx, TYPE, {
        organizationId: org,
        actorUserId: null,
        to: { permissions: ["inventory.stock.read"] },
        text: "Aviso de prueba",
        href: "/inicio",
        key,
      }),
    );
  }

  async function got(org: string, userId: string, key: string) {
    return db.notification.count({
      where: { organizationId: org, recipientUserId: userId, dedupeKey: key },
    });
  }

  it("with Producción the Encargado is notified; without it, not", async () => {
    const plant = await newCompany("Planta con avisos", ["production"]);
    const store = await newCompany("Almacén con avisos", []);
    const inPlant = await addMember(plant.org, ["production_supervisor"]);
    const inStore = await addMember(store.org, ["production_supervisor"]);
    const keeper = await addMember(store.org, ["warehouse"]);
    const key = `prueba:${stamp}`;
    await noticeTo(plant.org, key);
    await noticeTo(store.org, key);
    expect(await got(plant.org, inPlant, key)).toBe(1);
    expect(await got(store.org, inStore, key)).toBe(0);
    expect(await got(store.org, keeper, key)).toBe(1);
  });
});
