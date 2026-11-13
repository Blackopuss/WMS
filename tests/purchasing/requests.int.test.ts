import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  addOrderLine,
  addRequestLine,
  cancelPurchaseRequest,
  closePurchaseOrder,
  compareSuppliers,
  convertPurchaseRequest,
  countRequestsToAttend,
  createPurchaseOrder,
  createPurchaseRequest,
  getOrderReceipts,
  getPurchaseOrder,
  getPurchaseRequest,
  linkProductSupplier,
  listPurchaseRequests,
  receivePurchaseOrder,
  rejectPurchaseRequest,
  removeRequestLine,
  submitPurchaseOrder,
  submitPurchaseRequest,
  updatePurchaseRequest,
  updateRequestLine,
  type PurchasingActor,
} from "@/modules/purchasing";
import {
  approvalTypes,
  moduleRegistry,
  moduleOpenWork,
  operationSettings,
} from "@/modules/registry";
import {
  cancelApproval,
  decideApproval,
  updateApprovalRule,
} from "@/platform/approvals";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createPresentation, createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-57 (ADR 0055): who needs goods asks Compras; with the approval rule
// on, it waits for an authorization; Compras compares suppliers (only who
// may see costs) and turns it into one draft order per supplier, once.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${counter + 1}`,
      email: `solicitud.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<PurchasingActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa solicitudes ${counter}`,
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
      productLimit: 40,
      users: 20,
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba de solicitudes de compra",
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

