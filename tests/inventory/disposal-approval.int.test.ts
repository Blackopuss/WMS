import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  DISPOSAL_APPROVAL,
  changeStockStatus,
  disposalNeedsApproval,
  disposeStock,
  reconcileStock,
  registerEntry,
  registerExit,
  type InventoryActor,
} from "@/modules/inventory";
import { approvalTypes, moduleRegistry } from "@/modules/registry";
import {
  cancelApproval,
  decideApproval,
  getApprovalRequest,
  updateApprovalRule,
} from "@/platform/approvals";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createLocation, getActiveFacility } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-83 (ADR 0078): «Desechar mercancía pide autorización, con el porqué».

const stamp = Date.now();
let counter = 0;
let staff = "";
const REASON = "Golpeado en el traslado";

async function newUser(name: string) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `desecho.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa desechos ${counter}`,
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
      reason: "Prueba de desechos",
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

async function rule(
  owner: InventoryActor,
  enabled: boolean,
  options: { roles?: Role[]; allowSelfApproval?: boolean } = {},
) {
  const result = await updateApprovalRule(
    owner,
    approvalTypes,
    DISPOSAL_APPROVAL.key,
    {
      enabled,
      roles: options.roles ?? ["supervisor"],
      allowSelfApproval: options.allowSelfApproval ?? false,
    },
  );
  if (!result.ok) throw new Error(result.error);
}

type Item = {
  productId: string;
  locationId: string;
  damaged: () => Promise<string>;
};

