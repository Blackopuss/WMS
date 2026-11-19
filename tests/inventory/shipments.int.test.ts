import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  PACKING_MODE,
  SHIPMENT_DETAILS,
  acceptTask,
  addShipmentOrders,
  buildShipmentPdf,
  cancelShipment,
  confirmPick,
  countOrdersToArm,
  countOrdersToShip,
  createOutboundOrder,
  createShipment,
  deliverTask,
  dispatchShipment,
  findTraceMatches,
  finishPacking,
  getDaySummary,
  getOutboundOrder,
  getShipment,
  listContainerEvents,
  listOutboundOrders,
  listReadyOrders,
  listShipments,
  packScan,
  reconcileStock,
  registerEntry,
  releaseOutboundOrder,
  removeShipmentOrder,
  reportPackShortage,
  reverseMovement,
  setOutboundLine,
  startPacking,
  traceLot,
  traceSerial,
  updateShipment,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-16 (ADR 0045): a shipment takes orders ready to leave; confirming
// its exit empties their packages, writes ONE exit (SHIPMENT, key
// `ship:<id>`) with exactly what they hold in the staging place, consumes
// those reservations and ships the orders. Stock goes down once (PC-3).

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `embarque.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(options: { packing?: boolean } = {}) {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén embarques ${counter}`,
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
      productLimit: 60,
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de embarques",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  const actor = { organizationId: created.organizationId, userId: owner };
  if (options.packing) await setting(actor, PACKING_MODE.key, "on");
  return actor;
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

