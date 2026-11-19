import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  reconcileStock,
  reconcileValue,
  type InventoryActor,
} from "@/modules/inventory";
import {
  RECEIPT_REJECTION_PHOTO,
  addOrderLine,
  createPurchaseOrder,
  discardRejectionPhoto,
  getOrderReceipts,
  getPendingReport,
  getPurchasesBySupplier,
  receivePurchaseOrder,
  returnToSupplier,
  submitPurchaseOrder,
  uploadRejectionPhoto,
  type PurchasingActor,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createPresentation, createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { getDefaultLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { TEST_JPEG } from "../setup/images";

// WMS-84 (ADR 0079): what is rejected at the door when receiving never
// enters the stock: it is written down with its reason (required), stays
// pending in the order and is told apart from the quality rejection (which
// entered, went to «Rechazado» and went back with a return).

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${counter + 1}`,
      email: `rechazo.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<PurchasingActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa rechazos ${counter}`,
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
      reason: "Prueba de rechazos al recibir",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
): Promise<PurchasingActor> {
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
  extra: { tracking?: "NONE" | "LOT" | "SERIAL" } = {},
) {
  const created = await createProduct(actor, {
    sku: `R-${++skus}`,
    name: `Válvula ${skus}`,
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

const stockOf = async (productId: string) =>
  (
    await db.stockBalance.findMany({
      where: { productId, quantity: { gt: 0 } },
      orderBy: { status: "asc" },
      select: { status: true, quantity: true },
    })
  ).map((row) => `${row.status} ${row.quantity.toString()}`);

const orderStatus = async (orderId: string) =>
  (await db.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })).status;

const webhookEvents = (organizationId: string, type: string) =>
  db.webhookEvent.findMany({
    where: { organizationId, type },
    select: { payload: true },
  });

async function clean(actor: PurchasingActor) {
  expect(await reconcileStock(actor.organizationId)).toEqual([]);
  expect(await reconcileValue(actor.organizationId)).toEqual([]);
}

const webhookCompanies: string[] = [];
afterAll(async () => {
  // Webhook hand-outs left in the queue would make later files that run
  // the worker spend their rounds on them.
  if (webhookCompanies.length > 0) {
    await db.job.deleteMany({
      where: { organizationId: { in: webhookCompanies } },
    });
  }
  await db.$disconnect();
});

/** A webhook that listens to the receipts of the company. */
async function listen(actor: PurchasingActor) {
  webhookCompanies.push(actor.organizationId);
  await db.webhookEndpoint.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      url: "https://ejemplo.example/webhook",
      events: ["purchasing.receipt.confirmed", "purchasing.receipt.rejected"],
      secretCiphertext: "x",
      createdByUserId: actor.userId,
    },
  });
}

describe("rejected at the door when receiving (WMS-84)", () => {
  it("rejects part: nothing of it enters and it stays pending", async () => {
    const owner = await company();
    await listen(owner);
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);

    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "6" }],
      rejections: [
        {
          orderLineId,
          quantity: "4",
          reason: "  La etiqueta no coincide con la orden  ",
        },
      ],
    });
    expect(received).toMatchObject({ ok: true, status: "PARTIAL" });
    expect(received.ok && received.summary).toContain(
      "Rechazaste al recibir: 4 piezas",
    );
    // Only what was received entered; nothing rejected, no movement of it.
    expect(await stockOf(productId)).toEqual(["AVAILABLE 6"]);
    const movementLines = await db.stockMovementLine.findMany({
      where: { productId },
    });
    expect(movementLines.map((line) => line.baseQuantity.toString())).toEqual([
      "6",
    ]);

    const view = (await getOrderReceipts(owner, orderId))!;
    expect(view.lines[0]).toMatchObject({
      receivedText: "6 piezas",
      pendingText: "4 piezas",
      rejectedText: "4 piezas",
    });
    expect(view.receipts[0]!.rejections).toEqual([
      expect.objectContaining({
        orderLineId,
        quantityText: "4 piezas",
        quantity: "4",
        reason: "La etiqueta no coincide con la orden",
        lotCode: null,
        serials: [],
      }),
    ]);
    // The audit says it; the webhook too, apart from the confirmed one.
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: owner.organizationId,
          action: "purchase_order.receipt_rejected",
        },
      }),
    ).toBe(1);
    const rejectedEvents = await webhookEvents(
      owner.organizationId,
      "purchasing.receipt.rejected",
    );
    expect(rejectedEvents).toHaveLength(1);
    expect(JSON.stringify(rejectedEvents[0]!.payload)).toContain(
      "La etiqueta no coincide",
    );
    expect(
      await webhookEvents(owner.organizationId, "purchasing.receipt.confirmed"),
    ).toHaveLength(1);

    // The supplier replaces it: received against the same line.
    const replaced = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "4" }],
    });
    expect(replaced).toMatchObject({ ok: true, status: "RECEIVED" });
    expect(await stockOf(productId)).toEqual(["AVAILABLE 10"]);
    await clean(owner);
  });

  it("rejects everything: a receipt without movement that keeps the order waiting", async () => {
    const owner = await company();
    await listen(owner);
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

    // Half a box is not a box: in the terms of the line.
    const half = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "0" }],
      rejections: [{ orderLineId, quantity: "1.5", reason: "Cajas abiertas" }],
    });
    expect(half).toMatchObject({
      ok: false,
      lineFields: { [orderLineId]: "rejected" },
    });

    const rejected = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "0" }],
      rejections: [
        { orderLineId, quantity: "3", reason: "Cajas abiertas y mojadas" },
      ],
    });
    expect(rejected).toMatchObject({ ok: true, status: "SENT" });
    expect(await orderStatus(orderId)).toBe("SENT");
    const receipt = await db.purchaseReceipt.findUniqueOrThrow({
      where: { id: rejected.ok ? rejected.receiptId : "" },
    });
    expect(receipt.movementId).toBeNull();
    expect(await stockOf(productId)).toEqual([]);
    expect(
      await webhookEvents(owner.organizationId, "purchasing.receipt.confirmed"),
    ).toHaveLength(0);
    const view = (await getOrderReceipts(owner, orderId))!;
    expect(view.canReceive).toBe(true);
    expect(view.lines[0]).toMatchObject({
      pendingText: "3 cajas",
      rejectedText: "3 cajas",
      receivedText: null,
    });
    // Nothing goes back: there is nothing in stock.
    expect(view.canReturn).toBe(false);

    // Nothing at all is not a receipt.
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, quantity: "0" }],
      }),
    ).toMatchObject({ ok: false });
    await clean(owner);
  });

  it("asks why, and never more than what is pending with what is received", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);

    for (const reason of ["", "  ", "no"]) {
      const result = await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, quantity: "5" }],
        rejections: [{ orderLineId, quantity: "2", reason }],
      });
      expect(result).toMatchObject({
        ok: false,
        lineFields: { [orderLineId]: "rejectedReason" },
      });
    }
    const tooMuch = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "8" }],
      rejections: [{ orderLineId, quantity: "3", reason: "Sobra mercancía" }],
    });
    expect(tooMuch).toMatchObject({
      ok: false,
      lineFields: { [orderLineId]: "rejected" },
    });
    expect(tooMuch.ok || tooMuch.lineErrors?.[orderLineId]).toContain(
      "Solo faltan 10 piezas",
    );
    // A line of another order does not belong here.
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, quantity: "1" }],
        rejections: [
          { orderLineId: newId(), quantity: "1", reason: "No es de aquí" },
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(await db.purchaseReceipt.count({ where: { orderId } })).toBe(0);
    expect(await stockOf(productId)).toEqual([]);
  });

  it("the database keeps the reason and never changes a rejection", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "4" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const done = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "2" }],
      rejections: [{ orderLineId, quantity: "1", reason: "Otro modelo" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done));
    const row = await db.purchaseReceiptRejection.findFirstOrThrow({
      where: { receiptId: done.receiptId },
    });
    await expect(
      db.purchaseReceiptRejection.update({
        where: { id: row.id },
        data: { reason: "Cambiado" },
      }),
    ).rejects.toThrow();
    await expect(
      db.purchaseReceiptRejection.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    await expect(
      db.purchaseReceiptRejection.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          receiptId: done.receiptId,
          lineNumber: 2,
          orderLineId,
          productId,
          quantity: "1",
          reason: "   ",
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps the lot and serials it carried, without creating them", async () => {
    const owner = await company();
    const byLot = await product(owner, { tracking: "LOT" });
    const bySerial = await product(owner, { tracking: "SERIAL" });
    const plain = await product(owner);
    const orderId = await sentOrder(owner, [
      { productId: byLot, quantity: "10" },
      { productId: bySerial, quantity: "3" },
      { productId: plain, quantity: "2" },
    ]);
    const lotLine = await lineIdOf(owner, orderId, 0);
    const serialLine = await lineIdOf(owner, orderId, 1);
    const plainLine = await lineIdOf(owner, orderId, 2);
    const lots = await db.lot.count({
      where: { organizationId: owner.organizationId },
    });

    // A lot only for a product by lot; serials only for one by serial.
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId: plainLine, quantity: "1" }],
        rejections: [
          {
            orderLineId: plainLine,
            quantity: "1",
            reason: "No cuadra",
            lotCode: "L-1",
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      lineFields: { [plainLine]: "rejectedLotCode" },
    });
    // As many serials as pieces, and none received at the same time.
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId: serialLine, quantity: "1", serials: "SN-1" }],
        rejections: [
          {
            orderLineId: serialLine,
            quantity: "2",
            reason: "Golpeado",
            serials: "SN-2",
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      lineFields: { [serialLine]: "rejectedSerials" },
    });
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId: serialLine, quantity: "1", serials: "SN-1" }],
        rejections: [
          {
            orderLineId: serialLine,
            quantity: "1",
            reason: "Golpeado",
            serials: "sn-1",
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      lineFields: { [serialLine]: "rejectedSerials" },
    });

    const done = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [
        { orderLineId: lotLine, quantity: "6", lotCode: "L-OK" },
        { orderLineId: serialLine, quantity: "1", serials: "SN-1" },
      ],
      rejections: [
        {
          orderLineId: lotLine,
          quantity: "3",
          reason: "Caducidad vencida",
          lotCode: "l-viejo",
        },
        {
          orderLineId: lotLine,
          quantity: "1",
          reason: "Sin etiqueta de lote",
          lotCode: "L-SIN",
        },
        {
          orderLineId: serialLine,
          quantity: "2",
          reason: "Golpeado",
          serials: "SN-2\nSN-3",
        },
      ],
    });
    expect(done).toMatchObject({ ok: true, status: "PARTIAL" });
    const rows = await db.purchaseReceiptRejection.findMany({
      where: { receiptId: done.ok ? done.receiptId : "" },
      orderBy: { lineNumber: "asc" },
      select: { lotCode: true, serials: true, quantity: true },
    });
    expect(
      rows.map((row) => [row.quantity.toString(), row.lotCode, row.serials]),
    ).toEqual([
      ["3", "L-VIEJO", null],
      ["1", "L-SIN", null],
      ["2", null, "SN-2\nSN-3"],
    ]);
    // Only the lot that entered exists; the rejected serials do not.
    expect(
      await db.lot.count({ where: { organizationId: owner.organizationId } }),
    ).toBe(lots + 1);
    expect(
      await db.serialUnit.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(1);
    await clean(owner);
  });

  it("a retry with the same key answers once; other rejections are another receipt", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const idempotencyKey = newId();
    const input = {
      idempotencyKey,
      lines: [{ orderLineId, quantity: "5" }],
      rejections: [{ orderLineId, quantity: "2", reason: "Vienen rotas" }],
    };
    const first = await receivePurchaseOrder(owner, orderId, input);
    expect(first).toMatchObject({ ok: true });
    const again = await receivePurchaseOrder(owner, orderId, {
      ...input,
      rejections: [{ orderLineId, quantity: "2", reason: "Vienen rotas " }],
    });
    expect(again).toMatchObject({ ok: true, repeated: true });
    for (const other of [
      [{ orderLineId, quantity: "3", reason: "Vienen rotas" }],
      [],
    ]) {
      expect(
        await receivePurchaseOrder(owner, orderId, {
          ...input,
          rejections: other,
        }),
      ).toMatchObject({ ok: false, reason: "not_allowed" });
    }
    expect(
      await db.purchaseReceiptRejection.count({
        where: { orderLine: { orderId } },
      }),
    ).toBe(1);
    await clean(owner);
  });

  it("two receipts at once never go over what is pending", async () => {
    // 4 received + 4 rejected fit in 10; after one, 6 are pending and the
    // other no longer fits: the lock of the order puts them in line.
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const results = await Promise.all(
      [0, 1].map(() =>
        receivePurchaseOrder(owner, orderId, {
          idempotencyKey: newId(),
          lines: [{ orderLineId, quantity: "4" }],
          rejections: [{ orderLineId, quantity: "4", reason: "No cuadra" }],
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await db.purchaseReceiptRejection.count({
        where: { orderLine: { orderId } },
      }),
    ).toBe(1);
    expect(await stockOf(productId)).toEqual(["AVAILABLE 4"]);
    await clean(owner);
  });

  it("who receives rejects; who only reads does not", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "4" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const operator = await member(owner.organizationId, "operator");
    const viewer = await member(owner.organizationId, "viewer");
    const input = () => ({
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "0" }],
      rejections: [{ orderLineId, quantity: "1", reason: "Otro color" }],
    });
    await expect(
      receivePurchaseOrder(viewer, orderId, input()),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      uploadRejectionPhoto(viewer, { name: "a.jpg", bytes: TEST_JPEG }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      await receivePurchaseOrder(operator, orderId, input()),
    ).toMatchObject({ ok: true });
  });

  it("takes photos of what is rejected, as the company says", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const rejection = [{ orderLineId, quantity: "1", reason: "Abollado" }];

    const photo = await uploadRejectionPhoto(owner, {
      name: "rechazo.jpg",
      bytes: TEST_JPEG,
    });
    if (!photo.ok) throw new Error(photo.error);
    // Photos without a rejection are not evidence of anything.
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, quantity: "1" }],
        photoIds: [photo.fileId],
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });

    await setting(owner, RECEIPT_REJECTION_PHOTO.key, "required");
    expect(
      await receivePurchaseOrder(owner, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, quantity: "1" }],
        rejections: rejection,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
    // Another person's photo is not linked.
    const other = await member(owner.organizationId, "administrator");
    expect(
      await receivePurchaseOrder(other, orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, quantity: "1" }],
        rejections: rejection,
        photoIds: [photo.fileId],
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });

    const done = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "1" }],
      rejections: rejection,
      photoIds: [photo.fileId],
    });
    expect(done).toMatchObject({ ok: true });
    const view = (await getOrderReceipts(owner, orderId))!;
    expect(view.receipts[0]!.photos.map((p) => p.fileId)).toEqual([
      photo.fileId,
    ]);
    // A linked photo is not removed.
    expect(await discardRejectionPhoto(owner, photo.fileId)).toEqual({
      ok: false,
    });

    await setting(owner, RECEIPT_REJECTION_PHOTO.key, "off");
    expect(
      await uploadRejectionPhoto(owner, { name: "b.jpg", bytes: TEST_JPEG }),
    ).toMatchObject({ ok: false });
    await clean(owner);
  });

  it("the reports tell it apart from the quality rejection", async () => {
    const owner = await company();
    const productId = await product(owner);
    const orderId = await sentOrder(owner, [{ productId, quantity: "10" }]);
    const orderLineId = await lineIdOf(owner, orderId);
    const general = (await getDefaultLocation(owner))!.id;

    const received = await receivePurchaseOrder(owner, orderId, {
      idempotencyKey: newId(),
      lines: [{ orderLineId, quantity: "7" }],
      rejections: [{ orderLineId, quantity: "2", reason: "Modelo distinto" }],
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    // Quality: it entered, was analyzed, did not pass and goes back.
    const failed = await changeStockStatus(owner, {
      productId,
      locationId: general,
      from: "AVAILABLE",
      to: "REJECTED",
      quantity: "1",
      reason: "No pasó la prueba de presión",
      idempotencyKey: newId(),
    });
    expect(failed).toMatchObject({ ok: true });
    const receiptLine = (await getOrderReceipts(owner, orderId))!.receipts[0]!
      .lines[0]!;
    const back = await returnToSupplier(owner, received.receiptId, {
      reason: "No pasó calidad",
      idempotencyKey: newId(),
      lines: [
        {
          receiptLineId: receiptLine.receiptLineId,
          quantity: "1",
          status: "REJECTED",
        },
      ],
    });
    expect(back).toMatchObject({ ok: true });

    const pending = await getPendingReport(owner);
    expect(pending.rows.find((row) => row.orderId === orderId)).toMatchObject({
      rejectedText: "2 piezas",
      pendingText: "3 piezas",
    });
    const bySupplier = await getPurchasesBySupplier(owner);
    if (!bySupplier.ok) throw new Error(bySupplier.error);
    expect(bySupplier.rows).toEqual([
      expect.objectContaining({
        receipts: 1,
        returns: 1,
        qualityReturns: 1,
        receiptRejections: 1,
      }),
    ]);
    // Only what entered moved stock and value.
    expect(await stockOf(productId)).toEqual(["AVAILABLE 6"]);
    await clean(owner);
  });
});
