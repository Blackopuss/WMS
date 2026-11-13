import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  captureCount,
  changeStockStatus,
  confirmPick,
  createOutboundOrder,
  createTask,
  deliverTask,
  getOutboundOrder,
  listMovements,
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
  releaseTask,
  blockTask,
  reverseMovement,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  returnToSupplier,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct, updateProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import {
  createLocation,
  getActiveFacility,
  getDefaultLocation,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-21B (ADR 0041): a product by serial moves whole units, each one
// named by its serial; the balance is always the count of units inside.

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `series.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory"],
): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa series ${++counter}`,
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
      modules,
      validUntil: null,
      reason: "Prueba de series",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: "warehouse" | "operator",
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

async function product(actor: InventoryActor, tracking = "SERIAL") {
  const created = await createProduct(actor, {
    sku: `SER-${++counter}`,
    name: `Equipo ${counter}`,
    tracking: tracking as "SERIAL",
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(actor: InventoryActor, name: string) {
  const result = await createLocation(actor, { level: 1, name });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  serials: string[],
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity: String(serials.length),
    serials: serials.join("\n"),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.movementId;
}

/** Where each serial of a product is: «location|status», or «out». */
async function whereAre(productId: string) {
  const units = await db.serialUnit.findMany({
    where: { productId },
    orderBy: { serial: "asc" },
    select: { serial: true, locationId: true, status: true },
  });
  return Object.fromEntries(
    units.map((unit) => [
      unit.serial,
      unit.locationId ? `${unit.locationId}|${unit.status}` : "out",
    ]),
  );
}

const held = async (
  productId: string,
  locationId: string,
  status = "AVAILABLE",
) =>
  (
    await db.stockBalance.findFirst({
      where: { productId, locationId, status: status as "AVAILABLE" },
      select: { quantity: true },
    })
  )?.quantity.toString() ?? "0";

const key = () => newId();

afterAll(async () => {
  // Every company left balances, lines and units by serial in agreement.
  for (const organizationId of companies) {
    expect(await reconcileStock(organizationId)).toEqual([]);
  }
  await db.$disconnect();
});

describe("the control by serial", () => {
  it("counts whole units and changes only without stock", async () => {
    const actor = await company();
    expect(
      await createProduct(actor, {
        sku: `SER-${++counter}`,
        name: "Cable",
        unit: "m",
        step: "0.01",
        tracking: "SERIAL",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { step: expect.stringContaining("unidades enteras") },
    });
    const plain = await product(actor, "NONE");
    const general = (await getDefaultLocation(actor))!.id;
    expect(
      await registerEntry(actor, {
        productId: plain,
        locationId: general,
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    const card = { sku: `SER-${counter}`, name: `Equipo ${counter}` };
    expect(
      await updateProduct(actor, plain, { ...card, tracking: "SERIAL" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { tracking: expect.stringContaining("existencias") },
    });
    // A product without serials takes none.
    expect(
      await registerEntry(actor, {
        productId: plain,
        locationId: general,
        quantity: "1",
        serials: "X-1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        serials: expect.stringContaining("no se controla por serie"),
      },
    });
  });
});

describe("what comes in", () => {
  it("names one serial per unit, never one already in stock", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const entry = (quantity: string, serials?: string) =>
      registerEntry(actor, {
        productId,
        locationId: general,
        quantity,
        serials,
      });
    expect(await entry("2")).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("las 2 series") },
    });
    expect(await entry("2", "A-1")).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("Faltan series") },
    });
    expect(await entry("2", "A-1\na-1")).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("dos veces") },
    });
    // A scanner sends Enter after each reading; blank lines do not count.
    const ok = await entry("2", " a-1 \r\n\r\nA-2\n");
    expect(ok).toMatchObject({
      ok: true,
      summary: expect.stringContaining("series A-1 y A-2"),
    });
    expect(await whereAre(productId)).toEqual({
      "A-1": `${general}|AVAILABLE`,
      "A-2": `${general}|AVAILABLE`,
    });
    expect(await held(productId, general)).toBe("2");
    // A serial that is in stock does not come in again.
    expect(await entry("2", "A-2\nA-3")).toMatchObject({
      ok: false,
      fieldErrors: {
        serials: expect.stringContaining("La serie A-2 ya está en existencias"),
      },
    });
    // The initial balance, likewise.
    const other = await product(actor);
    expect(
      await registerInitialBalance(actor, {
        productId: other,
        locationId: general,
        quantity: "1",
        serials: "B-1",
      }),
    ).toMatchObject({ ok: true });
    // Serials are unique per product: another product may repeat one.
    expect(
      await registerEntry(actor, {
        productId: other,
        locationId: general,
        quantity: "1",
        serials: "A-1",
      }),
    ).toMatchObject({ ok: true });
    // The database refuses a line without its serials, whatever the code.
    const movementId = newId();
    await db.stockMovement.create({
      data: {
        id: movementId,
        organizationId: actor.organizationId,
        type: "ENTRY",
        createdByUserId: actor.userId,
      },
    });
    await expect(
      db.stockMovementLine.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          movementId,
          lineNumber: 1,
          productId,
          locationId: general,
          direction: "IN",
          capturedQuantity: "1",
          factor: "1",
          baseQuantity: "1",
          unitCode: "piece",
        },
      }),
    ).rejects.toThrow(/one serial per unit/);
    await expect(
      db.serialUnit.deleteMany({ where: { productId } }),
    ).rejects.toThrow(/never deleted/);
  });
});