/** A product with `quantity` in a zone of its own, `broken` of it damaged. */
async function damaged(
  owner: InventoryActor,
  quantity = "10",
  broken = "6",
  options: {
    tracking?: "LOT" | "SERIAL";
    lotCode?: string;
    serials?: string[];
  } = {},
): Promise<Item> {
  const product = await createProduct(owner, {
    sku: `DS-${++counter}`,
    name: `Guante ${counter}`,
    ...(options.tracking ? { tracking: options.tracking } : {}),
    ...(options.tracking === "LOT" ? { lotExpiry: "NONE" as const } : {}),
  });
  if (!product.ok) throw new Error(JSON.stringify(product));
  const zone = await createLocation(owner, {
    level: 1,
    name: `Zona ${counter}`,
  });
  if (!zone.ok) throw new Error("location setup failed");
  const entry = await registerEntry(owner, {
    productId: product.productId,
    locationId: zone.locationId,
    quantity,
    ...(options.lotCode ? { lotCode: options.lotCode } : {}),
    ...(options.serials ? { serials: options.serials.join("\n") } : {}),
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
  const lotId = options.lotCode
    ? (
        await db.lot.findFirst({
          where: { productId: product.productId },
          select: { id: true },
        })
      )?.id
    : undefined;
  const changed = await changeStockStatus(owner, {
    productId: product.productId,
    locationId: zone.locationId,
    from: "AVAILABLE",
    to: "DAMAGED",
    quantity: broken,
    reason: "Se cayó de la tarima",
    idempotencyKey: newId(),
    ...(lotId ? { lotId } : {}),
    ...(options.serials
      ? { serials: options.serials.slice(0, Number(broken)).join("\n") }
      : {}),
  });
  if (!changed.ok) throw new Error(JSON.stringify(changed));
  const damagedNow = async () => {
    const row = await db.stockBalance.findFirst({
      where: {
        productId: product.productId,
        locationId: zone.locationId,
        status: "DAMAGED",
      },
      select: { quantity: true },
    });
    return row?.quantity.toString() ?? "0";
  };
  return {
    productId: product.productId,
    locationId: zone.locationId,
    damaged: damagedNow,
  };
}

const disposalsOf = (organizationId: string, productId: string) =>
  db.stockMovement.findMany({
    where: {
      organizationId,
      type: "DISPOSAL",
      lines: { some: { productId } },
    },
    select: {
      id: true,
      createdByUserId: true,
      idempotencyKey: true,
      lines: { select: { lotId: true, status: true, baseQuantity: true } },
    },
  });

function ask(
  actor: InventoryActor,
  item: Item,
  extra: Partial<Parameters<typeof disposeStock>[1]> = {},
) {
  return disposeStock(actor, {
    productId: item.productId,
    locationId: item.locationId,
    status: "DAMAGED",
    quantity: "2",
    reason: REASON,
    idempotencyKey: newId(),
    ...extra,
  });
}

async function asked(
  actor: InventoryActor,
  item: Item,
  extra: Partial<Parameters<typeof disposeStock>[1]> = {},
): Promise<string> {
  const result = await ask(actor, item, extra);
  if (result.ok || result.reason !== "pending_approval") {
    throw new Error(`expected a request: ${JSON.stringify(result)}`);
  }
  return result.requestId;
}

const approve = (actor: InventoryActor, requestId: string) =>
  decideApproval(actor, approvalTypes, requestId, { decision: "approve" });

let owner: InventoryActor;
let clerk: InventoryActor; // Almacén: may write off.
let boss: InventoryActor; // Supervisor: authorizes.
let otherBoss: InventoryActor;
let floor: InventoryActor; // Almacenista: reports damage, never writes off.

beforeAll(async () => {
  owner = await company();
  clerk = await member(owner.organizationId, "warehouse", "Álvaro");
  boss = await member(owner.organizationId, "supervisor", "Sonia");
  otherBoss = await member(owner.organizationId, "supervisor", "Saúl");
  floor = await member(owner.organizationId, "operator", "Fermín");
}, 60_000);

afterEach(() => invalidateEntitlements());

afterAll(async () => {
  expect(await reconcileStock(owner.organizationId)).toEqual([]);
  await db.$disconnect();
});

describe("without the rule", () => {
  it("writes off as always and asks nobody", async () => {
    const fresh = await company();
    const item = await damaged(fresh);
    expect(await disposalNeedsApproval(fresh)).toBe(false);
    expect(await ask(fresh, item)).toMatchObject({ ok: true });
    expect(await item.damaged()).toBe("4");
    expect(
      await db.approvalRequest.count({
        where: { organizationId: fresh.organizationId },
      }),
    ).toBe(0);
    expect(await reconcileStock(fresh.organizationId)).toEqual([]);
  });
});

describe("with the rule on", () => {
  beforeAll(() => rule(owner, true));

  it("asks instead of writing, with the reason and no costs", async () => {
    expect(await disposalNeedsApproval(clerk)).toBe(true);
    const item = await damaged(owner);
    const key = newId();
    const result = await ask(clerk, item, { idempotencyKey: key });
    expect(result).toMatchObject({
      ok: false,
      reason: "pending_approval",
      formError: expect.stringContaining("Quedó pendiente de autorización"),
    });
    if (result.ok || result.reason !== "pending_approval") return;
    expect(await item.damaged()).toBe("6");
    expect(await disposalsOf(owner.organizationId, item.productId)).toEqual([]);
    const view = await getApprovalRequest(
      boss,
      approvalTypes,
      result.requestId,
    );
    expect(view?.summary).toContain(`Motivo: ${REASON}`);
    expect(view?.summary).toContain("dañado");
    expect(view?.summary).toContain("Hay 6");
    expect(view?.summary).not.toMatch(/\$/);

    // A retry with the same confirmation finds the same request.
    expect(await ask(clerk, item, { idempotencyKey: key })).toMatchObject({
      ok: false,
      reason: "pending_approval",
      requestId: result.requestId,
      repeated: true,
    });
    // The same confirmation with something else is not a retry.
    expect(
      await ask(clerk, item, { idempotencyKey: key, quantity: "3" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    // One request per product, location, state and lot.
    expect(await ask(boss, item)).toMatchObject({
      ok: false,
      reason: "not_allowed",
      formError: expect.stringContaining("esperando autorización"),
    });

    // Who asked (not a role of the rule) does not decide.
    expect(await approve(clerk, result.requestId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(await approve(boss, result.requestId)).toMatchObject({
      ok: true,
      status: "APPROVED",
    });
    expect(await item.damaged()).toBe("4");
    const written = await disposalsOf(owner.organizationId, item.productId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      createdByUserId: clerk.userId,
      idempotencyKey: key,
    });
    const trail = await db.auditEvent.findFirst({
      where: {
        organizationId: owner.organizationId,
        action: "inventory.disposed",
        targetId: written[0]!.id,
      },
      select: { actorUserId: true, metadata: true, reason: true },
    });
    expect(trail).toMatchObject({
      actorUserId: clerk.userId,
      reason: REASON,
      metadata: expect.objectContaining({
        autorizadoPor: "Sonia",
        solicitud: result.requestId,
      }),
    });
    // After it went through, the same confirmation is a repeat.
    expect(await ask(clerk, item, { idempotencyKey: key })).toMatchObject({
      ok: true,
      repeated: true,
    });
  });

  it("closes the detour available → damaged → write-off", async () => {
    const product = await createProduct(owner, {
      sku: `DS-${++counter}`,
      name: `Caja ${counter}`,
    });
    if (!product.ok) throw new Error("product setup failed");
    const zone = await createLocation(owner, {
      level: 1,
      name: `Zona ${counter}`,
    });
    if (!zone.ok) throw new Error("location setup failed");
    await registerEntry(owner, {
      productId: product.productId,
      locationId: zone.locationId,
      quantity: "5",
    });
    // The floor still reports damage at once.
    expect(
      await changeStockStatus(floor, {
        productId: product.productId,
        locationId: zone.locationId,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "5",
        reason: "Mojado",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    // The floor never writes off.
    await expect(
      ask(floor, { ...zoneItem(product.productId, zone.locationId) }),
    ).rejects.toThrow();
    // Writing it off waits.
    expect(
      await ask(clerk, zoneItem(product.productId, zone.locationId), {
        quantity: "5",
      }),
    ).toMatchObject({ ok: false, reason: "pending_approval" });
    expect(await disposalsOf(owner.organizationId, product.productId)).toEqual(
      [],
    );
  });

  it("a rejected request writes nothing and its confirmation is spent", async () => {
    const item = await damaged(owner);
    const key = newId();
    const requestId = await asked(clerk, item, { idempotencyKey: key });
    expect(
      await decideApproval(boss, approvalTypes, requestId, {
        decision: "reject",
        reason: "Se puede reparar",
      }),
    ).toMatchObject({ ok: true, status: "REJECTED" });
    expect(await item.damaged()).toBe("6");
    expect(await ask(clerk, item, { idempotencyKey: key })).toMatchObject({
      ok: false,
      reason: "not_allowed",
      formError: expect.stringContaining("se rechazó"),
    });
    // A new confirmation may ask again.
    expect(await ask(clerk, item)).toMatchObject({
      reason: "pending_approval",
    });
  });

  it("a withdrawn request frees the slot for a new one", async () => {
    const item = await damaged(owner);
    const requestId = await asked(clerk, item);
    expect(await cancelApproval(clerk, approvalTypes, requestId)).toEqual({
      ok: true,
    });
    expect(await ask(clerk, item)).toMatchObject({
      reason: "pending_approval",
    });
  });

  it("expires when that stock moved since, not when other stock did", async () => {
    const item = await damaged(owner, "10", "6");
    // Available stock of the same product leaves the same place: fine.
    const requestId = await asked(clerk, item);
    expect(
      await registerExit(owner, {
        productId: item.productId,
        locationId: item.locationId,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(await approve(boss, requestId)).toMatchObject({
      ok: true,
      status: "APPROVED",
    });
    expect(await item.damaged()).toBe("4");

    // Damaged stock comes in there after asking: the request expires.
    const second = await asked(clerk, item);
    expect(
      await changeStockStatus(owner, {
        productId: item.productId,
        locationId: item.locationId,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
        reason: "Otra caída",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await approve(boss, second)).toMatchObject({
      ok: false,
      reason: "expired",
      error: expect.stringContaining("hubo movimientos"),
    });
    expect(
      await getApprovalRequest(clerk, approvalTypes, second),
    ).toMatchObject({ status: "EXPIRED" });
    expect(await item.damaged()).toBe("5");
    expect(
      await disposalsOf(owner.organizationId, item.productId),
    ).toHaveLength(1);
  });

  it("expires when there is no longer enough", async () => {
    const item = await damaged(owner, "10", "6");
    const requestId = await asked(clerk, item, { quantity: "6" });
    // Someone sends the damaged stock back to available.
    await changeStockStatus(owner, {
      productId: item.productId,
      locationId: item.locationId,
      from: "DAMAGED",
      to: "AVAILABLE",
      quantity: "3",
      reason: "Estaba bien",
      idempotencyKey: newId(),
    });
    expect(await approve(boss, requestId)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(await item.damaged()).toBe("3");
  });

  it("keeps the lot", async () => {
    const item = await damaged(owner, "10", "4", {
      tracking: "LOT",
      lotCode: `L-${counter}`,
    });
    const lot = await db.lot.findFirst({
      where: { productId: item.productId },
      select: { id: true },
    });
    const requestId = await asked(clerk, item, { lotId: lot!.id });
    expect(await approve(boss, requestId)).toMatchObject({ ok: true });
    const [written] = await disposalsOf(owner.organizationId, item.productId);
    expect(written!.lines).toEqual([
      expect.objectContaining({ lotId: lot!.id, status: "DAMAGED" }),
    ]);
  });

  it("writes off the serials asked for, and expires if one moved", async () => {
    const serials = [`S-${stamp}-1`, `S-${stamp}-2`, `S-${stamp}-3`];
    const item = await damaged(owner, "3", "2", {
      tracking: "SERIAL",
      serials,
    });
    const requestId = await asked(clerk, item, {
      quantity: "1",
      serials: serials[0],
    });
    expect(await approve(boss, requestId)).toMatchObject({ ok: true });
    const unit = await db.serialUnit.findFirst({
      where: { productId: item.productId, serial: serials[0] },
      select: { locationId: true },
    });
    expect(unit?.locationId).toBeNull();

    const second = await asked(clerk, item, {
      quantity: "1",
      serials: serials[1],
    });
    await changeStockStatus(owner, {
      productId: item.productId,
      locationId: item.locationId,
      from: "DAMAGED",
      to: "AVAILABLE",
      quantity: "1",
      serials: serials[1],
      reason: "Funciona",
      idempotencyKey: newId(),
    });
    expect(await approve(boss, second)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("who asks decides only when the rule allows it, the titular too", async () => {
    const item = await damaged(owner);
    const requestId = await asked(owner, item);
    expect(await approve(owner, requestId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    await rule(owner, true, { allowSelfApproval: true });
    try {
      expect(await approve(owner, requestId)).toMatchObject({ ok: true });
    } finally {
      await rule(owner, true);
    }
  });

  it("decides only inside the scope; who asked must keep it", async () => {
    const facility = await getActiveFacility(owner);
    const item = await damaged(owner);
    const otherZone = await createLocation(owner, {
      level: 1,
      name: `Zona ajena ${counter}`,
    });
    if (!otherZone.ok) throw new Error("location setup failed");
    const zoned = await member(owner.organizationId, "supervisor", "Zoe");
    const zonedClerk = await member(owner.organizationId, "warehouse", "Zack");
    const limit = async (who: InventoryActor, zoneId: string) => {
      const scoped = await setMemberScope(owner.organizationId, owner.userId, {
        userId: who.userId,
        facilities: [{ facilityId: facility.id, zoneIds: [zoneId] }],
      });
      if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    };
    await limit(zoned, otherZone.locationId);
    await limit(zonedClerk, item.locationId);

    const requestId = await asked(zonedClerk, item);
    // Outside the zone the request does not exist.
    expect(
      await getApprovalRequest(zoned, approvalTypes, requestId),
    ).toBeNull();
    expect(await approve(zoned, requestId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // Who asked loses the zone: it expires.
    await limit(zonedClerk, otherZone.locationId);
    expect(await approve(boss, requestId)).toMatchObject({
      ok: false,
      reason: "expired",
      error: expect.stringContaining("ya no trabaja en esa ubicación"),
    });
    expect(await item.damaged()).toBe("6");
  });

  it("expires when who asked left the company", async () => {
    const item = await damaged(owner);
    const leaving = await member(owner.organizationId, "warehouse", "Lalo");
    const requestId = await asked(leaving, item);
    await db.membership.updateMany({
      where: { organizationId: owner.organizationId, userId: leaving.userId },
      data: { status: "DISABLED" },
    });
    expect(await approve(boss, requestId)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(await item.damaged()).toBe("6");
  });

  it("two people authorizing at once write it off once", async () => {
    const item = await damaged(owner);
    const requestId = await asked(clerk, item);
    const answers = await Promise.all([
      approve(boss, requestId),
      approve(otherBoss, requestId),
    ]);
    expect(answers.filter((a) => a.ok && !a.repeated)).toHaveLength(1);
    expect(await item.damaged()).toBe("4");
    expect(
      await disposalsOf(owner.organizationId, item.productId),
    ).toHaveLength(1);
  });

  it("two people asking at once open one request", async () => {
    const item = await damaged(owner);
    const answers = await Promise.all([ask(clerk, item), ask(boss, item)]);
    expect(
      answers.filter((a) => !a.ok && a.reason === "pending_approval"),
    ).toHaveLength(1);
    expect(
      await db.approvalRequest.count({
        where: {
          organizationId: owner.organizationId,
          typeKey: DISPOSAL_APPROVAL.key,
          status: "PENDING",
          sourceId: item.productId,
        },
      }),
    ).toBe(1);
  });

  it("authorizing against a status change at once never takes stock twice", async () => {
    const item = await damaged(owner, "10", "6");
    const requestId = await asked(clerk, item, { quantity: "6" });
    const [decided, changed] = await Promise.all([
      approve(boss, requestId),
      changeStockStatus(owner, {
        productId: item.productId,
        locationId: item.locationId,
        from: "DAMAGED",
        to: "REJECTED",
        quantity: "6",
        reason: "No sirve",
        idempotencyKey: newId(),
      }),
    ]);
    // Exactly one of them took the six damaged pieces.
    expect([decided.ok, changed.ok].filter(Boolean)).toHaveLength(1);
    expect(await item.damaged()).toBe("0");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

function zoneItem(productId: string, locationId: string): Item {
  return { productId, locationId, damaged: async () => "" };
}
