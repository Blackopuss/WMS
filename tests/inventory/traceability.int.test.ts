import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  confirmPick,
  createOutboundOrder,
  deliverTask,
  findTraceMatches,
  getOutboundOrder,
  listMovements,
  listProductSerials,
  reconcileStock,
  registerExit,
  registerTransfer,
  releaseOutboundOrder,
  setOutboundLine,
  traceLot,
  tracePurchaseOrder,
  traceSerial,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import {
  createLocation,
  getActiveFacility,
  getDefaultLocation,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-21B (ADR 0041): «where it came from and where it went», by lot, by
// serial or by order, within what the person may see.

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `rastreo.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa rastreo ${++counter}`,
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
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba de rastreo",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: "warehouse",
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

/**
 * A purchase order with one line of a product by serial and one by lot,
 * received into `zone`; returns everything a test needs.
 */
async function scenario() {
  const actor = await company();
  const serialProduct = await createProduct(actor, {
    sku: `RS-${++counter}`,
    name: "Equipo",
    tracking: "SERIAL",
  });
  const lotProduct = await createProduct(actor, {
    sku: `RL-${++counter}`,
    name: "Insumo",
    tracking: "LOT",
    lotExpiry: "OPTIONAL",
  });
  if (!serialProduct.ok || !lotProduct.ok) throw new Error("products");
  const zone = await createLocation(actor, { level: 1, name: "Zona A" });
  if (!zone.ok) throw new Error("zone");
  const supplier = await createSupplier(actor, { name: "Proveedora Norte" });
  if (!supplier.ok) throw new Error("supplier");
  const order = await createPurchaseOrder(actor, {
    supplierId: supplier.supplierId,
  });
  if (!order.ok) throw new Error("order");
  for (const productId of [serialProduct.productId, lotProduct.productId]) {
    const added = await addOrderLine(actor, order.orderId, {
      productId,
      capture: "base",
      quantity: "3",
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  await submitPurchaseOrder(actor, order.orderId);
  const [serialLine, lotLine] = await db.purchaseOrderLine.findMany({
    where: { orderId: order.orderId },
    orderBy: { lineNumber: "asc" },
  });
  const received = await receivePurchaseOrder(actor, order.orderId, {
    idempotencyKey: newId(),
    locationId: zone.locationId,
    lines: [
      {
        orderLineId: serialLine!.id,
        quantity: "3",
        serials: "TR-1\nTR-2\nTR-3",
      },
      { orderLineId: lotLine!.id, quantity: "3", lotCode: "LT-9" },
    ],
  });
  if (!received.ok) throw new Error(JSON.stringify(received));
  const unit = await db.serialUnit.findFirstOrThrow({
    where: { productId: serialProduct.productId, serial: "TR-2" },
  });
  const lot = await db.lot.findFirstOrThrow({
    where: { productId: lotProduct.productId, code: "LT-9" },
  });
  return {
    actor,
    serialProductId: serialProduct.productId,
    lotProductId: lotProduct.productId,
    zoneId: zone.locationId,
    purchaseOrderId: order.orderId,
    unit,
    lot,
  };
}

/** An outbound order of one line, released and picked to staging. */
async function pickOrder(
  actor: InventoryActor,
  productId: string,
  quantity: string,
  pick: { serials?: string; lotCode?: string },
) {
  const made = await createOutboundOrder(actor, { recipient: "Sucursal Sur" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  await setOutboundLine(actor, made.orderId, { productId, quantity });
  const released = await releaseOutboundOrder(actor, made.orderId);
  if (!released.ok) throw new Error(JSON.stringify(released));
  const task = await db.warehouseTask.findFirstOrThrow({
    where: { outboundLine: { orderId: made.orderId } },
    include: { product: true, fromLocation: true },
  });
  await acceptTask(actor, task.id);
  const confirmed = await confirmPick(actor, task.id, {
    productCode: task.product.sku,
    locationCode: task.fromLocation.name,
    quantity,
    ...pick,
  });
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
  const delivered = await deliverTask(actor, task.id);
  if (!delivered.ok) throw new Error(JSON.stringify(delivered));
  return made.orderId;
}

afterAll(async () => {
  for (const organizationId of companies) {
    expect(await reconcileStock(organizationId)).toEqual([]);
  }
  await db.$disconnect();
});

describe("traceability", () => {
  it("follows a serial from its receipt to the order it was picked for", async () => {
    const s = await scenario();
    const shelf = await createLocation(s.actor, { level: 1, name: "Zona B" });
    if (!shelf.ok) throw new Error("shelf");
    expect(
      await registerTransfer(s.actor, {
        productId: s.serialProductId,
        locationId: s.zoneId,
        toLocationId: shelf.locationId,
        quantity: "2",
        serials: "TR-2\nTR-3",
      }),
    ).toMatchObject({ ok: true });
    // The fullest place is picked from (Zona B): the picker scans there.
    const orderId = await pickOrder(s.actor, s.serialProductId, "1", {
      serials: "TR-2",
    });

    // One box: the serial is found and opens straight to it.
    expect(await findTraceMatches(s.actor, " tr-2 ")).toMatchObject({
      matches: [{ kind: "serial", id: s.unit.id, serial: "TR-2" }],
    });
    const trace = await traceSerial(s.actor, s.unit.id);
    expect(trace).toMatchObject({
      serial: "TR-2",
      now: { kind: "here", path: expect.stringContaining("Preparación") },
      origins: [
        {
          purchase: {
            orderId: s.purchaseOrderId,
            supplierName: "Proveedora Norte",
          },
        },
      ],
      orders: [{ orderId, recipient: "Sucursal Sur", delivered: true }],
    });
    const history = await listMovements(s.actor, { serialUnitId: s.unit.id });
    expect(history.items.map((item) => item.type)).toEqual([
      "TRANSFER",
      "TRANSFER",
      "RECEIPT",
    ]);

    // By order: which serial each line took.
    expect(
      await findTraceMatches(
        s.actor,
        (await getOutboundOrder(s.actor, orderId))!.numberText,
      ),
    ).toMatchObject({ matches: [{ kind: "order", id: orderId }] });
    const view = await getOutboundOrder(s.actor, orderId);
    expect(view?.tasks[0]?.serialUnits).toEqual([
      { id: s.unit.id, serial: "TR-2" },
    ]);

    // Once it leaves, it says so.
    await registerExit(s.actor, {
      productId: s.serialProductId,
      locationId: s.zoneId,
      quantity: "1",
      serials: "TR-1",
    });
    const gone = await db.serialUnit.findFirstOrThrow({
      where: { productId: s.serialProductId, serial: "TR-1" },
    });
    expect((await traceSerial(s.actor, gone.id))?.now).toEqual({
      kind: "out",
    });
    expect(
      (await listProductSerials(s.actor, s.serialProductId)).items.map(
        (item) => item.serial,
      ),
    ).toEqual(["TR-2", "TR-3"]);
  });

  it("follows a lot from its receipt to its order, and a purchase order to what it brought", async () => {
    const s = await scenario();
    const orderId = await pickOrder(s.actor, s.lotProductId, "2", {
      lotCode: "LT-9",
    });
    expect(await findTraceMatches(s.actor, "lt-9")).toMatchObject({
      matches: [{ kind: "lot", id: s.lot.id }],
    });
    expect(await traceLot(s.actor, s.lot.id)).toMatchObject({
      origins: [{ purchase: { supplierName: "Proveedora Norte" } }],
      orders: [{ orderId, delivered: true }],
    });
    const purchase = await tracePurchaseOrder(s.actor, s.purchaseOrderId);
    expect(purchase?.receipts[0]?.lines).toEqual([
      expect.objectContaining({
        lot: null,
        serials: [
          expect.objectContaining({ serial: "TR-1" }),
          expect.objectContaining({ serial: "TR-2" }),
          expect.objectContaining({ serial: "TR-3" }),
        ],
      }),
      expect.objectContaining({
        lot: expect.objectContaining({ code: "LT-9" }),
        serials: [],
      }),
    ]);
  });

  it("without Compras the supplier is not there; outside the scope nothing is", async () => {
    const s = await scenario();
    // Almacén reads movements and orders, never purchase orders.
    const floor = await member(s.actor.organizationId, "warehouse");
    const trace = await traceSerial(floor, s.unit.id);
    expect(trace?.origins).toEqual([
      expect.objectContaining({ purchase: null }),
    ]);
    expect(await tracePurchaseOrder(floor, s.purchaseOrderId)).toBeNull();
    expect(
      (await findTraceMatches(floor, "OC-0001")).matches.filter(
        (match) => match.kind === "purchase_order",
      ),
    ).toEqual([]);

    // Limited to another zone: the units, lots and receipts of Zona A do
    // not exist for that person.
    const other = await createLocation(s.actor, { level: 1, name: "Zona C" });
    if (!other.ok) throw new Error("zone");
    const facility = await getActiveFacility(s.actor);
    const scoped = await setMemberScope(
      s.actor.organizationId,
      s.actor.userId,
      {
        userId: floor.userId,
        facilities: [{ facilityId: facility.id, zoneIds: [other.locationId] }],
      },
    );
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    expect((await findTraceMatches(floor, "TR-2")).matches).toEqual([]);
    expect((await findTraceMatches(floor, "LT-9")).matches).toEqual([]);
    expect(await traceSerial(floor, s.unit.id)).toBeNull();
    expect(await traceLot(floor, s.lot.id)).toBeNull();
    expect((await listProductSerials(floor, s.serialProductId)).items).toEqual(
      [],
    );

    // Another company does not find this one's serials.
    const stranger = await company();
    expect((await findTraceMatches(stranger, "TR-2")).matches).toEqual([]);
    expect(await traceSerial(stranger, s.unit.id)).toBeNull();
    expect(await getDefaultLocation(stranger)).not.toBeNull();
  });
});