describe("what leaves, moves or changes", () => {
  it("names units that are right there; a unit leaves once", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, general, ["S-1", "S-2", "S-3", "S-4"]);

    expect(
      await registerExit(actor, {
        productId,
        locationId: shelf,
        quantity: "1",
        serials: "S-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "1",
        serials: "S-9",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("S-9 no está") },
    });
    const exit = await registerExit(actor, {
      productId,
      locationId: general,
      quantity: "1",
      serials: "S-1",
    });
    expect(exit).toMatchObject({ ok: true });
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "1",
        serials: "S-1",
      }),
    ).toMatchObject({ ok: false });

    // A relocation moves the very units.
    const moved = await registerTransfer(actor, {
      productId,
      locationId: general,
      toLocationId: shelf,
      quantity: "2",
      serials: "S-2\nS-3",
    });
    expect(moved).toMatchObject({ ok: true });
    expect(await whereAre(productId)).toMatchObject({
      "S-1": "out",
      "S-2": `${shelf}|AVAILABLE`,
      "S-3": `${shelf}|AVAILABLE`,
      "S-4": `${general}|AVAILABLE`,
    });
    // The history says which units each movement moved, and the filter by
    // unit finds them (traceability).
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { productId, serial: "S-2" },
    });
    const history = await listMovements(actor, { serialUnitId: unit.id });
    expect(history.items.map((item) => item.type)).toEqual([
      "TRANSFER",
      "ENTRY",
    ]);
    expect(history.items[0]!.lines[0]!.serials).toEqual(["S-2", "S-3"]);

    // A change of state keeps them in place, in the new state.
    expect(
      await changeStockStatus(actor, {
        productId,
        locationId: shelf,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
        serials: "S-3",
        reason: "Pantalla rota",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect((await whereAre(productId))["S-3"]).toBe(`${shelf}|DAMAGED`);
    // A damaged unit does not leave as available.
    expect(
      await registerExit(actor, {
        productId,
        locationId: shelf,
        quantity: "1",
        serials: "S-3",
      }),
    ).toMatchObject({ ok: false });

    // A quick exit with two lines may not name the same unit twice.
    expect(
      await registerQuickExit(actor, {
        reason: "Venta",
        lines: [
          { productId, locationId: shelf, quantity: "1", serials: "S-2" },
          { productId, locationId: shelf, quantity: "1", serials: "S-2" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      lineErrors: { 1: expect.stringContaining("otra línea") },
    });
    expect(
      await registerQuickExit(actor, {
        reason: "Venta",
        lines: [
          { productId, locationId: shelf, quantity: "1", serials: "S-2" },
          { productId, locationId: general, quantity: "1", serials: "S-4" },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(await whereAre(productId)).toMatchObject({
      "S-2": "out",
      "S-4": "out",
    });
  });

  it("two exits of the same unit at once: only one goes through", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    await enter(actor, productId, general, ["C-1", "C-2"]);
    const results = await Promise.all(
      [0, 1].map(() =>
        registerExit(actor, {
          productId,
          locationId: general,
          quantity: "1",
          serials: "C-1",
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await held(productId, general)).toBe("1");
    expect((await whereAre(productId))["C-1"]).toBe("out");
  });

  it("a reversal moves back the very same units", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const shelf = await place(actor, "Estante");
    const entryId = await enter(actor, productId, general, ["R-1", "R-2"]);
    const exit = await registerExit(actor, {
      productId,
      locationId: general,
      quantity: "1",
      serials: "R-1",
    });
    if (!exit.ok) throw new Error(JSON.stringify(exit));
    expect(
      await reverseMovement(actor, {
        movementId: exit.movementId,
        reason: "Se capturó la serie equivocada",
      }),
    ).toMatchObject({ ok: true, summary: expect.stringContaining("R-1") });
    expect((await whereAre(productId))["R-1"]).toBe(`${general}|AVAILABLE`);

    const transfer = await registerTransfer(actor, {
      productId,
      locationId: general,
      toLocationId: shelf,
      quantity: "2",
      serials: "R-1\nR-2",
    });
    if (!transfer.ok) throw new Error(JSON.stringify(transfer));
    expect(
      await reverseMovement(actor, {
        movementId: transfer.movementId,
        reason: "No era ese estante",
      }),
    ).toMatchObject({ ok: true });
    expect(await whereAre(productId)).toEqual({
      "R-1": `${general}|AVAILABLE`,
      "R-2": `${general}|AVAILABLE`,
    });
    // An entry whose units already left cannot be reversed.
    await registerExit(actor, {
      productId,
      locationId: general,
      quantity: "1",
      serials: "R-2",
    });
    expect(
      await reverseMovement(actor, {
        movementId: entryId,
        reason: "Entrada equivocada",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("R-2 ya no está"),
    });
    // A unit that left may come back with an entry (a return), as itself.
    expect(
      await registerEntry(actor, {
        productId,
        locationId: general,
        quantity: "1",
        serials: "r-2",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db.serialUnit.count({ where: { productId, serial: "R-2" } }),
    ).toBe(1);
  });
});

describe("corrections", () => {
  it("an adjustment names every serial there; a count does not take them", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, general, ["J-1", "J-2", "J-3"]);
    await enter(actor, productId, shelf, ["J-9"]);

    // J-2 went missing, J-4 appeared: two lines, one of each.
    const adjust = (quantity: string, serials: string) =>
      registerAdjustment(actor, {
        productId,
        locationId: general,
        quantity,
        serials,
        reason: "Conteo físico",
      });
    expect(await adjust("3", "J-1\nJ-3")).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("Faltan series") },
    });
    // A unit inside somewhere else is relocated, not adjusted.
    expect(await adjust("3", "J-1\nJ-3\nJ-9")).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("otra ubicación") },
    });
    const done = await adjust("3", "J-1\nJ-3\nJ-4");
    expect(done).toMatchObject({
      ok: true,
      summary: expect.stringMatching(
        /Faltaron \(serie J-2\).*Aparecieron \(serie J-4\)/,
      ),
    });
    expect(await whereAre(productId)).toMatchObject({
      "J-2": "out",
      "J-4": `${general}|AVAILABLE`,
    });
    expect(await held(productId, general)).toBe("3");
    if (!done.ok) return;
    const lines = await db.stockMovementLine.findMany({
      where: { movementId: done.movementId },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines.map((line) => line.direction)).toEqual(["OUT", "IN"]);
    // Its reversal undoes both sides.
    expect(
      await reverseMovement(actor, {
        movementId: done.movementId,
        reason: "Se contó mal",
      }),
    ).toMatchObject({ ok: true });
    expect(await whereAre(productId)).toMatchObject({
      "J-2": `${general}|AVAILABLE`,
      "J-4": "out",
    });

    const opened = await openCount(actor, { locationId: general });
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    expect(
      await captureCount(actor, {
        countId: opened.countId,
        productId,
        quantity: "3",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("número de serie"),
    });
  });
});

describe("tasks and picking", () => {
  it("a transfer task moves the units scanned when picking up", async () => {
    const actor = await company();
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, general, ["T-1", "T-2", "T-3"]);
    const task = await createTask(actor, {
      productId,
      fromLocationId: general,
      toLocationId: shelf,
      quantity: "2",
    });
    if (!task.ok) throw new Error(JSON.stringify(task));
    await acceptTask(actor, task.taskId);
    expect(await pickUpTask(actor, task.taskId, {})).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.any(String) },
    });
    expect(
      await pickUpTask(actor, task.taskId, { serials: "T-1\nT-2" }),
    ).toMatchObject({ ok: true });
    // While the task holds them, nobody else takes them.
    expect(
      await registerExit(actor, {
        productId,
        locationId: general,
        quantity: "1",
        serials: "T-1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("ya la tomó la tarea") },
    });
    expect(await deliverTask(actor, task.taskId)).toMatchObject({ ok: true });
    expect(await whereAre(productId)).toEqual({
      "T-1": `${shelf}|AVAILABLE`,
      "T-2": `${shelf}|AVAILABLE`,
      "T-3": `${general}|AVAILABLE`,
    });

    // A task released after a problem lets go of what was scanned.
    const second = await createTask(actor, {
      productId,
      fromLocationId: general,
      toLocationId: shelf,
      quantity: "1",
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    await acceptTask(actor, second.taskId);
    await pickUpTask(actor, second.taskId, { serials: "T-3" });
    await blockTask(actor, second.taskId, "No cabe");
    await releaseTask(actor, second.taskId);
    expect(
      await db.warehouseTaskSerial.count({ where: { taskId: second.taskId } }),
    ).toBe(0);
  });

  it("picking: the serials are scanned at the origin and set aside there", async () => {
    const actor = await company();
    const productId = await product(actor);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, ["P-1", "P-2", "P-3"]);
    const made = await createOutboundOrder(actor, { recipient: "Sucursal" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(actor, made.orderId, { productId, quantity: "2" });
    expect(await releaseOutboundOrder(actor, made.orderId)).toMatchObject({
      ok: true,
    });
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { organizationId: actor.organizationId, kind: "PICK" },
      include: { product: true, fromLocation: true },
    });
    await acceptTask(actor, task.id);
    const confirm = (serials?: string) =>
      confirmPick(actor, task.id, {
        productCode: task.product!.sku,
        locationCode: task.fromLocation.name,
        quantity: "2",
        serials,
      });
    expect(await confirm("P-1")).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("Faltan series") },
    });
    expect(await confirm("P-1\nP-3")).toMatchObject({ ok: true });
    expect(await deliverTask(actor, task.id)).toMatchObject({ ok: true });
    const staging = await db.location.findFirstOrThrow({
      where: { organizationId: actor.organizationId, isStaging: true },
    });
    expect(await whereAre(productId)).toEqual({
      "P-1": `${staging.id}|AVAILABLE`,
      "P-2": `${shelf}|AVAILABLE`,
      "P-3": `${staging.id}|AVAILABLE`,
    });
    // The order says which units were picked for its line.
    const view = await getOutboundOrder(actor, made.orderId);
    expect(view?.tasks[0]?.serials).toEqual(["P-1", "P-3"]);
    expect(view?.status).toBe("PICKED");
  });
});

