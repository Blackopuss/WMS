import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  EXPIRY_NOTICE,
  PICK_EXPIRED,
  PICKING_STRATEGY,
  acceptTask,
  applyCount,
  captureCount,
  changeLotExpiry,
  changeStockStatus,
  confirmPick,
  countExpiringLots,
  createOutboundOrder,
  createTask,
  deliverTask,
  getCount,
  getLot,
  getProductStock,
  getStockByLocation,
  listExpiringLots,
  listLotStock,
  listMovements,
  listProductLots,
  openCount,
  pickUpTask,
  reconcileStock,
  registerAdjustment,
  registerEntry,
  registerExit,
  registerInitialBalance,
  registerQuickExit,
  registerTransfer,
  releaseOutboundOrder,
  reverseMovement,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  returnToSupplier,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct, updateProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import {
  createLocation,
  getActiveFacility,
  getDefaultLocation,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-21A (ADR 0040): a product by lot is received, put away, picked and
// delivered with its lot; nothing moves it without one, nothing mixes two.

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

const EXPIRED = "2026-01-15";
const SOON = "2099-03-05";
const LATER = "2099-09-30";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `lotes.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory"],
): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa lotes ${++counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 40,
      users: 10,
      modules,
      validUntil: null,
      reason: "Prueba de lotes",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: "warehouse" | "operator",
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

async function product(
  actor: InventoryActor,
  control: {
    tracking?: "NONE" | "LOT";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = { tracking: "LOT", lotExpiry: "OPTIONAL" },
) {
  const created = await createProduct(actor, {
    sku: `LOT-${++counter}`,
    name: `Artículo ${counter}`,
    ...control,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(actor: InventoryActor, name: string, parentId?: string) {
  const result = await createLocation(actor, {
    level: parentId ? 3 : 1,
    name,
    ...(parentId ? { parentId } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function setting(actor: InventoryActor, key: string, value: string) {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

/** Brings a lot in; fails loudly when the entry is refused. */
async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  lotCode: string,
  lotExpiresOn?: string,
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    lotCode,
    lotExpiresOn,
    acceptRepeat: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.movementId;
}

const lotOf = async (productId: string, code: string) =>
  (await db.lot.findFirstOrThrow({ where: { productId, code } })).id;

/** Balance of a lot (or of «no lot») in a location and state. */
const held = async (
  productId: string,
  locationId: string,
  lotId: string | null,
  status = "AVAILABLE",
) =>
  (
    await db.stockBalance.findFirst({
      where: {
        productId,
        locationId,
        lotKey: lotId ?? "",
        status: status as "AVAILABLE",
      },
      select: { quantity: true },
    })
  )?.quantity.toString() ?? "0";

const key = () => newId();

afterAll(async () => {
  // Every test left its company reconciled, lot by lot.
  for (const organizationId of companies) {
    expect(await reconcileStock(organizationId)).toEqual([]);
  }
  await db.$disconnect();
});

describe("the control of a product", () => {
  it("is without lots unless said, and changes only without stock", async () => {
    const actor = await company();
    const plain = await product(actor, {});
    expect(
      await db.product.findUniqueOrThrow({ where: { id: plain } }),
    ).toMatchObject({ tracking: "NONE", lotExpiry: "NONE" });
    const general = (await getDefaultLocation(actor))!.id;
    const entry = await registerEntry(actor, {
      productId: plain,
      locationId: general,
      quantity: "5",
    });
    expect(entry.ok).toBe(true);

    // With stock, how it is controlled stays.
    const card = { sku: `LOT-${counter}`, name: `Artículo ${counter}` };
    expect(
      await updateProduct(actor, plain, { ...card, tracking: "LOT" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { tracking: expect.stringContaining("tiene existencias") },
    });
    // The database says the same to anything that skips the service.
    await expect(
      db.product.update({ where: { id: plain }, data: { tracking: "LOT" } }),
    ).rejects.toThrow();

    // Empty again, it may change, and the change is in the audit log.
    expect(
      await registerExit(actor, {
        productId: plain,
        locationId: general,
        quantity: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await updateProduct(actor, plain, {
        ...card,
        tracking: "LOT",
        lotExpiry: "REQUIRED",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db.product.findUniqueOrThrow({ where: { id: plain } }),
    ).toMatchObject({ tracking: "LOT", lotExpiry: "REQUIRED" });
    const change = await db.auditEvent.findFirst({
      where: {
        organizationId: actor.organizationId,
        action: "product.updated",
      },
    });
    expect(JSON.stringify(change?.metadata)).toContain("Por lote");

    // An edit that says nothing about the control keeps it.
    expect(
      await updateProduct(actor, plain, { ...card, name: "Otro nombre" }),
    ).toMatchObject({ ok: true });
    expect(
      await db.product.findUniqueOrThrow({ where: { id: plain } }),
    ).toMatchObject({ tracking: "LOT", lotExpiry: "REQUIRED" });

    // Its old movement, without a lot, can no longer be reversed.
    if (!entry.ok) throw new Error("unreachable");
    expect(
      await reverseMovement(actor, {
        movementId: entry.movementId,
        reason: "Prueba de reversa",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("cambió su control por lote"),
    });
  });
});

describe("stock that comes in", () => {
  it("names its lot: created once, reused after, never without one", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;

    // A product by lot never comes in without its lot.
    expect(
      await registerEntry(actor, {
        productId,
        locationId: general,
        quantity: "10",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { lotCode: expect.stringContaining("escribe el lote") },
    });

    await enter(actor, productId, general, "10", "  l-01 ", SOON);
    const lotId = await lotOf(productId, "L-01");
    expect(await held(productId, general, lotId)).toBe("10");
    expect(await held(productId, general, null)).toBe("0");

    // The same lot written another way is the same lot; its date is kept.
    await enter(actor, productId, general, "5", "L-01");
    expect(await db.lot.count({ where: { productId } })).toBe(1);
    expect(await held(productId, general, lotId)).toBe("15");

    // Another expiry date for a lot that exists is refused, saying which.
    expect(
      await registerEntry(actor, {
        productId,
        locationId: general,
        quantity: "1",
        lotCode: "L-01",
        lotExpiresOn: LATER,
        acceptRepeat: true,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        lotExpiresOn: expect.stringContaining("05/03/2099"),
      },
    });
    expect(
      await registerEntry(actor, {
        productId,
        locationId: general,
        quantity: "1",
        lotCode: "L-02",
        lotExpiresOn: "31/12/2099",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { lotExpiresOn: expect.any(String) },
    });
    expect(await db.lot.count({ where: { productId } })).toBe(1);

    // The summary and the history say the lot.
    const page = await listMovements(actor, { lotId });
    expect(page.total).toBe(2);
    expect(page.items[0]!.lines[0]).toMatchObject({ lot: "L-01", lotId });
  });

  it("a product without lots takes no lot, here or in the database", async () => {
    const actor = await company();
    const plain = await product(actor, {});
    const byLot = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    expect(
      await registerEntry(actor, {
        productId: plain,
        locationId: general,
        quantity: "3",
        lotCode: "L-01",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        lotCode: expect.stringContaining("no se controla por lote"),
      },
    });
    await enter(actor, byLot, general, "3", "L-01");
    const lotId = await lotOf(byLot, "L-01");
    // A lot of another product is not this product's lot.
    const other = await product(actor);
    await enter(actor, other, general, "3", "X-9");
    expect(
      await registerExit(actor, {
        productId: other,
        locationId: general,
        quantity: "1",
        lotId,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { lotId: expect.stringContaining("Ese lote no es de") },
    });
    // The triggers: a balance or a line that breaks the rule is not written.
    const balance = (lot: string | null, productId: string) =>
      db.stockBalance.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          productId,
          locationId: general,
          status: "DAMAGED",
          lotId: lot,
          lotKey: lot ?? "",
          quantity: "0",
        },
      });
    await expect(balance(lotId, plain)).rejects.toThrow();
    await expect(balance(null, byLot)).rejects.toThrow();
    await expect(balance(lotId, other)).rejects.toThrow();
    await expect(balance(lotId, byLot)).resolves.toBeTruthy();
    // A lot keeps its product and its code, and is never deleted.
    await expect(
      db.lot.update({ where: { id: lotId }, data: { code: "OTRO" } }),
    ).rejects.toThrow();
    await expect(db.lot.delete({ where: { id: lotId } })).rejects.toThrow();
  });

  it("asks for the expiry date when the product demands it", async () => {
    const actor = await company();
    const strict = await product(actor, {
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    });
    const none = await product(actor, { tracking: "LOT", lotExpiry: "NONE" });
    const general = (await getDefaultLocation(actor))!.id;
    expect(
      await registerEntry(actor, {
        productId: strict,
        locationId: general,
        quantity: "4",
        lotCode: "A1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { lotExpiresOn: "Escribe la caducidad del lote." },
    });
    expect(await db.lot.count({ where: { productId: strict } })).toBe(0);
    await enter(actor, strict, general, "4", "A1", SOON);
    expect(
      await registerEntry(actor, {
        productId: none,
        locationId: general,
        quantity: "4",
        lotCode: "B1",
        lotExpiresOn: SOON,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        lotExpiresOn: expect.stringContaining("no llevan caducidad"),
      },
    });
    // The initial balance is once per location and lot.
    const initial = (lotCode: string) =>
      registerInitialBalance(actor, {
        productId: none,
        locationId: general,
        quantity: "2",
        lotCode,
      });
    expect(await initial("B1")).toMatchObject({ ok: true });
    expect(await initial("B2")).toMatchObject({ ok: true });
    expect(await initial("B1")).toMatchObject({
      ok: false,
      fieldErrors: { locationId: expect.stringContaining("lote B1") },
    });
  });

  it("two entries of different lots are not the same entry (WMS-71)", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const entry = (lotCode: string) =>
      registerEntry(actor, {
        productId,
        locationId: general,
        quantity: "50",
        lotCode,
      });
    expect(await entry("L-1")).toMatchObject({ ok: true });
    // Same product and quantity, another lot: another delivery.
    expect(await entry("L-2")).toMatchObject({ ok: true });
    // The same lot again is what the warning is for.
    expect(await entry("L-2")).toMatchObject({
      ok: false,
      reason: "repeated_recently",
    });
  });

  it("two entries of a new lot at once create it once", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        registerEntry(actor, {
          productId,
          locationId: general,
          quantity: "7",
          lotCode: "NUEVO",
          acceptRepeat: true,
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await db.lot.count({ where: { productId } })).toBe(1);
    expect(
      await held(productId, general, await lotOf(productId, "NUEVO")),
    ).toBe("21");
  });
});

describe("what takes, moves or corrects stock", () => {
  async function scenario() {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const zone = await place(actor, "Zona A");
    await enter(actor, productId, general, "20", "L-01", SOON);
    await enter(actor, productId, general, "10", "L-02", LATER);
    return {
      actor,
      productId,
      general,
      zone,
      l1: await lotOf(productId, "L-01"),
      l2: await lotOf(productId, "L-02"),
    };
  }

  it("an exit, a quick exit and a move say which lot", async () => {
    const { actor, productId, general, zone, l1, l2 } = await scenario();
    // Never without a lot.
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { lotId: expect.stringContaining("di de qué lote") },
    });
    expect(
      await registerTransfer(actor, {
        productId,
        locationId: general,
        toLocationId: zone,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { lotId: expect.any(String) } });
    expect(
      await registerQuickExit(actor, {
        lines: [{ productId, locationId: general, quantity: "1" }],
        reason: "Consumo",
      }),
    ).toMatchObject({ ok: false, lineErrors: { 0: expect.any(String) } });

    // A lot never gives more than it holds, whatever the location has.
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "11",
        lotId: l2,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("del lote L-02") },
    });

    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "4",
        lotId: l1,
      }),
    ).toMatchObject({ ok: true, summary: expect.stringContaining("L-01") });
    expect(
      await registerTransfer(actor, {
        productId,
        locationId: general,
        toLocationId: zone,
        quantity: "6",
        lotId: l1,
      }),
    ).toMatchObject({ ok: true });
    // Two lines of the same product, each its lot, in one movement.
    expect(
      await registerQuickExit(actor, {
        lines: [
          { productId, locationId: general, quantity: "2", lotId: l1 },
          { productId, locationId: general, quantity: "3", lotId: l2 },
          { productId, locationId: zone, quantity: "1", lotId: l1 },
        ],
        reason: "Consumo",
      }),
    ).toMatchObject({ ok: true });
    expect(await held(productId, general, l1)).toBe("8");
    expect(await held(productId, general, l2)).toBe("7");
    expect(await held(productId, zone, l1)).toBe("5");
    expect(await held(productId, zone, l2)).toBe("0");

    // What the screens offer: each lot where it is; a location adds them.
    const choices = await listLotStock(actor, productId);
    expect(
      choices.map((row) => [row.locationId, row.code, row.free]).sort(),
    ).toEqual(
      [
        [general, "L-01", "8"],
        [general, "L-02", "7"],
        [zone, "L-01", "5"],
      ].sort(),
    );
    expect(await getStockByLocation(actor, productId)).toEqual({
      [general]: "15",
      [zone]: "5",
    });
    expect(
      (await listProductLots(actor, productId)).map((lot) => [
        lot.code,
        lot.total,
      ]),
    ).toEqual([
      ["L-01", "13"],
      ["L-02", "7"],
    ]);
    expect((await getProductStock(actor, productId))?.lots).toHaveLength(3);
  });

  it("two exits of the same lot at once never take more than it holds", async () => {
    const { actor, productId, general, l2 } = await scenario();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        registerExit(actor, {
          productId,
          locationId: general,
          quantity: "4",
          lotId: l2,
        }),
      ),
    );
    // 10 in the lot: two exits of 4 fit, the others do not (there are 20
    // more of another lot in the same location).
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(await held(productId, general, l2)).toBe("2");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("an adjustment and a change of state work on one lot", async () => {
    const { actor, productId, general, zone, l1, l2 } = await scenario();
    expect(
      await registerAdjustment(actor, {
        productId,
        locationId: general,
        quantity: "18",
        reason: "Conteo físico",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { lotId: expect.any(String) } });
    expect(
      await registerAdjustment(actor, {
        productId,
        locationId: general,
        quantity: "18",
        reason: "Conteo físico",
        lotId: l1,
      }),
    ).toMatchObject({ ok: true });
    // A lot the system knows, found where it had none.
    expect(
      await registerAdjustment(actor, {
        productId,
        locationId: zone,
        quantity: "2",
        reason: "Apareció en la zona",
        lotId: l2,
      }),
    ).toMatchObject({ ok: true });
    expect(await held(productId, general, l1)).toBe("18");
    expect(await held(productId, zone, l2)).toBe("2");

    const change = (lotId?: string) =>
      changeStockStatus(actor, {
        productId,
        locationId: general,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "3",
        reason: "Empaque roto",
        idempotencyKey: key(),
        lotId,
      });
    expect(await change()).toMatchObject({
      ok: false,
      fieldErrors: { lotId: expect.any(String) },
    });
    expect(await change(l1)).toMatchObject({ ok: true });
    expect(await held(productId, general, l1)).toBe("15");
    expect(await held(productId, general, l1, "DAMAGED")).toBe("3");
    expect(await held(productId, general, l2)).toBe("10");
  });

  it("a reversal puts each line back in its lot", async () => {
    const { actor, productId, general, zone, l1, l2 } = await scenario();
    const moved = await registerTransfer(actor, {
      productId,
      locationId: general,
      toLocationId: zone,
      quantity: "9",
      lotId: l1,
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    expect(
      await reverseMovement(actor, {
        movementId: moved.movementId,
        reason: "Era otro lote",
      }),
    ).toMatchObject({ ok: true });
    expect(await held(productId, general, l1)).toBe("20");
    expect(await held(productId, zone, l1)).toBe("0");
    expect(await held(productId, general, l2)).toBe("10");
    const out = await registerExit(actor, {
      productId,
      locationId: general,
      quantity: "10",
      lotId: l2,
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(
      await reverseMovement(actor, {
        movementId: out.movementId,
        reason: "No salió nada",
      }),
    ).toMatchObject({ ok: true });
    expect(await held(productId, general, l2)).toBe("10");
    expect(await held(productId, general, null)).toBe("0");
  });

  it("a count is by lot and applies each lot on its own", async () => {
    const { actor, productId, general, l1, l2 } = await scenario();
    const opened = await openCount(actor, { locationId: general });
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    const capture = (quantity: string, lotId?: string) =>
      captureCount(actor, {
        countId: opened.countId,
        productId,
        quantity,
        lotId,
      });
    expect(await capture("5")).toMatchObject({
      ok: false,
      field: "lotId",
    });
    expect(await capture("18", l1)).toMatchObject({ ok: true });
    expect(await capture("12", l2)).toMatchObject({ ok: true });
    const detail = await getCount(actor, opened.countId);
    expect(
      detail?.lines.map((line) => [line.lot, line.system, line.difference]),
    ).toEqual(
      expect.arrayContaining([
        ["L-01", "20", "-2"],
        ["L-02", "10", "2"],
      ]),
    );
    // Something of one lot leaves after it was counted: only that lot's
    // target moves.
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "3",
        lotId: l1,
      }),
    ).toMatchObject({ ok: true });
    const after = await getCount(actor, opened.countId);
    const lineOf = (code: string) =>
      after!.lines.find((line) => line.lot === code)!;
    expect(lineOf("L-01").since).toMatchObject({ moved: "-3", target: "15" });
    expect(lineOf("L-02").since).toMatchObject({ moved: "0", target: "12" });
    expect(
      await applyCount(actor, {
        countId: opened.countId,
        reason: "Conteo de cierre",
      }),
    ).toMatchObject({ ok: true, adjusted: 2 });
    expect(await held(productId, general, l1)).toBe("15");
    expect(await held(productId, general, l2)).toBe("12");
  });

  it("a transfer task moves its lot", async () => {
    const { actor, productId, general, zone, l1 } = await scenario();
    expect(
      await createTask(actor, {
        productId,
        fromLocationId: general,
        toLocationId: zone,
        quantity: "5",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { lotId: expect.any(String) } });
    const task = await createTask(actor, {
      productId,
      fromLocationId: general,
      toLocationId: zone,
      quantity: "5",
      lotId: l1,
    });
    if (!task.ok) throw new Error(JSON.stringify(task));
    await acceptTask(actor, task.taskId);
    await pickUpTask(actor, task.taskId);
    expect(await deliverTask(actor, task.taskId)).toMatchObject({ ok: true });
    expect(await held(productId, zone, l1)).toBe("5");
    expect(await held(productId, general, l1)).toBe("15");
    // Its lot never changes.
    await expect(
      db.warehouseTask.update({
        where: { id: task.taskId },
        data: { lotId: null },
      }),
    ).rejects.toThrow();
  });
});

describe("picking", () => {
  async function scenario() {
    const actor = await company();
    const productId = await product(actor);
    const a = await place(actor, "Zona A");
    const b = await place(actor, "Zona B");
    // The oldest lot expires last; the fullest location holds the newest.
    await enter(actor, productId, a, "10", "VIEJO", LATER);
    await enter(actor, productId, b, "30", "NUEVO", SOON);
    await enter(actor, productId, a, "5", "CADUCO", EXPIRED);
    return { actor, productId, a, b };
  }

  async function release(
    actor: InventoryActor,
    productId: string,
    quantity: string,
    options: { takeWhatThereIs?: boolean } = {},
  ) {
    const made = await createOutboundOrder(actor, { recipient: "Sucursal" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(actor, made.orderId, { productId, quantity });
    const result = await releaseOutboundOrder(actor, made.orderId, options);
    return { orderId: made.orderId, result };
  }

  const picks = (organizationId: string) =>
    db.warehouseTask.findMany({
      where: { organizationId, kind: "PICK" },
      orderBy: { number: "asc" },
      include: { lot: true, product: true, fromLocation: true },
    });

  it("FEFO takes what expires first and never what already expired", async () => {
    const { actor, productId } = await scenario();
    await setting(actor, PICKING_STRATEGY.key, "fefo");
    const { result } = await release(actor, productId, "35");
    expect(result).toMatchObject({ ok: true });
    const tasks = await picks(actor.organizationId);
    expect(
      tasks.map((task) => [task.lot?.code, task.quantity.toString()]),
    ).toEqual([
      ["NUEVO", "30"],
      ["VIEJO", "5"],
    ]);
    // Each task holds its lot: the reservation says which.
    const reservations = await db.stockReservation.findMany({
      where: { organizationId: actor.organizationId, state: "ACTIVE" },
      include: { lot: true },
    });
    expect(
      reservations
        .map((row) => [row.lot?.code, row.remaining.toString()])
        .sort(),
    ).toEqual([
      ["NUEVO", "30"],
      ["VIEJO", "5"],
    ]);
  });

  it("FIFO takes the oldest lot; the fullest location is the default", async () => {
    const { actor, productId } = await scenario();
    await setting(actor, PICKING_STRATEGY.key, "fifo");
    expect((await release(actor, productId, "12")).result).toMatchObject({
      ok: true,
    });
    expect(
      (await picks(actor.organizationId)).map((task) => [
        task.lot?.code,
        task.quantity.toString(),
      ]),
    ).toEqual([
      ["VIEJO", "10"],
      ["NUEVO", "2"],
    ]);

    const other = await scenario();
    expect(
      (await release(other.actor, other.productId, "12")).result,
    ).toMatchObject({ ok: true });
    expect(
      (await picks(other.actor.organizationId)).map((task) => task.lot?.code),
    ).toEqual(["NUEVO"]);
  });

  it("what expired is not proposed unless the company says so", async () => {
    const { actor, productId } = await scenario();
    await setting(actor, PICKING_STRATEGY.key, "fefo");
    // 40 are good; the 5 expired ones do not count.
    expect((await release(actor, productId, "45")).result).toMatchObject({
      ok: false,
      reason: "short",
    });
    await setting(actor, PICK_EXPIRED.key, "allow");
    expect((await release(actor, productId, "45")).result).toMatchObject({
      ok: true,
    });
    expect(
      (await picks(actor.organizationId)).map((task) => task.lot?.code),
    ).toEqual(["CADUCO", "NUEVO", "VIEJO"]);
  });

  it("the picker confirms the lot and delivers it reserved for the order", async () => {
    const { actor, productId, a, b } = await scenario();
    await setting(actor, PICKING_STRATEGY.key, "fefo");
    await release(actor, productId, "35");
    const [first, second] = await picks(actor.organizationId);
    const nuevo = await lotOf(productId, "NUEVO");
    const viejo = await lotOf(productId, "VIEJO");

    // What is set aside for the order does not leave by hand, lot by lot.
    expect(
      await registerExit(actor, {
        productId,
        locationId: b,
        quantity: "1",
        lotId: nuevo,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registerExit(actor, {
        productId,
        locationId: a,
        quantity: "6",
        lotId: viejo,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registerExit(actor, {
        productId,
        locationId: a,
        quantity: "5",
        lotId: viejo,
      }),
    ).toMatchObject({ ok: true });

    await acceptTask(actor, first!.id);
    const confirm = (lotCode?: string) =>
      confirmPick(actor, first!.id, {
        productCode: first!.product.sku,
        locationCode: first!.fromLocation.name,
        quantity: "30",
        lotCode,
      });
    expect(await confirm()).toMatchObject({
      ok: false,
      fieldErrors: { lotCode: expect.stringContaining("NUEVO") },
    });
    expect(await confirm("viejo")).toMatchObject({
      ok: false,
      fieldErrors: { lotCode: expect.stringContaining("no es el lote") },
    });
    expect(await confirm(" nuevo ")).toMatchObject({ ok: true });
    expect(await deliverTask(actor, first!.id)).toMatchObject({ ok: true });

    const staging = await db.location.findFirstOrThrow({
      where: { organizationId: actor.organizationId, isStaging: true },
    });
    expect(await held(productId, staging.id, nuevo)).toBe("30");
    expect(await held(productId, b, nuevo)).toBe("0");
    // In staging it stays held for the order, with its lot.
    expect(
      await db.stockReservation.findFirst({
        where: {
          organizationId: actor.organizationId,
          locationId: staging.id,
          state: "ACTIVE",
        },
      }),
    ).toMatchObject({ lotId: nuevo });

    await acceptTask(actor, second!.id);
    expect(
      await confirmPick(actor, second!.id, {
        productCode: second!.product.sku,
        locationCode: second!.fromLocation.name,
        quantity: "5",
        lotCode: "VIEJO",
      }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(actor, second!.id)).toMatchObject({ ok: true });
    expect(await held(productId, staging.id, viejo)).toBe("5");
    expect(
      await db.outboundOrder.findFirstOrThrow({
        where: { organizationId: actor.organizationId },
      }),
    ).toMatchObject({ status: "PICKED" });
  });

  it("a product without lots is picked as before, whatever the strategy", async () => {
    const actor = await company();
    const plain = await product(actor, {});
    const a = await place(actor, "Zona A");
    const b = await place(actor, "Zona B");
    for (const [locationId, quantity] of [
      [a, "30"],
      [b, "20"],
    ] as const) {
      await registerEntry(actor, { productId: plain, locationId, quantity });
    }
    await setting(actor, PICKING_STRATEGY.key, "fefo");
    expect((await release(actor, plain, "40")).result).toMatchObject({
      ok: true,
    });
    expect(
      (await picks(actor.organizationId)).map((task) => [
        task.fromLocationId,
        task.lotId,
        task.quantity.toString(),
      ]),
    ).toEqual([
      [a, null, "30"],
      [b, null, "10"],
    ]);
  });
});

describe("a purchase order of a product by lot", () => {
  it("is received with its lot and goes back from that lot", async () => {
    const actor = await company(["inventory", "purchasing"]);
    const productId = await product(actor, {
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    });
    const plain = await product(actor, {});
    const general = (await getDefaultLocation(actor))!.id;
    const supplier = await createSupplier(actor, { name: "Proveedor" });
    if (!supplier.ok) throw new Error("supplier setup failed");
    const order = await createPurchaseOrder(actor, {
      supplierId: supplier.supplierId,
    });
    if (!order.ok) throw new Error("order setup failed");
    for (const id of [productId, plain]) {
      const added = await addOrderLine(actor, order.orderId, {
        productId: id,
        capture: "base",
        quantity: "10",
      });
      if (!added.ok) throw new Error(JSON.stringify(added));
    }
    expect(await submitPurchaseOrder(actor, order.orderId)).toMatchObject({
      ok: true,
    });
    const [lotLine, plainLine] = await db.purchaseOrderLine.findMany({
      where: { orderId: order.orderId },
      orderBy: { lineNumber: "asc" },
    });
    const receive = (lot: { lotCode?: string; lotExpiresOn?: string }) =>
      receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey: key(),
        locationId: general,
        lines: [
          { orderLineId: lotLine!.id, quantity: "6", ...lot },
          { orderLineId: plainLine!.id, quantity: "10" },
        ],
      });
    // Without its lot, or without the date its product demands, nothing
    // of the receipt is written.
    expect(await receive({})).toMatchObject({
      ok: false,
      lineErrors: { [lotLine!.id]: expect.stringContaining("escribe el lote") },
    });
    expect(await receive({ lotCode: "R-1" })).toMatchObject({
      ok: false,
      lineErrors: { [lotLine!.id]: expect.stringContaining("caducidad") },
    });
    expect(await db.lot.count({ where: { productId } })).toBe(0);
    expect(
      await db.purchaseReceipt.count({ where: { orderId: order.orderId } }),
    ).toBe(0);

    const received = await receive({ lotCode: "R-1", lotExpiresOn: SOON });
    expect(received).toMatchObject({ ok: true, status: "PARTIAL" });
    const lotId = await lotOf(productId, "R-1");
    expect(await held(productId, general, lotId)).toBe("6");
    expect(await held(plain, general, null)).toBe("10");
    const receiptLine = await db.purchaseReceiptLine.findFirstOrThrow({
      where: { orderLineId: lotLine!.id },
    });
    expect(receiptLine.lotId).toBe(lotId);

    // The rest arrives in another lot: a second receipt.
    expect(
      await receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey: key(),
        locationId: general,
        lines: [
          {
            orderLineId: lotLine!.id,
            quantity: "4",
            lotCode: "R-2",
            lotExpiresOn: LATER,
          },
        ],
      }),
    ).toMatchObject({ ok: true, status: "RECEIVED" });
    const second = await lotOf(productId, "R-2");

    // What goes back leaves from the lot it came in, not from another.
    expect(
      await returnToSupplier(actor, receiptLine.receiptId, {
        reason: "Llegó golpeado",
        idempotencyKey: key(),
        lines: [{ receiptLineId: receiptLine.id, quantity: "2" }],
      }),
    ).toMatchObject({ ok: true });
    expect(await held(productId, general, lotId)).toBe("4");
    expect(await held(productId, general, second)).toBe("4");
    // If that lot is no longer there, the other one is not taken instead.
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "4",
        lotId,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await returnToSupplier(actor, receiptLine.receiptId, {
        reason: "Llegó golpeado",
        idempotencyKey: key(),
        lines: [{ receiptLineId: receiptLine.id, quantity: "1" }],
      }),
    ).toMatchObject({ ok: false });
    expect(await held(productId, general, second)).toBe("4");
  });
});

describe("lots about to expire and the card of a lot", () => {
  it("lists what expired or will within the days the company chose", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const inDays = (days: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    await enter(actor, productId, general, "5", "CADUCO", EXPIRED);
    await enter(actor, productId, general, "5", "PRONTO", inDays(20));
    await enter(actor, productId, general, "5", "LEJOS", inDays(50));
    await enter(actor, productId, general, "5", "SIN-FECHA");
    await enter(actor, productId, general, "5", "VACIO", inDays(3));
    // A lot without stock is nobody's problem.
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "5",
        lotId: await lotOf(productId, "VACIO"),
      }),
    ).toMatchObject({ ok: true });

    const page = await listExpiringLots(actor);
    expect(page.noticeDays).toBe(30);
    expect(
      page.items.map((item) => [item.code, item.expired, item.quantityLabel]),
    ).toEqual([
      ["CADUCO", true, "5 piezas"],
      ["PRONTO", false, "5 piezas"],
    ]);
    expect(await countExpiringLots(actor)).toBe(2);
    await setting(actor, EXPIRY_NOTICE.key, "60");
    expect(
      (await listExpiringLots(actor)).items.map((item) => item.code),
    ).toEqual(["CADUCO", "PRONTO", "LEJOS"]);
    await setting(actor, EXPIRY_NOTICE.key, "7");
    expect(await countExpiringLots(actor)).toBe(1);
  });

  it("shows where a lot is and corrects its expiry date with audit", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const zone = await place(actor, "Zona A");
    await enter(actor, productId, general, "9", "L-7", SOON);
    const lotId = await lotOf(productId, "L-7");
    await registerTransfer(actor, {
      productId,
      locationId: general,
      toLocationId: zone,
      quantity: "4",
      lotId,
    });
    const card = await getLot(actor, lotId);
    expect(card).toMatchObject({
      code: "L-7",
      expiresOn: SOON,
      expiresLabel: "05/03/2099",
      total: "9",
      expired: false,
    });
    expect(card!.places.map((row) => [row.locationId, row.quantity])).toEqual(
      expect.arrayContaining([
        [general, "5"],
        [zone, "4"],
      ]),
    );
    expect((await listMovements(actor, { lotId })).total).toBe(2);

    expect(
      await changeLotExpiry(actor, { lotId, expiresOn: LATER, reason: "x" }),
    ).toMatchObject({ ok: false, field: "reason" });
    expect(
      await changeLotExpiry(actor, {
        lotId,
        expiresOn: "no es fecha",
        reason: "Se capturó mal",
      }),
    ).toMatchObject({ ok: false, field: "expiresOn" });
    expect(
      await changeLotExpiry(actor, {
        lotId,
        expiresOn: LATER,
        reason: "Se capturó mal el mes",
      }),
    ).toMatchObject({ ok: true });
    expect((await getLot(actor, lotId))?.expiresOn).toBe(LATER);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: actor.organizationId,
          action: "inventory.lot_expiry_changed",
        },
      }),
    ).toBe(1);
    // An operator may bring lots in, not correct their dates.
    const operator = await member(actor.organizationId, "operator");
    await expect(
      changeLotExpiry(operator, {
        lotId,
        expiresOn: SOON,
        reason: "No debería poder",
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await enter(operator, productId, general, "1", "L-8", SOON);
  });
});

describe("between companies and inside a scope", () => {
  it("a lot of another company does not exist", async () => {
    const one = await company();
    const other = await company();
    const productId = await product(one);
    const theirs = await product(other);
    const general = (await getDefaultLocation(one))!.id;
    const otherGeneral = (await getDefaultLocation(other))!.id;
    await enter(one, productId, general, "5", "L-1", SOON);
    await enter(other, theirs, otherGeneral, "5", "L-1", SOON);
    const lotId = await lotOf(productId, "L-1");
    expect(await getLot(other, lotId)).toBeNull();
    expect(await listLotStock(other, productId)).toEqual([]);
    expect(await listProductLots(other, productId)).toEqual([]);
    expect((await listMovements(other, { lotId })).total).toBe(0);
    expect(
      await changeLotExpiry(other, {
        lotId,
        expiresOn: LATER,
        reason: "De otra empresa",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // Their own product cannot leave from our lot.
    expect(
      await registerExit(other, {
        productId: theirs,
        locationId: otherGeneral,
        quantity: "1",
        lotId,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { lotId: expect.any(String) } });
    expect((await listExpiringLots(other)).items).toEqual([]);
  });

  it("someone limited to a zone sees and moves the lots of that zone", async () => {
    const actor = await company();
    const productId = await product(actor);
    const zoneA = await place(actor, "Zona A");
    const zoneB = await place(actor, "Zona B");
    await enter(actor, productId, zoneA, "8", "L-A", EXPIRED);
    await enter(actor, productId, zoneB, "6", "L-B", EXPIRED);
    const limited = await member(actor.organizationId, "warehouse");
    const facility = await getActiveFacility(actor);
    const scoped = await setMemberScope(actor.organizationId, actor.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: facility.id, zoneIds: [zoneB] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const lotA = await lotOf(productId, "L-A");
    const lotB = await lotOf(productId, "L-B");

    expect(
      (await listLotStock(limited, productId)).map((row) => row.code),
    ).toEqual(["L-B"]);
    expect(
      (await listProductLots(limited, productId)).map((lot) => [
        lot.code,
        lot.total,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["L-B", "6"],
        ["L-A", "0"],
      ]),
    );
    expect(
      (await listExpiringLots(limited)).items.map((item) => item.code),
    ).toEqual(["L-B"]);
    expect(await countExpiringLots(limited)).toBe(1);
    expect((await getLot(limited, lotA))?.places).toEqual([]);
    expect((await listMovements(limited, { lotId: lotA })).total).toBe(0);
    // Whatever ids arrive, nothing leaves a zone that is not theirs.
    await expect(
      registerExit(limited, {
        productId,
        locationId: zoneA,
        quantity: "1",
        lotId: lotA,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      await registerExit(limited, {
        productId,
        locationId: zoneB,
        quantity: "1",
        lotId: lotB,
      }),
    ).toMatchObject({ ok: true });
  });
});
