import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { findTraceMatches, tracePurchaseOrder } from "@/modules/inventory";
import {
  addOrderLine,
  addRequestLine,
  cancelPurchaseOrder,
  closePurchaseOrder,
  convertPurchaseRequest,
  createPurchaseOrder,
  createPurchaseRequest,
  findReceiptConfirmation,
  formatOrderNumber,
  getOrderDeliveries,
  getOrderReceipts,
  getPendingReport,
  getPurchaseOrder,
  getPurchaseRequest,
  listPurchaseOrders,
  listPurchaseRequests,
  receivePurchaseOrder,
  requestOrderDelivery,
  submitPurchaseOrder,
  submitPurchaseRequest,
  type PurchasingActor,
} from "@/modules/purchasing";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import {
  createFacility,
  getDefaultLocation,
  listFacilities,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-57 (ADR 0055, closes the pending of ADR 0035 and ADR 0038): a
// purchase order is of a warehouse. For someone limited to another one it
// does not exist — not in lists, reports, its receipts nor the trace —;
// it is received only in its warehouse; the orders written before (no
// warehouse) stay of the whole company; a request passes its warehouse on.

const stamp = Date.now();
let counter = 0;

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `oc.almacen.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
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

let owner: PurchasingActor;
/** Buyer limited to warehouse B. */
let buyerB: PurchasingActor;
/** Almacén limited to warehouse B. */
let askerB: PurchasingActor;
let facilityA = "";
let facilityB = "";
let generalB = "";
let productId = "";
let supplierId = "";

async function sentOrder(actor: PurchasingActor, facilityId?: string) {
  const order = await createPurchaseOrder(actor, {
    supplierId,
    ...(facilityId ? { facilityId } : {}),
  });
  if (!order.ok) throw new Error(JSON.stringify(order));
  const line = await addOrderLine(actor, order.orderId, {
    productId,
    capture: "base",
    quantity: "4",
  });
  if (!line.ok) throw new Error(JSON.stringify(line));
  const sent = await submitPurchaseOrder(actor, order.orderId);
  if (!sent.ok) throw new Error(JSON.stringify(sent));
  return order;
}

beforeAll(async () => {
  const ownerId = await newUser();
  const created = await createOrganization(ownerId, {
    name: `Empresa OC almacén ${stamp}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser();
  await db.platformStaff.create({ data: { userId: staff } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 10,
      facilities: 3,
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba del almacén de las órdenes",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  owner = { organizationId: created.organizationId, userId: ownerId };
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  await switchFacility(owner, facilityB);
  generalB = (await getDefaultLocation(owner))!.id;
  await switchFacility(owner, facilityA);

  const product = await createProduct(owner, { sku: "OCA-1", name: "Broca" });
  if (!product.ok) throw new Error("product setup failed");
  productId = product.productId;
  const supplier = await createSupplier(owner, { name: "Proveedor único" });
  if (!supplier.ok) throw new Error("supplier setup failed");
  supplierId = supplier.supplierId;

  buyerB = await member(owner.organizationId, "buyer");
  askerB = await member(owner.organizationId, "warehouse");
  for (const who of [buyerB, askerB]) {
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: who.userId,
      facilities: [{ facilityId: facilityB }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
  }
}, 60_000);

afterAll(() => db.$disconnect());

describe("the warehouse of a purchase order (WMS-57)", () => {
  it("an order is of the active warehouse of who writes it, or the one chosen", async () => {
    const inA = await createPurchaseOrder(owner, { supplierId });
    expect(inA).toMatchObject({ ok: true });
    const inB = await createPurchaseOrder(owner, {
      supplierId,
      facilityId: facilityB,
    });
    expect(inB).toMatchObject({ ok: true });
    const stored = await db.purchaseOrder.findMany({
      where: {
        id: { in: [inA.ok ? inA.orderId : "", inB.ok ? inB.orderId : ""] },
      },
      select: { id: true, facilityId: true },
    });
    expect(
      Object.fromEntries(stored.map((row) => [row.id, row.facilityId])),
    ).toEqual({
      [inA.ok ? inA.orderId : ""]: facilityA,
      [inB.ok ? inB.orderId : ""]: facilityB,
    });
    // Someone limited to B does not choose A.
    expect(
      await createPurchaseOrder(buyerB, { supplierId, facilityId: facilityA }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { facilityId: expect.any(String) },
    });
    // The warehouse of an order never changes (trigger).
    await expect(
      db.purchaseOrder.update({
        where: { id: inA.ok ? inA.orderId : "" },
        data: { facilityId: facilityB },
      }),
    ).rejects.toThrow(/cannot change/);
  });

  it("an order of A does not exist for who is limited to B", async () => {
    const order = await sentOrder(owner);
    const received = await receivePurchaseOrder(owner, order.orderId, {
      idempotencyKey: newId(),
      lines: [
        {
          orderLineId: (await getOrderReceipts(owner, order.orderId))!.lines[0]!
            .orderLineId,
          quantity: "1",
        },
      ],
    });
    expect(received).toMatchObject({ ok: true, status: "PARTIAL" });

    expect(await getPurchaseOrder(buyerB, order.orderId)).toBeNull();
    expect(await getOrderReceipts(buyerB, order.orderId)).toBeNull();
    expect(await getOrderDeliveries(buyerB, order.orderId)).toBeNull();
    expect(
      (await listPurchaseOrders(buyerB)).items.map((item) => item.id),
    ).not.toContain(order.orderId);
    expect(
      (await listPurchaseOrders(buyerB, { toReceive: true })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(order.orderId);
    expect(
      (await getPendingReport(buyerB)).rows.map((row) => row.orderId),
    ).not.toContain(order.orderId);
    expect(
      await receivePurchaseOrder(buyerB, order.orderId, {
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await closePurchaseOrder(buyerB, order.orderId, { reason: "No llega" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await cancelPurchaseOrder(buyerB, order.orderId, { reason: "No llega" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await requestOrderDelivery(buyerB, order.orderId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await tracePurchaseOrder(buyerB, order.orderId)).toBeNull();
    const number = (await getPurchaseOrder(owner, order.orderId))!.numberText;
    expect(
      (await findTraceMatches(buyerB, number)).matches.filter(
        (match) => match.kind === "purchase_order",
      ),
    ).toEqual([]);
    expect(
      (await findTraceMatches(owner, number)).matches.filter(
        (match) => match.kind === "purchase_order",
      ),
    ).toHaveLength(1);
  });

  it("an order is received only in its warehouse", async () => {
    const order = await sentOrder(owner);
    const refused = await receivePurchaseOrder(owner, order.orderId, {
      idempotencyKey: newId(),
      locationId: generalB,
    });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok || refused.formError).toContain("almacén");
    expect(
      await db.purchaseReceipt.count({ where: { orderId: order.orderId } }),
    ).toBe(0);
    const key = newId();
    expect(
      await receivePurchaseOrder(owner, order.orderId, {
        idempotencyKey: key,
      }),
    ).toMatchObject({ ok: true, status: "RECEIVED" });
    expect(await findReceiptConfirmation(owner, key)).not.toBeNull();
  });

  it("an order written before (no warehouse) is of the whole company", async () => {
    const last = await db.purchaseOrder.findFirst({
      where: { organizationId: owner.organizationId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const id = newId();
    await db.purchaseOrder.create({
      data: {
        id,
        organizationId: owner.organizationId,
        number: (last?.number ?? 0) + 1,
        contactId: supplierId,
        createdByUserId: owner.userId,
      },
    });
    expect(await getPurchaseOrder(buyerB, id)).toMatchObject({
      facilityName: null,
    });
    expect(
      (await listPurchaseOrders(buyerB)).items.map((item) => item.id),
    ).toContain(id);
    expect(
      (await listPurchaseOrders(owner)).items.map((item) => item.id),
    ).toContain(id);
    expect(formatOrderNumber((last?.number ?? 0) + 1)).toMatch(/^OC-/);
  });

  it("the lists are of the active warehouse; someone in B sees the orders of B", async () => {
    const inB = await sentOrder(owner, facilityB);
    expect(
      (await listPurchaseOrders(owner)).items.map((item) => item.id),
    ).not.toContain(inB.orderId);
    expect(
      (await listPurchaseOrders(buyerB)).items.map((item) => item.id),
    ).toContain(inB.orderId);
    // The detail is there for whoever reaches B, the titular included.
    expect(await getPurchaseOrder(owner, inB.orderId)).toMatchObject({
      facilityName: "Bodega B",
    });
    expect(
      await receivePurchaseOrder(buyerB, inB.orderId, {
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
  });

  it("a request is of the warehouse of who asks, and so is its order", async () => {
    const created = await createPurchaseRequest(askerB, {
      productId,
      capture: "base",
      quantity: "3",
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(
      await submitPurchaseRequest(askerB, created.requestId),
    ).toMatchObject({ ok: true });
    // Compras of A (the titular, active in A) does not list it to attend…
    expect(
      (await listPurchaseRequests(owner, { view: "attend" })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(created.requestId);
    // …the buyer of B does.
    expect(
      (await listPurchaseRequests(buyerB, { view: "attend" })).items.map(
        (item) => item.id,
      ),
    ).toContain(created.requestId);
    const line = (await getPurchaseRequest(buyerB, created.requestId))!
      .lines[0]!;
    const converted = await convertPurchaseRequest(buyerB, created.requestId, {
      suppliers: { [line.id]: supplierId },
    });
    expect(converted).toMatchObject({ ok: true });
    if (!converted.ok) return;
    const order = await db.purchaseOrder.findFirst({
      where: { id: converted.orders[0]!.orderId },
      select: { facilityId: true, purchaseRequestId: true },
    });
    expect(order).toEqual({
      facilityId: facilityB,
      purchaseRequestId: created.requestId,
    });

    // A request of A does not exist for who is limited to B.
    const inA = await createPurchaseRequest(owner, {
      productId,
      capture: "base",
      quantity: "1",
    });
    if (!inA.ok) throw new Error("setup");
    await submitPurchaseRequest(owner, inA.requestId);
    expect(await getPurchaseRequest(buyerB, inA.requestId)).toBeNull();
    expect(
      await addRequestLine(askerB, inA.requestId, {
        productId,
        capture: "base",
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await convertPurchaseRequest(buyerB, inA.requestId, { suppliers: {} }),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });
});