describe("purchasing", () => {
  it("a receipt names its serials; a return sends back units of that receipt", async () => {
    const actor = await company(["inventory", "purchasing"]);
    const productId = await product(actor);
    const general = (await getDefaultLocation(actor))!.id;
    const supplier = await createSupplier(actor, { name: "Proveedor" });
    if (!supplier.ok) throw new Error("supplier setup failed");
    const order = await createPurchaseOrder(actor, {
      supplierId: supplier.supplierId,
    });
    if (!order.ok) throw new Error("order setup failed");
    const added = await addOrderLine(actor, order.orderId, {
      productId,
      capture: "base",
      quantity: "3",
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
    await submitPurchaseOrder(actor, order.orderId);
    const line = await db.purchaseOrderLine.findFirstOrThrow({
      where: { orderId: order.orderId },
    });
    await enter(actor, productId, general, ["Z-1"]);
    const receive = (quantity: string, serials: string) =>
      receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey: key(),
        locationId: general,
        lines: [{ orderLineId: line.id, quantity, serials }],
      });
    expect(await receive("2", "Z-1\nZ-2")).toMatchObject({
      ok: false,
      lineErrors: { [line.id]: expect.stringContaining("Z-1 ya está") },
      lineFields: { [line.id]: "serials" },
    });
    expect(await receive("2", "Z-2\nZ-3")).toMatchObject({ ok: true });
    const receipt = await db.purchaseReceipt.findFirstOrThrow({
      where: { orderId: order.orderId },
      include: { lines: true },
    });
    const giveBack = (serials: string) =>
      returnToSupplier(actor, receipt.id, {
        idempotencyKey: key(),
        reason: "Llegó dañado",
        lines: [
          { receiptLineId: receipt.lines[0]!.id, quantity: "1", serials },
        ],
      });
    // Z-1 is in stock, but it did not arrive with this receipt.
    expect(await giveBack("Z-1")).toMatchObject({
      ok: false,
      lineErrors: {
        [receipt.lines[0]!.id]: expect.stringContaining(
          "no llegó en esta recepción",
        ),
      },
    });
    expect(await giveBack("Z-3")).toMatchObject({ ok: true });
    expect(await whereAre(productId)).toEqual({
      "Z-1": `${general}|AVAILABLE`,
      "Z-2": `${general}|AVAILABLE`,
      "Z-3": "out",
    });
  });
});

