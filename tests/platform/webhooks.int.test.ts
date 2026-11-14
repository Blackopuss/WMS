import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  registerAdjustment,
  registerEntry,
} from "@/modules/inventory";
import { moduleRegistry, webhookEventTypes } from "@/modules/registry";
import {
  WEBHOOK_DELIVERY_JOB,
  WEBHOOK_FANOUT_JOB,
  WEBHOOK_PAUSE_AFTER,
  createTransport,
  createWebhookEndpoint,
  emitWebhookEvent,
  listWebhookEndpoints,
  pinnedLookup,
  purgeWebhookHistory,
  removeWebhookEndpoint,
  rotateWebhookSecret,
  setWebhookEndpointPaused,
  updateWebhookEndpoint,
  webhookDeliveryHandler,
  webhookFanoutHandler,
  type DeliveryAttempt,
  type WebhookTransport,
} from "@/platform/api";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { runNextJob, settleFailedJobs } from "@/platform/jobs";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-60 (ADR 0058): events are emitted inside the transaction of the
// fact, delivered signed by the worker with retries and the same event
// id, the delivery log never keeps the body, and a destination that keeps
// failing pauses itself and tells who manages the API.

type Actor = { organizationId: string; userId: string };

const stamp = Date.now();
let counter = 0;

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `webhooks.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<Actor> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `Empresa webhooks ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser("Personal");
  await db.platformStaff.create({ data: { userId: staff } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 20,
      facilities: 3,
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba de webhooks",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: ownerId };
}

const ALL = webhookEventTypes.map((type) => type.key);
const typeOf = (key: string) =>
  webhookEventTypes.find((type) => type.key === key)!;

type Sent = { url: string; body: string; headers: Record<string, string> };

function fakeTransport(answers: DeliveryAttempt[]) {
  const sent: Sent[] = [];
  const transport: WebhookTransport = async (input) => {
    sent.push(input);
    return answers.shift() ?? { kind: "delivered", status: 200 };
  };
  return { sent, transport };
}

/** Runs the due webhook jobs of the queue with the given transport. */
async function runDeliveries(transport: WebhookTransport, at = new Date()) {
  const handlers = {
    [WEBHOOK_FANOUT_JOB]: webhookFanoutHandler(),
    [WEBHOOK_DELIVERY_JOB]: webhookDeliveryHandler({ transport }),
  };
  let ran = 0;
  for (;;) {
    // Jobs queued while running (deliveries of a hand-out) are due at once.
    const outcome = await runNextJob(handlers, {
      now: () => new Date(Math.max(at.getTime(), Date.now())),
    });
    if (outcome.kind === "idle") break;
    ran++;
  }
  await settleFailedJobs(handlers);
  return ran;
}

/** Clears pending jobs of earlier tests so each test sees only its own. */
async function drain() {
  await runDeliveries(
    fakeTransport([]).transport,
    new Date(Date.now() + 864e5),
  );
}

function verify(secret: string, header: string, body: string) {
  const parts = header.split(",");
  const t = parts.find((part) => part.startsWith("t="))!.slice(2);
  const expected = createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  return parts
    .filter((part) => part.startsWith("v1="))
    .some((part) => part.slice(3) === expected);
}

let a: Actor;
let b: Actor;
let productId = "";
let general = "";

beforeAll(async () => {
  a = await company();
  b = await company();
  const product = await createProduct(a, { sku: "WH-1", name: "Producto WH" });
  if (!product.ok) throw new Error("product");
  productId = product.productId;
  general = (
    await db.location.findFirstOrThrow({
      where: { organizationId: a.organizationId, isDefault: true },
    })
  ).id;
  const entry = await registerEntry(a, {
    productId,
    locationId: general,
    quantity: "50",
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("destinos", () => {
  it("valida la dirección y los eventos, y muestra el secreto una vez", async () => {
    const bad = await createWebhookEndpoint(
      a,
      { url: "http://ejemplo.com/x", events: [] },
      webhookEventTypes,
    );
    expect(bad).toMatchObject({
      ok: false,
      fieldErrors: { url: expect.any(String), events: expect.any(String) },
    });
    const privateUrl = await createWebhookEndpoint(
      a,
      { url: "https://169.254.169.254/latest", events: ALL },
      webhookEventTypes,
    );
    expect(privateUrl.ok).toBe(false);
    const created = await createWebhookEndpoint(
      a,
      {
        url: "https://hooks.ejemplo.com/wms",
        events: [...ALL, "otro.evento.x"],
      },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(created.secret).toMatch(/^whsec_/);
    const row = await db.webhookEndpoint.findUniqueOrThrow({
      where: { id: created.endpointId },
    });
    expect(row.secretCiphertext).not.toContain(created.secret!.slice(6));
    expect(row.events).toEqual(ALL);
    const listed = (await listWebhookEndpoints(a)).endpoints;
    expect(JSON.stringify(listed)).not.toContain(created.secret!.slice(6));
    await removeWebhookEndpoint(a, created.endpointId);
  });

  it("solo quien administra la API los toca; otra empresa no los ve", async () => {
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/a", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    expect(
      (await listWebhookEndpoints(b)).endpoints.map((each) => each.id),
    ).not.toContain(created.endpointId);
    expect(
      await setWebhookEndpointPaused(b, created.endpointId, true),
    ).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await updateWebhookEndpoint(
        b,
        created.endpointId,
        { url: "https://otro.ejemplo.com/x", events: ALL },
        webhookEventTypes,
      ),
    ).toMatchObject({ ok: false, reason: "not_found" });
    const viewerId = await newUser("Consulta");
    const membership = await db.membership.create({
      data: { id: newId(), organizationId: a.organizationId, userId: viewerId },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        membershipId: membership.id,
        role: "viewer",
      },
    });
    await expect(
      listWebhookEndpoints({
        organizationId: a.organizationId,
        userId: viewerId,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await removeWebhookEndpoint(a, created.endpointId);
  });
});

describe("alcance por almacén (WMS-20)", () => {
  it("quien está limitado a almacenes no ve ni toca los webhooks", async () => {
    const adminId = await newUser("Admin limitado");
    const membership = await db.membership.create({
      data: { id: newId(), organizationId: a.organizationId, userId: adminId },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        membershipId: membership.id,
        role: "administrator",
      },
    });
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: a.organizationId, isDefault: true },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        membershipId: membership.id,
        facilityId: main.id,
      },
    });
    const limited = { organizationId: a.organizationId, userId: adminId };
    const own = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/todo", events: ALL },
      webhookEventTypes,
    );
    if (!own.ok) throw new Error("endpoint");
    expect(await listWebhookEndpoints(limited)).toEqual({
      limited: true,
      endpoints: [],
    });
    expect(
      await createWebhookEndpoint(
        limited,
        { url: "https://hooks.ejemplo.com/mio", events: ALL },
        webhookEventTypes,
      ),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    for (const result of [
      await setWebhookEndpointPaused(limited, own.endpointId, true),
      await rotateWebhookSecret(limited, own.endpointId),
      await removeWebhookEndpoint(limited, own.endpointId),
      await updateWebhookEndpoint(
        limited,
        own.endpointId,
        { url: "https://hooks.ejemplo.com/x", events: ALL },
        webhookEventTypes,
      ),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "not_allowed" });
    }
    await removeWebhookEndpoint(a, own.endpointId);
  });
});

