import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  PUTAWAY_MODE,
  acceptTask,
  applyCount,
  assignTask,
  buildExport,
  cancelCount,
  cancelTask,
  captureCount,
  changeStockStatus,
  createOutboundOrder,
  createTask,
  countLowStock,
  deliverTask,
  findTraceMatches,
  listProductSerials,
  traceSerial,
  getCount,
  countExpiringLots,
  getInventoryValue,
  getLot,
  getOutboundOrder,
  getPackingView,
  finishPacking,
  addShipmentOrders,
  buildShipmentPdf,
  buildLabels,
  cancelShipment,
  createShipment,
  dispatchShipment,
  getShipment,
  listShipments,
  packScan,
  startPacking,
  getProductStock,
  getStockByLocation,
  getStockTotals,
  getTask,
  listCounts,
  listExpiringLots,
  listLotStock,
  listProductLots,
  listLowStock,
  listMovements,
  listOutboundOrders,
  listRecentMovements,
  listStockLocations,
  listTasks,
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
  setMinimum,
  setOutboundLine,
  type InventoryActor,
  CONTAINERS_MODE,
  closeContainer,
  getContainer,
  listContainers,
  moveContainer,
  packStock,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  generateSuggestedOrders,
  getPurchaseSuggestions,
  receivePurchaseOrder,
  returnToSupplier,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { readSpreadsheet } from "@/platform/files";