async function product(
  actor: InventoryActor,
  extra: {
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const n = ++counter;
  const created = await createProduct(actor, {
    sku: `EMB-${n}`,
    name: `Artículo ${n}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function rack(actor: InventoryActor, name: string) {
  const result = await createLocation(actor, { level: 3, name });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: { lotCode?: string; lotExpiresOn?: string; serials?: string } = {},
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

async function released(
  actor: InventoryActor,
  lines: { productId: string; quantity: string }[],
  recipient = "Sucursal Sur",
) {
  const made = await createOutboundOrder(actor, {
    recipient,
    address: "Av. Juárez 100, Centro",
    reference: "OC-CLIENTE-77",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  for (const line of lines) {
    const set = await setOutboundLine(actor, made.orderId, line);
    if (!set.ok) throw new Error(JSON.stringify(set));
  }
  const result = await releaseOutboundOrder(actor, made.orderId);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return made.orderId;
}

async function pickAll(
  actor: InventoryActor,
  orderId: string,
  serialsOf: (productId: string) => string | undefined = () => undefined,
) {
  const tasks = await db.warehouseTask.findMany({
    where: { kind: "PICK", outboundLine: { orderId } },
    orderBy: { number: "asc" },
    include: { product: true, fromLocation: true, lot: true },
  });
  for (const task of tasks) {
    expect(await acceptTask(actor, task.id)).toMatchObject({ ok: true });
    const confirmed = await confirmPick(actor, task.id, {
      productCode: task.product!.sku,
      locationCode: task.fromLocation.name,
      lotCode: task.lot?.code,
      quantity: task.quantity!.toString(),
      serials: serialsOf(task.productId!),
    });
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
    const delivered = await deliverTask(actor, task.id);
    if (!delivered.ok) throw new Error(JSON.stringify(delivered));
  }
}

/** Packs everything picked of a product (scanning its key) and finishes. */
async function packAll(
  actor: InventoryActor,
  orderId: string,
  scans: { code: string; quantity?: string }[],
) {
  expect(await startPacking(actor, orderId)).toMatchObject({ ok: true });
  for (const scan of scans) {
    const result = await packScan(actor, orderId, scan);
    if (!result.ok) throw new Error(JSON.stringify(result));
  }
  const finished = await finishPacking(actor, orderId);
  if (!finished.ok) throw new Error(JSON.stringify(finished));
}

const skuOf = async (productId: string) =>
  (await db.product.findUniqueOrThrow({ where: { id: productId } })).sku;

const staging = (organizationId: string) =>
  db.location.findFirstOrThrow({ where: { organizationId, isStaging: true } });

const balanceOf = async (productId: string, locationId?: string) =>
  (
    await db.stockBalance.aggregate({
      where: { productId, ...(locationId ? { locationId } : {}) },
      _sum: { quantity: true },
    })
  )._sum.quantity?.toString() ?? "0";

const heldOf = async (productId: string) =>
  (
    await db.stockReservation.aggregate({
      where: { productId, state: "ACTIVE" },
      _sum: { remaining: true },
    })
  )._sum.remaining?.toString() ?? "0";

const shipmentsOf = (organizationId: string) =>
  db.stockMovement.findMany({
    where: { organizationId, type: "SHIPMENT" },
    include: { lines: true },
  });

async function ship(actor: InventoryActor, orderIds: string[], extra = {}) {
  const made = await createShipment(actor, { orderIds, ...extra });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.shipmentId;
}

const decoder = new TextDecoder("windows-1252");

/** The texts drawn on each page of a PDF, as a person would read them. */
function pagesOf(file: Buffer): string[] {
  const raw = file.toString("latin1");
  return [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((stream) =>
    [...stream[1]!.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((text) =>
        decoder.decode(Buffer.from(text[1]!.replace(/\\(.)/g, "$1"), "latin1")),
      )
      .join("\n"),
  );
}

/** Every object of the file is where its table says it is. */
function expectWellFormed(file: Buffer) {
  const text = file.toString("latin1");
  expect(text.startsWith("%PDF-1.4\n")).toBe(true);
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  const table = text.slice(start).split("\n");
  const size = Number(table[1]!.split(" ")[1]);
  for (let id = 1; id < size; id++) {
    const offset = Number(table[2 + id]!.slice(0, 10));
    expect(text.slice(offset, offset + 12), `object ${id}`).toMatch(
      new RegExp(`^${id} 0 obj\n`),
    );
  }
}

afterAll(() => db.$disconnect());

describe("a packed order leaves once (PC-3)", () => {
  it("confirming twice at once writes one exit; packages are emptied and kept in their history", async () => {
    const owner = await company({ packing: true });
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "4" }]);
    await pickAll(owner, orderId);
    await packAll(owner, orderId, [
      { code: await skuOf(item), quantity: "3" },
      { code: await skuOf(item), quantity: "1" },
    ]);
    const place = await staging(owner.organizationId);
    const [box] = await db.container.findMany({
      where: { outboundOrderId: orderId },
    });
    expect(await countOrdersToShip(owner)).toBe(1);

    const shipmentId = await ship(owner, [orderId], {
      carrier: "Transportes del Norte",
      trackingNumber: "GU-123",
      vehiclePlate: "abc-12-34",
      driverName: "Raúl Pérez",
    });
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      numberText: "EM-0001",
      status: "DRAFT",
      ready: true,
      vehiclePlate: "ABC-12-34",
      packageCount: 1,
      orders: [
        {
          problem: null,
          lines: [{ quantityText: "4 piezas", packageCode: box!.code }],
        },
      ],
    });

    const [one, two] = await Promise.all([
      dispatchShipment(owner, shipmentId),
      dispatchShipment(owner, shipmentId),
    ]);
    expect([one, two].filter((r) => r.ok && !r.repeated)).toHaveLength(1);
    expect([one, two].filter((r) => r.ok && r.repeated)).toHaveLength(1);
    // And once more, later: nothing new.
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
      repeated: true,
    });

    const exits = await shipmentsOf(owner.organizationId);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      reference: "EM-0001",
      idempotencyKey: `ship:${shipmentId}`,
    });
    expect(exits[0]!.lines.map((l) => l.baseQuantity.toString())).toEqual([
      "4",
    ]);
    // Stock went down once: 10 − 4; nothing left in staging nor held.
    expect(await balanceOf(item)).toBe("6");
    expect(await balanceOf(item, place.id)).toBe("0");
    expect(await heldOf(item)).toBe("0");
    // The package: emptied, closed, and what it took is in its history.
    const after = await db.container.findUniqueOrThrow({
      where: { id: box!.id },
      include: { items: true },
    });
    expect(after.status).toBe("CLOSED");
    expect(after.items).toHaveLength(0);
    const events = await listContainerEvents(owner, box!.id);
    expect(events?.items[0]).toMatchObject({
      kind: "SHIPPED",
      text: expect.stringContaining("4 piezas"),
      movementId: exits[0]!.id,
    });
    // The order and the shipment left.
    expect(await getOutboundOrder(owner, orderId)).toMatchObject({
      status: "SHIPPED",
      shipment: { numberText: "EM-0001", status: "SHIPPED" },
      lineItems: [{ shippedText: "4 piezas" }],
      readyToShip: false,
    });
    const view = await getShipment(owner, shipmentId);
    expect(view).toMatchObject({
      status: "SHIPPED",
      movementId: exits[0]!.id,
      packageCount: 1,
      orders: [
        {
          status: "SHIPPED",
          lines: [{ quantityText: "4 piezas", packageCode: box!.code }],
          packages: [{ code: box!.code }],
        },
      ],
    });
    expect(await countOrdersToShip(owner)).toBe(0);
    const trail = await listAuditTrail(owner.organizationId, { limit: 20 });
    expect(trail.map((entry) => entry.action)).toContain(
      "inventory.shipment_dispatched",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a dispatch is not reversed from Inventario, and a shipped shipment never changes", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "5");
    const orderId = await released(owner, [{ productId: item, quantity: "2" }]);
    await pickAll(owner, orderId);
    const shipmentId = await ship(owner, [orderId]);
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    const [exit] = await shipmentsOf(owner.organizationId);
    expect(
      await reverseMovement(owner, {
        movementId: exit!.id,
        reason: "Se despachó por error",
      }),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
      error: expect.stringContaining("no se reversa"),
    });
    for (const result of [
      await cancelShipment(owner, shipmentId, "Ya no sale"),
      await updateShipment(owner, shipmentId, { carrier: "Otro" }),
      await removeShipmentOrder(owner, shipmentId, orderId),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "not_allowed" });
    }
    // The base says the same.
    await expect(
      db.shipment.update({
        where: { id: shipmentId },
        data: { carrier: "Otro" },
      }),
    ).rejects.toThrow();
    await expect(
      db.shipmentLine.updateMany({
        where: { shipmentId },
        data: { serials: "X" },
      }),
    ).rejects.toThrow();
    await expect(
      db.shipmentOrder.deleteMany({ where: { shipmentId } }),
    ).rejects.toThrow();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("what may leave", () => {
  it("with packing on, only packed orders; with it off, straight from picking", async () => {
    const owner = await company({ packing: true });
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "3" }]);
    await pickAll(owner, orderId);
    // «No se despacha sin empacar».
    expect(await createShipment(owner, { orderIds: [orderId] })).toMatchObject({
      ok: false,
      fieldErrors: { orders: expect.stringContaining("falta empacarlo") },
    });
    expect((await listReadyOrders(owner)).total).toBe(0);
    // Off: it may go. Put in a shipment, then packing comes back on.
    await setting(owner, PACKING_MODE.key, "off");
    expect((await listReadyOrders(owner)).items).toMatchObject([
      { id: orderId, statusLabel: "Surtido" },
    ]);
    expect(
      (await listOutboundOrders(owner, { status: "por-despachar" })).total,
    ).toBe(1);
    const shipmentId = await ship(owner, [orderId]);
    await setting(owner, PACKING_MODE.key, "on");
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      ready: false,
      orders: [{ problem: expect.stringContaining("falta empacarlo") }],
    });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("falta empacarlo"),
    });
    expect(await shipmentsOf(owner.organizationId)).toHaveLength(0);
    expect(await balanceOf(item)).toBe("10");
    // Off again: it leaves from PICKED, from the staging place.
    await setting(owner, PACKING_MODE.key, "off");
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    expect(
      (await db.outboundOrder.findUniqueOrThrow({ where: { id: orderId } }))
        .status,
    ).toBe("SHIPPED");
    expect(await balanceOf(item)).toBe("7");
    expect(await heldOf(item)).toBe("0");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("an order being packed, still picking, or of another warehouse does not leave", async () => {
    const owner = await company({ packing: true });
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const picking = await released(owner, [{ productId: item, quantity: "1" }]);
    expect(await createShipment(owner, { orderIds: [picking] })).toMatchObject({
      ok: false,
      fieldErrors: {
        orders: expect.stringContaining("no termina de surtirse"),
      },
    });
    await pickAll(owner, picking);
    await startPacking(owner, picking);
    expect(await createShipment(owner, { orderIds: [picking] })).toMatchObject({
      ok: false,
      fieldErrors: { orders: expect.stringContaining("se está empacando") },
    });
    expect(await createShipment(owner, { orderIds: [newId()] })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await createShipment(owner, { orderIds: [] })).toMatchObject({
      ok: false,
      fieldErrors: { orders: "Elige al menos un pedido." },
    });
    // The base: an order ships only within a shipment.
    await finishPacking(owner, picking);
    await expect(
      db.outboundOrder.update({
        where: { id: picking },
        data: { status: "SHIPPED" },
      }),
    ).rejects.toThrow();
  });

  it("the company may ask for the carrier and who takes it", async () => {
    const owner = await company();
    await setting(owner, SHIPMENT_DETAILS.key, "required");
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "5");
    const orderId = await released(owner, [{ productId: item, quantity: "1" }]);
    await pickAll(owner, orderId);
    const shipmentId = await ship(owner, [orderId]);
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      detailsRequired: true,
    });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("transportista"),
    });
    expect(
      await updateShipment(owner, shipmentId, {
        carrier: "Paquetería Express",
        driverName: "Luis",
      }),
    ).toMatchObject({ ok: true });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
  });
});

describe("exactly what is set aside", () => {
  it("a shortage when packing: only what was packed leaves; the rest stays loose", async () => {
    const owner = await company({ packing: true });
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "5" }]);
    await pickAll(owner, orderId);
    expect(await startPacking(owner, orderId)).toMatchObject({ ok: true });
    await packScan(owner, orderId, {
      code: await skuOf(item),
      quantity: "3",
    });
    const line = await db.outboundOrderLine.findFirstOrThrow({
      where: { orderId },
    });
    expect(
      await reportPackShortage(owner, orderId, {
        lineId: line.id,
        reason: "Dos piezas rotas",
      }),
    ).toMatchObject({ ok: true });
    expect(await finishPacking(owner, orderId)).toMatchObject({ ok: true });
    const place = await staging(owner.organizationId);
    const shipmentId = await ship(owner, [orderId]);
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    const [exit] = await shipmentsOf(owner.organizationId);
    expect(exit!.lines.map((l) => l.baseQuantity.toString())).toEqual(["3"]);
    // The two missing ones stay loose in staging, free for an adjustment.
    expect(await balanceOf(item, place.id)).toBe("2");
    expect(await balanceOf(item)).toBe("7");
    expect(await heldOf(item)).toBe("0");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("several orders in one shipment: one exit, each line with its order", async () => {
    const owner = await company();
    const a = await product(owner);
    const b = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, a, shelf, "20");
    await enter(owner, b, shelf, "20");
    const first = await released(owner, [
      { productId: a, quantity: "2" },
      { productId: b, quantity: "3" },
    ]);
    const second = await released(
      owner,
      [{ productId: a, quantity: "5" }],
      "Sucursal Norte",
    );
    await pickAll(owner, first);
    await pickAll(owner, second);
    const shipmentId = await ship(owner, [second, first]);
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
      summary: expect.stringContaining("2 pedidos"),
    });
    const exits = await shipmentsOf(owner.organizationId);
    expect(exits).toHaveLength(1);
    const lines = await db.shipmentLine.findMany({ where: { shipmentId } });
    const total = (orderId: string, productId: string) =>
      lines
        .filter((l) => l.orderId === orderId && l.productId === productId)
        .reduce((sum, l) => sum + Number(l.quantity), 0);
    expect(total(first, a)).toBe(2);
    expect(total(first, b)).toBe(3);
    expect(total(second, a)).toBe(5);
    expect(await balanceOf(a)).toBe("13");
    expect(await balanceOf(b)).toBe("17");
    expect(
      (
        await db.outboundOrder.findMany({
          where: { id: { in: [first, second] } },
        })
      ).map((order) => order.status),
    ).toEqual(["SHIPPED", "SHIPPED"]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("one open shipment per order", () => {
  it("an order is in one open shipment; removing it or cancelling lets it go", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const one = await released(owner, [{ productId: item, quantity: "1" }]);
    const two = await released(owner, [{ productId: item, quantity: "1" }]);
    await pickAll(owner, one);
    await pickAll(owner, two);
    const first = await ship(owner, [one]);
    expect(await createShipment(owner, { orderIds: [one] })).toMatchObject({
      ok: false,
      fieldErrors: {
        orders: expect.stringContaining("ya está en el embarque EM-0001"),
      },
    });
    // Not even at the same time: two shipments for the same order.
    const [x, y] = await Promise.all([
      createShipment(owner, { orderIds: [two] }),
      createShipment(owner, { orderIds: [two] }),
    ]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    const second = (x.ok ? x : y) as { shipmentId: string };
    expect((await listReadyOrders(owner)).total).toBe(0);
    // WMS-87: the number of «Embarques» agrees with that list; Inicio still
    // counts what has not left.
    expect(await countOrdersToArm(owner)).toBe(0);
    expect(await countOrdersToShip(owner)).toBe(2);
    expect(
      await removeShipmentOrder(owner, second.shipmentId, two),
    ).toMatchObject({ ok: true });
    expect(await addShipmentOrders(owner, first, [two])).toMatchObject({
      ok: true,
    });
    expect(await getShipment(owner, first)).toMatchObject({
      orders: [{ id: one }, { id: two }],
    });
    // Cancelling lets both go; they may join another.
    expect(await cancelShipment(owner, first, "x")).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.any(String) },
    });
    expect(
      await cancelShipment(owner, first, "El cliente lo recoge mañana"),
    ).toMatchObject({ ok: true });
    expect(
      await cancelShipment(owner, first, "El cliente lo recoge mañana"),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await dispatchShipment(owner, first)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect((await listReadyOrders(owner)).total).toBe(2);
    expect(await countOrdersToArm(owner)).toBe(2);
    await ship(owner, [one, two]);
    expect(await getShipment(owner, first)).toMatchObject({
      status: "CANCELLED",
      orders: [{ id: one }, { id: two }],
    });
    expect((await listShipments(owner)).items.map((s) => s.numberText)).toEqual(
      ["EM-0003", "EM-0002", "EM-0001"],
    );
    expect(
      (await listShipments(owner, { status: "CANCELLED" })).items,
    ).toHaveLength(1);
  });
});

describe("lots and serials", () => {
  it("lots and units leave with the shipment; units are out; the trace reaches the shipment", async () => {
    const owner = await company({ packing: true });
    const byLot = await product(owner, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    const bySerial = await product(owner, { tracking: "SERIAL" });
    const shelf = await rack(owner, "Rack A");
    await enter(owner, byLot, shelf, "6", {
      lotCode: "LT-9",
      lotExpiresOn: "2099-01-31",
    });
    await enter(owner, bySerial, shelf, "3", { serials: "SH-1\nSH-2\nSH-3" });
    const orderId = await released(owner, [
      { productId: byLot, quantity: "4" },
      { productId: bySerial, quantity: "2" },
    ]);
    await pickAll(owner, orderId, (productId) =>
      productId === bySerial ? "SH-1\nSH-3" : undefined,
    );
    await packAll(owner, orderId, [
      { code: await skuOf(byLot), quantity: "4" },
      { code: "SH-1" },
      { code: "SH-3" },
    ]);
    const shipmentId = await ship(owner, [orderId], {
      carrier: "Fletes García",
      trackingNumber: "FG-555",
    });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    const units = await db.serialUnit.findMany({
      where: { organizationId: owner.organizationId, productId: bySerial },
      orderBy: { serial: "asc" },
    });
    // The two that left are out of the warehouse; the third stays.
    expect(units.map((u) => [u.serial, u.locationId !== null])).toEqual([
      ["SH-1", false],
      ["SH-2", true],
      ["SH-3", false],
    ]);
    expect(units.every((u) => u.containerId === null)).toBe(true);
    const lines = await db.shipmentLine.findMany({ where: { shipmentId } });
    const lot = await db.lot.findFirstOrThrow({
      where: { organizationId: owner.organizationId, code: "LT-9" },
    });
    expect(lines.find((l) => l.productId === byLot)).toMatchObject({
      lotId: lot.id,
    });
    expect(lines.find((l) => l.productId === bySerial)?.serials).toBe(
      "SH-1, SH-3",
    );
    // Traceability: the lot and the serial reach the shipment.
    expect((await traceLot(owner, lot.id))?.shipments).toMatchObject([
      {
        numberText: "EM-0001",
        recipient: "Sucursal Sur",
        carrier: "Fletes García",
        trackingNumber: "FG-555",
        quantityText: "4 piezas",
      },
    ]);
    expect((await traceSerial(owner, units[0]!.id))?.shipments).toMatchObject([
      { numberText: "EM-0001", trackingNumber: "FG-555" },
    ]);
    expect((await traceSerial(owner, units[1]!.id))?.shipments).toEqual([]);
    expect((await findTraceMatches(owner, "em-1")).matches).toMatchObject([
      { kind: "shipment", id: shipmentId, numberText: "EM-0001" },
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("without packing, picked units by serial leave from the staging place", async () => {
    const owner = await company();
    const bySerial = await product(owner, { tracking: "SERIAL" });
    const shelf = await rack(owner, "Rack A");
    await enter(owner, bySerial, shelf, "2", { serials: "Q-1\nQ-2" });
    const orderId = await released(owner, [
      { productId: bySerial, quantity: "1" },
    ]);
    await pickAll(owner, orderId, () => "Q-2");
    const shipmentId = await ship(owner, [orderId]);
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      orders: [{ lines: [{ serials: ["Q-2"], packageCode: null }] }],
    });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    const left = await db.serialUnit.findFirstOrThrow({
      where: { organizationId: owner.organizationId, serial: "Q-2" },
    });
    expect(left.locationId).toBeNull();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("the PDF", () => {
  it("carries the transport, each order with what goes, the packages and the signatures", async () => {
    const owner = await company({ packing: true });
    const item = await product(owner, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "8", { lotCode: "PDF-1" });
    const orderId = await released(owner, [{ productId: item, quantity: "5" }]);
    await pickAll(owner, orderId);
    await packAll(owner, orderId, [{ code: await skuOf(item), quantity: "5" }]);
    const shipmentId = await ship(owner, [orderId], {
      carrier: "Transportes del Bajío",
      trackingNumber: "TB-0099",
      vehiclePlate: "XYZ-123",
      driverName: "Marta Ruiz",
      note: "Entregar en andén 2.",
    });
    // A draft says so.
    const draft = await buildShipmentPdf(owner, shipmentId);
    expect(pagesOf(draft!.bytes).join("\n")).toContain(
      "BORRADOR · todavía no sale",
    );
    await dispatchShipment(owner, shipmentId);
    const pdf = await buildShipmentPdf(owner, shipmentId);
    expect(pdf).toMatchObject({
      name: "EM-0001.pdf",
      contentType: "application/pdf",
    });
    expectWellFormed(pdf!.bytes);
    const text = pagesOf(pdf!.bytes).join("\n");
    const sku = await skuOf(item);
    const box = await db.container.findFirstOrThrow({
      where: { outboundOrderId: orderId },
    });
    for (const expected of [
      "HOJA DE EMBARQUE",
      "EM-0001",
      "Transportes del Bajío",
      "TB-0099",
      "XYZ-123",
      "Marta Ruiz",
      "PS-0001 · Sucursal Sur",
      "Av. Juárez 100, Centro",
      "Su referencia: OC-CLIENTE-77",
      `(${sku})`,
      "5 piezas",
      "Lote PDF-1",
      box.code,
      "Entregar en andén 2.",
      "Entrega",
      "Recibe",
      "Página 1 de 1",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("BORRADOR");
    expect(text).not.toMatch(/\$|precio|costo/i);
    const trail = await listAuditTrail(owner.organizationId, { limit: 20 });
    expect(trail.map((entry) => entry.action)).toContain(
      "inventory.shipment_exported",
    );
  });
});

describe("who may", () => {
  it("the floor ships; Gerencia and Consulta read and download; Montacargas does nothing", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "5");
    const orderId = await released(owner, [{ productId: item, quantity: "1" }]);
    await pickAll(owner, orderId);
    const operator = await member(owner.organizationId, "operator");
    const manager = await member(owner.organizationId, "manager");
    const viewer = await member(owner.organizationId, "viewer");
    const forklift = await member(owner.organizationId, "forklift");
    for (const reader of [manager, viewer]) {
      await expect(
        createShipment(reader, { orderIds: [orderId] }),
      ).rejects.toThrow();
    }
    await expect(listShipments(forklift)).rejects.toThrow();
    const shipmentId = await ship(operator, [orderId]);
    for (const reader of [manager, viewer]) {
      await expect(dispatchShipment(reader, shipmentId)).rejects.toThrow();
      expect(await getShipment(reader, shipmentId)).toMatchObject({
        status: "DRAFT",
      });
      expect(await buildShipmentPdf(reader, shipmentId)).not.toBeNull();
    }
    expect(await dispatchShipment(operator, shipmentId)).toMatchObject({
      ok: true,
    });
  });

  it("another company's shipment does not exist", async () => {
    const owner = await company();
    const other = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "5");
    const orderId = await released(owner, [{ productId: item, quantity: "1" }]);
    await pickAll(owner, orderId);
    const shipmentId = await ship(owner, [orderId]);
    expect(await getShipment(other, shipmentId)).toBeNull();
    expect(await buildShipmentPdf(other, shipmentId)).toBeNull();
    for (const result of [
      await dispatchShipment(other, shipmentId),
      await cancelShipment(other, shipmentId, "No es mío"),
      await addShipmentOrders(other, shipmentId, [orderId]),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(await createShipment(other, { orderIds: [orderId] })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect((await listShipments(other)).total).toBe(0);
    expect(await balanceOf(item)).toBe("5");
  });
});

describe("summary of the day", () => {
  it("counts the orders shipped today with the same condition as their list", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "5");
    const orderId = await released(owner, [{ productId: item, quantity: "1" }]);
    await pickAll(owner, orderId);
    expect((await getDaySummary(owner)).ordersShipped).toEqual({
      documents: 0,
      lines: 0,
    });
    const shipmentId = await ship(owner, [orderId]);
    await dispatchShipment(owner, shipmentId);
    const summary = await getDaySummary(owner);
    expect(summary.ordersShipped).toEqual({ documents: 1, lines: 1 });
    expect(
      await listOutboundOrders(owner, { shippedOn: summary.day }),
    ).toMatchObject({ total: 1, shippedOn: summary.day, status: null });
    expect(
      (await listOutboundOrders(owner, { shippedOn: "2000-01-01" })).total,
    ).toBe(0);
  });
});