describe("emisión", () => {
  it("sin destinos no escribe nada; con uno, evento, entrega y trabajo", async () => {
    const before = await db.webhookEvent.count({
      where: { organizationId: a.organizationId },
    });
    const adjusted = await registerAdjustment(a, {
      productId,
      locationId: general,
      quantity: "49",
      reason: "Conteo físico de prueba",
    });
    expect(adjusted.ok).toBe(true);
    expect(
      await db.webhookEvent.count({
        where: { organizationId: a.organizationId },
      }),
    ).toBe(before);

    const created = await createWebhookEndpoint(
      a,
      {
        url: "https://hooks.ejemplo.com/ajustes",
        events: ["inventory.adjustment.applied"],
      },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    const again = await registerAdjustment(a, {
      productId,
      locationId: general,
      quantity: "48",
      reason: "Conteo físico de prueba",
    });
    if (!again.ok) throw new Error(JSON.stringify(again));
    const event = await db.webhookEvent.findFirstOrThrow({
      where: { organizationId: a.organizationId },
      orderBy: { id: "desc" },
    });
    expect(event.type).toBe("inventory.adjustment.applied");
    expect(event.payload).toMatchObject({
      id: event.id,
      apiVersion: "v1",
      data: {
        movementId: again.movementId,
        source: "manual",
        lines: [
          {
            productId,
            previousQuantity: "49",
            countedQuantity: "48",
            difference: "-1",
          },
        ],
      },
    });
    // Never costs in the body.
    expect(JSON.stringify(event.payload)).not.toMatch(/cost/i);
    // A status change does not go to a destination that did not ask for it.
    const status = await changeStockStatus(a, {
      productId,
      locationId: general,
      from: "AVAILABLE",
      to: "DAMAGED",
      quantity: "1",
      reason: "Caja rota",
      idempotencyKey: newId(),
    });
    expect(status.ok).toBe(true);
    expect(
      await db.webhookEvent.count({
        where: {
          organizationId: a.organizationId,
          type: "inventory.stock_status.changed",
        },
      }),
    ).toBe(0);
    await removeWebhookEndpoint(a, created.endpointId);
    await drain();
  });

  it("emite el cambio de estado y la recepción con cantidades en texto", async () => {
    const created = await createWebhookEndpoint(
      a,
      {
        url: "https://hooks.ejemplo.com/hechos",
        events: [
          "inventory.stock_status.changed",
          "purchasing.receipt.confirmed",
        ],
      },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    const changed = await changeStockStatus(a, {
      productId,
      locationId: general,
      from: "AVAILABLE",
      to: "QUARANTINE",
      quantity: "2",
      reason: "Revisión",
      idempotencyKey: newId(),
    });
    if (!changed.ok) throw new Error(JSON.stringify(changed));
    const status = await db.webhookEvent.findFirstOrThrow({
      where: {
        organizationId: a.organizationId,
        type: "inventory.stock_status.changed",
      },
    });
    expect(status.payload).toMatchObject({
      data: {
        movementId: changed.movementId,
        productId,
        fromStatus: "AVAILABLE",
        toStatus: "QUARANTINE",
        quantity: "2",
        source: "manual",
      },
    });

    const supplier = await db.contact.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        name: "Proveedor WH",
        isSupplier: true,
        createdByUserId: a.userId,
      },
    });
    const {
      addOrderLine,
      createPurchaseOrder,
      receivePurchaseOrder,
      submitPurchaseOrder,
    } = await import("@/modules/purchasing");
    const order = await createPurchaseOrder(a, { supplierId: supplier.id });
    if (!order.ok) throw new Error(JSON.stringify(order));
    await addOrderLine(a, order.orderId, {
      productId,
      capture: "base",
      quantity: "5",
      unitCost: "12",
    });
    const sent = await submitPurchaseOrder(a, order.orderId);
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    const received = await receivePurchaseOrder(a, order.orderId, {
      idempotencyKey: newId(),
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    const receipt = await db.webhookEvent.findFirstOrThrow({
      where: {
        organizationId: a.organizationId,
        type: "purchasing.receipt.confirmed",
      },
    });
    expect(receipt.payload).toMatchObject({
      data: {
        receiptId: received.receiptId,
        purchaseOrderId: order.orderId,
        orderStatus: "RECEIVED",
        lines: [{ productId, quantity: "5", damaged: false }],
      },
    });
    // The cost of the order line never travels.
    expect(JSON.stringify(receipt.payload)).not.toMatch(/cost|"12(\.0+)?"/i);
    await removeWebhookEndpoint(a, created.endpointId);
    await drain();
  });

  it("emite el despacho desde un embarque real", async () => {
    const {
      acceptTask,
      confirmPick,
      createOutboundOrder,
      createShipment,
      deliverTask,
      dispatchShipment,
      releaseOutboundOrder,
      setOutboundLine,
    } = await import("@/modules/inventory");
    const { createLocation } = await import("@/platform/locations");
    const created = await createWebhookEndpoint(
      a,
      {
        url: "https://hooks.ejemplo.com/despachos",
        events: ["inventory.shipment.dispatched"],
      },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    const shelf = await createLocation(a, {
      level: 3,
      name: "Estante despacho",
    });
    if (!shelf.ok) throw new Error(JSON.stringify(shelf));
    const entered = await registerEntry(a, {
      productId,
      locationId: shelf.locationId,
      quantity: "4",
      acceptRepeat: true,
    });
    if (!entered.ok) throw new Error(JSON.stringify(entered));
    const order = await createOutboundOrder(a, {
      recipient: "Cliente despacho",
    });
    if (!order.ok) throw new Error(JSON.stringify(order));
    await setOutboundLine(a, order.orderId, { productId, quantity: "3" });
    const released = await releaseOutboundOrder(a, order.orderId);
    if (!released.ok) throw new Error(JSON.stringify(released));
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "PICK", outboundLine: { orderId: order.orderId } },
      include: { product: true, fromLocation: true },
    });
    for (const task of tasks) {
      await acceptTask(a, task.id);
      const picked = await confirmPick(a, task.id, {
        productCode: task.product!.sku,
        locationCode: task.fromLocation.name,
        quantity: task.quantity!.toString(),
      });
      if (!picked.ok) throw new Error(JSON.stringify(picked));
      const delivered = await deliverTask(a, task.id);
      if (!delivered.ok) throw new Error(JSON.stringify(delivered));
    }
    const shipment = await createShipment(a, { orderIds: [order.orderId] });
    if (!shipment.ok) throw new Error(JSON.stringify(shipment));
    const dispatched = await dispatchShipment(a, shipment.shipmentId);
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched));
    const event = await db.webhookEvent.findFirstOrThrow({
      where: {
        organizationId: a.organizationId,
        type: "inventory.shipment.dispatched",
      },
    });
    expect(event.payload).toMatchObject({
      data: {
        shipmentId: shipment.shipmentId,
        orders: [{ id: order.orderId, lines: [{ productId, quantity: "3" }] }],
      },
    });
    // The fact only queued the hand-out; the worker makes the delivery.
    expect(
      await db.webhookDelivery.count({
        where: { endpointId: created.endpointId },
      }),
    ).toBe(0);
    const { sent, transport } = fakeTransport([]);
    await runDeliveries(transport);
    expect(sent.map((each) => each.headers["wms-event-id"])).toEqual([
      event.id,
    ]);
    await removeWebhookEndpoint(a, created.endpointId);
  });

  it("no reparte un evento de un módulo que la empresa ya no tiene", async () => {
    await drain();
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/modulo", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    await forOrganization(a.organizationId).$transaction((tx) =>
      emitWebhookEvent(
        tx,
        { key: "inventory.adjustment.applied", module: "crm" },
        { organizationId: a.organizationId, data: {} },
      ),
    );
    const { sent, transport } = fakeTransport([]);
    await runDeliveries(transport);
    expect(sent).toHaveLength(0);
    expect(
      await db.webhookDelivery.count({
        where: { endpointId: created.endpointId },
      }),
    ).toBe(0);
    await removeWebhookEndpoint(a, created.endpointId);
  });

  it("si la operación se revierte no hay evento", async () => {
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/revierte", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    const before = await db.webhookEvent.count({
      where: { organizationId: a.organizationId },
    });
    await expect(
      forOrganization(a.organizationId).$transaction(async (tx) => {
        await emitWebhookEvent(tx, typeOf("inventory.adjustment.applied"), {
          organizationId: a.organizationId,
          data: { x: 1 },
        });
        throw new Error("se revierte");
      }),
    ).rejects.toThrow("se revierte");
    expect(
      await db.webhookEvent.count({
        where: { organizationId: a.organizationId },
      }),
    ).toBe(before);
    await removeWebhookEndpoint(a, created.endpointId);
  });
});