import {
  createFacility,
  createLocation,
  getActiveFacility,
  getDefaultLocation,
  listFacilities,
  listLocations,
  switchFacility,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-20, critical test PC-12: someone limited to warehouse B neither sees
// nor moves anything of warehouse A, whatever id of A reaches a service.
// The limited person is an administrator, so every refusal here comes from
// the scope and not from a missing permission.

const stamp = Date.now();
let counter = 0;

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `alcance.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
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

const key = () => `alcance-${newId()}`;
const OUTSIDE = { code: "location_out_of_scope" };

let owner: InventoryActor;
/** Administrator limited to warehouse B. */
let limited: InventoryActor;
/** Administrator without any limit. */
let free: InventoryActor;
let facilityA = "";
let facilityB = "";
let generalA = "";
let shelfA = "";
let generalB = "";
let shelfB = "";
let productId = "";
let entryInA = "";

async function stockAt(locationId: string) {
  const rows = await db.stockBalance.findMany({
    where: { productId, locationId },
  });
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function shelf(name: string) {
  const made = await createLocation(owner, { level: 3, name });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

async function enter(locationId: string, quantity: string) {
  const result = await registerEntry(owner, {
    // Identical entries on purpose (WMS-71).
    acceptRepeat: true,
    productId,
    locationId,
    quantity,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.movementId;
}

beforeAll(async () => {
  const ownerId = await newUser();
  const created = await createOrganization(ownerId, {
    name: `Empresa alcance ${stamp}`,
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
      reason: "Prueba de alcance",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  owner = { organizationId: created.organizationId, userId: ownerId };

  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;

  generalA = (await getDefaultLocation(owner))!.id;
  shelfA = await shelf("Estante A1");
  await switchFacility(owner, facilityB);
  generalB = (await getDefaultLocation(owner))!.id;
  shelfB = await shelf("Estante B1");
  await switchFacility(owner, facilityA);

  const product = await createProduct(owner, {
    sku: "ALC-1",
    name: "Tornillo",
  });
  if (!product.ok) throw new Error("product setup failed");
  productId = product.productId;
  entryInA = await enter(generalA, "10");
  await enter(shelfA, "5");
  await enter(generalB, "7");
  await enter(shelfB, "3");

  limited = await member(owner.organizationId, "administrator");
  free = await member(owner.organizationId, "administrator");
  const scoped = await setMemberScope(owner.organizationId, owner.userId, {
    userId: limited.userId,
    facilities: [{ facilityId: facilityB }],
  });
  if (!scoped.ok) throw new Error(JSON.stringify(scoped));
}, 60_000);

afterAll(() => db.$disconnect());

describe("PC-12: units by serial and their traceability (WMS-21B)", () => {
  it("a unit of A is neither moved, listed nor traced from B", async () => {
    const product = await createProduct(owner, {
      sku: "ALC-SER",
      name: "Equipo con serie",
      tracking: "SERIAL",
    });
    if (!product.ok) throw new Error("product setup failed");
    const entered = await registerEntry(owner, {
      productId: product.productId,
      locationId: shelfA,
      quantity: "1",
      serials: "ALC-SN-1",
    });
    expect(entered).toMatchObject({ ok: true });
    await expect(
      registerExit(limited, {
        productId: product.productId,
        locationId: shelfA,
        quantity: "1",
        serials: "ALC-SN-1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { productId: product.productId },
    });
    expect((await findTraceMatches(limited, "ALC-SN-1")).matches).toEqual([]);
    expect(await traceSerial(limited, unit.id)).toBeNull();
    expect(
      (await listProductSerials(limited, product.productId)).items,
    ).toEqual([]);
    expect((await findTraceMatches(free, "ALC-SN-1")).matches).toHaveLength(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: limited to warehouse B", () => {
  it("works in B and cannot switch to A", async () => {
    // The main warehouse is A and it is closed: the person lands in B.
    expect((await getActiveFacility(limited)).id).toBe(facilityB);
    expect(await switchFacility(limited, facilityA)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect((await getActiveFacility(limited)).id).toBe(facilityB);
    expect((await listFacilities(limited)).map((each) => each.id)).toEqual([
      facilityB,
    ]);
    // Even with A stored as the active one (it was before the limit).
    await db.membership.updateMany({
      where: { userId: limited.userId },
      data: { activeFacilityId: facilityA },
    });
    expect((await getActiveFacility(limited)).id).toBe(facilityB);
    expect(await switchFacility(limited, facilityB)).toMatchObject({
      ok: true,
    });
  });

  it("lists and selectors offer nothing of A", async () => {
    const offered = (await listStockLocations(limited)).map((each) => each.id);
    expect(offered.sort()).toEqual([generalB, shelfB].sort());
    const tree = await listLocations(limited);
    expect(tree?.facility.id).toBe(facilityB);
    expect(tree?.locations.map((each) => each.id).sort()).toEqual(
      [generalB, shelfB].sort(),
    );
    await expect(
      listLocations(limited, { facilityId: facilityA }),
    ).rejects.toMatchObject({ code: "facility_out_of_scope" });
    expect((await getDefaultLocation(limited))?.id).toBe(generalB);
  });

  it("sees only the stock, the movements and the exports of B", async () => {
    expect(Object.keys(await getStockByLocation(limited, productId))).toEqual(
      expect.arrayContaining([generalB, shelfB]),
    );
    expect(
      Object.keys(await getStockByLocation(limited, productId)),
    ).toHaveLength(2);
    const stock = await getProductStock(limited, productId);
    expect(stock?.total).toBe("10");
    expect(stock?.locations.map((each) => each.id).sort()).toEqual(
      [generalB, shelfB].sort(),
    );
    expect(await getStockTotals(limited, [productId])).toEqual({
      [productId]: "10",
    });
    // The owner still sees everything.
    expect((await getProductStock(owner, productId))?.total).toBe("25");

    const history = await listMovements(limited);
    expect(history.total).toBe(2);
    expect(
      history.items.flatMap((item) => item.lines.map((line) => line.location)),
    ).toEqual(expect.arrayContaining(["General", "Estante B1"]));
    expect(JSON.stringify(history.items)).not.toContain("Estante A1");
    // Not even asking for a movement of A by its id.
    expect(
      await listRecentMovements(limited, { movementId: entryInA }),
    ).toEqual([]);
    expect(
      await listRecentMovements(owner, { movementId: entryInA }),
    ).toHaveLength(1);

    for (const kind of ["existencias", "movimientos"] as const) {
      const file = await buildExport(limited, { kind, format: "csv" });
      if (!file.ok) throw new Error(file.error);
      expect(file.rows).toBe(2);
      const read = readSpreadsheet(file.name, file.bytes);
      if (!read.ok) throw new Error(read.error);
      expect(JSON.stringify(read.rows)).toContain("Estante B1");
      expect(JSON.stringify(read.rows)).not.toContain("Estante A1");
    }
  });

  it("no movement service accepts a location of A", async () => {
    const before = [await stockAt(generalA), await stockAt(shelfA)];

    await expect(
      registerEntry(limited, {
        // Identical entries on purpose (WMS-71).
        acceptRepeat: true,
        productId,
        locationId: generalA,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      registerExit(limited, { productId, locationId: shelfA, quantity: "1" }),
    ).rejects.toMatchObject(OUTSIDE);
    const fresh = await createProduct(owner, { sku: "ALC-2", name: "Clavo" });
    if (!fresh.ok) throw new Error("product setup failed");
    await expect(
      registerInitialBalance(limited, {
        productId: fresh.productId,
        locationId: generalA,
        quantity: "4",
        reason: "Arranque",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      registerQuickExit(limited, {
        lines: [
          { productId, locationId: generalB, quantity: "1" },
          { productId, locationId: shelfA, quantity: "1" },
        ],
        reason: "Consumo",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    // Relocation: neither from A, nor into A.
    await expect(
      registerTransfer(limited, {
        productId,
        locationId: generalA,
        toLocationId: shelfA,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      registerTransfer(limited, {
        productId,
        locationId: generalB,
        toLocationId: shelfA,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      registerAdjustment(limited, {
        productId,
        locationId: generalA,
        quantity: "1",
        reason: "Conteo de control",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      changeStockStatus(limited, {
        productId,
        locationId: generalA,
        from: "AVAILABLE",
        to: "QUARANTINE",
        quantity: "1",
        reason: "Caja mojada",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      reverseMovement(limited, {
        movementId: entryInA,
        reason: "Se capturó dos veces",
      }),
    ).rejects.toMatchObject(OUTSIDE);

    expect([await stockAt(generalA), await stockAt(shelfA)]).toEqual(before);
    // Without a location it is General of B, never the one of A.
    const entry = await registerEntry(limited, {
      // Identical entries on purpose (WMS-71).
      acceptRepeat: true,
      productId,
      quantity: "2",
    });
    expect(entry).toMatchObject({ ok: true });
    expect(await stockAt(generalB)).toBe(9);
    const exit = await registerQuickExit(limited, {
      lines: [{ productId, quantity: "2" }],
      reason: "Consumo",
    });
    expect(exit).toMatchObject({ ok: true });
    expect(await stockAt(generalB)).toBe(7);
    expect([await stockAt(generalA), await stockAt(shelfA)]).toEqual(before);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("counts of A do not exist for them", async () => {
    await expect(
      openCount(limited, { locationId: shelfA }),
    ).rejects.toMatchObject(OUTSIDE);
    const opened = await openCount(owner, { locationId: shelfA });
    if (!opened.ok) throw new Error("count setup failed");
    const captured = await captureCount(owner, {
      countId: opened.countId,
      productId,
      quantity: "4",
    });
    if (!captured.ok) throw new Error("capture setup failed");

    expect(await getCount(limited, opened.countId)).toBeNull();
    expect((await listCounts(limited)).map((each) => each.id)).not.toContain(
      opened.countId,
    );
    expect(
      await captureCount(limited, {
        countId: opened.countId,
        productId,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await applyCount(limited, {
        countId: opened.countId,
        reason: "Diferencia de conteo",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await cancelCount(limited, opened.countId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await stockAt(shelfA)).toBe(5);
    // The owner still has it, untouched.
    expect(await getCount(owner, opened.countId)).toMatchObject({
      status: "OPEN",
    });
    expect(await cancelCount(owner, opened.countId)).toMatchObject({
      ok: true,
    });

    // In B everything works.
    const mine = await openCount(limited, { locationId: shelfB });
    expect(mine).toMatchObject({ ok: true });
    if (mine.ok) await cancelCount(limited, mine.countId);
  });

  it("tasks of A are neither created, seen, taken nor given to them", async () => {
    await expect(
      createTask(limited, {
        productId,
        fromLocationId: generalA,
        toLocationId: shelfA,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    const task = await createTask(owner, {
      productId,
      fromLocationId: generalA,
      toLocationId: shelfA,
      quantity: "1",
    });
    if (!task.ok) throw new Error(JSON.stringify(task));

    expect(await getTask(limited, task.taskId)).toBeNull();
    for (const view of ["mine", "available", "open", "closed"]) {
      expect((await listTasks(limited, { view })).items).toEqual([]);
    }
    expect(await acceptTask(limited, task.taskId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await cancelTask(limited, task.taskId, "No hace falta"),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // Nobody hands them a task they cannot reach.
    expect(await assignTask(owner, task.taskId, limited.userId)).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: { assignToUserId: expect.stringMatching(/no trabaja/) },
    });
    expect(
      await createTask(owner, {
        productId,
        fromLocationId: generalA,
        toLocationId: shelfA,
        quantity: "1",
        assignToUserId: limited.userId,
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    // Even a task already theirs (given before the limit) stays closed.
    await db.warehouseTask.update({
      where: { id: task.taskId },
      data: { status: "ASSIGNED", assignedToUserId: limited.userId },
    });
    expect(await acceptTask(limited, task.taskId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect((await listTasks(limited, { view: "mine" })).items).toEqual([]);
    expect(await stockAt(generalA)).toBe(10);

    // In B a task is created and seen as usual.
    const own = await createTask(limited, {
      productId,
      fromLocationId: generalB,
      toLocationId: shelfB,
      quantity: "1",
    });
    expect(own).toMatchObject({ ok: true });
    expect((await listTasks(limited, { view: "available" })).total).toBe(1);
  });

  it("orders of A do not exist for them", async () => {
    const order = await createOutboundOrder(owner, { recipient: "Cliente" });
    if (!order.ok) throw new Error(JSON.stringify(order));
    const line = await setOutboundLine(owner, order.orderId, {
      productId,
      quantity: "1",
    });
    if (!line.ok) throw new Error(JSON.stringify(line));

    expect(await getOutboundOrder(limited, order.orderId)).toBeNull();
    expect((await listOutboundOrders(limited)).items).toEqual([]);
    expect(await releaseOutboundOrder(limited, order.orderId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await setOutboundLine(limited, order.orderId, {
        productId,
        quantity: "2",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // Nor packing it (WMS-15).
    for (const result of [
      await startPacking(limited, order.orderId),
      await packScan(limited, order.orderId, { code: "ALC-1" }),
      await finishPacking(limited, order.orderId),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(await getPackingView(limited, order.orderId)).toBeNull();
    expect(await getOutboundOrder(owner, order.orderId)).toMatchObject({
      status: "DRAFT",
    });
    // Nor its shipments (WMS-16): a shipment of A does not exist for them.
    const shipmentId = newId();
    await db.shipment.create({
      data: {
        id: shipmentId,
        organizationId: owner.organizationId,
        number: 901,
        facilityId: facilityA,
        createdByUserId: owner.userId,
      },
    });
    expect(await getShipment(limited, shipmentId)).toBeNull();
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      numberText: "EM-0901",
    });
    expect(await buildShipmentPdf(limited, shipmentId)).toBeNull();
    // Nor their labels (WMS-26).
    for (const request of [
      { kind: "pedido", id: order.orderId },
      { kind: "bultos", order: order.orderId },
      { kind: "embarque", id: shipmentId },
    ] as const) {
      expect(await buildLabels(limited, request)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
    expect((await listShipments(limited)).items).toEqual([]);
    expect((await findTraceMatches(limited, "EM-0901")).matches).toEqual([]);
    for (const result of [
      await dispatchShipment(limited, shipmentId),
      await cancelShipment(limited, shipmentId, "No es de mi almacén"),
      await addShipmentOrders(limited, shipmentId, [order.orderId]),
      await createShipment(limited, { orderIds: [order.orderId] }),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    // Their own order is of B.
    const own = await createOutboundOrder(limited, { recipient: "Cliente" });
    if (!own.ok) throw new Error(JSON.stringify(own));
    expect(
      (
        await db.outboundOrder.findUniqueOrThrow({
          where: { id: own.orderId },
        })
      ).facilityId,
    ).toBe(facilityB);
  });

  it("receives and returns purchases only in B", async () => {
    const supplier = await createSupplier(owner, { name: "Proveedor" });
    if (!supplier.ok) throw new Error("supplier setup failed");
    const order = await createPurchaseOrder(owner, {
      supplierId: supplier.supplierId,
    });
    if (!order.ok) throw new Error("order setup failed");
    const added = await addOrderLine(owner, order.orderId, {
      productId,
      capture: "base",
      quantity: "6",
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
    const sent = await submitPurchaseOrder(owner, order.orderId);
    if (!sent.ok) throw new Error("submit failed");
    const orderLine = await db.purchaseOrderLine.findFirstOrThrow({
      where: { orderId: order.orderId },
    });

    // Neither as the place of the receipt nor as the place of one line.
    await expect(
      receivePurchaseOrder(limited, order.orderId, {
        idempotencyKey: key(),
        locationId: shelfA,
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      receivePurchaseOrder(limited, order.orderId, {
        idempotencyKey: key(),
        locationId: shelfB,
        lines: [
          { orderLineId: orderLine.id, quantity: "2", locationId: shelfA },
        ],
      }),
    ).rejects.toMatchObject(OUTSIDE);
    expect(await stockAt(shelfA)).toBe(5);
    expect(
      await db.purchaseReceipt.count({ where: { orderId: order.orderId } }),
    ).toBe(0);

    // The owner receives part in A: the limited person cannot return it,
    // nor take a return out of a location of A.
    const inA = await receivePurchaseOrder(owner, order.orderId, {
      idempotencyKey: key(),
      lines: [{ orderLineId: orderLine.id, quantity: "2", locationId: shelfA }],
    });
    if (!inA.ok) throw new Error(JSON.stringify(inA));
    const lineInA = await db.purchaseReceiptLine.findFirstOrThrow({
      where: { receiptId: inA.receiptId },
    });
    await expect(
      returnToSupplier(limited, inA.receiptId, {
        reason: "Llegó dañado",
        idempotencyKey: key(),
        lines: [{ receiptLineId: lineInA.id, quantity: "1" }],
      }),
    ).rejects.toMatchObject(OUTSIDE);
    expect(await stockAt(shelfA)).toBe(7);

    // In B it receives and returns.
    const inB = await receivePurchaseOrder(limited, order.orderId, {
      idempotencyKey: key(),
      locationId: shelfB,
    });
    if (!inB.ok) throw new Error(JSON.stringify(inB));
    const lineInB = await db.purchaseReceiptLine.findFirstOrThrow({
      where: { receiptId: inB.receiptId },
    });
    await expect(
      returnToSupplier(limited, inB.receiptId, {
        reason: "Llegó dañado",
        idempotencyKey: key(),
        lines: [
          { receiptLineId: lineInB.id, quantity: "1", locationId: shelfA },
        ],
      }),
    ).rejects.toMatchObject(OUTSIDE);
    expect(
      await returnToSupplier(limited, inB.receiptId, {
        reason: "Llegó dañado",
        idempotencyKey: key(),
        lines: [{ receiptLineId: lineInB.id, quantity: "1" }],
      }),
    ).toMatchObject({ ok: true });
    expect(await stockAt(shelfA)).toBe(7);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("lots of A are neither seen, listed as expiring nor taken (WMS-21)", async () => {
    const made = await createProduct(owner, {
      sku: "ALC-LOTE",
      name: "Pegamento",
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    if (!made.ok) throw new Error("product setup failed");
    for (const [locationId, lotCode] of [
      [shelfA, "L-A"],
      [shelfB, "L-B"],
    ] as const) {
      const entry = await registerEntry(owner, {
        productId: made.productId,
        locationId,
        quantity: "6",
        lotCode,
        lotExpiresOn: "2026-01-15",
      });
      if (!entry.ok) throw new Error(JSON.stringify(entry));
    }
    const lots = await db.lot.findMany({
      where: { productId: made.productId },
    });
    const lotA = lots.find((lot) => lot.code === "L-A")!.id;
    const lotB = lots.find((lot) => lot.code === "L-B")!.id;

    expect(
      (await listLotStock(limited, made.productId)).map((row) => row.code),
    ).toEqual(["L-B"]);
    expect(
      (await listProductLots(limited, made.productId))
        .filter((lot) => lot.total !== "0")
        .map((lot) => lot.code),
    ).toEqual(["L-B"]);
    expect(
      (await listExpiringLots(limited)).items.map((item) => item.code),
    ).toEqual(["L-B"]);
    expect(await countExpiringLots(limited)).toBe(1);
    // The lot exists (its code is of the product), but not its stock in A.
    expect((await getLot(limited, lotA))?.places).toEqual([]);
    expect((await listMovements(limited, { lotId: lotA })).total).toBe(0);
    await expect(
      registerExit(limited, {
        productId: made.productId,
        locationId: shelfA,
        quantity: "1",
        lotId: lotA,
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      registerTransfer(limited, {
        productId: made.productId,
        locationId: shelfB,
        toLocationId: shelfA,
        quantity: "1",
        lotId: lotB,
      }),
    ).rejects.toMatchObject(OUTSIDE);
    // Who has no limit sees both, each in its warehouse.
    expect(
      (await listLotStock(free, made.productId)).map((row) => row.code).sort(),
    ).toEqual(["L-A", "L-B"]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("figures of the whole company are not for them", async () => {
    // A minimum far above what there is: the product is low for the company.
    expect(
      await setMinimum(owner, { productId, quantity: "100000" }),
    ).toMatchObject({ ok: true });

    // Without a limit: the list, the count, the value and what to buy.
    expect((await listLowStock(free)).items.map((i) => i.productId)).toContain(
      productId,
    );
    expect(await countLowStock(free)).toBeGreaterThan(0);
    expect(await getInventoryValue(free)).not.toBeNull();
    expect((await getPurchaseSuggestions(free)).limited).toBe(false);

    // Limited to B: none of them, and it says why instead of «all is fine».
    expect(await listLowStock(limited)).toMatchObject({
      items: [],
      total: 0,
      withMinimum: 0,
      limited: true,
    });
    expect(await countLowStock(limited)).toBe(0);
    expect(await getInventoryValue(limited)).toBeNull();
    expect(await getPurchaseSuggestions(limited)).toEqual({
      groups: [],
      covered: [],
      limited: true,
    });
    expect(
      await generateSuggestedOrders(limited, { productIds: [productId] }),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("without rows nothing changes, and the titular is never limited", async () => {
    expect(await switchFacility(free, facilityB)).toMatchObject({ ok: true });
    expect(await switchFacility(free, facilityA)).toMatchObject({ ok: true });
    expect(
      await registerEntry(free, {
        // Identical entries on purpose (WMS-71).
        acceptRepeat: true,
        productId,
        locationId: shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerExit(free, {
        productId,
        locationId: shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect((await listFacilities(free)).map((each) => each.id).sort()).toEqual(
      [facilityA, facilityB].sort(),
    );

    // Rows written behind the services do not limit the titular.
    const ownerMembership = await db.membership.findFirstOrThrow({
      where: { organizationId: owner.organizationId, userId: owner.userId },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        membershipId: ownerMembership.id,
        facilityId: facilityB,
      },
    });
    expect((await getActiveFacility(owner)).id).toBe(facilityA);
    expect(
      await registerEntry(owner, {
        // Identical entries on purpose (WMS-71).
        acceptRepeat: true,
        productId,
        locationId: shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerExit(owner, {
        productId,
        locationId: shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    await db.membershipScope.deleteMany({
      where: { membershipId: ownerMembership.id },
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("limited to a zone of a warehouse", () => {
  let zoned: InventoryActor;
  let zoneId = "";
  let inZone = "";

  beforeAll(async () => {
    // In B: «Zona 1» with a shelf inside; General and «Estante B1» stay out.
    await switchFacility(owner, facilityB);
    const zone = await createLocation(owner, { level: 1, name: "Zona 1" });
    if (!zone.ok) throw new Error(JSON.stringify(zone));
    zoneId = zone.locationId;
    const inside = await createLocation(owner, {
      level: 3,
      name: "Estante Z1",
      parentId: zoneId,
    });
    if (!inside.ok) throw new Error(JSON.stringify(inside));
    inZone = inside.locationId;
    await switchFacility(owner, facilityA);
    await enter(inZone, "4");

    zoned = await member(owner.organizationId, "administrator");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: zoned.userId,
      facilities: [{ facilityId: facilityB, zoneIds: [zoneId] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
  }, 60_000);

  it("is offered only the locations of the zone", async () => {
    expect((await getActiveFacility(zoned)).id).toBe(facilityB);
    expect(
      (await listStockLocations(zoned)).map((each) => each.id).sort(),
    ).toEqual([zoneId, inZone].sort());
    expect(
      (await listLocations(zoned))?.locations.map((each) => each.id).sort(),
    ).toEqual([zoneId, inZone].sort());
    // General of the warehouse is outside the zone: nothing by default.
    expect(await getDefaultLocation(zoned)).toBeNull();
    expect(Object.keys(await getStockByLocation(zoned, productId))).toEqual([
      inZone,
    ]);
    expect((await getProductStock(zoned, productId))?.total).toBe("4");
  });

  it("moves only inside the zone", async () => {
    await expect(
      registerEntry(zoned, {
        // Identical entries on purpose (WMS-71).
        acceptRepeat: true,
        productId,
        locationId: shelfB,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    // Without a location it would be General, which is outside.
    await expect(
      registerEntry(zoned, {
        // Identical entries on purpose (WMS-71).
        acceptRepeat: true,
        productId,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      registerTransfer(zoned, {
        productId,
        locationId: inZone,
        toLocationId: shelfB,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      createTask(zoned, {
        productId,
        fromLocationId: inZone,
        toLocationId: shelfB,
        quantity: "1",
      }),
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      openCount(zoned, { locationId: shelfB }),
    ).rejects.toMatchObject(OUTSIDE);
    // The task of B created before (General → Estante B1) is not theirs.
    expect((await listTasks(zoned, { view: "available" })).items).toEqual([]);

    expect(
      await registerTransfer(zoned, {
        productId,
        locationId: inZone,
        toLocationId: zoneId,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerExit(zoned, {
        productId,
        locationId: zoneId,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(await stockAt(shelfB)).toBeGreaterThan(0);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("the repeated-entry warning does not tell what happened outside the zone", async () => {
    // Someone else just entered 7 in a shelf outside the zone.
    await enter(shelfB, "7");
    const first = await registerEntry(zoned, {
      productId,
      locationId: inZone,
      quantity: "7",
    });
    expect(first).toMatchObject({ ok: true });
    // Their own entry, inside the zone, does warn.
    expect(
      await registerEntry(zoned, {
        productId,
        locationId: inZone,
        quantity: "7",
      }),
    ).toMatchObject({ ok: false, reason: "repeated_recently" });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a put-away is recommended and left only inside the zone (WMS-52)", async () => {
    const dock = await createLocation(owner, {
      level: 3,
      name: "Recepción Z1",
      parentId: zoneId,
      type: "RECEIVING",
    });
    if (!dock.ok) throw new Error(JSON.stringify(dock));
    const turned = await updateOperationSetting(
      owner,
      operationSettings,
      PUTAWAY_MODE.key,
      "tasks",
    );
    if (!turned.ok) throw new Error(turned.error);
    try {
      // The same product sits outside the zone too (shelf B1).
      await registerEntry(zoned, {
        acceptRepeat: true,
        productId,
        locationId: dock.locationId,
        quantity: "2",
      });
      const task = await db.warehouseTask.findFirstOrThrow({
        where: { kind: "PUTAWAY", fromLocationId: dock.locationId },
      });
      expect(task.toLocationId).toBe(inZone);
      expect(await acceptTask(zoned, task.id)).toMatchObject({ ok: true });
      expect(await pickUpTask(zoned, task.id)).toMatchObject({ ok: true });
      expect(
        await deliverTask(zoned, task.id, { locationCode: "Estante B1" }),
      ).toMatchObject({
        ok: false,
        fieldErrors: {
          locationCode: expect.stringContaining("No encontramos"),
        },
      });
      expect(
        await deliverTask(zoned, task.id, { locationCode: "Estante Z1" }),
      ).toMatchObject({ ok: true });
    } finally {
      await updateOperationSetting(
        owner,
        operationSettings,
        PUTAWAY_MODE.key,
        "manual",
      );
    }
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a pallet outside the zone does not exist for them; inside, it moves only inside (WMS-53)", async () => {
    const turned = await updateOperationSetting(
      owner,
      operationSettings,
      CONTAINERS_MODE.key,
      "on",
    );
    if (!turned.ok) throw new Error(turned.error);
    // The owner packs one in B1 (outside the zone).
    await switchFacility(owner, facilityB);
    await enter(shelfB, "3");
    const outside = await packStock(owner, {
      locationId: shelfB,
      productId,
      quantity: "2",
    });
    if (!outside.ok) throw new Error(JSON.stringify(outside));
    await switchFacility(owner, facilityA);
    expect(await getContainer(zoned, outside.containerId)).toBeNull();
    expect((await listContainers(zoned)).total).toBe(0);
    expect(
      await moveContainer(zoned, {
        containerId: outside.containerId,
        locationCode: "Estante Z1",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    expect(await closeContainer(zoned, outside.containerId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // Theirs, inside the zone: never to a place outside it.
    const mine = await packStock(zoned, {
      locationId: inZone,
      productId,
      quantity: "1",
    });
    if (!mine.ok) throw new Error(JSON.stringify(mine));
    expect(
      await moveContainer(zoned, {
        containerId: mine.containerId,
        locationCode: "Estante B1",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("No encontramos") },
    });
    expect(
      await moveContainer(zoned, {
        containerId: mine.containerId,
        locationCode: "Zona 1",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await closeContainer(zoned, mine.containerId)).toMatchObject({
      ok: true,
    });
    expect(await closeContainer(owner, outside.containerId)).toMatchObject({
      ok: true,
    });
    await updateOperationSetting(
      owner,
      operationSettings,
      CONTAINERS_MODE.key,
      "off",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});
