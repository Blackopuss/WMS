import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  cancelOutboundOrder,
  createOutboundOrder,
  getOutboundOrder,
  getProductStock,
  getReservedTotals,
  listOutboundOrders,
  reconcileStock,
  registerEntry,
  registerExit,
  releaseOutboundOrder,
  removeOutboundLine,
  setOutboundLine,
  updateOutboundOrder,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { getDefaultLocation } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-13 (spec 5.2): an outbound order is written as a draft, released to
// the warehouse — which reserves its stock without moving it — or
// cancelled, which releases what it held.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `pedidos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Almacén ${counter}`,
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
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de pedidos de salida",
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

async function product(owner: InventoryActor, name: string, stock: string) {
  const created = await createProduct(owner, {
    sku: `PS-${++counter}`,
    name,
  });
  if (!created.ok) throw new Error("product setup failed");
  if (stock !== "0") {
    const entry = await registerEntry(owner, {
      productId: created.productId,
      locationId: (await getDefaultLocation(owner))!.id,
      quantity: stock,
    });
    if (!entry.ok) throw new Error("entry setup failed");
  }
  return created.productId;
}

async function draft(owner: InventoryActor, recipient = "Sucursal Norte") {
  const made = await createOutboundOrder(owner, {
    recipient,
    reference: "OC-778",
    dueOn: "2026-11-20",
    priority: "URGENT",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.orderId;
}

afterAll(() => db.$disconnect());

describe("writing an order", () => {
  it("a draft takes one line per product and changes freely", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "50");
    const clavos = await product(owner, "Clavo 2 in", "0");
    const orderId = await draft(owner);
    expect(
      await setOutboundLine(owner, orderId, {
        productId: tablas,
        quantity: "10",
      }),
    ).toMatchObject({
      ok: true,
      summary: "10 piezas de Tabla de pino en el pedido.",
    });
    // The same product again replaces its quantity.
    await setOutboundLine(owner, orderId, {
      productId: tablas,
      quantity: "12",
    });
    await setOutboundLine(owner, orderId, { productId: clavos, quantity: "5" });
    expect(
      await setOutboundLine(owner, orderId, {
        productId: tablas,
        quantity: "1.5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    let order = await getOutboundOrder(owner, orderId);
    expect(order).toMatchObject({
      numberText: "PS-0001",
      status: "DRAFT",
      statusLabel: "Borrador",
      urgent: true,
      recipient: "Sucursal Norte",
      reference: "OC-778",
      dueOn: "2026-11-20",
    });
    expect(
      order!.lineItems.map((line) => [line.productName, line.quantityText]),
    ).toEqual([
      ["Tabla de pino", "12 piezas"],
      ["Clavo 2 in", "5 piezas"],
    ]);
    await removeOutboundLine(owner, orderId, order!.lineItems[1]!.id);
    expect(
      await updateOutboundOrder(owner, orderId, { recipient: "Obra Centro" }),
    ).toMatchObject({ ok: true });
    order = await getOutboundOrder(owner, orderId);
    expect(order).toMatchObject({ recipient: "Obra Centro", lines: 1 });
    expect(await createOutboundOrder(owner, { recipient: "" })).toMatchObject({
      ok: false,
      fieldErrors: { recipient: expect.any(String) },
    });
  });
});

describe("releasing", () => {
  it("reserves every line without moving the stock", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "50");
    const orderId = await draft(owner);
    await setOutboundLine(owner, orderId, {
      productId: tablas,
      quantity: "30",
    });
    expect(await releaseOutboundOrder(owner, orderId)).toMatchObject({
      ok: true,
      summary: "Se liberó el pedido PS-0001: todo quedó reservado.",
    });
    expect(await releaseOutboundOrder(owner, orderId)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await getReservedTotals(owner, [tablas])).toEqual({
      [tablas]: "30",
    });
    expect(await getProductStock(owner, tablas)).toMatchObject({
      total: "50",
      available: "20",
    });
    const order = await getOutboundOrder(owner, orderId);
    expect(order).toMatchObject({
      status: "RELEASED",
      statusLabel: "Liberado",
    });
    expect(order!.lineItems[0]).toMatchObject({
      reservedText: "30 piezas",
      shortText: null,
    });
    // Released, the order no longer changes.
    expect(
      await setOutboundLine(owner, orderId, {
        productId: tablas,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringMatching(/ya se liberó/),
    });
    // What it reserved does not leave by hand.
    const general = (await getDefaultLocation(owner))!.id;
    expect(
      await registerExit(owner, {
        productId: tablas,
        locationId: general,
        quantity: "21",
      }),
    ).toMatchObject({ ok: false });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("when something does not reach, says what is short and reserves nothing", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "8");
    const clavos = await product(owner, "Clavo 2 in", "100");
    const orderId = await draft(owner);
    await setOutboundLine(owner, orderId, {
      productId: tablas,
      quantity: "10",
    });
    await setOutboundLine(owner, orderId, {
      productId: clavos,
      quantity: "40",
    });
    const result = await releaseOutboundOrder(owner, orderId);
    expect(result).toMatchObject({
      ok: false,
      reason: "short",
      formError: "Un producto no alcanza.",
      shortages: [
        { productName: "Tabla de pino", asked: "10 piezas", free: "8 piezas" },
      ],
    });
    expect(await getReservedTotals(owner, [tablas, clavos])).toEqual({});
    // Released with what there is: the rest stays pending.
    expect(
      await releaseOutboundOrder(owner, orderId, { takeWhatThereIs: true }),
    ).toMatchObject({
      ok: true,
      summary: expect.stringMatching(/1 producto quedó/),
    });
    expect(await getReservedTotals(owner, [tablas, clavos])).toEqual({
      [tablas]: "8",
      [clavos]: "40",
    });
    const order = await getOutboundOrder(owner, orderId);
    expect(order!.lineItems[0]).toMatchObject({ shortText: "2 piezas" });
  });

  it("two orders released at once never reserve more than there is (PC-2)", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "20");
    const orders = [await draft(owner), await draft(owner)];
    for (const orderId of orders) {
      await setOutboundLine(owner, orderId, {
        productId: tablas,
        quantity: "15",
      });
    }
    const results = await Promise.all(
      orders.map((orderId) => releaseOutboundOrder(owner, orderId)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "short" });
    expect(await getReservedTotals(owner, [tablas])).toEqual({
      [tablas]: "15",
    });
  });
});