describe("entrega", () => {
  it("firma con HMAC-SHA256 y reintenta con el mismo id sin duplicar", async () => {
    await drain();
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/firma", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    await forOrganization(a.organizationId).$transaction((tx) =>
      emitWebhookEvent(tx, typeOf("inventory.shipment.dispatched"), {
        organizationId: a.organizationId,
        data: { shipmentId: "x", lines: [{ quantity: "2.5" }] },
      }),
    );
    const { sent, transport } = fakeTransport([
      { kind: "failed", status: 500, reason: "El destino respondió 500." },
      { kind: "delivered", status: 204 },
    ]);
    await runDeliveries(transport);
    const delivery = await db.webhookDelivery.findFirstOrThrow({
      where: { endpointId: created.endpointId },
    });
    expect(delivery).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastStatusCode: 500,
    });
    expect(delivery.reason).toBe("El destino respondió 500.");
    // The retry waits; at its time it goes again with the same event id.
    await runDeliveries(transport, new Date(Date.now() + 60_000));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["wms-event-id"]).toBe(
      sent[1]!.headers["wms-event-id"],
    );
    expect(sent[0]!.body).toBe(sent[1]!.body);
    expect(
      verify(
        created.secret!,
        sent[1]!.headers["wms-signature"]!,
        sent[1]!.body,
      ),
    ).toBe(true);
    expect(
      verify("whsec_otro", sent[1]!.headers["wms-signature"]!, sent[1]!.body),
    ).toBe(false);
    const done = await db.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(done).toMatchObject({
      status: "DELIVERED",
      attempts: 2,
      lastStatusCode: 204,
    });
    // Running the job again (at least once) sends nothing more.
    const handler = webhookDeliveryHandler({ transport });
    await handler.handle({
      jobId: newId(),
      organizationId: a.organizationId,
      createdByUserId: null,
      payload: { deliveryId: delivery.id },
      attempt: 3,
      maxAttempts: 6,
    });
    expect(sent).toHaveLength(2);
    // The delivery of another company is not found from here.
    await handler.handle({
      jobId: newId(),
      organizationId: b.organizationId,
      createdByUserId: null,
      payload: { deliveryId: delivery.id },
      attempt: 1,
      maxAttempts: 6,
    });
    expect(sent).toHaveLength(2);
    await removeWebhookEndpoint(a, created.endpointId);
  });

  it("al cambiar el secreto firma con los dos durante el cambio", async () => {
    await drain();
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/rota", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    const rotated = await rotateWebhookSecret(a, created.endpointId);
    if (!rotated.ok) throw new Error("rotate");
    await forOrganization(a.organizationId).$transaction((tx) =>
      emitWebhookEvent(tx, typeOf("purchasing.receipt.confirmed"), {
        organizationId: a.organizationId,
        data: { receiptId: "r" },
      }),
    );
    const { sent, transport } = fakeTransport([]);
    await runDeliveries(transport);
    const header = sent[0]!.headers["wms-signature"]!;
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(verify(created.secret!, header, sent[0]!.body)).toBe(true);
    expect(verify(rotated.secret!, header, sent[0]!.body)).toBe(true);
    await removeWebhookEndpoint(a, created.endpointId);
  });

  it("tras fallos seguidos se pausa sola y avisa a quien administra la API", async () => {
    await drain();
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/falla", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    for (let i = 0; i < WEBHOOK_PAUSE_AFTER; i++) {
      await forOrganization(a.organizationId).$transaction((tx) =>
        emitWebhookEvent(tx, typeOf("inventory.adjustment.applied"), {
          organizationId: a.organizationId,
          data: { n: i },
        }),
      );
    }
    const failing: WebhookTransport = async () => ({
      kind: "failed",
      reason: "No se pudo conectar con el destino.",
    });
    // Every attempt fails until the jobs use up their attempts.
    for (let round = 0; round < 7; round++) {
      await runDeliveries(failing, new Date(Date.now() + round * 3 * 3600_000));
    }
    const deliveries = await db.webhookDelivery.findMany({
      where: { endpointId: created.endpointId },
    });
    expect(deliveries.every((each) => each.status === "FAILED")).toBe(true);
    expect(
      deliveries.every(
        (each) => each.reason === "No se pudo conectar con el destino.",
      ),
    ).toBe(true);
    const endpoint = await db.webhookEndpoint.findUniqueOrThrow({
      where: { id: created.endpointId },
    });
    expect(endpoint).toMatchObject({
      status: "PAUSED",
      pausedByFailures: true,
    });
    const notice = await db.notification.findFirst({
      where: {
        organizationId: a.organizationId,
        recipientUserId: a.userId,
        typeKey: "platform.webhook_paused",
      },
    });
    expect(notice?.href).toBe("/configuracion/api");
    // Paused: new facts do not reach it.
    const before = await db.webhookDelivery.count({
      where: { endpointId: created.endpointId },
    });
    await forOrganization(a.organizationId).$transaction((tx) =>
      emitWebhookEvent(tx, typeOf("inventory.adjustment.applied"), {
        organizationId: a.organizationId,
        data: {},
      }),
    );
    expect(
      await db.webhookDelivery.count({
        where: { endpointId: created.endpointId },
      }),
    ).toBe(before);
    // Resuming forgets the failures.
    expect(
      await setWebhookEndpointPaused(a, created.endpointId, false),
    ).toMatchObject({ ok: true });
    const resumed = await db.webhookEndpoint.findUniqueOrThrow({
      where: { id: created.endpointId },
    });
    expect(resumed).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    await removeWebhookEndpoint(a, created.endpointId);
  }, 60_000);

  it("una entrega pendiente de un destino pausado no se manda", async () => {
    await drain();
    const created = await createWebhookEndpoint(
      a,
      { url: "https://hooks.ejemplo.com/pausa", events: ALL },
      webhookEventTypes,
    );
    if (!created.ok) throw new Error("endpoint");
    await forOrganization(a.organizationId).$transaction((tx) =>
      emitWebhookEvent(tx, typeOf("inventory.adjustment.applied"), {
        organizationId: a.organizationId,
        data: {},
      }),
    );
    // Handed out while active; paused before the delivery runs.
    await runNextJob(
      { [WEBHOOK_FANOUT_JOB]: webhookFanoutHandler() },
      { now: () => new Date() },
    );
    await setWebhookEndpointPaused(a, created.endpointId, true);
    const { sent, transport } = fakeTransport([]);
    await runDeliveries(transport);
    expect(sent).toHaveLength(0);
    const delivery = await db.webhookDelivery.findFirstOrThrow({
      where: { endpointId: created.endpointId },
    });
    expect(delivery.status).toBe("SKIPPED");
    await removeWebhookEndpoint(a, created.endpointId);
  });

  it("borra el historial de más de 30 días", async () => {
    const old = new Date(Date.now() - 40 * 864e5);
    const eventId = newId();
    const endpoint = await db.webhookEndpoint.findFirstOrThrow({
      where: { organizationId: a.organizationId },
    });
    await db.webhookEvent.create({
      data: {
        id: eventId,
        organizationId: a.organizationId,
        type: "x.y.z",
        payload: {},
        createdAt: old,
      },
    });
    await db.webhookDelivery.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        endpointId: endpoint.id,
        eventId,
        status: "DELIVERED",
      },
    });
    const purged = await purgeWebhookHistory(a.organizationId);
    expect(purged.events).toBeGreaterThanOrEqual(1);
    expect(
      await db.webhookEvent.findUnique({ where: { id: eventId } }),
    ).toBeNull();
  });
});

