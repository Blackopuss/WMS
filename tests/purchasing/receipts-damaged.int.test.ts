import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CONTAINERS_MODE,
  PUTAWAY_MODE,
  changeStockStatus,
  getProductStock,
  reconcileStock,
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
import { provisionCompany } from "@/platform/billing";
import { createPresentation, createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { createLocation, getDefaultLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-54 (ADR 0052): what arrives damaged from a supplier counts as
// received but enters in «Dañado», as its own receipt line: it gets no
// put-away task, is not available, and goes back to the supplier from
// «Dañado», apart from what arrived healthy.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${counter + 1}`,
      email: `danado.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<PurchasingActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa daños ${counter}`,
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
      users: 10,
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba de daños al recibir",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
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
  extra: { tracking?: "NONE" | "LOT" | "SERIAL" } = {},
) {
  const created = await createProduct(actor, {
    sku: `D-${++skus}`,
    name: `Foco ${skus}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function sentOrder(
  actor: PurchasingActor,
  lines: { productId: string; capture?: string; quantity: string }[],
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
      capture: line.capture ?? "base",
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
    select: { status: true, quantity: true, lotKey: true },
  });

const plain = (rows: Awaited<ReturnType<typeof balances>>) =>
  rows.map((row) => `${row.status} ${row.quantity.toString()}`);

afterAll(() => db.$disconnect());

describe("damaged goods at a receipt (WMS-54)", () => {
  it("counts as received, enters damaged and gets no put-away task", async () => {
    const owner = await company();
    await createLocation(owner, { level: 3, name: "Estante A" });
    await setting(owner, PUTAWAY_MODE.key, "tasks");
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);

    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "10", damaged: "3" }],
    });
    expect(received).toMatchObject({ ok: true, status: "RECEIVED" });
    expect(received.ok && received.summary).toContain("Quedó en «Dañado»");
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 7",
      "DAMAGED 3",
    ]);
    // Only the healthy part is put away; only it is available.
    const tasks = await db.warehouseTask.findMany({
      where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
    });
    expect(tasks.map((task) => task.quantity?.toString())).toEqual(["7"]);
    const stock = await getProductStock(owner, productId);
    expect(stock?.available).toBe("7");

    const view = await getOrderReceipts(owner, orderId);
    expect(view!.lines[0]!.pendingText).toBeNull();
    expect(
      view!.receipts[0]!.lines.map((line) => [line.damaged, line.quantityText]),
    ).toEqual([
      [false, "7 piezas"],
      [true, "3 piezas"],
    ]);
    // The damaged part entered at the same cost as the rest.
    const lines = await db.stockMovementLine.findMany({
      where: { productId },
      orderBy: { lineNumber: "asc" },
      select: { status: true, unitCost: true },
    });
    expect(
      lines.map((line) => [line.status, line.unitCost?.toString()]),
    ).toEqual([
      ["AVAILABLE", "10"],
      ["DAMAGED", "10"],
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("is counted in the terms of the line and never more than what arrived", async () => {
    const owner = await company();
    const productId = await product(owner);
    const made = await createPresentation(owner, productId, {
      name: "Caja",
      factor: "10",
    });
    if (!made.ok) throw new Error("presentation setup failed");
    const orderId = await sentOrder(owner, [
      { productId, capture: `p:${made.presentationId}`, quantity: "3" },
    ]);
    const orderLineId = await lineIdOf(owner, orderId);

    const tooMuch = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "2", damaged: "3" }],
    });
    expect(tooMuch).toMatchObject({
      ok: false,
      lineFields: { [orderLineId]: "damaged" },
    });
    expect(tooMuch.ok || tooMuch.lineErrors?.[orderLineId]).toContain(
      "lo dañado no puede ser más",
    );

    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "2", damaged: "1" }],
    });
    expect(received).toMatchObject({ ok: true, status: "PARTIAL" });
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 10",
      "DAMAGED 10",
    ]);
    // 1 box is still pending: damaged boxes count as received.
    expect(
      (await getOrderReceipts(owner, orderId))!.lines[0]!.pendingText,
    ).toBe("1 caja");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("keeps the lot of each part and names the damaged serials", async () => {
    const owner = await company();
    const byLot = await product(owner, { tracking: "LOT" });
    const bySerial = await product(owner, { tracking: "SERIAL" });
    const orderId = await sentOrder(owner, [
      { productId: byLot, quantity: "10" },
      { productId: bySerial, quantity: "3" },
    ]);
    const lotLine = await lineIdOf(owner, orderId, 0);
    const serialLine = await lineIdOf(owner, orderId, 1);

    const stranger = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [
        {
          orderLineId: serialLine,
          quantity: "3",
          serials: "S-1\nS-2\nS-3",
          damagedSerials: "S-9",
        },
      ],
    });
    expect(stranger).toMatchObject({
      ok: false,
      lineFields: { [serialLine]: "damagedSerials" },
    });

    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [
        { orderLineId: lotLine, quantity: "6", lotCode: "L-1", damaged: "2" },
        { orderLineId: lotLine, quantity: "4", lotCode: "L-2" },
        {
          orderLineId: serialLine,
          quantity: "3",
          serials: "S-1\nS-2\nS-3",
          damagedSerials: "s-2",
        },
      ],
    });
    expect(received).toMatchObject({ ok: true, status: "RECEIVED" });
    const lots = await db.lot.findMany({
      where: { productId: byLot },
      orderBy: { code: "asc" },
    });
    expect(
      (await balances(byLot)).map(
        (row) =>
          `${row.status} ${lots.find((lot) => lot.id === row.lotKey)?.code} ${row.quantity.toString()}`,
      ),
    ).toEqual(["AVAILABLE L-1 4", "AVAILABLE L-2 4", "DAMAGED L-1 2"]);
    const units = await db.serialUnit.findMany({
      where: { productId: bySerial },
      orderBy: { serial: "asc" },
      select: { serial: true, status: true },
    });
    expect(units.map((unit) => `${unit.serial} ${unit.status}`)).toEqual([
      "S-1 AVAILABLE",
      "S-2 DAMAGED",
      "S-3 AVAILABLE",
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("recognizes a retry by its damaged part too", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const idempotencyKey = newId();
    const input = {
      idempotencyKey,
      lines: [{ orderLineId, quantity: "5", damaged: "2" }],
    };
    expect(await receivePurchaseOrder(owner, orderId, input)).toMatchObject({
      ok: true,
    });
    expect(await receivePurchaseOrder(owner, orderId, input)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey,
        lines: [{ orderLineId, quantity: "5", damaged: "1" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 3",
      "DAMAGED 2",
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("goes back to the supplier from «Dañado», apart from what arrived healthy", async () => {
    const owner = await company();
    const productId = await product(owner);
    const bySerial = await product(owner, { tracking: "SERIAL" });
    const orderId = await sentOrder(owner, [
      { productId, quantity: "10" },
      { productId: bySerial, quantity: "2" },
    ]);
    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [
        {
          orderLineId: await lineIdOf(owner, orderId, 0),
          quantity: "10",
          damaged: "3",
        },
        {
          orderLineId: await lineIdOf(owner, orderId, 1),
          quantity: "2",
          serials: "X-1\nX-2",
          damagedSerials: "X-2",
        },
      ],
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    const receipt = (await getOrderReceipts(owner, orderId))!.receipts[0]!;
    const damagedLine = receipt.lines.find(
      (line) => line.damaged && !line.bySerial,
    )!;
    const healthyLine = receipt.lines.find(
      (line) => !line.damaged && !line.bySerial,
    )!;
    const damagedSerial = receipt.lines.find(
      (line) => line.damaged && line.bySerial,
    )!;

    // Never more than what arrived damaged.
    const tooMuch = await returnToSupplier(owner, received.receiptId, {
      reason: "Llegó roto",
      idempotencyKey: newId(),
      lines: [{ receiptLineId: damagedLine.receiptLineId, quantity: "4" }],
    });
    expect(tooMuch).toMatchObject({ ok: false });
    // A serial that arrived healthy does not go back as damaged.
    expect(
      await returnToSupplier(owner, received.receiptId, {
        reason: "Llegó roto",
        idempotencyKey: newId(),
        lines: [
          {
            receiptLineId: damagedSerial.receiptLineId,
            quantity: "1",
            serials: "X-1",
          },
        ],
      }),
    ).toMatchObject({ ok: false });

    const back = await returnToSupplier(owner, received.receiptId, {
      reason: "Llegó roto",
      idempotencyKey: newId(),
      lines: [
        { receiptLineId: damagedLine.receiptLineId, quantity: "2" },
        { receiptLineId: healthyLine.receiptLineId, quantity: "1" },
        {
          receiptLineId: damagedSerial.receiptLineId,
          quantity: "1",
          serials: "X-2",
        },
      ],
    });
    expect(back).toMatchObject({ ok: true });
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 6",
      "DAMAGED 1",
    ]);
    expect(plain(await balances(bySerial))).toEqual(["AVAILABLE 1"]);
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { productId: bySerial, serial: "X-2" },
    });
    expect(unit.locationId).toBeNull();

    // What is left damaged changed state: the return says so plainly.
    const general = (await getDefaultLocation(owner))!.id;
    const released = await changeStockStatus(owner, {
      productId,
      locationId: general,
      from: "DAMAGED",
      to: "AVAILABLE",
      quantity: "1",
      reason: "Se reparó",
      idempotencyKey: newId(),
    });
    expect(released).toMatchObject({ ok: true });
    const gone = await returnToSupplier(owner, received.receiptId, {
      reason: "Llegó roto",
      idempotencyKey: newId(),
      lines: [{ receiptLineId: damagedLine.receiptLineId, quantity: "1" }],
    });
    expect(gone).toMatchObject({ ok: false });
    expect(gone.ok || gone.lineErrors?.[damagedLine.receiptLineId]).toContain(
      "en «Dañado»",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("leaves the damaged part out of the pallet", async () => {
    const owner = await company();
    await createLocation(owner, { level: 3, name: "Estante B" });
    await setting(owner, CONTAINERS_MODE.key, "on");
    await setting(owner, PUTAWAY_MODE.key, "tasks");
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [
        {
          orderLineId: await lineIdOf(owner, orderId),
          quantity: "10",
          damaged: "4",
        },
      ],
      container: { kind: "Tarima" },
    });
    expect(received).toMatchObject({ ok: true });
    const items = await db.containerItem.findMany({ where: { productId } });
    expect(items.map((item) => item.quantity.toString())).toEqual(["6"]);
    expect(plain(await balances(productId))).toEqual([
      "AVAILABLE 6",
      "DAMAGED 4",
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});
