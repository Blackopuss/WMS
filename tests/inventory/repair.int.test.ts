import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  REPAIR_RELEASE,
  changeStockStatus,
  countInRepair,
  createOutboundOrder,
  disposeStock,
  getProductStock,
  heldStock,
  holdStock,
  listInRepair,
  listLowStock,
  reconcileStock,
  reconcileValue,
  registerEntry,
  registerExit,
  releaseOutboundOrder,
  replenishNow,
  reverseMovement,
  saveReplenishmentRule,
  setMinimum,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { getPurchaseSuggestions } from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation, getDefaultLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { LOCKING_TRANSACTION, db, forOrganization, lockRows } from "@/server";

// WMS-75 (ADR 0072): «En restauración» is a state that is never available
// (PC-5). It is entered and left with «Cambiar estado» by who manages the
// warehouse (never the floor, R3); what was restored goes back directly
// or through inspection (`inventory.repair.release`, R2); the value never
// moves with it.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `restauracion.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Taller ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 10,
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba de restauración",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
): Promise<InventoryActor> {
  const userId = await newUser();
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

async function place(
  owner: InventoryActor,
  name: string,
  type: "STORAGE" | "PICKING" | "REPAIR" = "STORAGE",
) {
  const made = await createLocation(owner, { level: 3, name, type });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

async function product(
  owner: InventoryActor,
  extra: { tracking?: "NONE" | "LOT" | "SERIAL" } = {},
) {
  const n = ++counter;
  const created = await createProduct(owner, {
    sku: `RS-${n}`,
    name: `Silla ${n}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return { productId: created.productId, sku: `RS-${n}` };
}

async function enter(
  owner: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: { lotCode?: string; serials?: string } = {},
) {
  const done = await registerEntry(owner, {
    productId,
    locationId,
    quantity,
    unitCost: "50",
    acceptRepeat: true,
    acceptCapacity: true,
    ...extra,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  return done.movementId;
}

/** 20 pieces at 50 in General. */
async function scenario() {
  const owner = await company();
  const { productId, sku } = await product(owner);
  const general = (await getDefaultLocation(owner))!.id;
  await enter(owner, productId, general, "20");
  return { owner, productId, sku, general };
}

const change = (
  actor: InventoryActor,
  at: { productId: string; general: string },
  input: {
    from: string;
    to: string;
    quantity: string;
    reason?: string;
    toLocationId?: string;
    lotId?: string;
    serials?: string;
  },
  key = newId(),
) =>
  changeStockStatus(actor, {
    productId: at.productId,
    locationId: at.general,
    reason: "Pata floja",
    idempotencyKey: key,
    ...input,
  });

const valueOf = async (productId: string) =>
  (
    await db.productCost.findFirstOrThrow({ where: { productId } })
  ).stockValue.toString();

async function balanced(organizationId: string) {
  expect(await reconcileStock(organizationId)).toEqual([]);
  expect(await reconcileValue(organizationId)).toEqual([]);
}

afterAll(() => db.$disconnect());

describe("«En restauración» (WMS-75)", () => {
  it("is on hand, never available; restored goes back at the average cost", async () => {
    const at = await scenario();
    const { owner, productId } = at;
    const before = await valueOf(productId);
    const sent = await change(owner, at, {
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "6",
    });
    expect(sent).toMatchObject({
      ok: true,
      summary:
        "6 piezas de Silla " +
        at.sku.slice(3) +
        " en General pasaron de Disponible a En restauración.",
    });
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "20",
      available: "14",
    });
    expect(await valueOf(productId)).toBe(before);
    expect(await countInRepair(owner)).toBe(1);
    const list = await listInRepair(owner);
    expect(list.items).toEqual([
      expect.objectContaining({
        productId,
        quantity: "6",
        origin: "Desde Disponible",
        decidable: true,
      }),
    ]);
    // Restored: back to available, the value untouched and each line at
    // the price of the product.
    const back = await change(owner, at, {
      from: "REPAIR",
      to: "AVAILABLE",
      quantity: "6",
      reason: "Restaurado",
    });
    expect(back).toMatchObject({ ok: true });
    if (!back.ok) return;
    const lines = await db.stockMovementLine.findMany({
      where: { movementId: back.movementId },
    });
    expect(lines.map((line) => line.unitCost?.toString())).toEqual([
      "50",
      "50",
    ]);
    expect(await valueOf(productId)).toBe(before);
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "20",
      available: "20",
    });
    expect(await countInRepair(owner)).toBe(0);
    await balanced(owner.organizationId);
  });

  it("PC-5: feeds no exit, order, minimum, suggestion nor replenishment", async () => {
    const owner = await company();
    const { productId, sku } = await product(owner);
    const shelf = await place(owner, "Rack 1");
    const picking = await place(owner, "Surtido 1", "PICKING");
    await enter(owner, productId, shelf, "10");
    const at = { productId, general: shelf };
    expect(
      await change(owner, at, {
        from: "AVAILABLE",
        to: "REPAIR",
        quantity: "10",
      }),
    ).toMatchObject({ ok: true });

    expect(
      await registerExit(owner, {
        productId,
        locationId: shelf,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    const order = await createOutboundOrder(owner, {
      recipient: "Cliente",
      reference: "R-1",
      dueOn: "2026-11-30",
      priority: "NORMAL",
    });
    if (!order.ok) throw new Error(JSON.stringify(order));
    await setOutboundLine(owner, order.orderId, { productId, quantity: "1" });
    expect(await releaseOutboundOrder(owner, order.orderId)).toMatchObject({
      ok: false,
    });
    expect(await db.stockReservation.count({ where: { productId } })).toBe(0);
    // Below its minimum: nothing available, so it is low and suggested.
    await setMinimum(owner, { productId, quantity: "5" });
    expect(
      (await listLowStock(owner)).items.map((item) => item.productId),
    ).toContain(productId);
    const suggested = await getPurchaseSuggestions(owner);
    expect(
      suggested.groups.flatMap((group) =>
        group.items.map((item) => item.productId),
      ),
    ).toContain(productId);
    // A picking place below its minimum finds nothing to bring.
    const rule = await saveReplenishmentRule(owner, {
      productCode: sku,
      locationId: picking,
      minQuantity: "2",
      maxQuantity: "5",
      multiple: "",
    });
    expect(rule).toMatchObject({ ok: true });
    expect(await replenishNow(owner)).toMatchObject({ ok: true, created: 0 });
    // Neither disposed nor taken by a reversal of the entry.
    expect(
      await disposeStock(owner, {
        productId,
        locationId: shelf,
        status: "REPAIR",
        quantity: "1",
        reason: "No tiene arreglo",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await db.stockBalance.findMany({
        where: { productId, quantity: { gt: 0 } },
        select: { status: true, quantity: true },
      }),
    ).toEqual([expect.objectContaining({ status: "REPAIR" })]);
    await balanced(owner.organizationId);
  });

  it("what could not be restored goes to damaged and is disposed from there", async () => {
    const at = await scenario();
    const { owner, productId } = at;
    await change(owner, at, { from: "AVAILABLE", to: "REPAIR", quantity: "3" });
    expect(
      await change(owner, at, {
        from: "REPAIR",
        to: "DAMAGED",
        quantity: "1",
        reason: "No tuvo arreglo",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await disposeStock(owner, {
        productId,
        locationId: at.general,
        status: "DAMAGED",
        quantity: "1",
        reason: "No tuvo arreglo",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "19",
      available: "17",
    });
    await balanced(owner.organizationId);
  });
});

describe("who sends to restoration (R3)", () => {
  it("the floor never does; who manages the warehouse sends and releases", async () => {
    const at = await scenario();
    const { owner } = at;
    const operator = await member(owner.organizationId, "operator");
    const forklift = await member(owner.organizationId, "forklift");
    const viewer = await member(owner.organizationId, "viewer");
    const manager = await member(owner.organizationId, "manager");
    const supervisor = await member(owner.organizationId, "supervisor");
    const warehouse = await member(owner.organizationId, "warehouse");

    // The floor reports damage, as today, but never sends to restoration.
    expect(
      await change(operator, at, {
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    for (const from of ["AVAILABLE", "DAMAGED"]) {
      await expect(
        change(operator, at, { from, to: "REPAIR", quantity: "1" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
    for (const actor of [forklift, viewer, manager]) {
      await expect(
        change(actor, at, { from: "AVAILABLE", to: "REPAIR", quantity: "1" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
    expect(
      await change(supervisor, at, {
        from: "DAMAGED",
        to: "REPAIR",
        quantity: "2",
        reason: "Se puede reparar",
      }),
    ).toMatchObject({ ok: true });
    // Nor does the floor release it.
    await expect(
      change(operator, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "1",
        reason: "Restaurado",
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(
      await change(warehouse, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "2",
        reason: "Restaurado",
      }),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });

  it("another company neither sees nor changes it", async () => {
    const at = await scenario();
    await change(at.owner, at, {
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "4",
    });
    const stranger = await company();
    expect(await countInRepair(stranger)).toBe(0);
    expect((await listInRepair(stranger)).items).toEqual([]);
    expect(
      await change(stranger, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "4",
        reason: "Restaurado",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await countInRepair(at.owner)).toBe(1);
    await balanced(at.owner.organizationId);
  });
});

describe("`inventory.repair.release` (R2)", () => {
  it("with inspection, restored stock goes through «En inspección», also when reversing", async () => {
    const at = await scenario();
    const { owner, productId } = at;
    const sent = await change(owner, at, {
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "5",
    });
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    await setting(owner, REPAIR_RELEASE.key, "inspection");
    expect(
      await change(owner, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "5",
        reason: "Restaurado",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { to: expect.stringMatching(/pase por inspección/) },
    });
    expect(
      await reverseMovement(owner, {
        movementId: sent.movementId,
        reason: "Era otra silla",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/pase por inspección/),
    });
    expect(
      await change(owner, at, {
        from: "REPAIR",
        to: "INSPECTION",
        quantity: "5",
        reason: "Restaurado, a revisión",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await change(owner, at, {
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "5",
        reason: "Revisado",
      }),
    ).toMatchObject({ ok: true });
    expect(await getProductStock(owner, productId)).toMatchObject({
      available: "20",
    });

    // Directly (the default), the reversal undoes it.
    await setting(owner, REPAIR_RELEASE.key, "direct");
    const again = await change(owner, at, {
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "2",
    });
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(
      await reverseMovement(owner, {
        movementId: again.movementId,
        reason: "Era otra silla",
      }),
    ).toMatchObject({ ok: true });
    expect(await getProductStock(owner, productId)).toMatchObject({
      available: "20",
    });
    await balanced(owner.organizationId);
  });
});

describe("a restoration place", () => {
  it("takes no available stock: what is released there must leave it", async () => {
    const at = await scenario();
    const { owner, productId, general } = at;
    const bench = await place(owner, "Taller", "REPAIR");
    expect(
      await registerEntry(owner, {
        productId,
        locationId: bench,
        quantity: "1",
        acceptRepeat: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await change(owner, at, {
        from: "AVAILABLE",
        to: "REPAIR",
        quantity: "4",
        toLocationId: bench,
      }),
    ).toMatchObject({ ok: true });
    const atBench = { productId, general: bench };
    expect(
      await change(owner, atBench, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "4",
        reason: "Restaurado",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { to: expect.stringMatching(/es de restauración/) },
    });
    expect(
      await change(owner, atBench, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "4",
        reason: "Restaurado",
        toLocationId: general,
      }),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });
});

describe("lots, serials, holds and two at once", () => {
  it("a lot keeps its lot and a serial is the same unit", async () => {
    const owner = await company();
    const general = (await getDefaultLocation(owner))!.id;
    const byLot = await product(owner, { tracking: "LOT" });
    await enter(owner, byLot.productId, general, "5", { lotCode: "L-7" });
    const lot = await db.lot.findFirstOrThrow({
      where: { productId: byLot.productId },
    });
    expect(
      await change(
        owner,
        { productId: byLot.productId, general },
        { from: "AVAILABLE", to: "REPAIR", quantity: "2", lotId: lot.id },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await db.stockBalance.findFirstOrThrow({
        where: { productId: byLot.productId, status: "REPAIR" },
      }),
    ).toMatchObject({ lotId: lot.id });
    expect((await listInRepair(owner)).items[0]).toMatchObject({
      lotCode: "L-7",
    });

    const bySerial = await product(owner, { tracking: "SERIAL" });
    await enter(owner, bySerial.productId, general, "2", {
      serials: "SN-A\nSN-B",
    });
    expect(
      await change(
        owner,
        { productId: bySerial.productId, general },
        { from: "AVAILABLE", to: "REPAIR", quantity: "1", serials: "SN-B" },
      ),
    ).toMatchObject({ ok: true });
    const units = await db.serialUnit.findMany({
      where: { productId: bySerial.productId },
      orderBy: { serial: "asc" },
      select: { serial: true, status: true },
    });
    expect(units).toEqual([
      { serial: "SN-A", status: "AVAILABLE" },
      { serial: "SN-B", status: "REPAIR" },
    ]);
    // A unit in restoration does not leave as available.
    expect(
      await registerExit(owner, {
        productId: bySerial.productId,
        locationId: general,
        quantity: "1",
        serials: "SN-B",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await change(
        owner,
        { productId: bySerial.productId, general },
        {
          from: "REPAIR",
          to: "AVAILABLE",
          quantity: "1",
          serials: "SN-B",
          reason: "Restaurado",
        },
      ),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });

  it("a document may hold what is in restoration; nobody else takes it", async () => {
    const at = await scenario();
    const { owner, productId, general } = at;
    await change(owner, at, {
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "4",
    });
    const slot = {
      productId,
      locationId: general,
      status: "REPAIR" as const,
      lotId: null,
    };
    const held = await forOrganization(owner.organizationId).$transaction(
      async (tx) => {
        await lockRows(tx, "product", [productId]);
        await lockRows(tx, "location", [general]);
        return holdStock(tx, owner, {
          ...slot,
          quantity: "3",
          sourceType: "test",
          sourceId: newId(),
          sourceText: "RP-0001",
        });
      },
      LOCKING_TRANSACTION,
    );
    expect(held).toMatchObject({ ok: true });
    expect(
      (
        await heldStock(forOrganization(owner.organizationId), slot)
      ).quantity.toString(),
    ).toBe("3");
    expect(
      await change(owner, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "2",
        reason: "Restaurado",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await change(owner, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "1",
        reason: "Restaurado",
      }),
    ).toMatchObject({ ok: true });
    expect((await listInRepair(owner)).items[0]).toMatchObject({
      heldBy: "RP-0001",
      decidable: false,
    });
    await balanced(owner.organizationId);
  });

  it("two releases at once never take more than is in restoration", async () => {
    const at = await scenario();
    const { owner } = at;
    await change(owner, at, {
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "10",
    });
    const results = await Promise.all([
      change(owner, at, {
        from: "REPAIR",
        to: "AVAILABLE",
        quantity: "6",
        reason: "Restaurado",
      }),
      change(owner, at, {
        from: "REPAIR",
        to: "DAMAGED",
        quantity: "6",
        reason: "No tuvo arreglo",
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await db.stockBalance.findFirstOrThrow({
        where: { productId: at.productId, status: "REPAIR" },
      }),
    ).toMatchObject({ quantity: expect.anything() });
    const left = await db.stockBalance.findFirstOrThrow({
      where: { productId: at.productId, status: "REPAIR" },
    });
    expect(left.quantity.toString()).toBe("4");
    await balanced(owner.organizationId);
  });
});

describe("the database", () => {
  it("holds admit restoration and never available; a return decides restoration", async () => {
    const at = await scenario();
    const { owner, productId, general } = at;
    // What the hold below holds is really there (reconciliation).
    await change(owner, at, { from: "AVAILABLE", to: "REPAIR", quantity: "2" });
    const insert = (status: string) =>
      db.$executeRaw`INSERT INTO stock_hold (id, organizationId, productId, locationId, status, lotKey, quantity, remaining, sourceType, sourceId, sourceText, createdByUserId)
        VALUES (${newId()}, ${owner.organizationId}, ${productId}, ${general}, ${status}, '', 1, 1, 'test', ${newId()}, 'RP-1', ${owner.userId})`;
    await expect(insert("AVAILABLE")).rejects.toThrow();
    await expect(insert("IN_TRANSIT")).rejects.toThrow();
    expect(await insert("REPAIR")).toBe(1);
    const checks = await db.$queryRaw<{ clause: string }[]>`
      SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_NAME = 'customer_return_decision_outcome'
        AND CONSTRAINT_SCHEMA = DATABASE()`;
    expect(checks[0]?.clause).toMatch(/REPAIR/);
    expect(checks[0]?.clause).not.toMatch(/BLOCKED|QUARANTINE/);
    // A purchase receipt never enters in restoration.
    const receiptChecks = await db.$queryRaw<{ clause: string }[]>`
      SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_NAME = 'purchase_receipt_line_status'
        AND CONSTRAINT_SCHEMA = DATABASE()`;
    expect(receiptChecks[0]?.clause).not.toMatch(/REPAIR/);
  });
});
