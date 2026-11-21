import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  ADJUSTMENT_APPROVAL,
  ADJUSTMENT_APPROVAL_THRESHOLD,
  COUNT_APPROVAL,
  COUNT_REVIEW_THRESHOLD,
  applyCount,
  cancelCount,
  captureCount,
  getCount,
  getStockByLocation,
  openCount,
  reconcileStock,
  registerAdjustment,
  registerEntry,
  registerExit,
  type InventoryActor,
} from "@/modules/inventory";
import {
  approvalTypes,
  moduleRegistry,
  operationSettings,
} from "@/modules/registry";
import {
  cancelApproval,
  decideApproval,
  getApprovalRequest,
  listPendingApprovals,
  updateApprovalRule,
} from "@/platform/approvals";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-41 (ADR 0053): corrections above the company's threshold wait for an
// authorization (WMS-56). PC-7: «Un ajuste queda auditado y requiere
// autorización según reglas».

const stamp = Date.now();
let counter = 0;
let staff = "";
const REASON = "Conteo físico: faltaban piezas";

async function newUser(name: string) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `autoriza.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa autorizaciones ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser("Soporte");
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 100,
      users: 20,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de autorizaciones",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  name: string,
): Promise<InventoryActor> {
  const userId = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

async function setting(owner: InventoryActor, key: string, value: string) {
  const result = await updateOperationSetting(
    owner,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

async function ruleOn(owner: InventoryActor, key: string, on = true) {
  const result = await updateApprovalRule(owner, approvalTypes, key, {
    enabled: on,
    roles: ["supervisor"],
    allowSelfApproval: false,
  });
  if (!result.ok) throw new Error(result.error);
}

/** A product with `quantity` on a shelf of its own. */
async function stocked(owner: InventoryActor, quantity = "100") {
  const product = await createProduct(owner, {
    sku: `AU-${++counter}`,
    name: `Tornillo ${counter}`,
  });
  if (!product.ok) throw new Error("product setup failed");
  const shelf = await createLocation(owner, {
    level: 3,
    name: `Estante ${counter}`,
  });
  if (!shelf.ok) throw new Error("location setup failed");
  await registerEntry(owner, {
    productId: product.productId,
    locationId: shelf.locationId,
    quantity,
  });
  const stock = async () =>
    (await getStockByLocation(owner, product.productId))[shelf.locationId] ??
    "0";
  return { productId: product.productId, locationId: shelf.locationId, stock };
}

const adjustmentsOf = (organizationId: string, productId: string) =>
  db.stockMovement.count({
    where: {
      organizationId,
      type: "ADJUSTMENT",
      lines: { some: { productId } },
    },
  });

let owner: InventoryActor;
let clerk: InventoryActor; // Almacén: may adjust.
let boss: InventoryActor; // Supervisor: authorizes.
let otherBoss: InventoryActor;

beforeAll(async () => {
  owner = await company();
  clerk = await member(owner.organizationId, "warehouse", "Álvaro");
  boss = await member(owner.organizationId, "supervisor", "Sonia");
  otherBoss = await member(owner.organizationId, "supervisor", "Saúl");
}, 60_000);

afterEach(() => invalidateEntitlements());

afterAll(async () => {
  expect(await reconcileStock(owner.organizationId)).toEqual([]);
  await db.$disconnect();
});

describe("corrections without the rule", () => {
  it("apply as always while the company does not ask for authorization", async () => {
    const fresh = await company();
    const item = await stocked(fresh, "100");
    const result = await registerAdjustment(fresh, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "10",
      reason: REASON,
    });
    expect(result).toMatchObject({ ok: true });
    expect(await item.stock()).toBe("10");
    expect(
      await db.approvalRequest.count({
        where: { organizationId: fresh.organizationId },
      }),
    ).toBe(0);
    expect(await reconcileStock(fresh.organizationId)).toEqual([]);
  });
});

describe("PC-7: a correction is audited and needs an authorization by the rules", () => {
  beforeAll(async () => {
    await ruleOn(owner, ADJUSTMENT_APPROVAL.key);
    await setting(owner, ADJUSTMENT_APPROVAL_THRESHOLD.key, "25");
  });

  it("below the threshold it applies at once", async () => {
    const item = await stocked(owner, "100");
    const result = await registerAdjustment(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "80",
      reason: REASON,
    });
    expect(result).toMatchObject({ ok: true });
    expect(await item.stock()).toBe("80");
  });

  it("above it nothing changes until someone authorizes it, once; who asked and who authorized stay", async () => {
    const item = await stocked(owner, "100");
    const key = `key-${newId()}`;
    const asked = await registerAdjustment(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "40",
      reason: REASON,
      idempotencyKey: key,
    });
    expect(asked).toMatchObject({
      ok: false,
      reason: "pending_approval",
    });
    if (asked.ok || asked.reason !== "pending_approval") return;
    expect(asked.formError).toMatch(/^Quedó pendiente de autorización: /);
    // The stock did not change and nothing moved.
    expect(await item.stock()).toBe("100");
    expect(await adjustmentsOf(owner.organizationId, item.productId)).toBe(0);

    // A retry of the same confirmation finds the same request.
    expect(
      await registerAdjustment(clerk, {
        productId: item.productId,
        locationId: item.locationId,
        quantity: "40",
        reason: REASON,
        idempotencyKey: key,
      }),
    ).toMatchObject({
      reason: "pending_approval",
      requestId: asked.requestId,
      repeated: true,
    });
    // Another correction of the same thing waits for this one.
    expect(
      await registerAdjustment(clerk, {
        productId: item.productId,
        locationId: item.locationId,
        quantity: "30",
        reason: REASON,
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });

    const request = await getApprovalRequest(
      boss,
      approvalTypes,
      asked.requestId,
    );
    expect(request).toMatchObject({
      typeLabel: "Corregir existencias",
      canDecide: true,
      requestedByName: "Álvaro",
    });
    expect(request?.summary).toContain(
      "el sistema tiene 100 piezas y se contaron 40 piezas (−60 piezas)",
    );
    // Who asked does not authorize their own correction.
    expect(
      await decideApproval(clerk, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ).toMatchObject({ ok: false });

    // Two supervisors at the same time: it is applied once.
    const results = await Promise.all([
      decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "approve",
        reason: "Lo vi en el estante",
      }),
      decideApproval(otherBoss, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.repeated)).toHaveLength(1);
    expect(await item.stock()).toBe("40");
    expect(await adjustmentsOf(owner.organizationId, item.productId)).toBe(1);

    // The movement is in the name of who asked; the log says who
    // authorized it.
    const movement = await db.stockMovement.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        type: "ADJUSTMENT",
        lines: { some: { productId: item.productId } },
      },
      include: { lines: true },
    });
    expect(movement).toMatchObject({
      createdByUserId: clerk.userId,
      reason: REASON,
      idempotencyKey: key,
    });
    expect(movement.lines[0]!.baseQuantity.toString()).toBe("60");
    const decided = await getApprovalRequest(
      clerk,
      approvalTypes,
      asked.requestId,
    );
    expect(decided).toMatchObject({ status: "APPROVED" });
    const winner = results.find((r) => r.ok && !r.repeated);
    const approver = winner === results[0] ? "Sonia" : "Saúl";
    expect(decided?.decidedByName).toBe(approver);

    const trail = await listAuditTrail(owner.organizationId, { limit: 100 });
    const adjusted = trail.find(
      (entry) =>
        entry.action === "inventory.adjusted" &&
        entry.facts.includes(`Autorizó: ${approver}`),
    );
    expect(adjusted).toMatchObject({ actorName: "Álvaro", reason: REASON });
    expect(adjusted?.facts).toEqual(
      expect.arrayContaining(["Había: 100 piezas", "Contado: 40 piezas"]),
    );
    expect(
      trail.some(
        (entry) =>
          entry.action === "approval.approved" && entry.actorName === approver,
      ),
    ).toBe(true);
    expect(
      trail.some(
        (entry) =>
          entry.action === "approval.requested" && entry.actorName === "Álvaro",
      ),
    ).toBe(true);

    // The same confirmation, after it was applied, is the same movement.
    expect(
      await registerAdjustment(clerk, {
        productId: item.productId,
        locationId: item.locationId,
        quantity: "40",
        reason: REASON,
        idempotencyKey: key,
      }),
    ).toMatchObject({ ok: true, repeated: true, movementId: movement.id });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("rejected, nothing changes", async () => {
    const item = await stocked(owner, "100");
    const asked = await registerAdjustment(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "0",
      reason: REASON,
    });
    if (asked.ok || asked.reason !== "pending_approval") {
      throw new Error(JSON.stringify(asked));
    }
    expect(
      await decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "reject",
        reason: "Vuelve a contar el pasillo",
      }),
    ).toMatchObject({ ok: true, status: "REJECTED" });
    expect(await item.stock()).toBe("100");
    expect(await adjustmentsOf(owner.organizationId, item.productId)).toBe(0);
  });

  it("expires when who asked lost the permission or left the company (WMS-97)", async () => {
    for (const lose of ["role", "membership"] as const) {
      const asker = await member(owner.organizationId, "warehouse", "Ana");
      const item = await stocked(owner, "100");
      const asked = await registerAdjustment(asker, {
        productId: item.productId,
        locationId: item.locationId,
        quantity: "40",
        reason: REASON,
      });
      if (asked.ok || asked.reason !== "pending_approval") {
        throw new Error(JSON.stringify(asked));
      }
      if (lose === "role") {
        await db.membershipRole.updateMany({
          where: { membership: { userId: asker.userId } },
          data: { role: "viewer" },
        });
      } else {
        await db.membership.updateMany({
          where: { userId: asker.userId },
          data: { status: "DISABLED" },
        });
      }
      const decided = await decideApproval(
        boss,
        approvalTypes,
        asked.requestId,
        {
          decision: "approve",
        },
      );
      expect(decided).toMatchObject({ ok: false, reason: "expired" });
      if (decided.ok) return;
      expect(decided.error).toMatch(
        lose === "role" ? /ya no tiene permiso/ : /ya no trabaja/,
      );
      expect(await item.stock()).toBe("100");
      expect(await adjustmentsOf(owner.organizationId, item.productId)).toBe(0);
    }
  });

  it("if the stock moved after asking, it expires instead of applying an old difference", async () => {
    const item = await stocked(owner, "100");
    const asked = await registerAdjustment(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "40",
      reason: REASON,
    });
    if (asked.ok || asked.reason !== "pending_approval") {
      throw new Error(JSON.stringify(asked));
    }
    const exit = await registerExit(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "10",
    });
    expect(exit).toMatchObject({ ok: true });
    const decided = await decideApproval(boss, approvalTypes, asked.requestId, {
      decision: "approve",
    });
    expect(decided).toMatchObject({ ok: false, reason: "expired" });
    if (decided.ok) return;
    expect(decided.error).toMatch(/Cuenta de nuevo/);
    expect(await item.stock()).toBe("90");
    expect(await adjustmentsOf(owner.organizationId, item.productId)).toBe(0);
    expect(
      await getApprovalRequest(clerk, approvalTypes, asked.requestId),
    ).toMatchObject({ status: "EXPIRED" });
    // A new correction can be asked for now.
    expect(
      await registerAdjustment(clerk, {
        productId: item.productId,
        locationId: item.locationId,
        quantity: "40",
        reason: REASON,
      }),
    ).toMatchObject({ reason: "pending_approval" });
  });

  it("withdrawn by who asked, nothing changes", async () => {
    const item = await stocked(owner, "100");
    const asked = await registerAdjustment(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "1",
      reason: REASON,
    });
    if (asked.ok || asked.reason !== "pending_approval") {
      throw new Error(JSON.stringify(asked));
    }
    expect(await cancelApproval(clerk, approvalTypes, asked.requestId)).toEqual(
      {
        ok: true,
      },
    );
    expect(await item.stock()).toBe("100");
  });

  it("a new lot is born only when the correction is applied", async () => {
    const product = await createProduct(owner, {
      sku: `AU-L-${++counter}`,
      name: "Pintura",
      tracking: "LOT",
    });
    if (!product.ok) throw new Error("product setup failed");
    const shelf = await createLocation(owner, {
      level: 3,
      name: `Estante lotes ${counter}`,
    });
    if (!shelf.ok) throw new Error("location setup failed");
    const asked = await registerAdjustment(clerk, {
      productId: product.productId,
      locationId: shelf.locationId,
      quantity: "5",
      lotCode: "L-NUEVO",
      reason: "Apareció en el estante",
    });
    if (asked.ok || asked.reason !== "pending_approval") {
      throw new Error(JSON.stringify(asked));
    }
    expect(
      await db.lot.count({ where: { productId: product.productId } }),
    ).toBe(0);
    expect(
      await decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db.lot.findMany({
        where: { productId: product.productId },
        select: { code: true },
      }),
    ).toEqual([{ code: "L-NUEVO" }]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("who may not adjust does not see it nor decide it", async () => {
    const item = await stocked(owner, "100");
    const asked = await registerAdjustment(clerk, {
      productId: item.productId,
      locationId: item.locationId,
      quantity: "2",
      reason: REASON,
    });
    if (asked.ok || asked.reason !== "pending_approval") {
      throw new Error(JSON.stringify(asked));
    }
    for (const role of ["manager", "operator", "viewer"] as const) {
      const person = await member(owner.organizationId, role, `Rol ${role}`);
      expect(await listPendingApprovals(person, approvalTypes)).toMatchObject({
        decides: false,
      });
      expect(
        await decideApproval(person, approvalTypes, asked.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(await item.stock()).toBe("100");
    await cancelApproval(clerk, approvalTypes, asked.requestId);
  });
});

describe("counts with big differences", () => {
  async function scene(org: InventoryActor) {
    const item = await stocked(org, "100");
    const opened = await openCount(org, { locationId: item.locationId });
    if (!opened.ok) throw new Error("count setup failed");
    const captured = await captureCount(clerk, {
      countId: opened.countId,
      productId: item.productId,
      quantity: "50",
    });
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    return { ...item, countId: opened.countId };
  }

  beforeAll(async () => {
    await setting(owner, COUNT_REVIEW_THRESHOLD.key, "10");
  });

  it("without the rule, the review box of WMS-55 stays", async () => {
    const count = await scene(owner);
    expect(
      await applyCount(clerk, { countId: count.countId, reason: REASON }),
    ).toMatchObject({ ok: false, field: "reviewed" });
    expect(
      await applyCount(clerk, {
        countId: count.countId,
        reason: REASON,
        reviewed: true,
      }),
    ).toMatchObject({ ok: true, adjusted: 1 });
    expect(await count.stock()).toBe("50");
  });

  it("with the rule, applying waits for an authorization and the count is frozen meanwhile", async () => {
    await ruleOn(owner, COUNT_APPROVAL.key);
    try {
      const count = await scene(owner);
      const asked = await applyCount(clerk, {
        countId: count.countId,
        reason: REASON,
        // The box does not replace the authorization.
        reviewed: true,
      });
      expect(asked).toMatchObject({ ok: false, reason: "pending_approval" });
      if (asked.ok || asked.reason !== "pending_approval") return;
      expect(await count.stock()).toBe("100");
      const detail = await getCount(clerk, count.countId);
      expect(detail).toMatchObject({
        status: "OPEN",
        pendingApprovalId: asked.requestId,
      });

      // While it waits: no captures, no cancelling, no applying by hand.
      expect(
        await captureCount(clerk, {
          countId: count.countId,
          productId: count.productId,
          quantity: "1",
        }),
      ).toMatchObject({ ok: false, reason: "not_allowed" });
      expect(await cancelCount(clerk, count.countId)).toMatchObject({
        ok: false,
      });
      expect(
        await applyCount(boss, {
          countId: count.countId,
          reason: REASON,
          reviewed: true,
        }),
      ).toMatchObject({ ok: false, reason: "not_allowed" });

      const request = await getApprovalRequest(
        boss,
        approvalTypes,
        asked.requestId,
      );
      expect(request).toMatchObject({
        typeLabel: "Aplicar conteos con diferencias grandes",
        href: `/conteos/${count.countId}`,
        canDecide: true,
      });
      expect(
        await decideApproval(boss, approvalTypes, asked.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: true, status: "APPROVED" });
      expect(await count.stock()).toBe("50");
      expect(await getCount(clerk, count.countId)).toMatchObject({
        status: "APPLIED",
        closedByName: "Álvaro",
        pendingApprovalId: null,
      });
      expect(await reconcileStock(owner.organizationId)).toEqual([]);
    } finally {
      await ruleOn(owner, COUNT_APPROVAL.key, false);
    }
  });

  it("an authorized count expires when who asked may no longer apply counts (WMS-97)", async () => {
    await ruleOn(owner, COUNT_APPROVAL.key);
    try {
      const asker = await member(owner.organizationId, "warehouse", "Lidia");
      const count = await scene(owner);
      const asked = await applyCount(asker, {
        countId: count.countId,
        reason: REASON,
        reviewed: true,
      });
      if (asked.ok || asked.reason !== "pending_approval") {
        throw new Error(JSON.stringify(asked));
      }
      await db.membershipRole.updateMany({
        where: { membership: { userId: asker.userId } },
        data: { role: "operator" },
      });
      const decided = await decideApproval(
        boss,
        approvalTypes,
        asked.requestId,
        {
          decision: "approve",
        },
      );
      expect(decided).toMatchObject({ ok: false, reason: "expired" });
      if (decided.ok) return;
      expect(decided.error).toMatch(/ya no tiene permiso/);
      expect(await count.stock()).toBe("100");
    } finally {
      await ruleOn(owner, COUNT_APPROVAL.key, false);
    }
  });

  it("a withdrawn request frees the count again", async () => {
    await ruleOn(owner, COUNT_APPROVAL.key);
    try {
      const count = await scene(owner);
      const asked = await applyCount(clerk, {
        countId: count.countId,
        reason: REASON,
      });
      if (asked.ok || asked.reason !== "pending_approval") {
        throw new Error(JSON.stringify(asked));
      }
      await cancelApproval(clerk, approvalTypes, asked.requestId);
      expect(await cancelCount(clerk, count.countId)).toEqual({ ok: true });
      expect(await count.stock()).toBe("100");
    } finally {
      await ruleOn(owner, COUNT_APPROVAL.key, false);
    }
  });
});
