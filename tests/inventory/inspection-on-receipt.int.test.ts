import { afterAll, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import {
  CONTAINERS_MODE,
  CROSS_DOCK_MODE,
  PUTAWAY_MODE,
  changeStockStatus,
  countAwaitingInspection,
  disposeStock,
  findDisposalConfirmation,
  getProductStock,
  heldStock,
  holdStock,
  listAwaitingInspection,
  reconcileStock,
  reconcileValue,
  releaseHold,
  reverseMovement,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  getOrderReceipts,
  receivePurchaseOrder,
  returnToSupplier,
  submitPurchaseOrder,
  type PurchasingActor,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct, updateProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { LOCKING_TRANSACTION, db, forOrganization, lockRows } from "@/server";

// WMS-30-0 (ADR 0068): a product inspected on receipt enters in
// inspection (never available), counts as received at the same cost, is
// not crossdocked, put away nor palletized; it is decided with «Cambiar
// estado»; what is rejected goes back to the supplier or is written off
// (DISPOSAL); and a generic hold keeps any open document's stock out of
// reach of every other operation.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${counter + 1}`,
      email: `inspeccion.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory", "purchasing"],
): Promise<PurchasingActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa inspección ${counter}`,
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
      productLimit: 30,
      users: 20,
      modules,
      validUntil: null,
      reason: "Prueba de inspección al recibir",
    },
  );
  if (!result.ok) throw new Error(`provision failed: ${JSON.stringify(result)}`);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(organizationId: string, role: Role) {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
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

let skus = 0;
async function product(
  actor: PurchasingActor,
  extra: { tracking?: "NONE" | "LOT" | "SERIAL"; inspect?: boolean } = {},
) {
  const created = await createProduct(actor, {
    sku: `I-${++skus}`,
    name: `Válvula ${skus}`,
    ...(extra.tracking ? { tracking: extra.tracking } : {}),
    inspectOnReceipt: extra.inspect === false ? "no" : "yes",
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function sentOrder(
  actor: PurchasingActor,
  lines: { productId: string; quantity: string }[],
) {
  const supplier = await createSupplier(actor, {
    name: `Proveedor ${newId().slice(-6)}`,
  });
  if (!supplier.ok) throw new Error("supplier setup failed");
  const order = await createPurchaseOrder(actor, {
    supplierId: supplier.supplierId,
  });
  if (!order.ok) throw new Error("order setup failed");
  for (const line of lines) {
    const added = await addOrderLine(actor, order.orderId, {
      productId: line.productId,
      capture: "base",
      quantity: line.quantity,
      unitCost: "10",
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  const sent = await submitPurchaseOrder(actor, order.orderId);
  if (!sent.ok) throw new Error("submit failed");
  return order.orderId;
}

const lineIdOf = async (actor: PurchasingActor, orderId: string, n = 0) =>
  (await getOrderReceipts(actor, orderId))!.lines[n]!.orderLineId;

const balances = (productId: string) =>
  db.stockBalance.findMany({
    where: { productId, quantity: { gt: 0 } },
    orderBy: [{ status: "asc" }, { lotKey: "asc" }],
    select: { status: true, quantity: true, locationId: true, lotKey: true },
  });

const plain = (rows: Awaited<ReturnType<typeof balances>>) =>
  rows.map((row) => `${row.status} ${row.quantity.toString()}`);

const valueOf = async (productId: string) =>
  (
    await db.productCost.findFirst({ where: { productId } })
  )?.stockValue.toString();

async function balanced(organizationId: string) {
  expect(await reconcileStock(organizationId)).toEqual([]);
  expect(await reconcileValue(organizationId)).toEqual([]);
}

/** Receives everything of a one-line order of `productId`. */
async function received(
  owner: PurchasingActor,
  productId: string,
  quantity: string,
  extra: Record<string, string> = {},
) {
  const orderId = await sentOrder(owner, [{ productId, quantity }]);
  const orderLineId = await lineIdOf(owner, orderId);
  const result = await receivePurchaseOrder(owner, orderId, {
    idempotencyKey: newId(),
    lines: [{ orderLineId, quantity, ...extra }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  const view = await getOrderReceipts(owner, orderId);
  return { orderId, orderLineId, receiptId: result.receiptId, view, result };
}

afterAll(() => db.$disconnect());

describe("inspection on receipt (WMS-30-0)", () => {
  it("enters in inspection, counts as received at the same cost, apart from the damaged", async () => {
    const owner = await company();
    await createLocation(owner, { level: 3, name: "Estante A" });
    await setting(owner, PUTAWAY_MODE.key, "tasks");
    const productId = await product(owner);
    const { view, result } = await received(owner, productId, "10", {
      damaged: "2",
    });
    expect(result.status).toBe("RECEIVED");
    expect(result.summary).toContain("Quedó en inspección: 8 piezas");
    expect(plain(await balances(productId))).toEqual([
      "INSPECTION 8",
      "DAMAGED 2",
    ]);
    expect(view!.lines[0]!.pendingText).toBeNull();
    expect(
      view!.receipts[0]!.lines.map((line) => [line.status, line.inspection]),
    ).toEqual([
      ["INSPECTION", true],
      ["DAMAGED", false],
    ]);
    // Nothing is available (PC-5) and nothing is put away.
    expect((await getProductStock(owner, productId))?.available).toBe("0");
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    // Same cost as any receipt: the value covers every state.
    expect(await valueOf(productId)).toBe("100");
    await balanced(owner.organizationId);
  });

  it("works the same in a company with Calidad", async () => {
    const owner = await company([
      "inventory",
      "purchasing",
      "production",
      "quality",
    ]);
    const productId = await product(owner);
    await received(owner, productId, "5");
    expect(plain(await balances(productId))).toEqual(["INSPECTION 5"]);
    expect(await countAwaitingInspection(owner)).toBe(1);
    await balanced(owner.organizationId);
  });

  it("a product not inspected enters available as before", async () => {
    const owner = await company();
    const productId = await product(owner, { inspect: false });
    await received(owner, productId, "4");
    expect(plain(await balances(productId))).toEqual(["AVAILABLE 4"]);
    // The rule changes on the card, and applies to the next receipts.
    const changed = await updateProduct(owner, productId, {
      sku: `I-${skus}`,
      name: `Válvula ${skus}`,
      inspectOnReceipt: "yes",
    });
    expect(changed).toMatchObject({ ok: true });
    await received(owner, productId, "3");
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 4",
      "INSPECTION 3",
    ]);
    await balanced(owner.organizationId);
  });

  it("is never crossdocked nor palletized", async () => {
    const owner = await company();
    await setting(owner, CROSS_DOCK_MODE.key, "on");
    await setting(owner, CONTAINERS_MODE.key, "on");
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "5" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const pallet = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "5" }],
      container: { code: "", kind: "Tarima" },
    });
    expect(pallet.ok).toBe(false);
    expect(JSON.stringify(pallet)).toContain("no va en la tarima");
    const loose = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "5" }],
    });
    expect(loose).toMatchObject({ ok: true });
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    expect(await db.containerItem.count({ where: { productId } })).toBe(0);
    await balanced(owner.organizationId);
  });

  it("recognizes a retry although the rule of the product changed", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const input = {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "6" }],
    };
    expect(await receivePurchaseOrder(owner, orderId, input)).toMatchObject({
      ok: true,
    });
    await updateProduct(owner, productId, {
      sku: `I-${skus}`,
      name: `Válvula ${skus}`,
      inspectOnReceipt: "no",
    });
    expect(await receivePurchaseOrder(owner, orderId, input)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(plain(await balances(productId))).toEqual(["INSPECTION 6"]);
    await balanced(owner.organizationId);
  });

  it("is decided with «Cambiar estado» and the release gets its put-away task", async () => {
    const owner = await company();
    await createLocation(owner, { level: 3, name: "Estante A" });
    await setting(owner, PUTAWAY_MODE.key, "tasks");
    const productId = await product(owner);
    await received(owner, productId, "10");
    const [row] = await balances(productId);
    const list = await listAwaitingInspection(owner);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      quantityLabel: "10 piezas",
      decidable: true,
      heldLabel: null,
    });
    expect(list.items[0]!.origin).toContain("Recepción de compra");

    // The floor does not decide.
    const operator = await member(owner.organizationId, "operator");
    await expect(
      changeStockStatus(operator, {
        productId,
        locationId: row!.locationId,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "1",
        reason: "Revisado",
        idempotencyKey: newId(),
      }),
    ).rejects.toThrow();

    const supervisor = await member(owner.organizationId, "supervisor");
    const released = await changeStockStatus(supervisor, {
      productId,
      locationId: row!.locationId,
      from: "INSPECTION",
      to: "AVAILABLE",
      quantity: "7",
      reason: "Revisado, cumple",
      idempotencyKey: newId(),
    });
    expect(released).toMatchObject({ ok: true });
    const rejected = await changeStockStatus(supervisor, {
      productId,
      locationId: row!.locationId,
      from: "INSPECTION",
      to: "REJECTED",
      quantity: "3",
      reason: "No cumple la medida",
      idempotencyKey: newId(),
    });
    expect(rejected).toMatchObject({ ok: true });
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 7",
      "REJECTED 3",
    ]);
    const tasks = await db.warehouseTask.findMany({
      where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
    });
    expect(tasks.map((task) => task.quantity?.toString())).toEqual(["7"]);
    expect(await countAwaitingInspection(owner)).toBe(0);
    await balanced(owner.organizationId);
  });

  it("goes back to the supplier from rejected and from inspection", async () => {
    const owner = await company();
    const productId = await product(owner);
    const { receiptId, orderId } = await received(owner, productId, "10");
    const view = await getOrderReceipts(owner, orderId);
    const receiptLine = view!.receipts[0]!.lines[0]!;
    await changeStockStatus(owner, {
      productId,
      locationId: receiptLine.locationId,
      from: "INSPECTION",
      to: "REJECTED",
      quantity: "4",
      reason: "No cumple",
      idempotencyKey: newId(),
    });
    // Both states are offered for the return.
    const again = await getOrderReceipts(owner, orderId);
    expect(
      again!.receipts[0]!.lines[0]!.returnStates.map((state) => state.id),
    ).toEqual(["INSPECTION", "REJECTED"]);

    const key = newId();
    const fromRejected = {
      reason: "No cumple la medida",
      idempotencyKey: key,
      lines: [
        {
          receiptLineId: receiptLine.receiptLineId,
          quantity: "4",
          status: "REJECTED",
        },
      ],
    };
    const back = await returnToSupplier(owner, receiptId, fromRejected);
    expect(back).toMatchObject({ ok: true });
    expect(back.ok && back.summary).toContain("rechazado");
    expect(await returnToSupplier(owner, receiptId, fromRejected)).toMatchObject(
      { ok: true, repeated: true },
    );
    // The same key from another state is another return.
    expect(
      await returnToSupplier(owner, receiptId, {
        ...fromRejected,
        lines: [{ ...fromRejected.lines[0]!, status: "INSPECTION" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });

    // By default it leaves from the state it came in: inspection.
    const fromInspection = await returnToSupplier(owner, receiptId, {
      reason: "Se regresa sin revisar",
      idempotencyKey: newId(),
      lines: [{ receiptLineId: receiptLine.receiptLineId, quantity: "6" }],
    });
    expect(fromInspection).toMatchObject({ ok: true });
    // Never more than what arrived.
    const more = await returnToSupplier(owner, receiptId, {
      reason: "Otra vez",
      idempotencyKey: newId(),
      lines: [{ receiptLineId: receiptLine.receiptLineId, quantity: "1" }],
    });
    expect(more).toMatchObject({ ok: false });
    expect(plain(await balances(productId))).toEqual([]);
    // At the cost it came in with: nothing of value is left.
    expect(await valueOf(productId)).toBe("0");
    await balanced(owner.organizationId);
  });

  it("returns and writes off by lot and by serial", async () => {
    const owner = await company();
    const byLot = await product(owner, { tracking: "LOT" });
    const bySerial = await product(owner, { tracking: "SERIAL" });
    const orderId = await sentOrder(owner, [
      { productId: byLot, quantity: "6" },
      { productId: bySerial, quantity: "3" },
    ]);
    const lotLine = await lineIdOf(owner, orderId, 0);
    const serialLine = await lineIdOf(owner, orderId, 1);
    const result = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [
        { orderLineId: lotLine, quantity: "6", lotCode: "L-7" },
        { orderLineId: serialLine, quantity: "3", serials: "A-1\nA-2\nA-3" },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const units = await db.serialUnit.findMany({
      where: { productId: bySerial },
      select: { status: true },
    });
    expect(units.every((unit) => unit.status === "INSPECTION")).toBe(true);
    const view = await getOrderReceipts(owner, orderId);
    const [lotReceipt, serialReceipt] = view!.receipts[0]!.lines;
    const lot = await db.lot.findFirstOrThrow({ where: { productId: byLot } });

    await changeStockStatus(owner, {
      productId: bySerial,
      locationId: serialReceipt!.locationId,
      from: "INSPECTION",
      to: "REJECTED",
      quantity: "2",
      serials: "A-1\nA-2",
      reason: "No enciende",
      idempotencyKey: newId(),
    });
    const back = await returnToSupplier(owner, result.receiptId, {
      reason: "No enciende",
      idempotencyKey: newId(),
      lines: [
        {
          receiptLineId: serialReceipt!.receiptLineId,
          quantity: "1",
          status: "REJECTED",
          serials: "A-1",
        },
      ],
    });
    expect(back).toMatchObject({ ok: true });
    const disposed = await disposeStock(owner, {
      productId: bySerial,
      locationId: serialReceipt!.locationId,
      status: "REJECTED",
      quantity: "1",
      serials: "A-2",
      reason: "Se tira, sin arreglo",
      idempotencyKey: newId(),
    });
    expect(disposed).toMatchObject({ ok: true });
    const gone = await db.serialUnit.findMany({
      where: { productId: bySerial, serial: { in: ["A-1", "A-2"] } },
      select: { locationId: true },
    });
    expect(gone.every((unit) => unit.locationId === null)).toBe(true);

    await changeStockStatus(owner, {
      productId: byLot,
      locationId: lotReceipt!.locationId,
      lotId: lot.id,
      from: "INSPECTION",
      to: "DAMAGED",
      quantity: "2",
      reason: "Golpeado",
      idempotencyKey: newId(),
    });
    const lotDisposed = await disposeStock(owner, {
      productId: byLot,
      locationId: lotReceipt!.locationId,
      lotId: lot.id,
      status: "DAMAGED",
      quantity: "2",
      reason: "Golpeado, no sirve",
      idempotencyKey: newId(),
    });
    expect(lotDisposed).toMatchObject({ ok: true });
    expect(plain(await balances(byLot))).toEqual(["INSPECTION 4"]);
    await balanced(owner.organizationId);
  });
});

describe("«Desechar» (WMS-30-0)", () => {
  async function rejectedStock(owner: PurchasingActor, quantity = "10") {
    const productId = await product(owner);
    await received(owner, productId, quantity);
    const [row] = await balances(productId);
    const changed = await changeStockStatus(owner, {
      productId,
      locationId: row!.locationId,
      from: "INSPECTION",
      to: "REJECTED",
      quantity,
      reason: "No cumple",
      idempotencyKey: newId(),
    });
    if (!changed.ok) throw new Error(JSON.stringify(changed));
    return { productId, locationId: row!.locationId };
  }

  it("leaves at the average cost, as a loss, once per key, and is never reversed", async () => {
    const owner = await company();
    const { productId, locationId } = await rejectedStock(owner);
    expect(await valueOf(productId)).toBe("100");
    const input = {
      productId,
      locationId,
      status: "REJECTED",
      quantity: "4",
      reason: "Roto, no se puede devolver",
      idempotencyKey: newId(),
    };
    const done = await disposeStock(owner, input);
    expect(done).toMatchObject({ ok: true });
    expect(await disposeStock(owner, input)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(
      await disposeStock(owner, { ...input, quantity: "3" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await findDisposalConfirmation(owner, input.idempotencyKey),
    ).toMatchObject({ movementId: done.ok ? done.movementId : "" });
    expect(plain(await balances(productId))).toEqual(["REJECTED 6"]);
    expect(await valueOf(productId)).toBe("60");
    const line = await db.stockMovementLine.findFirstOrThrow({
      where: { movement: { type: "DISPOSAL" }, productId },
    });
    expect(line.unitCost?.toString()).toBe("10");
    const reversed = await reverseMovement(owner, {
      movementId: done.ok ? done.movementId : "",
      reason: "Me equivoqué",
      idempotencyKey: newId(),
    });
    expect(reversed).toMatchObject({ ok: false });
    await balanced(owner.organizationId);
  });

  it("never takes available stock nor more than there is, and asks why", async () => {
    const owner = await company();
    const productId = await product(owner, { inspect: false });
    await received(owner, productId, "5");
    const [row] = await balances(productId);
    expect(
      await disposeStock(owner, {
        productId,
        locationId: row!.locationId,
        status: "AVAILABLE",
        quantity: "1",
        reason: "Sobra",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    const rejected = await rejectedStock(owner, "2");
    expect(
      await disposeStock(owner, {
        ...rejected,
        status: "REJECTED",
        quantity: "3",
        reason: "Roto",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await disposeStock(owner, {
        ...rejected,
        status: "REJECTED",
        quantity: "1",
        reason: "",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    expect(plain(await balances(rejected.productId))).toEqual(["REJECTED 2"]);
    await balanced(owner.organizationId);
  });

  it("is for whoever adjusts: not the floor nor Gerencia", async () => {
    const owner = await company();
    const stock = await rejectedStock(owner);
    for (const role of ["operator", "forklift", "manager", "viewer", "buyer"]) {
      const person = await member(owner.organizationId, role as Role);
      await expect(
        disposeStock(person, {
          ...stock,
          status: "REJECTED",
          quantity: "1",
          reason: "Roto",
          idempotencyKey: newId(),
        }),
      ).rejects.toThrow();
    }
    for (const role of ["administrator", "warehouse", "supervisor"]) {
      const person = await member(owner.organizationId, role as Role);
      expect(
        await disposeStock(person, {
          ...stock,
          status: "REJECTED",
          quantity: "1",
          reason: "Roto",
          idempotencyKey: newId(),
        }),
      ).toMatchObject({ ok: true });
    }
    expect(plain(await balances(stock.productId))).toEqual(["REJECTED 7"]);
    await balanced(owner.organizationId);
  });

  it("two write-offs and a return at once never go below zero", async () => {
    const owner = await company();
    const productId = await product(owner);
    const { receiptId, orderId } = await received(owner, productId, "5");
    const view = await getOrderReceipts(owner, orderId);
    const line = view!.receipts[0]!.lines[0]!;
    await changeStockStatus(owner, {
      productId,
      locationId: line.locationId,
      from: "INSPECTION",
      to: "REJECTED",
      quantity: "5",
      reason: "No cumple",
      idempotencyKey: newId(),
    });
    const results = await Promise.all([
      disposeStock(owner, {
        productId,
        locationId: line.locationId,
        status: "REJECTED",
        quantity: "3",
        reason: "Roto",
        idempotencyKey: newId(),
      }),
      disposeStock(owner, {
        productId,
        locationId: line.locationId,
        status: "REJECTED",
        quantity: "3",
        reason: "Roto",
        idempotencyKey: newId(),
      }),
      returnToSupplier(owner, receiptId, {
        reason: "No cumple",
        idempotencyKey: newId(),
        lines: [
          {
            receiptLineId: line.receiptLineId,
            quantity: "3",
            status: "REJECTED",
          },
        ],
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(plain(await balances(productId))).toEqual(["REJECTED 2"]);
    await balanced(owner.organizationId);
  });
});

describe("generic hold (WMS-30-0)", () => {
  async function hold(
    owner: InventoryActor,
    slot: {
      productId: string;
      locationId: string;
      status: "INSPECTION" | "REJECTED";
    },
    quantity: string,
    unitIds?: string[],
  ) {
    return forOrganization(owner.organizationId).$transaction(async (tx) => {
      await lockRows(tx, "product", [slot.productId]);
      await lockRows(tx, "location", [slot.locationId]);
      return holdStock(tx, owner, {
        ...slot,
        lotId: null,
        quantity,
        unitIds,
        sourceType: "test",
        sourceId: newId(),
        sourceText: "IN-0001",
      });
    }, LOCKING_TRANSACTION);
  }

  it("keeps what an open document holds out of every other operation", async () => {
    const owner = await company();
    const productId = await product(owner);
    const { receiptId, orderId } = await received(owner, productId, "10");
    const view = await getOrderReceipts(owner, orderId);
    const line = view!.receipts[0]!.lines[0]!;
    const slot = {
      productId,
      locationId: line.locationId,
      status: "INSPECTION" as const,
    };
    const held = await hold(owner, slot, "8");
    expect(held).toMatchObject({ ok: true });
    // Nothing held twice: only 2 are free.
    expect(await hold(owner, slot, "3")).toMatchObject({ ok: false });

    const change = await changeStockStatus(owner, {
      productId,
      locationId: line.locationId,
      from: "INSPECTION",
      to: "AVAILABLE",
      quantity: "3",
      reason: "Revisado",
      idempotencyKey: newId(),
    });
    expect(change).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(change.ok || change.fieldErrors.quantity).toContain("IN-0001");
    expect(
      await returnToSupplier(owner, receiptId, {
        reason: "Se regresa",
        idempotencyKey: newId(),
        lines: [{ receiptLineId: line.receiptLineId, quantity: "3" }],
      }),
    ).toMatchObject({ ok: false });
    // What is free still moves.
    const free = await changeStockStatus(owner, {
      productId,
      locationId: line.locationId,
      from: "INSPECTION",
      to: "REJECTED",
      quantity: "2",
      reason: "No cumple",
      idempotencyKey: newId(),
    });
    expect(free).toMatchObject({ ok: true });
    // A reversal of that change would take rejected stock: allowed; but a
    // hold on rejected stock stops it.
    expect(
      await hold(
        owner,
        { ...slot, status: "REJECTED" },
        "2",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await reverseMovement(owner, {
        movementId: free.ok ? free.movementId : "",
        reason: "Me equivoqué",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await disposeStock(owner, {
        productId,
        locationId: line.locationId,
        status: "REJECTED",
        quantity: "1",
        reason: "Roto",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    // The list says what is held and by whom.
    const list = await listAwaitingInspection(owner);
    expect(list.items[0]).toMatchObject({
      heldLabel: "8 piezas",
      heldBy: "IN-0001",
      decidable: false,
    });
    await balanced(owner.organizationId);

    // Released, it is free again.
    if (!held.ok) throw new Error("hold");
    await forOrganization(owner.organizationId).$transaction(async (tx) => {
      await lockRows(tx, "product", [productId]);
      await releaseHold(tx, held.holdId, { quantity: "5" });
      expect(
        (await heldStock(tx, { ...slot, lotId: null })).quantity.toString(),
      ).toBe("3");
      await releaseHold(tx, held.holdId);
    }, LOCKING_TRANSACTION);
    const after = await db.stockHold.findUniqueOrThrow({
      where: { id: held.holdId },
    });
    expect(after.state).toBe("CLOSED");
    expect(
      await changeStockStatus(owner, {
        productId,
        locationId: line.locationId,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "8",
        reason: "Revisado",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });

  it("holds units by serial and the database keeps holds whole", async () => {
    const owner = await company();
    const productId = await product(owner, { tracking: "SERIAL" });
    await received(owner, productId, "2", { serials: "B-1\nB-2" });
    const [row] = await balances(productId);
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { productId, serial: "B-1" },
    });
    const slot = {
      productId,
      locationId: row!.locationId,
      status: "INSPECTION" as const,
    };
    expect(await hold(owner, slot, "1")).toMatchObject({ ok: false });
    const held = await hold(owner, slot, "1", [unit.id]);
    expect(held).toMatchObject({ ok: true });
    // The held unit does not change state; the other one does.
    const blocked = await changeStockStatus(owner, {
      productId,
      locationId: row!.locationId,
      from: "INSPECTION",
      to: "AVAILABLE",
      quantity: "1",
      serials: "B-1",
      reason: "Revisado",
      idempotencyKey: newId(),
    });
    expect(blocked).toMatchObject({ ok: false });
    expect(
      await changeStockStatus(owner, {
        productId,
        locationId: row!.locationId,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "1",
        serials: "B-2",
        reason: "Revisado",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    // Triggers: a hold is never deleted nor grown, never on available.
    if (!held.ok) throw new Error("hold");
    await expect(
      db.stockHold.delete({ where: { id: held.holdId } }),
    ).rejects.toThrow();
    await expect(
      db.stockHold.update({
        where: { id: held.holdId },
        data: { quantity: "5" },
      }),
    ).rejects.toThrow();
    await expect(
      db.stockHold.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          productId,
          locationId: row!.locationId,
          status: "AVAILABLE",
          quantity: "1",
          remaining: "1",
          sourceType: "test",
          sourceId: newId(),
          sourceText: "X",
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
    await balanced(owner.organizationId);
  });

  it("a hold larger than its balance is reported by the reconciliation", async () => {
    const owner = await company();
    const productId = await product(owner);
    await received(owner, productId, "2");
    const [row] = await balances(productId);
    // Written by hand, behind the services: what reconciliation catches.
    await db.stockHold.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        productId,
        locationId: row!.locationId,
        status: "INSPECTION",
        quantity: "5",
        remaining: "5",
        sourceType: "test",
        sourceId: newId(),
        sourceText: "X",
        createdByUserId: owner.userId,
      },
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([
      expect.objectContaining({ source: "holds", fromMovements: "5" }),
    ]);
  });

  it("two holds of the same stock at once: only one", async () => {
    const owner = await company();
    const productId = await product(owner);
    await received(owner, productId, "5");
    const [row] = await balances(productId);
    const slot = {
      productId,
      locationId: row!.locationId,
      status: "INSPECTION" as const,
    };
    const results = await Promise.all([
      hold(owner, slot, "4"),
      hold(owner, slot, "4"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const total = (
      await db.stockHold.findMany({ where: { productId } })
    ).reduce((sum, row) => sum.plus(row.remaining.toString()), dec(0));
    expect(total.toString()).toBe("4");
    await balanced(owner.organizationId);
  });
});