describe("protección de destinos (SSRF)", () => {
  const send = (transport: WebhookTransport, url: string) =>
    transport({ url, body: "{}", headers: {} });

  it("rechaza direcciones privadas, también si el nombre resuelve a una", async () => {
    const literal = createTransport();
    for (const url of [
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/x",
    ]) {
      expect(await send(literal, url)).toMatchObject({ kind: "failed" });
    }
    const toPrivate = createTransport({
      resolver: async () => [{ address: "10.0.0.7", family: 4 }],
    });
    expect(await send(toPrivate, "https://hooks.ejemplo.com/x")).toEqual({
      kind: "failed",
      reason: "La dirección apunta a una red privada o reservada.",
    });
    const mixed = createTransport({
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ],
    });
    expect(await send(mixed, "https://hooks.ejemplo.com/x")).toMatchObject({
      kind: "failed",
      reason: "La dirección apunta a una red privada o reservada.",
    });
    const metadataV6 = createTransport({
      resolver: async () => [{ address: "fd00:ec2::254", family: 6 }],
    });
    expect(await send(metadataV6, "https://hooks.ejemplo.com/x")).toMatchObject(
      { kind: "failed" },
    );
    const unknown = createTransport({
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await send(unknown, "https://hooks.ejemplo.com/x")).toEqual({
      kind: "failed",
      reason: "No se encontró la dirección del destino.",
    });
    expect(await send(literal, "http://hooks.ejemplo.com/x")).toMatchObject({
      kind: "failed",
    });
  });

  it("conecta solo a la dirección validada", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    const single: unknown[] = [];
    lookup("otro.ejemplo.com", {}, (...args) => single.push(...args));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all: unknown[] = [];
    lookup("otro.ejemplo.com", { all: true }, (...args) => all.push(...args));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});