describe("companies and scope", () => {
  it("another company's units do not exist; a zone closed to someone neither", async () => {
    const a = await company();
    const b = await company();
    const productA = await product(a);
    const productB = await product(b);
    const generalA = (await getDefaultLocation(a))!.id;
    const generalB = (await getDefaultLocation(b))!.id;
    await enter(a, productA, generalA, ["K-1"]);
    // The same serial in another company is another unit.
    await enter(b, productB, generalB, ["K-1"]);
    // B cannot take A's unit by naming A's product.
    expect(
      await registerExit(b, {
        productId: productA,
        locationId: generalB,
        quantity: "1",
        serials: "K-1",
      }),
    ).toMatchObject({ ok: false });
    expect((await whereAre(productA))["K-1"]).toBe(`${generalA}|AVAILABLE`);

    const zoneA = await place(a, "Zona A");
    const zoneB = await place(a, "Zona B");
    await enter(a, productA, zoneA, ["K-2"]);
    const limited = await member(a.organizationId, "warehouse");
    const facility = await getActiveFacility(a);
    const scoped = await setMemberScope(a.organizationId, a.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: facility.id, zoneIds: [zoneB] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    await expect(
      registerExit(limited, {
        productId: productA,
        locationId: zoneA,
        quantity: "1",
        serials: "K-2",
      }),
    ).rejects.toThrow();
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { productId: productA, serial: "K-2" },
    });
    expect(
      (await listMovements(limited, { serialUnitId: unit.id })).items,
    ).toEqual([]);
  });
});
