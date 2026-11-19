import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { runGlobalSearch } from "@/platform/search";
import {
  createEquipment,
  getEquipment,
  getIncident,
  listEquipment,
  saveEquipmentType,
  setEquipmentOutOfService,
  listIncidents,
  reportIncident,
  startIncident,
  addFacilityTransferLine,
  createFacilityTransfer,
  getFacilityTransfer,
  listFacilityTransfers,
  receiveFacilityTransfer,
  sendFacilityTransfer,
  decideCustomerReturn,
  getCustomerReturn,
  listCustomerReturns,
  receiveCustomerReturn,
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
  createCountProgram,
  generateTodayCounts,
  getCountProgram,
  listCountPage,
  listCountPrograms,
  setCountProgramPaused,
  updateCountProgram,
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
  getWarehouseIndicators,
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
  countAwaitingInspection,
  countInRepair,
  disposeStock,
  listAwaitingInspection,
  listInRepair,
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
  getReplenishmentRule,
  listReplenishmentRules,
  removeReplenishmentRule,
  replenishNow,
  saveReplenishmentRule,
  PICKING_MODE,
  cancelOutboundOrder,
  cancelWave,
  createWave,
  getWave,
  listOpenWaves,
  takeWaveTasks,
  reachesTask,
  uploadTaskPhoto,
} from "@/modules/inventory";
import {
  acceptProductionRequest,
  activateRecipeVersion,
  createProductionOrder,
  createRecipe,
  getProductionOrder,
  getProductionRequest,
  listProductionOrders,
  listProductionRequests,
  rejectProductionRequest,
  releaseProductionOrder,
  setRecipeArea,
  setRecipeInput,
  submitProductionRequest,
} from "@/modules/production";
import {
  addOrderLine,
  createPurchaseOrder,
  generateSuggestedOrders,
  getPurchaseSuggestions,
  receivePurchaseOrder,
  returnToSupplier,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import {
  approvalTypes,
  evidenceOwners,
  moduleRegistry,
  operationSettings,
  searchSources,
} from "@/modules/registry";
import {
  countPendingApprovals,
  decideApproval,
  getApprovalRequest,
  listPendingApprovals,
  updateApprovalRule,
} from "@/platform/approvals";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { archiveProduct, createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { createFileLink, readSpreadsheet } from "@/platform/files";
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

import { TEST_JPEG } from "../setup/images";

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
      modules: ["inventory", "purchasing", "production"],
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

  it("finds nothing of A in the global search (WMS-66)", async () => {
    const shelves = await runGlobalSearch(limited, "estante", searchSources);
    const places = shelves.groups.find(
      (group) => group.kind === "inventory.location",
    );
    expect(places?.hits.map((hit) => hit.id)).toEqual([shelfB]);
    expect(JSON.stringify(shelves)).not.toContain("Estante A1");
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
    // WMS-57: an order of A does not exist for who is limited to B…
    const ofA = await createPurchaseOrder(owner, {
      supplierId: supplier.supplierId,
    });
    if (!ofA.ok) throw new Error("order setup failed");
    expect(
      await receivePurchaseOrder(limited, ofA.orderId, {
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // WMS-84: nor can it reject anything of it at the door.
    expect(
      await receivePurchaseOrder(limited, ofA.orderId, {
        idempotencyKey: key(),
        lines: [],
        rejections: [
          { orderLineId: newId(), quantity: "1", reason: "No cuadra" },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // …but one of the whole company (written before orders had a
    // warehouse) does: it is received and returned within the scope.
    const last = await db.purchaseOrder.findFirstOrThrow({
      where: { organizationId: owner.organizationId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const order = { orderId: newId() };
    await db.purchaseOrder.create({
      data: {
        id: order.orderId,
        organizationId: owner.organizationId,
        number: last.number + 1,
        contactId: supplier.supplierId,
        createdByUserId: owner.userId,
      },
    });
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

  it("the warehouse indicators name only the zone and its warehouse (WMS-32)", async () => {
    const seen = await getWarehouseIndicators(zoned, { preset: "7" });
    expect(seen.facility.id).toBe(facilityB);
    expect(seen.facilities.map((each) => each.id)).toEqual([facilityB]);
    expect(seen.zones.length).toBeGreaterThan(0);
    for (const zone of seen.zones) expect(zone.zoneId).toBe(zoneId);
    // A warehouse outside the scope is ignored, not shown.
    const asked = await getWarehouseIndicators(zoned, {
      preset: "7",
      facilityId: facilityA,
    });
    expect(asked.facility.id).toBe(facilityB);
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

  it("replenishment rules and «Reponer ahora» stay inside the zone (WMS-23/24)", async () => {
    await switchFacility(owner, facilityB);
    const faceIn = await createLocation(owner, {
      level: 3,
      name: "Surtido Z1",
      parentId: zoneId,
      type: "PICKING",
    });
    const faceOut = await createLocation(owner, {
      level: 3,
      name: "Surtido B1",
      type: "PICKING",
    });
    if (!faceIn.ok || !faceOut.ok) throw new Error("places");
    const { sku } = await db.product.findUniqueOrThrow({
      where: { id: productId },
      select: { sku: true },
    });
    const outside = await saveReplenishmentRule(owner, {
      productCode: sku,
      locationId: faceOut.locationId,
      minQuantity: "1",
      maxQuantity: "3",
    });
    if (!outside.ok) throw new Error(JSON.stringify(outside));
    await switchFacility(owner, facilityA);
    // A place outside the zone is not found; the zone's is.
    expect(
      await saveReplenishmentRule(zoned, {
        productCode: sku,
        locationId: faceOut.locationId,
        minQuantity: "1",
        maxQuantity: "3",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    const inside = await saveReplenishmentRule(zoned, {
      productCode: sku,
      locationId: faceIn.locationId,
      minQuantity: "1",
      maxQuantity: "2",
    });
    if (!inside.ok) throw new Error(JSON.stringify(inside));
    expect(await getReplenishmentRule(zoned, outside.ruleId)).toBeNull();
    expect(await removeReplenishmentRule(zoned, outside.ruleId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      (await listReplenishmentRules(zoned)).items.map((rule) => rule.id),
    ).toEqual([inside.ruleId]);
    // Only the zone's rule, and only from storage inside the zone.
    expect(await replenishNow(zoned)).toMatchObject({ ok: true, created: 1 });
    const tasks = await db.warehouseTask.findMany({
      where: {
        organizationId: owner.organizationId,
        kind: "REPLENISH",
        status: "PENDING",
      },
    });
    expect(
      tasks.map((task) => [task.fromLocationId, task.toLocationId]),
    ).toEqual([[inZone, faceIn.locationId]]);
    for (const task of tasks) {
      expect(
        await cancelTask(owner, task.id, "Fin de la prueba"),
      ).toMatchObject({ ok: true });
    }
    await removeReplenishmentRule(owner, outside.ruleId);
    await removeReplenishmentRule(owner, inside.ruleId);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
  it("an equipment card shows only what is inside the zone, and a task outside it is not named (WMS-42)", async () => {
    await switchFacility(owner, facilityB);
    const type = await saveEquipmentType(owner, { name: "Patín de zona" });
    if (!type.ok) throw new Error(JSON.stringify(type));
    const made = await createEquipment(owner, {
      code: "MZ-01",
      name: "Patín de B",
      typeId: type.typeId,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // An incident outside the zone and one of the whole warehouse.
    const outside = await reportIncident(owner, {
      kind: "OTHER",
      description: "Rayado en el estante B1.",
      location: "Estante B1",
      equipment: "MZ-01",
      idempotencyKey: key(),
    });
    const anywhere = await reportIncident(owner, {
      kind: "OTHER",
      description: "Le falta una etiqueta.",
      equipment: "MZ-01",
      idempotencyKey: key(),
    });
    if (!outside.ok || !anywhere.ok) throw new Error("incidents failed");
    // A task outside the zone, taken with it by the titular.
    const away = await createTask(owner, {
      productId,
      fromLocationId: generalB,
      toLocationId: shelfB,
      quantity: "1",
      equipmentTypeId: type.typeId,
    });
    if (!away.ok) throw new Error(JSON.stringify(away));
    const taken = await acceptTask(owner, away.taskId, {
      equipmentCode: "MZ-01",
    });
    if (!taken.ok) throw new Error(JSON.stringify(taken));
    await switchFacility(owner, facilityA);

    const card = await getEquipment(zoned, made.equipmentId);
    expect(card).not.toBeNull();
    expect(card!.incidents.map((each) => each.id)).toEqual([
      anywhere.incidentId,
    ]);
    expect(card!.openTasks).toEqual([]);
    expect(card!.tasks).toEqual([]);
    expect(card!.inUseBy).toBe("Otra persona");
    // The zone does not manage what goes all over the warehouse.
    await expect(
      setEquipmentOutOfService(zoned, made.equipmentId, {
        reason: "Desde la zona no",
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    // Taking a task of the zone with it: told it is busy, not where.
    const here = await createTask(zoned, {
      productId,
      fromLocationId: inZone,
      toLocationId: zoneId,
      quantity: "1",
      equipmentTypeId: type.typeId,
    });
    if (!here.ok) throw new Error(JSON.stringify(here));
    const busy = await acceptTask(zoned, here.taskId, {
      equipmentCode: "MZ-01",
    });
    expect(busy).toMatchObject({ ok: false });
    if (!busy.ok) {
      expect(busy.fieldErrors?.equipmentCode).toContain("otra persona");
      expect(busy.fieldErrors?.equipmentCode).not.toMatch(/T-\d/);
    }
    // Leave nothing open for the rest of the file.
    await cancelTask(zoned, here.taskId, "Prueba terminada");
    await cancelTask(owner, away.taskId, "Prueba terminada");
  });
});

describe("PC-12: customer returns (WMS-17)", () => {
  it("a return of A does not exist from B, and nothing is received into A", async () => {
    const product = await createProduct(owner, {
      sku: "ALC-DEV",
      name: "Devuelto",
    });
    if (!product.ok) throw new Error("product setup failed");
    const received = await receiveCustomerReturn(owner, {
      returnedBy: "Mostrador",
      reason: "No lo quiso",
      locationId: shelfA,
      idempotencyKey: key(),
      lines: [{ productId: product.productId, quantity: "2" }],
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    const number = (await getCustomerReturn(owner, received.returnId))!
      .numberText;

    expect(await getCustomerReturn(limited, received.returnId)).toBeNull();
    expect((await listCustomerReturns(limited)).items).toEqual([]);
    expect((await findTraceMatches(limited, number)).matches).toEqual([]);
    const lineId = (
      await db.customerReturnLine.findFirstOrThrow({
        where: { returnId: received.returnId },
      })
    ).id;
    expect(
      await decideCustomerReturn(limited, {
        returnId: received.returnId,
        lineId,
        outcome: "AVAILABLE",
        quantity: "2",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    await expect(
      receiveCustomerReturn(limited, {
        returnedBy: "Mostrador",
        reason: "No lo quiso",
        locationId: shelfA,
        idempotencyKey: key(),
        lines: [{ productId: product.productId, quantity: "1" }],
      }),
    ).rejects.toMatchObject(OUTSIDE);
    // In B they receive and decide as usual.
    const own = await receiveCustomerReturn(limited, {
      returnedBy: "Mostrador",
      reason: "No lo quiso",
      locationId: shelfB,
      idempotencyKey: key(),
      lines: [{ productId: product.productId, quantity: "1" }],
    });
    expect(own).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: transfers between warehouses (WMS-19)", () => {
  it("from B a transfer of A is only received: no places of A, no sending, nothing into A", async () => {
    const product = await createProduct(owner, {
      sku: "ALC-TRA",
      name: "Trasladado",
    });
    if (!product.ok) throw new Error("product setup failed");
    const item = product.productId;
    const entered = await registerEntry(owner, {
      productId: item,
      locationId: shelfA,
      quantity: "4",
    });
    if (!entered.ok) throw new Error(JSON.stringify(entered));
    const made = await createFacilityTransfer(owner, {
      toFacilityId: facilityB,
      idempotencyKey: key(),
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // A draft of A is not changed nor sent from B.
    expect(
      await addFacilityTransferLine(limited, {
        transferId: made.transferId,
        productId: item,
        source: shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await getFacilityTransfer(limited, made.transferId)).toMatchObject({
      atOrigin: false,
      atDestination: true,
    });
    expect(
      await addFacilityTransferLine(owner, {
        transferId: made.transferId,
        productId: item,
        source: shelfA,
        quantity: "4",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await sendFacilityTransfer(limited, {
        transferId: made.transferId,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await sendFacilityTransfer(owner, {
        transferId: made.transferId,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    // From B: waiting to be received, without the places of A.
    expect(
      (await listFacilityTransfers(limited, { view: "incoming" })).items.map(
        (each) => each.id,
      ),
    ).toEqual([made.transferId]);
    expect(
      (await listFacilityTransfers(limited, { view: "sent" })).items,
    ).toEqual([]);
    const seen = await getFacilityTransfer(limited, made.transferId);
    expect(seen!.lines[0]!.fromPath).toBeNull();
    const lineId = seen!.lines[0]!.id;
    // Nothing of it is received into A.
    await expect(
      receiveFacilityTransfer(limited, {
        transferId: made.transferId,
        locationId: shelfA,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "4" }],
      }),
    ).rejects.toMatchObject(OUTSIDE);
    expect(
      await receiveFacilityTransfer(limited, {
        transferId: made.transferId,
        locationId: shelfB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "4" }],
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: cycle count programs (WMS-55)", () => {
  it("a program of A does not exist for them, nor do its counts", async () => {
    const created = await createCountProgram(owner, {
      name: `Ciclo A ${stamp}`,
      rootLocationId: shelfA,
      basis: "EVEN",
      everyDays: "7",
      locationsPerDay: "5",
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const generated = await generateTodayCounts(owner, created.programId);
    expect(generated).toMatchObject({ ok: true });

    expect(
      (await listCountPrograms(limited)).map((each) => each.id),
    ).not.toContain(created.programId);
    expect(await getCountProgram(limited, created.programId)).toBeNull();
    expect(await generateTodayCounts(limited, created.programId)).toMatchObject(
      { ok: false, reason: "not_found" },
    );
    expect(
      await setCountProgramPaused(limited, created.programId, true),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await updateCountProgram(limited, created.programId, {
        name: "Otro",
        basis: "EVEN",
        everyDays: "7",
        locationsPerDay: "5",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // A program can only cover what the person reaches: a location of
    // A is not one of their warehouse.
    expect(
      await createCountProgram(limited, {
        name: "Fuera",
        rootLocationId: shelfA,
        basis: "EVEN",
        everyDays: "7",
        locationsPerDay: "5",
      }),
    ).toMatchObject({
      ok: false,
      reason: "not_found",
      field: "rootLocationId",
    });
    const today = await listCountPage(limited, { view: "today" });
    const mine = await listCountPage(owner, { view: "today" });
    expect(mine.total).toBeGreaterThan(0);
    for (const count of mine.items) {
      expect(today.items.map((each) => each.id)).not.toContain(count.id);
    }
  }, 60_000);
});

describe("PC-12: approvals (WMS-56/41)", () => {
  it("a request about a location of A does not exist from B; one of B is decided there", async () => {
    const on = await updateApprovalRule(
      owner,
      approvalTypes,
      "inventory.adjustment",
      {
        enabled: true,
        roles: ["administrator"],
        allowSelfApproval: false,
      },
    );
    expect(on).toMatchObject({ ok: true });
    await switchFacility(owner, facilityA);
    const placeA = await shelf("Estante A aprobaciones");
    await enter(placeA, "5");
    await switchFacility(owner, facilityB);
    const placeB = await shelf("Estante B aprobaciones");
    await enter(placeB, "3");
    await switchFacility(owner, facilityA);
    try {
      const inA = await registerAdjustment(owner, {
        productId,
        locationId: placeA,
        quantity: "4",
        reason: "Conteo físico del estante A1",
      });
      const inB = await registerAdjustment(owner, {
        productId,
        locationId: placeB,
        quantity: "2",
        reason: "Conteo físico del estante B1",
      });
      if (inA.ok || inA.reason !== "pending_approval") {
        throw new Error(JSON.stringify(inA));
      }
      if (inB.ok || inB.reason !== "pending_approval") {
        throw new Error(JSON.stringify(inB));
      }
      const pending = await listPendingApprovals(limited, approvalTypes);
      expect(pending.rows.map((row) => row.id)).toEqual([inB.requestId]);
      expect(await countPendingApprovals(limited, approvalTypes)).toBe(1);
      expect(
        await getApprovalRequest(limited, approvalTypes, inA.requestId),
      ).toBeNull();
      expect(
        await decideApproval(limited, approvalTypes, inA.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: false, reason: "not_found" });
      expect(await stockAt(placeA)).toBe(5);

      expect(
        await decideApproval(limited, approvalTypes, inB.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: true, status: "APPROVED" });
      expect(await stockAt(placeB)).toBe(2);
      expect(
        await decideApproval(free, approvalTypes, inA.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: true, status: "APPROVED" });
      expect(await stockAt(placeA)).toBe(4);
      expect(await reconcileStock(owner.organizationId)).toEqual([]);
    } finally {
      await updateApprovalRule(owner, approvalTypes, "inventory.adjustment", {
        enabled: false,
        roles: ["administrator"],
        allowSelfApproval: false,
      });
    }
  });
});

describe("PC-12: picking waves (WMS-25)", () => {
  it("a wave of A does not exist from B, and A's orders do not join a wave there", async () => {
    await updateOperationSetting(
      owner,
      operationSettings,
      PICKING_MODE.key,
      "waves",
    );
    const made = await createOutboundOrder(owner, { recipient: "Ola A" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(owner, made.orderId, { productId, quantity: "1" });
    const wave = await createWave(owner, { orderIds: [made.orderId] });
    if (!wave.ok) throw new Error(JSON.stringify(wave));
    expect(await getWave(free, wave.waveId)).not.toBeNull();
    expect(await getWave(limited, wave.waveId)).toBeNull();
    expect(await listOpenWaves(limited)).toEqual([]);
    expect(await takeWaveTasks(limited, wave.waveId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await cancelWave(limited, wave.waveId, "No es de mi almacén"),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // From B (where the limited person works) an order of A is not found.
    expect(
      await createWave(limited, { orderIds: [made.orderId] }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await cancelOutboundOrder(owner, made.orderId, "Fin de la prueba"),
    ).toMatchObject({ ok: true });
    // Its last open task went with the order: the wave ended.
    expect(
      (await db.pickWave.findUniqueOrThrow({ where: { id: wave.waveId } }))
        .status,
    ).toBe("DONE");
    await updateOperationSetting(
      owner,
      operationSettings,
      PICKING_MODE.key,
      "orders",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: incidents and their notices (WMS-39)", () => {
  it("an incident of A does not exist from B, nor does its notice reach there", async () => {
    const reported = await reportIncident(free, {
      kind: "DAMAGED_GOODS",
      description: "Caja mojada en el estante.",
      location: "Estante A1",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    expect(await getIncident(limited, reported.incidentId)).toBeNull();
    expect(await startIncident(limited, reported.incidentId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      (await listIncidents(limited, { view: "open" })).rows.map(
        (row) => row.id,
      ),
    ).not.toContain(reported.incidentId);
    // Who attends in A heard it; who only reaches B did not.
    const heard = (userId: string) =>
      db.notification.count({
        where: {
          recipientUserId: userId,
          typeKey: "inventory.incident_reported",
          href: `/incidencias/${reported.incidentId}`,
        },
      });
    expect(await heard(owner.userId)).toBe(1);
    expect(await heard(limited.userId)).toBe(0);
    // From B, a place of A is not found.
    expect(
      await reportIncident(limited, {
        kind: "MISPLACED",
        description: "Algo de A.",
        location: "Estante A1",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { location: expect.any(String) },
    });
  });
});

describe("PC-12: equipment (WMS-42)", () => {
  it("a piece of equipment of A does not exist from B, nor is it named in a report there", async () => {
    const type = await saveEquipmentType(free, { name: "Patín de alcance" });
    if (!type.ok) throw new Error(JSON.stringify(type));
    const made = await createEquipment(free, {
      code: "PA-01",
      name: "Patín de A",
      typeId: type.typeId,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await getEquipment(free, made.equipmentId)).not.toBeNull();
    expect(await getEquipment(limited, made.equipmentId)).toBeNull();
    expect(
      (await listEquipment(limited)).rows.map((row) => row.id),
    ).not.toContain(made.equipmentId);
    expect(
      await setEquipmentOutOfService(limited, made.equipmentId, {
        reason: "Desde B no",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await reportIncident(limited, {
        kind: "BROKEN_EQUIPMENT",
        description: "No arranca el patín.",
        equipment: "PA-01",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { equipment: expect.any(String) },
    });
    const still = await getEquipment(free, made.equipmentId);
    expect(still!.status).toBe("IN_SERVICE");
  });
});

describe("PC-12: archiving a product (WMS-57B)", () => {
  async function item(sku: string) {
    const made = await createProduct(owner, { sku, name: `Archivable ${sku}` });
    if (!made.ok) throw new Error("product setup failed");
    return made.productId;
  }

  async function orderFor(
    product: string,
    supplierId: string,
    facilityId: string,
  ) {
    const order = await createPurchaseOrder(owner, { supplierId, facilityId });
    if (!order.ok) throw new Error(JSON.stringify(order));
    const line = await addOrderLine(owner, order.orderId, {
      productId: product,
      capture: "base",
      quantity: "2",
    });
    if (!line.ok) throw new Error(JSON.stringify(line));
    const sent = await submitPurchaseOrder(owner, order.orderId);
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    const { number } = await db.purchaseOrder.findFirstOrThrow({
      where: { id: order.orderId },
      select: { number: true },
    });
    return `OC-${String(number).padStart(4, "0")}`;
  }

  async function stillActive(product: string) {
    const row = await db.product.findFirstOrThrow({
      where: { id: product },
      select: { status: true },
    });
    expect(row.status).toBe("ACTIVE");
  }

  it("orders of A keep it from being archived but are neither named nor counted from B", async () => {
    const supplier = await createSupplier(owner, {
      name: "Proveedor del archivado",
    });
    if (!supplier.ok) throw new Error("supplier setup failed");
    const product = await item("ALC-ARC-1");
    const inA = await orderFor(product, supplier.supplierId, facilityA);
    const alsoInA = await orderFor(product, supplier.supplierId, facilityA);

    // From B: refused, without which, how many nor where.
    const fromB = await archiveProduct(limited, product);
    expect(fromB).toMatchObject({ ok: false, reason: "has_open_orders" });
    const generic = !fromB.ok ? fromB.error : "";
    expect(generic).not.toMatch(/OC-|\d|Bodega|Almacén principal/);
    expect(generic).toContain("almacenes que no tienes asignados");
    await stillActive(product);

    // Without a limit: named as before.
    const fromFree = await archiveProduct(free, product);
    expect(fromFree).toMatchObject({
      ok: false,
      reason: "has_open_orders",
      error: expect.stringContaining(`las órdenes ${inA}, ${alsoInA}`),
    });

    // With one of B too, from B only that one is named.
    const inB = await orderFor(product, supplier.supplierId, facilityB);
    const withB = await archiveProduct(limited, product);
    expect(withB).toMatchObject({ ok: false, reason: "has_open_orders" });
    const named = !withB.ok ? withB.error : "";
    expect(named).toContain(`la orden ${inB}.`);
    expect(named).not.toContain(inA);
    expect(named).not.toContain(alsoInA);
    expect(named).not.toContain("más");
    await stillActive(product);
  });

  it("stock in A keeps it from being archived but is neither named nor counted from B", async () => {
    const product = await item("ALC-ARC-2");
    const put = async (locationId: string, quantity: string) => {
      const result = await registerEntry(owner, {
        acceptRepeat: true,
        productId: product,
        locationId,
        quantity,
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
    };
    await put(shelfA, "4");
    await put(generalA, "5");
    const fromB = await archiveProduct(limited, product);
    expect(fromB).toMatchObject({ ok: false, reason: "has_stock" });
    const generic = !fromB.ok ? fromB.error : "";
    expect(generic).not.toMatch(/\d/);
    expect(generic).toContain("almacenes o zonas que no tienes asignados");
    expect(await archiveProduct(free, product)).toMatchObject({
      ok: false,
      reason: "has_stock",
      error: expect.stringContaining(
        "Todavía hay 9 piezas de este producto en 2 ubicaciones.",
      ),
    });
    // With some in B, from B only that part is counted.
    await put(shelfB, "2");
    expect(await archiveProduct(limited, product)).toMatchObject({
      ok: false,
      reason: "has_stock",
      error: expect.stringContaining("Todavía hay 2 piezas de este producto."),
    });
    await stillActive(product);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: inspection and write-offs (WMS-30-0)", () => {
  it("what waits for inspection in A is not listed from B, nor is anything of A written off", async () => {
    for (const to of ["INSPECTION", "REJECTED"] as const) {
      const moved = await changeStockStatus(owner, {
        productId,
        locationId: shelfA,
        from: "AVAILABLE",
        to,
        quantity: "1",
        reason: "Revisión de alcance",
        idempotencyKey: key(),
      });
      if (!moved.ok) throw new Error(JSON.stringify(moved));
    }
    // Other tests of this file leave stock in inspection too.
    expect(
      (await listAwaitingInspection(owner)).items.some(
        (item) => item.locationId === shelfA,
      ),
    ).toBe(true);
    // From B only what is in B (a customer return of another test).
    const seen = await listAwaitingInspection(limited);
    expect(seen.total).toBe(await countAwaitingInspection(limited));
    expect(
      seen.items.filter((item) => [shelfA, generalA].includes(item.locationId)),
    ).toEqual([]);
    await expect(
      disposeStock(limited, {
        productId,
        locationId: shelfA,
        status: "REJECTED",
        quantity: "1",
        reason: "Roto",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject(OUTSIDE);
    expect(
      await db.stockBalance.count({
        where: {
          productId,
          locationId: shelfA,
          status: "REJECTED",
          quantity: 1,
        },
      }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a write-off waiting in A does not exist from B (WMS-83)", async () => {
    const on = await updateApprovalRule(
      owner,
      approvalTypes,
      "inventory.disposal",
      { enabled: true, roles: ["administrator"], allowSelfApproval: false },
    );
    expect(on).toMatchObject({ ok: true });
    try {
      const moved = await changeStockStatus(owner, {
        productId,
        locationId: shelfA,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
        reason: "Revisión de alcance",
        idempotencyKey: key(),
      });
      if (!moved.ok) throw new Error(JSON.stringify(moved));
      const asked = await disposeStock(owner, {
        productId,
        locationId: shelfA,
        status: "DAMAGED",
        quantity: "1",
        reason: "Roto en A",
        idempotencyKey: key(),
      });
      if (asked.ok || asked.reason !== "pending_approval") {
        throw new Error(JSON.stringify(asked));
      }
      expect(
        await getApprovalRequest(limited, approvalTypes, asked.requestId),
      ).toBeNull();
      expect(
        await decideApproval(limited, approvalTypes, asked.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: false, reason: "not_found" });
      expect(
        await db.stockMovement.count({
          where: {
            organizationId: owner.organizationId,
            type: "DISPOSAL",
            reason: "Roto en A",
          },
        }),
      ).toBe(0);
      expect(
        await decideApproval(free, approvalTypes, asked.requestId, {
          decision: "approve",
        }),
      ).toMatchObject({ ok: true, status: "APPROVED" });
      expect(await reconcileStock(owner.organizationId)).toEqual([]);
    } finally {
      await updateApprovalRule(owner, approvalTypes, "inventory.disposal", {
        enabled: false,
        roles: ["administrator"],
        allowSelfApproval: false,
      });
    }
  });
});

describe("PC-12: what is in restoration (WMS-75)", () => {
  it("what is restored in A is neither listed, counted nor released from B", async () => {
    const moved = await changeStockStatus(owner, {
      productId,
      locationId: shelfA,
      from: "AVAILABLE",
      to: "REPAIR",
      quantity: "1",
      reason: "Se repara",
      idempotencyKey: key(),
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    expect(
      (await listInRepair(owner)).items.some(
        (item) => item.locationId === shelfA,
      ),
    ).toBe(true);
    // From B, where nothing is in restoration, there is nothing.
    expect(await countInRepair(limited)).toBe(0);
    expect((await listInRepair(limited)).items).toEqual([]);
    for (const to of ["AVAILABLE", "DAMAGED"] as const) {
      await expect(
        changeStockStatus(limited, {
          productId,
          locationId: shelfA,
          from: "REPAIR",
          to,
          quantity: "1",
          reason: "Restaurado",
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject(OUTSIDE);
    }
    // Nor is stock of B sent to a restoration place of A.
    await expect(
      changeStockStatus(limited, {
        productId,
        locationId: shelfB,
        toLocationId: shelfA,
        from: "AVAILABLE",
        to: "REPAIR",
        quantity: "1",
        reason: "Se repara",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject(OUTSIDE);
    expect(
      await db.stockBalance.count({
        where: { productId, locationId: shelfA, status: "REPAIR", quantity: 1 },
      }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: production orders (WMS-28)", () => {
  it("an order of A does not exist from B, nor its «Surtir a producción» tasks", async () => {
    await updateOperationSetting(
      owner,
      operationSettings,
      "production.materials.mode",
      "issue",
    );
    const area = await createLocation(owner, {
      level: 1,
      name: "Línea A",
      type: "PRODUCTION",
    });
    if (!area.ok) throw new Error(JSON.stringify(area));
    const kit = await createProduct(owner, { sku: "ALC-KIT", name: "Kit" });
    if (!kit.ok) throw new Error(JSON.stringify(kit));
    const recipe = await createRecipe(owner, kit.productId, {
      baseQuantity: "1",
    });
    if (!recipe.ok) throw new Error(JSON.stringify(recipe));
    await setRecipeInput(owner, recipe.versionId, {
      productId,
      quantity: "1",
    });
    expect(await activateRecipeVersion(owner, recipe.versionId)).toMatchObject({
      ok: true,
    });
    const made = await createProductionOrder(owner, {
      productId: kit.productId,
      quantity: "2",
      areaLocationId: area.locationId,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await releaseProductionOrder(owner, made.orderId)).toMatchObject({
      ok: true,
    });
    expect(await getProductionOrder(limited, made.orderId)).toBeNull();
    expect((await listProductionOrders(limited)).items).toEqual([]);
    expect(await releaseProductionOrder(limited, made.orderId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // From B its area cannot be chosen either.
    expect(
      await createProductionOrder(limited, {
        productId: kit.productId,
        quantity: "1",
        areaLocationId: area.locationId,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { areaLocationId: expect.any(String) },
    });
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { kind: "ISSUE", productionOrderLine: { orderId: made.orderId } },
    });
    expect(await acceptTask(limited, task.id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await getProductionOrder(free, made.orderId)).not.toBeNull();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: production requests (WMS-28B)", () => {
  it("a request of an area of A does not exist from B", async () => {
    const area = await createLocation(owner, {
      level: 1,
      name: "Línea SP",
      type: "PRODUCTION",
    });
    if (!area.ok) throw new Error(JSON.stringify(area));
    const kit = await createProduct(owner, { sku: "ALC-SP", name: "Kit SP" });
    if (!kit.ok) throw new Error(JSON.stringify(kit));
    const recipe = await createRecipe(owner, kit.productId, {
      baseQuantity: "1",
    });
    if (!recipe.ok) throw new Error(JSON.stringify(recipe));
    await setRecipeInput(owner, recipe.versionId, {
      productId,
      quantity: "1",
    });
    expect(await activateRecipeVersion(owner, recipe.versionId)).toMatchObject({
      ok: true,
    });
    expect(
      await setRecipeArea(owner, kit.productId, area.locationId),
    ).toMatchObject({ ok: true });
    expect(
      await setMinimum(owner, { productId: kit.productId, quantity: "5" }),
    ).toMatchObject({ ok: true });
    const asked = await submitProductionRequest(owner, {
      productId: kit.productId,
      quantity: "5",
    });
    if (!asked.ok) throw new Error(JSON.stringify(asked));
    expect(await getProductionRequest(limited, asked.requestId)).toBeNull();
    expect((await listProductionRequests(limited)).items).toEqual([]);
    expect(
      await acceptProductionRequest(limited, asked.requestId),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // Not even a wrong quantity says it exists.
    expect(
      await acceptProductionRequest(limited, asked.requestId, {
        quantity: "abc",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await rejectProductionRequest(limited, asked.requestId, "No hace falta"),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // From B it is never asked (its area is in A; here B also has tasks
    // to its name from the tests above).
    expect(
      await submitProductionRequest(limited, {
        productId: kit.productId,
        quantity: "5",
      }),
    ).toMatchObject({ ok: false });
    expect(
      (await getProductionRequest(free, asked.requestId))?.decision,
    ).not.toBeNull();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("PC-12: photos of a task (WMS-37B)", () => {
  it("the photo of a task of A does not exist from B, nor is one taken there", async () => {
    const spot = await shelf("Estante A9");
    const task = await createTask(owner, {
      productId,
      fromLocationId: shelfA,
      toLocationId: spot,
      quantity: "1",
    });
    if (!task.ok) throw new Error(JSON.stringify(task));
    expect(await acceptTask(owner, task.taskId)).toMatchObject({ ok: true });
    expect(await pickUpTask(owner, task.taskId)).toMatchObject({ ok: true });
    const upload = (actor: InventoryActor) =>
      uploadTaskPhoto(actor, task.taskId, {
        name: "foto.jpg",
        bytes: TEST_JPEG,
      });
    const uploaded = await upload(owner);
    if (!uploaded.ok) throw new Error(uploaded.error);
    // Even a task of A given to them before the limit: no photo from B.
    await db.warehouseTask.update({
      where: { id: task.taskId },
      data: { assignedToUserId: limited.userId },
    });
    expect(await upload(limited)).toMatchObject({ ok: false });
    await db.warehouseTask.update({
      where: { id: task.taskId },
      data: { assignedToUserId: owner.userId },
    });
    expect(
      await deliverTask(owner, task.taskId, { photoIds: [uploaded.fileId] }),
    ).toMatchObject({ ok: true });
    expect(await reachesTask(free, task.taskId)).toBe(true);
    expect(await reachesTask(limited, task.taskId)).toBe(false);
    expect(
      await createFileLink(free, uploaded.fileId, { owners: evidenceOwners }),
    ).toMatchObject({ ok: true });
    expect(
      await createFileLink(limited, uploaded.fileId, {
        owners: evidenceOwners,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});