describe("cancelling", () => {
  it("releases what the order held, once, with a reason", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "20");
    const orderId = await draft(owner);
    await setOutboundLine(owner, orderId, {
      productId: tablas,
      quantity: "15",
    });
    await releaseOutboundOrder(owner, orderId);
    expect(await cancelOutboundOrder(owner, orderId, "")).toMatchObject({
      ok: false,
      fieldErrors: { reason: "Escribe por qué se cancela." },
    });
    expect(
      await cancelOutboundOrder(owner, orderId, "El cliente ya no lo quiere"),
    ).toMatchObject({
      ok: true,
      summary:
        "Se canceló el pedido PS-0001 y se liberó lo que tenía reservado.",
    });
    expect(await cancelOutboundOrder(owner, orderId, "Otra vez")).toMatchObject(
      { ok: true, repeated: true },
    );
    expect(await getReservedTotals(owner, [tablas])).toEqual({});
    expect(await releaseOutboundOrder(owner, orderId)).toMatchObject({
      ok: false,
      formError: "Este pedido está cancelado.",
    });
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: owner.organizationId,
          action: "inventory.outbound_cancelled",
        },
      }),
    ).toBe(1);
  });
});

describe("listing and who may", () => {
  it("lists newest first, filters by state, and checks permissions", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "20");
    const first = await draft(owner, "Primero");
    await draft(owner, "Segundo");
    await setOutboundLine(owner, first, { productId: tablas, quantity: "1" });
    await releaseOutboundOrder(owner, first);
    const all = await listOutboundOrders(owner);
    expect(all.items.map((item) => item.recipient)).toEqual([
      "Segundo",
      "Primero",
    ]);
    expect(
      (await listOutboundOrders(owner, { status: "RELEASED" })).items.map(
        (item) => item.numberText,
      ),
    ).toEqual(["PS-0001"]);

    const operator = await member(owner.organizationId, "operator");
    const buyer = await member(owner.organizationId, "buyer");
    expect((await listOutboundOrders(operator)).total).toBe(2);
    await expect(draft(operator)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(listOutboundOrders(buyer)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("nobody reaches the orders of another company", async () => {
    const ours = await company();
    const theirs = await company();
    const orderId = await draft(theirs);
    expect(await getOutboundOrder(ours, orderId)).toBeNull();
    for (const result of [
      await releaseOutboundOrder(ours, orderId),
      await cancelOutboundOrder(ours, orderId, "No es mío"),
      await updateOutboundOrder(ours, orderId, { recipient: "X" }),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect((await listOutboundOrders(ours)).total).toBe(0);
  });
});

describe("in the database", () => {
  it("lines only change in draft; an order is never deleted", async () => {
    const owner = await company();
    const tablas = await product(owner, "Tabla de pino", "5");
    const orderId = await draft(owner);
    await setOutboundLine(owner, orderId, { productId: tablas, quantity: "1" });
    await releaseOutboundOrder(owner, orderId);
    await expect(
      db.outboundOrderLine.updateMany({
        where: { orderId },
        data: { quantity: "2" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundOrder.update({
        where: { id: orderId },
        data: { recipient: "Otro" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundOrder.update({
        where: { id: orderId },
        data: { status: "SHIPPED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundOrder.delete({ where: { id: orderId } }),
    ).rejects.toThrow();
  });
});