let skus = 0;
async function product(actor: PurchasingActor) {
  const created = await createProduct(actor, {
    sku: `SC-${++skus}`,
    name: `Taladro ${skus}`,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function supplier(actor: PurchasingActor, name: string) {
  const created = await createSupplier(actor, { name });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.supplierId;
}

async function rule(owner: PurchasingActor, on: boolean) {
  const result = await updateApprovalRule(
    owner,
    approvalTypes,
    "purchasing.request",
    { enabled: on, roles: ["buyer"], allowSelfApproval: false },
  );
  if (!result.ok) throw new Error(result.error);
}

/** A draft of `who` with the given products, sent with the rule as it is. */
async function sentRequest(
  who: PurchasingActor,
  lines: { productId: string; quantity: string; capture?: string }[],
) {
  const [first, ...rest] = lines;
  const created = await createPurchaseRequest(who, {
    productId: first!.productId,
    capture: first!.capture ?? "base",
    quantity: first!.quantity,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  for (const line of rest) {
    const added = await addRequestLine(who, created.requestId, {
      productId: line.productId,
      capture: line.capture ?? "base",
      quantity: line.quantity,
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  const sent = await submitPurchaseRequest(who, created.requestId);
  return { requestId: created.requestId, sent };
}

/** Every key anywhere in an answer: no cost may hide in it. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((each) => keysOf(each, into));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

const COSTLY = /cost|amount|price|totalText/i;

let owner: PurchasingActor;
let warehouse: PurchasingActor;
let buyer: PurchasingActor;
let viewer: PurchasingActor;
let operator: PurchasingActor;
let manager: PurchasingActor;

beforeAll(async () => {
  owner = await company();
  warehouse = await member(owner.organizationId, "warehouse");
  buyer = await member(owner.organizationId, "buyer");
  viewer = await member(owner.organizationId, "viewer");
  operator = await member(owner.organizationId, "operator");
  manager = await member(owner.organizationId, "manager");
}, 60_000);

afterAll(() => db.$disconnect());

describe("asking for goods (WMS-57)", () => {
  it("a request is a draft of who asks, then reaches Compras directly", async () => {
    const drill = await product(owner);
    const bits = await product(owner);
    const created = await createPurchaseRequest(warehouse, {
      productId: drill,
      capture: "base",
      quantity: "5",
      neededOn: "2026-12-01",
      notes: "Se acabaron en el pasillo 3",
    });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    const added = await addRequestLine(warehouse, created.requestId, {
      productId: bits,
      capture: "base",
      quantity: "2",
    });
    expect(added).toMatchObject({ ok: true });
    // The same product twice is one line.
    expect(
      await addRequestLine(warehouse, created.requestId, {
        productId: bits,
        capture: "base",
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { productId: expect.any(String) },
    });
    expect(
      await updateRequestLine(warehouse, added.ok ? added.lineId : "", {
        capture: "base",
        quantity: "3",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await updatePurchaseRequest(warehouse, created.requestId, {
        neededOn: "2026-12-02",
        notes: "Urgente",
      }),
    ).toMatchObject({ ok: true });

    // A draft is private: Compras does not see it nor touch it.
    expect(await getPurchaseRequest(buyer, created.requestId)).toBeNull();
    expect(
      await addRequestLine(buyer, created.requestId, {
        productId: drill,
        capture: "base",
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await submitPurchaseRequest(buyer, created.requestId)).toMatchObject(
      { ok: false, reason: "not_found" },
    );

    const before = await countRequestsToAttend(buyer);
    expect(await submitPurchaseRequest(warehouse, created.requestId)).toEqual({
      ok: true,
      status: "APPROVED",
    });
    // Sending twice sends once.
    expect(await submitPurchaseRequest(warehouse, created.requestId)).toEqual({
      ok: true,
      status: "APPROVED",
      repeated: true,
    });
    expect(await countRequestsToAttend(buyer)).toBe(before + 1);
    // Who asks does not attend.
    expect(await countRequestsToAttend(warehouse)).toBe(0);

    const seen = await getPurchaseRequest(buyer, created.requestId);
    expect(seen).toMatchObject({
      status: "APPROVED",
      statusLabel: "Por atender",
      neededOn: "2026-12-02",
      notes: "Urgente",
      canAttend: true,
      editable: false,
    });
    expect(seen!.lines.map((line) => line.quantityText)).toEqual([
      "5 piezas",
      "3 piezas",
    ]);
    // Lines no longer change once sent (service and trigger).
    expect(
      await removeRequestLine(warehouse, seen!.lines[0]!.id),
    ).toMatchObject({ ok: false });
    await expect(
      db.purchaseRequestLine.deleteMany({ where: { id: seen!.lines[0]!.id } }),
    ).rejects.toThrow(/not a draft/);

    const attend = await listPurchaseRequests(buyer, { view: "attend" });
    expect(attend.items.map((item) => item.id)).toContain(created.requestId);
    const mine = await listPurchaseRequests(warehouse, { view: "mine" });
    expect(mine.items[0]).toMatchObject({
      id: created.requestId,
      statusLabel: "Por atender",
      lines: 2,
    });
    // Only Compras has «Por atender».
    await expect(
      listPurchaseRequests(warehouse, { view: "attend" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("who asked cancels it while it is not authorized", async () => {
    const drill = await product(owner);
    const created = await createPurchaseRequest(warehouse, {
      productId: drill,
      capture: "base",
      quantity: "1",
    });
    if (!created.ok) throw new Error("setup");
    expect(await cancelPurchaseRequest(buyer, created.requestId)).toMatchObject(
      { ok: false },
    );
    expect(
      await cancelPurchaseRequest(warehouse, created.requestId),
    ).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(
      await cancelPurchaseRequest(warehouse, created.requestId),
    ).toMatchObject({ ok: true, repeated: true });
    expect(
      await submitPurchaseRequest(warehouse, created.requestId),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });

    // Once with Compras it is not cancelled: Compras rejects it.
    const sent = await sentRequest(warehouse, [
      { productId: drill, quantity: "2" },
    ]);
    expect(
      await cancelPurchaseRequest(warehouse, sent.requestId),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });
    await expect(
      rejectPurchaseRequest(warehouse, sent.requestId, { reason: "No toca" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      await rejectPurchaseRequest(buyer, sent.requestId, { reason: "no" }),
    ).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    expect(
      await rejectPurchaseRequest(buyer, sent.requestId, {
        reason: "Todavía hay en la otra bodega",
      }),
    ).toMatchObject({ ok: true, status: "REJECTED" });
    expect(await getPurchaseRequest(warehouse, sent.requestId)).toMatchObject({
      status: "REJECTED",
      rejectReason: "Todavía hay en la otra bodega",
    });
    // A request is never deleted (trigger).
    await expect(
      db.purchaseRequest.deleteMany({ where: { id: sent.requestId } }),
    ).rejects.toThrow(/never deleted/);
  });

  it("a request needs something to ask for and products in use", async () => {
    const created = await createPurchaseRequest(warehouse, {});
    if (!created.ok) throw new Error("setup");
    expect(
      await submitPurchaseRequest(warehouse, created.requestId),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await createPurchaseRequest(warehouse, { neededOn: "mañana" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { neededOn: expect.any(String) },
    });
    expect(
      await createPurchaseRequest(warehouse, {
        productId: await product(owner),
        capture: "base",
        quantity: "0",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
  });

  it("who may ask, read and attend, by role", async () => {
    const drill = await product(owner);
    for (const who of [operator, viewer, manager]) {
      await expect(
        createPurchaseRequest(who, {
          productId: drill,
          capture: "base",
          quantity: "1",
        }),
      ).rejects.toMatchObject({ kind: "forbidden" });
    }
    // Consulta and Gerencia read what was sent; the floor does not.
    await expect(listPurchaseRequests(operator)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect((await listPurchaseRequests(viewer)).total).toBeGreaterThan(0);
    expect((await listPurchaseRequests(manager)).total).toBeGreaterThan(0);
    const sent = await sentRequest(warehouse, [
      { productId: drill, quantity: "1" },
    ]);
    const vendor = await supplier(owner, `Roles ${stamp}`);
    // Neither who asks nor who reads turns it into an order.
    for (const who of [warehouse, viewer, manager]) {
      await expect(
        convertPurchaseRequest(who, sent.requestId, { suppliers: {} }),
      ).rejects.toMatchObject({ kind: "forbidden" });
    }
    const line = (await getPurchaseRequest(buyer, sent.requestId))!.lines[0]!;
    expect(
      await convertPurchaseRequest(buyer, sent.requestId, {
        suppliers: { [line.id]: vendor },
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("with the approval rule on (WMS-56)", () => {
  it("it waits, is authorized and reaches Compras; or is rejected with its reason", async () => {
    await rule(owner, true);
    try {
      const drill = await product(owner);
      const first = await sentRequest(warehouse, [
        { productId: drill, quantity: "4" },
      ]);
      expect(first.sent).toMatchObject({
        ok: false,
        reason: "pending_approval",
      });
      if (first.sent.ok || first.sent.reason !== "pending_approval") return;
      const approvalId = first.sent.approvalRequestId;
      // Sending again answers with the same wait.
      expect(
        await submitPurchaseRequest(warehouse, first.requestId),
      ).toMatchObject({
        ok: false,
        reason: "pending_approval",
        approvalRequestId: approvalId,
        repeated: true,
      });
      const waiting = await getPurchaseRequest(warehouse, first.requestId);
      expect(waiting).toMatchObject({
        status: "SUBMITTED",
        statusLabel: "Esperando autorización",
        approvalRequestId: approvalId,
        canSubmit: false,
        canAttend: false,
      });
      // Not to attend yet, not convertible.
      expect(
        (await listPurchaseRequests(buyer, { view: "attend" })).items.map(
          (item) => item.id,
        ),
      ).not.toContain(first.requestId);
      expect(
        await convertPurchaseRequest(buyer, first.requestId, {
          suppliers: {},
        }),
      ).toMatchObject({ ok: false, reason: "invalid_transition" });
      // Who asks does not authorize (nor holds what deciding takes).
      expect(
        await decideApproval(warehouse, approvalTypes, approvalId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: false });

      expect(
        await decideApproval(buyer, approvalTypes, approvalId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: true, status: "APPROVED" });
      const approved = await getPurchaseRequest(warehouse, first.requestId);
      expect(approved).toMatchObject({
        status: "APPROVED",
        approvalRequestId: null,
      });
      expect(approved!.approvedByName).toBeTruthy();
      // In the name of who asked, with who authorized it.
      const event = await db.auditEvent.findFirst({
        where: {
          action: "purchase_request.approved",
          targetId: first.requestId,
        },
        select: { actorUserId: true, metadata: true },
      });
      expect(event?.actorUserId).toBe(warehouse.userId);
      expect(event?.metadata).toMatchObject({
        autorizadoPor: expect.any(String),
      });

      const second = await sentRequest(warehouse, [
        { productId: drill, quantity: "9" },
      ]);
      if (second.sent.ok || second.sent.reason !== "pending_approval") {
        throw new Error("expected a wait");
      }
      expect(
        await decideApproval(
          buyer,
          approvalTypes,
          second.sent.approvalRequestId,
          {
            decision: "reject",
            reason: "Ya viene en la orden de la semana",
          },
        ),
      ).toMatchObject({ ok: true, status: "REJECTED" });
      expect(
        await getPurchaseRequest(warehouse, second.requestId),
      ).toMatchObject({
        status: "REJECTED",
        rejectReason: "Ya viene en la orden de la semana",
      });
    } finally {
      await rule(owner, false);
    }
  });

  it("withdrawing the authorization leaves it to send again or cancel", async () => {
    await rule(owner, true);
    try {
      const drill = await product(owner);
      const sent = await sentRequest(warehouse, [
        { productId: drill, quantity: "1" },
      ]);
      if (sent.sent.ok || sent.sent.reason !== "pending_approval") {
        throw new Error("expected a wait");
      }
      // Withdrawn from Aprobaciones › Mis solicitudes.
      expect(
        await cancelApproval(
          warehouse,
          approvalTypes,
          sent.sent.approvalRequestId,
        ),
      ).toMatchObject({ ok: true });
      expect(await getPurchaseRequest(warehouse, sent.requestId)).toMatchObject(
        {
          status: "SUBMITTED",
          statusLabel: "Se retiró la autorización",
          approvalRequestId: null,
          canSubmit: true,
          canCancel: true,
        },
      );
      // Sent again: a new authorization.
      const again = await submitPurchaseRequest(warehouse, sent.requestId);
      expect(again).toMatchObject({ ok: false, reason: "pending_approval" });
      if (again.ok || again.reason !== "pending_approval") return;
      expect(again.approvalRequestId).not.toBe(sent.sent.approvalRequestId);

      // Cancelling while it waits withdraws the authorization too.
      expect(
        await cancelPurchaseRequest(warehouse, sent.requestId),
      ).toMatchObject({ ok: true, status: "CANCELLED" });
      const withdrawn = await db.approvalRequest.findFirst({
        where: { id: again.approvalRequestId },
        select: { status: true },
      });
      expect(withdrawn?.status).toBe("CANCELLED");

      // With the rule off now, sending reaches Compras directly.
      const other = await sentRequest(warehouse, [
        { productId: drill, quantity: "1" },
      ]);
      if (other.sent.ok || other.sent.reason !== "pending_approval") {
        throw new Error("expected a wait");
      }
      await cancelApproval(
        warehouse,
        approvalTypes,
        other.sent.approvalRequestId,
      );
      await rule(owner, false);
      expect(await submitPurchaseRequest(warehouse, other.requestId)).toEqual({
        ok: true,
        status: "APPROVED",
      });
    } finally {
      await rule(owner, false);
    }
  });

  it("an authorization whose request no longer waits expires", async () => {
    await rule(owner, true);
    try {
      const drill = await product(owner);
      const sent = await sentRequest(warehouse, [
        { productId: drill, quantity: "1" },
      ]);
      if (sent.sent.ok || sent.sent.reason !== "pending_approval") {
        throw new Error("expected a wait");
      }
      // Moved out of its wait by hand, as a stale authorization would find it.
      await db.purchaseRequest.update({
        where: { id: sent.requestId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      expect(
        await decideApproval(
          buyer,
          approvalTypes,
          sent.sent.approvalRequestId,
          {
            decision: "approve",
          },
        ),
      ).toMatchObject({ ok: false, reason: "expired" });
    } finally {
      await rule(owner, false);
    }
  });
});

describe("turning a request into orders", () => {
  it("one draft per supplier, with what was asked and the last cost; once", async () => {
    const drill = await product(owner);
    const box = await createPresentation(owner, drill, {
      name: "Caja",
      factor: "10",
    });
    if (!box.ok) throw new Error("presentation");
    const bits = await product(owner);
    const north = await supplier(owner, `Norte ${stamp}`);
    const south = await supplier(owner, `Sur ${stamp}`);
    for (const [productId, contactId] of [
      [drill, north],
      [bits, south],
    ] as const) {
      const linked = await linkProductSupplier(buyer, {
        productId,
        supplierId: contactId,
        supplierSku: `PRV-${productId.slice(-4)}`,
      });
      if (!linked.ok) throw new Error(JSON.stringify(linked));
    }
    // A last cost of the drill at Norte, by the box.
    const earlier = await createPurchaseOrder(buyer, { supplierId: north });
    if (!earlier.ok) throw new Error("order");
    await addOrderLine(buyer, earlier.orderId, {
      productId: drill,
      capture: `p:${box.presentationId}`,
      quantity: "1",
      unitCost: "150",
    });
    await submitPurchaseOrder(buyer, earlier.orderId);
    await receivePurchaseOrder(buyer, earlier.orderId, {
      idempotencyKey: newId(),
    });

    const sent = await sentRequest(warehouse, [
      { productId: drill, quantity: "2", capture: `p:${box.presentationId}` },
      { productId: bits, quantity: "7" },
    ]);
    const request = (await getPurchaseRequest(buyer, sent.requestId))!;
    const [drillLine, bitsLine] = request.lines;
    const suppliers = { [drillLine!.id]: north, [bitsLine!.id]: south };

    // A line without supplier is refused, nothing is written.
    const missing = await convertPurchaseRequest(buyer, sent.requestId, {
      suppliers: { [drillLine!.id]: north },
    });
    expect(missing).toMatchObject({
      ok: false,
      lineErrors: { [bitsLine!.id]: expect.any(String) },
    });
    // A supplier of another company is not one of ours.
    const stranger = await company();
    const foreign = await supplier(stranger, "Ajeno");
    expect(
      await convertPurchaseRequest(buyer, sent.requestId, {
        suppliers: { ...suppliers, [bitsLine!.id]: foreign },
      }),
    ).toMatchObject({
      ok: false,
      lineErrors: { [bitsLine!.id]: expect.any(String) },
    });

    // Two at the same time: it is converted once.
    const results = await Promise.all([
      convertPurchaseRequest(buyer, sent.requestId, { suppliers }),
      convertPurchaseRequest(owner, sent.requestId, { suppliers }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && result.repeated),
    ).toHaveLength(1);
    const orders = await db.purchaseOrder.findMany({
      where: { purchaseRequestId: sent.requestId },
      orderBy: { number: "asc" },
      select: { id: true, contactId: true, status: true, facilityId: true },
    });
    expect(orders).toHaveLength(2);
    expect(orders.map((order) => order.status)).toEqual(["DRAFT", "DRAFT"]);
    expect(new Set(orders.map((order) => order.contactId))).toEqual(
      new Set([north, south]),
    );
    // Again later: the same orders.
    const again = await convertPurchaseRequest(buyer, sent.requestId, {
      suppliers,
    });
    expect(again).toMatchObject({ ok: true, repeated: true });
    expect(
      again.ok && again.orders.map((order) => order.orderId).sort(),
    ).toEqual(orders.map((order) => order.id).sort());

    const northOrder = await getPurchaseOrder(
      buyer,
      orders.find((order) => order.contactId === north)!.id,
    );
    expect(northOrder).toMatchObject({
      request: { id: sent.requestId, numberText: request.numberText },
    });
    expect(northOrder!.lines).toMatchObject([
      {
        productId: drill,
        capture: `p:${box.presentationId}`,
        quantityText: "2 cajas × 10 = 20 piezas",
        supplierSku: `PRV-${drill.slice(-4)}`,
        // The last cost, for the same way of buying it.
        unitCost: "150",
      },
    ]);
    const southOrder = await getPurchaseOrder(
      buyer,
      orders.find((order) => order.contactId === south)!.id,
    );
    expect(southOrder!.lines).toMatchObject([
      { productId: bits, quantityText: "7 piezas", unitCost: null },
    ]);

    // Who asked sees what it became, without costs or amounts.
    const followed = await getPurchaseRequest(warehouse, sent.requestId);
    expect(followed).toMatchObject({
      status: "CONVERTED",
      statusLabel: "Convertida en orden",
    });
    expect(followed!.orders.map((order) => order.statusLabel)).toEqual([
      "Borrador",
      "Borrador",
    ]);
    // Almacén does not see suppliers either.
    expect(followed!.orders[0]).not.toHaveProperty("supplierName");
    for (const key of keysOf(followed)) expect(key).not.toMatch(COSTLY);
    // Rejecting a converted request is not possible.
    expect(
      await rejectPurchaseRequest(buyer, sent.requestId, {
        reason: "Ya no hace falta",
      }),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });
  });
});

describe("comparing suppliers (known data)", () => {
  it("last cost per unit, delivery days, fulfillment and damage; the suggested one", async () => {
    const cheap = await company();
    const drill = await product(cheap);
    const box = await createPresentation(cheap, drill, {
      name: "Caja",
      factor: "10",
    });
    if (!box.ok) throw new Error("presentation");
    const alfa = await supplier(cheap, "Alfa");
    const beta = await supplier(cheap, "Beta");
    const gamma = await supplier(cheap, "Gamma");
    for (const contactId of [alfa, beta, gamma]) {
      const linked = await linkProductSupplier(cheap, {
        productId: drill,
        supplierId: contactId,
      });
      if (!linked.ok) throw new Error(JSON.stringify(linked));
    }
    async function bought(
      contactId: string,
      line: { capture: string; quantity: string; unitCost: string },
      receive: { quantity: string; damaged?: string },
      daysToArrive: number,
      close = false,
    ) {
      const order = await createPurchaseOrder(cheap, { supplierId: contactId });
      if (!order.ok) throw new Error("order");
      await addOrderLine(cheap, order.orderId, { productId: drill, ...line });
      await submitPurchaseOrder(cheap, order.orderId);
      const orderLineId = (await getOrderReceipts(cheap, order.orderId))!
        .lines[0]!.orderLineId;
      const received = await receivePurchaseOrder(cheap, order.orderId, {
        idempotencyKey: newId(),
        lines: [{ orderLineId, ...receive }],
      });
      if (!received.ok) throw new Error(JSON.stringify(received));
      if (close) {
        const closed = await closePurchaseOrder(cheap, order.orderId, {
          reason: "Ya no lo surtirá",
        });
        if (!closed.ok) throw new Error(JSON.stringify(closed));
      }
      // As if it had been sent `daysToArrive` days before it arrived.
      const first = await db.purchaseReceipt.findFirst({
        where: { orderId: order.orderId },
        select: { createdAt: true },
      });
      await db.purchaseOrder.update({
        where: { id: order.orderId },
        data: {
          sentAt: new Date(
            first!.createdAt.getTime() - daysToArrive * 86_400_000,
          ),
        },
      });
    }
    // Alfa: a box of 10 at $120 → $12 a piece; all arrived, 2 of 10 broken;
    // 3 and then 5 days.
    await bought(
      alfa,
      { capture: `p:${box.presentationId}`, quantity: "1", unitCost: "100" },
      { quantity: "1" },
      5,
    );
    await bought(
      alfa,
      { capture: "base", quantity: "10", unitCost: "13" },
      { quantity: "10", damaged: "2" },
      3,
    );
    await bought(
      alfa,
      { capture: `p:${box.presentationId}`, quantity: "1", unitCost: "120" },
      { quantity: "1" },
      4,
    );
    // Beta: $11 a piece, but only half of it arrived (closed short); 2 days.
    await bought(
      beta,
      { capture: "base", quantity: "10", unitCost: "11" },
      { quantity: "5" },
      2,
      true,
    );
    // Gamma: never bought.

    const asker = await member(cheap.organizationId, "warehouse");
    const sent = await sentRequest(asker, [
      { productId: drill, quantity: "30" },
    ]);
    const compared = await compareSuppliers(cheap, sent.requestId);
    expect(compared).toMatchObject({ visible: true, truncated: false });
    if (!compared || !compared.visible) return;
    expect(compared.criterion).toContain("90 %");
    const [line] = compared.lines;
    const by = Object.fromEntries(
      line!.options.map((option) => [option.supplierName, option]),
    );
    expect(by.Alfa).toMatchObject({
      unitCost: "12",
      lastCostText: "$120.00 por caja de 10 piezas",
      unitCostText: "$12.00 por pieza",
      // (5 + 3 + 4) / 3
      leadDays: "4",
      leadOrders: 3,
      fulfillment: "100",
      // (0 + 0.2 + 0) / 3 lines
      damaged: "6.7",
      fulfillmentOrders: 3,
      meetsMinimum: true,
      suggested: true,
    });
    expect(by.Beta).toMatchObject({
      unitCost: "11",
      leadDays: "2",
      fulfillment: "50",
      damaged: "0",
      meetsMinimum: false,
      suggested: false,
    });
    expect(by.Gamma).toMatchObject({
      unitCost: null,
      lastCostText: null,
      leadDays: null,
      fulfillment: null,
      meetsMinimum: true,
      suggested: false,
    });
    expect(line!.suggestedSupplierId).toBe(alfa);

    // Without a minimum, the cheapest per piece wins.
    const changed = await updateOperationSetting(
      cheap,
      operationSettings,
      "purchasing.compare.min_fulfillment",
      "any",
    );
    expect(changed).toMatchObject({ ok: true });
    const anyCost = await compareSuppliers(cheap, sent.requestId);
    expect(
      anyCost && anyCost.visible && anyCost.lines[0]!.suggestedSupplierId,
    ).toBe(beta);
  });

  it("is only for who may see costs: no answer of a request carries them", async () => {
    const drill = await product(owner);
    const sent = await sentRequest(warehouse, [
      { productId: drill, quantity: "1" },
    ]);
    for (const who of [warehouse, viewer]) {
      expect(await compareSuppliers(who, sent.requestId)).toEqual({
        visible: false,
      });
    }
    for (const who of [warehouse, viewer, buyer]) {
      for (const key of keysOf(await getPurchaseRequest(who, sent.requestId))) {
        expect(key).not.toMatch(COSTLY);
      }
      for (const key of keysOf(await listPurchaseRequests(who))) {
        expect(key).not.toMatch(COSTLY);
      }
    }
    expect(await compareSuppliers(manager, sent.requestId)).toMatchObject({
      visible: true,
    });
  });
});

describe("notices (WMS-39)", () => {
  const noticesOf = (actor: PurchasingActor, typeKey: string, id: string) =>
    db.notification.findMany({
      where: {
        organizationId: actor.organizationId,
        recipientUserId: actor.userId,
        typeKey,
        href: `/compras/solicitudes/${id}`,
      },
      orderBy: { id: "asc" },
    });

  it("Compras hears what reaches it; who asked hears the answer, never costs", async () => {
    const drill = await product(owner);
    const first = await sentRequest(warehouse, [
      { productId: drill, quantity: "3" },
    ]);
    expect(first.sent).toMatchObject({ ok: true, status: "APPROVED" });
    // Who buys (and the titular) hears it; who asked and who only reads do not.
    for (const actor of [buyer, owner]) {
      expect(
        await noticesOf(actor, "purchasing.request_to_attend", first.requestId),
      ).toHaveLength(1);
    }
    for (const actor of [warehouse, viewer, manager, operator]) {
      expect(
        await noticesOf(actor, "purchasing.request_to_attend", first.requestId),
      ).toHaveLength(0);
    }
    const [toAttend] = await noticesOf(
      buyer,
      "purchasing.request_to_attend",
      first.requestId,
    );
    expect(toAttend!.text).toMatch(/^Por atender: SC-\d{4}: 1 producto/);
    expect(toAttend!.text).not.toMatch(/\$|costo/i);

    expect(
      await rejectPurchaseRequest(buyer, first.requestId, {
        reason: "Hay suficiente en otra bodega.",
      }),
    ).toMatchObject({ ok: true });
    const [answer] = await noticesOf(
      warehouse,
      "purchasing.request_answered",
      first.requestId,
    );
    expect(answer!.text).toContain("Motivo: Hay suficiente en otra bodega.");

    const north = await supplier(owner, `Norte avisos ${stamp}`);
    const second = await sentRequest(warehouse, [
      { productId: drill, quantity: "2" },
    ]);
    const request = (await getPurchaseRequest(buyer, second.requestId))!;
    expect(
      await convertPurchaseRequest(buyer, second.requestId, {
        suppliers: { [request.lines[0]!.id]: north },
      }),
    ).toMatchObject({ ok: true });
    const [converted] = await noticesOf(
      warehouse,
      "purchasing.request_answered",
      second.requestId,
    );
    expect(converted!.text).toContain("se convirtió en orden de compra");
    // Who asked may not see orders nor suppliers: the notice names neither.
    expect(converted!.text).not.toContain("Norte");
    expect(converted!.text).not.toMatch(/OC-\d/);
  });

  it("with the rule on, Compras hears it only once it is authorized", async () => {
    await rule(owner, true);
    try {
      const drill = await product(owner);
      const sent = await sentRequest(warehouse, [
        { productId: drill, quantity: "1" },
      ]);
      if (sent.sent.ok || sent.sent.reason !== "pending_approval") {
        throw new Error(JSON.stringify(sent.sent));
      }
      expect(
        await noticesOf(buyer, "purchasing.request_to_attend", sent.requestId),
      ).toHaveLength(0);
      expect(
        await decideApproval(
          buyer,
          approvalTypes,
          sent.sent.approvalRequestId,
          {
            decision: "approve",
          },
        ),
      ).toMatchObject({ ok: true });
      // The buyer authorized it: the titular hears it, not the buyer.
      expect(
        await noticesOf(owner, "purchasing.request_to_attend", sent.requestId),
      ).toHaveLength(1);
      expect(
        await noticesOf(buyer, "purchasing.request_to_attend", sent.requestId),
      ).toHaveLength(0);
    } finally {
      await rule(owner, false);
    }
  });
});

describe("between companies", () => {
  it("a request of another company does not exist", async () => {
    const drill = await product(owner);
    const sent = await sentRequest(warehouse, [
      { productId: drill, quantity: "1" },
    ]);
    const other = await company();
    const stranger = await member(other.organizationId, "buyer");
    expect(await getPurchaseRequest(other, sent.requestId)).toBeNull();
    expect(await compareSuppliers(stranger, sent.requestId)).toBeNull();
    expect(
      await convertPurchaseRequest(other, sent.requestId, { suppliers: {} }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await rejectPurchaseRequest(other, sent.requestId, {
        reason: "No es nuestra",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      (await listPurchaseRequests(other, { view: "attend" })).items,
    ).toEqual([]);
    // Nor with the product of the other company.
    expect(
      await createPurchaseRequest(other, {
        productId: drill,
        capture: "base",
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("taking Compras away (CMP-17)", () => {
  it("warns of the requests not yet turned into orders", async () => {
    const lone = await company();
    const asker = await member(lone.organizationId, "warehouse");
    const drill = await product(lone);
    await sentRequest(asker, [{ productId: drill, quantity: "1" }]);
    await createPurchaseRequest(asker, {});
    const lines = await moduleOpenWork("purchasing", lone.organizationId);
    expect(lines.join("\n")).toMatch(/1 solicitud de compra espera/);
    expect(lines.join("\n")).toMatch(/1 solicitud de compra en borrador/);
  });
});
