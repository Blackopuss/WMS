import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CUSTOMER_RETURN_WITHOUT_ORDER,
  PUTAWAY_MODE,
  acceptTask,
  changeStockStatus,
  confirmPick,
  countReturnsToReview,
  createOutboundOrder,
  createShipment,
  decideCustomerReturn,
  deliverTask,
  dispatchShipment,
  findReturnableOrders,
  findTraceMatches,
  getCustomerReturn,
  getReturnableOrder,
  listCustomerReturns,
  listMovements,
  receiveCustomerReturn,
  reconcileStock,
  registerEntry,
  registerExit,
  releaseOutboundOrder,
  reverseMovement,
  setOutboundLine,
  traceLot,
  traceSerial,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation, getDefaultLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-17 (ADR 0046): what a customer brings back enters in inspection and
// becomes available, damaged or rejected only by a decision tied to the
// return, with who and why (PC-5). Never more than what left with the
// order; lots and serials come back as themselves; the value adds up.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `devolucion.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company() {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén devoluciones ${counter}`,
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
      reason: "Prueba de devoluciones",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
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
    sku: `DEV-${n}`,
    name: `Artículo ${n}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(actor: InventoryActor, name: string, type?: string) {
  const result = await createLocation(actor, { level: 3, name, type });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: {
    lotCode?: string;
    lotExpiresOn?: string;
    serials?: string;
    unitCost?: string;
  } = {},
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

/** An order released, picked and dispatched: what it took left. */
async function shipped(
  actor: InventoryActor,
  lines: { productId: string; quantity: string }[],
  serialsOf: (productId: string) => string | undefined = () => undefined,
) {
  const made = await createOutboundOrder(actor, {
    recipient: "Cliente Norte",
    address: "Calle 5 de Mayo 12",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  for (const line of lines) {
    const set = await setOutboundLine(actor, made.orderId, line);
    if (!set.ok) throw new Error(JSON.stringify(set));
  }
  const released = await releaseOutboundOrder(actor, made.orderId);
  if (!released.ok) throw new Error(JSON.stringify(released));
  const tasks = await db.warehouseTask.findMany({
    where: { kind: "PICK", outboundLine: { orderId: made.orderId } },
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
  const shipment = await createShipment(actor, { orderIds: [made.orderId] });
  if (!shipment.ok) throw new Error(JSON.stringify(shipment));
  const out = await dispatchShipment(actor, shipment.shipmentId);
  if (!out.ok) throw new Error(JSON.stringify(out));
  return made.orderId;
}

const keyOf = async (orderId: string, productId: string) =>
  (await getReturnableOrderAs(orderId)).rows.find(
    (row) => row.productId === productId,
  )!.key;

let lastActor: InventoryActor | null = null;
async function getReturnableOrderAs(orderId: string) {
  const view = await getReturnableOrder(lastActor!, orderId);
  if (!view) throw new Error("order not returnable");
  return view;
}

const balance = async (productId: string, locationId: string, status: string) =>
  (
    await db.stockBalance.aggregate({
      where: {
        productId,
        locationId,
        status: status as "AVAILABLE",
      },
      _sum: { quantity: true },
    })
  )._sum.quantity?.toString() ?? "0";

async function receive(
  actor: InventoryActor,
  input: Partial<Parameters<typeof receiveCustomerReturn>[1]> & {
    lines: Parameters<typeof receiveCustomerReturn>[1]["lines"];
    locationId: string;
  },
) {
  return receiveCustomerReturn(actor, {
    returnedBy: "Cliente Norte",
    reason: "No lo quiso",
    idempotencyKey: newId(),
    ...input,
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("customer returns (WMS-17)", () => {
  it("PC-5: what comes back is in inspection and only a decision releases it", async () => {
    const owner = await company();
    lastActor = owner;
    const shelf = await place(owner, "Estante A");
    const dock = await place(owner, "Andén de devoluciones", "RECEIVING");
    const item = await product(owner);
    await enter(owner, item, shelf, "10", { unitCost: "10" });
    const orderId = await shipped(owner, [{ productId: item, quantity: "10" }]);

    // Only a shipped order is found, by its number or its shipment's.
    const found = await findReturnableOrders(
      owner,
      (
        await db.outboundOrder.findUniqueOrThrow({ where: { id: orderId } })
      ).number
        .toString()
        .replace(/^/, "PS-"),
    );
    expect(found).toMatchObject({ ok: true, orders: [{ id: orderId }] });

    const received = await receive(owner, {
      orderId,
      locationId: dock,
      lines: [{ key: await keyOf(orderId, item), quantity: "4" }],
    });
    expect(received).toMatchObject({ ok: true });
    if (!received.ok) return;
    expect(await balance(item, dock, "INSPECTION")).toBe("4");
    expect(await balance(item, dock, "AVAILABLE")).toBe("0");

    // It is not available: it cannot leave, be reserved or picked.
    expect(
      await registerExit(owner, {
        productId: item,
        locationId: dock,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    const other = await createOutboundOrder(owner, { recipient: "Otro" });
    if (!other.ok) throw new Error("order");
    await setOutboundLine(owner, other.orderId, {
      productId: item,
      quantity: "1",
    });
    expect(await releaseOutboundOrder(owner, other.orderId)).toMatchObject({
      ok: false,
    });

    // No side path: «Cambiar estado» does not release what the return holds.
    expect(
      await changeStockStatus(owner, {
        productId: item,
        locationId: dock,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "1",
        reason: "Se ve bien",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringMatching(/devolución DV-/) },
    });
    // Nor is its entry reversed.
    expect(
      await reverseMovement(owner, {
        movementId: (
          await db.customerReturn.findUniqueOrThrow({
            where: { id: received.returnId },
          })
        ).movementId,
        reason: "Me equivoqué de cantidad",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await countReturnsToReview(owner)).toBe(1);

    const view = (await getCustomerReturn(owner, received.returnId))!;
    const lineId = view.lines[0]!.id;
    // Damaged needs a reason.
    expect(
      await decideCustomerReturn(owner, {
        returnId: received.returnId,
        lineId,
        outcome: "DAMAGED",
        quantity: "1",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    const key = newId();
    const released = await decideCustomerReturn(owner, {
      returnId: received.returnId,
      lineId,
      outcome: "AVAILABLE",
      quantity: "3",
      toLocationId: shelf,
      idempotencyKey: key,
    });
    expect(released).toMatchObject({ ok: true });
    // The same confirmation again changes nothing.
    expect(
      await decideCustomerReturn(owner, {
        returnId: received.returnId,
        lineId,
        outcome: "AVAILABLE",
        quantity: "3",
        toLocationId: shelf,
        idempotencyKey: key,
      }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await balance(item, shelf, "AVAILABLE")).toBe("3");
    expect(
      await decideCustomerReturn(owner, {
        returnId: received.returnId,
        lineId,
        outcome: "DAMAGED",
        quantity: "2",
        reason: "Caja rota",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    const damaged = await decideCustomerReturn(owner, {
      returnId: received.returnId,
      lineId,
      outcome: "DAMAGED",
      quantity: "1",
      reason: "Caja rota",
      idempotencyKey: newId(),
    });
    expect(damaged).toMatchObject({ ok: true });
    expect(await balance(item, dock, "DAMAGED")).toBe("1");
    expect(await balance(item, dock, "INSPECTION")).toBe("0");

    const after = (await getCustomerReturn(owner, received.returnId))!;
    expect(after.status).toBe("RESOLVED");
    expect(after.lines[0]!.decisions).toHaveLength(2);
    expect(await countReturnsToReview(owner)).toBe(0);
    // A decision is of its document: it is not reversed either.
    const decision = await db.customerReturnDecision.findFirstOrThrow({
      where: { returnId: received.returnId, outcome: "AVAILABLE" },
    });
    expect(
      await reverseMovement(owner, {
        movementId: decision.movementId,
        reason: "Se liberó por error",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    // Every decision is registered with who and why.
    expect(decision.decidedByUserId).toBe(owner.userId);
    expect(decision.reason.length).toBeGreaterThanOrEqual(3);
    // Every unit that is available again came through a decision.
    const intoAvailable = await db.stockMovementLine.aggregate({
      where: {
        organizationId: owner.organizationId,
        productId: item,
        direction: "IN",
        status: "AVAILABLE",
        movement: { type: "STATUS_CHANGE" },
      },
      _sum: { baseQuantity: true },
    });
    expect(intoAvailable._sum.baseQuantity?.toString()).toBe("3");
    const trail = await listAuditTrail(owner.organizationId, { limit: 30 });
    expect(trail.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "inventory.customer_return_received",
        "inventory.customer_return_decided",
      ]),
    );

    // The history shows the entry, with its type.
    const history = await listMovements(owner, { productId: item });
    expect(history.items.map((m) => m.type)).toContain("CUSTOMER_RETURN");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("other stock in inspection is still free to change; what the return holds is not", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const item = await product(owner);
    await enter(owner, item, dock, "12");
    const orderId = await shipped(owner, [{ productId: item, quantity: "5" }]);
    // 2 of what never left go to inspection by hand.
    expect(
      await changeStockStatus(owner, {
        productId: item,
        locationId: dock,
        from: "AVAILABLE",
        to: "INSPECTION",
        quantity: "2",
        reason: "Revisar etiqueta",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    const received = await receive(owner, {
      orderId,
      locationId: dock,
      lines: [{ key: await keyOf(orderId, item), quantity: "3" }],
    });
    expect(received).toMatchObject({ ok: true });
    expect(await balance(item, dock, "INSPECTION")).toBe("5");
    const take = (quantity: string) =>
      changeStockStatus(owner, {
        productId: item,
        locationId: dock,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity,
        reason: "Revisado",
        idempotencyKey: newId(),
      });
    expect(await take("3")).toMatchObject({ ok: false });
    expect(await take("2")).toMatchObject({ ok: true });
    expect(await take("1")).toMatchObject({ ok: false });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("never more than what left, also with two returns at once", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const shelf = await place(owner, "Estante");
    const item = await product(owner);
    await enter(owner, item, shelf, "10");
    const orderId = await shipped(owner, [{ productId: item, quantity: "8" }]);
    const key = await keyOf(orderId, item);
    const tooMuch = await receive(owner, {
      orderId,
      locationId: dock,
      lines: [{ key, quantity: "9" }],
    });
    expect(tooMuch).toMatchObject({
      ok: false,
      lineErrors: { 0: expect.stringMatching(/solo pueden regresar/) },
    });

    const [a, b] = await Promise.all([
      receive(owner, {
        orderId,
        locationId: dock,
        lines: [{ key, quantity: "5" }],
      }),
      receive(owner, {
        orderId,
        locationId: dock,
        lines: [{ key, quantity: "5" }],
      }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(await balance(item, dock, "INSPECTION")).toBe("5");
    const view = await getReturnableOrder(owner, orderId);
    expect(view!.rows[0]!.left).toBe("3");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("refuses an order that has not left, and the same key with something else", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const item = await product(owner);
    await enter(owner, item, dock, "10");
    const pending = await createOutboundOrder(owner, { recipient: "Cliente" });
    if (!pending.ok) throw new Error("order");
    await setOutboundLine(owner, pending.orderId, {
      productId: item,
      quantity: "1",
    });
    expect(
      await receive(owner, {
        orderId: pending.orderId,
        locationId: dock,
        lines: [{ key: "x|", quantity: "1" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await getReturnableOrder(owner, pending.orderId)).toBeNull();

    const orderId = await shipped(owner, [{ productId: item, quantity: "4" }]);
    const line = await keyOf(orderId, item);
    const idempotencyKey = newId();
    const first = await receive(owner, {
      orderId,
      locationId: dock,
      idempotencyKey,
      lines: [{ key: line, quantity: "2" }],
    });
    expect(first).toMatchObject({ ok: true });
    expect(
      await receive(owner, {
        orderId,
        locationId: dock,
        idempotencyKey,
        lines: [{ key: line, quantity: "2" }],
      }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(
      await receive(owner, {
        orderId,
        locationId: dock,
        idempotencyKey,
        lines: [{ key: line, quantity: "1" }],
      }),
    ).toMatchObject({ ok: false, formError: expect.any(String) });
    expect(await balance(item, dock, "INSPECTION")).toBe("2");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a lot comes back to its lot and a serial as the same unit", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const shelf = await place(owner, "Estante");
    const byLot = await product(owner, { tracking: "LOT" });
    const bySerial = await product(owner, { tracking: "SERIAL" });
    await enter(owner, byLot, shelf, "6", { lotCode: "L-77" });
    await enter(owner, bySerial, shelf, "3", { serials: "S1\nS2\nS3" });
    const orderId = await shipped(
      owner,
      [
        { productId: byLot, quantity: "6" },
        { productId: bySerial, quantity: "2" },
      ],
      (id) => (id === bySerial ? "S1\nS2" : undefined),
    );
    const view = (await getReturnableOrder(owner, orderId))!;
    const serialRow = view.rows.find((row) => row.productId === bySerial)!;
    expect(serialRow.serials.sort()).toEqual(["S1", "S2"]);
    const lotRow = view.rows.find((row) => row.productId === byLot)!;

    // A serial that did not leave with this order is refused.
    expect(
      await receive(owner, {
        orderId,
        locationId: dock,
        lines: [{ key: serialRow.key, quantity: "1", serials: "S3" }],
      }),
    ).toMatchObject({
      ok: false,
      lineErrors: { 0: expect.stringMatching(/no salió/) },
    });
    const received = await receive(owner, {
      orderId,
      locationId: dock,
      lines: [
        { key: lotRow.key, quantity: "2" },
        { key: serialRow.key, quantity: "1", serials: "S1" },
      ],
    });
    expect(received).toMatchObject({ ok: true });
    if (!received.ok) return;
    const lot = await db.lot.findFirstOrThrow({ where: { productId: byLot } });
    expect(
      (
        await db.stockBalance.findFirstOrThrow({
          where: { productId: byLot, locationId: dock },
        })
      ).lotId,
    ).toBe(lot.id);
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { productId: bySerial, serial: "S1" },
    });
    expect(unit).toMatchObject({ locationId: dock, status: "INSPECTION" });
    // Already back: not again.
    expect(
      await receive(owner, {
        orderId,
        locationId: dock,
        lines: [{ key: serialRow.key, quantity: "1", serials: "S1" }],
      }),
    ).toMatchObject({ ok: false });

    // Tracing the lot and the unit says they came back.
    const lotTrace = await traceLot(owner, lot.id);
    expect(lotTrace?.returns).toEqual([
      expect.objectContaining({ numberText: expect.stringMatching(/^DV-/) }),
    ]);
    const serialTrace = await traceSerial(owner, unit.id);
    expect(serialTrace?.returns).toHaveLength(1);
    const number = (await getCustomerReturn(owner, received.returnId))!
      .numberText;
    expect((await findTraceMatches(owner, number)).matches).toEqual([
      expect.objectContaining({
        kind: "customer_return",
        id: received.returnId,
      }),
    ]);

    // The serial cannot be released on the side; the return decides it.
    expect(
      await changeStockStatus(owner, {
        productId: bySerial,
        locationId: dock,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "1",
        serials: "S1",
        reason: "Funciona",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    const card = (await getCustomerReturn(owner, received.returnId))!;
    const serialLine = card.lines.find((l) => l.productId === bySerial)!;
    expect(serialLine.pendingSerials).toEqual(["S1"]);
    expect(
      await decideCustomerReturn(owner, {
        returnId: received.returnId,
        lineId: serialLine.id,
        outcome: "REJECTED",
        quantity: "1",
        reason: "No enciende",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db.serialUnit.findUniqueOrThrow({ where: { id: unit.id } }),
    ).toMatchObject({ status: "REJECTED" });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("without an order: product, quantity and lot, at the average cost; the company may forbid it", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const item = await product(owner, { tracking: "LOT" });
    await enter(owner, item, dock, "4", { lotCode: "A1", unitCost: "20" });
    const received = await receive(owner, {
      locationId: dock,
      returnedBy: "Mostrador",
      lines: [{ productId: item, quantity: "2", lotCode: "B9" }],
    });
    expect(received).toMatchObject({ ok: true });
    const line = await db.stockMovementLine.findFirstOrThrow({
      where: { movement: { type: "CUSTOMER_RETURN" }, productId: item },
    });
    expect(line.status).toBe("INSPECTION");
    expect(line.unitCost?.toString()).toBe("20");
    expect(await db.lot.count({ where: { productId: item } })).toBe(2);

    await setting(owner, CUSTOMER_RETURN_WITHOUT_ORDER.key, "forbid");
    expect(
      await receive(owner, {
        locationId: dock,
        lines: [{ productId: item, quantity: "1", lotCode: "B9" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("comes back at the cost it left with, and the value adds up", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const shelf = await place(owner, "Estante");
    const item = await product(owner);
    await enter(owner, item, shelf, "10", { unitCost: "10" });
    const orderId = await shipped(owner, [{ productId: item, quantity: "10" }]);
    // The cost moves after it left.
    await enter(owner, item, shelf, "10", { unitCost: "30" });
    const received = await receive(owner, {
      orderId,
      locationId: dock,
      lines: [{ key: await keyOf(orderId, item), quantity: "5" }],
    });
    expect(received).toMatchObject({ ok: true });
    const line = await db.stockMovementLine.findFirstOrThrow({
      where: { movement: { type: "CUSTOMER_RETURN" }, productId: item },
    });
    expect(line.unitCost?.toString()).toBe("10");
    const cost = await db.productCost.findFirstOrThrow({
      where: { productId: item },
    });
    // 10 × 30 + 5 × 10 = 350 for 15 units.
    expect(cost.stockValue.toString()).toBe("350");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("released in a place «de paso» with put-away by tasks gets its task", async () => {
    const owner = await company();
    lastActor = owner;
    await setting(owner, PUTAWAY_MODE.key, "tasks");
    const shelf = await place(owner, "Estante");
    const general = (await getDefaultLocation(owner))!.id;
    const item = await product(owner);
    await enter(owner, item, shelf, "5");
    const orderId = await shipped(owner, [{ productId: item, quantity: "5" }]);
    const received = await receive(owner, {
      orderId,
      locationId: general,
      lines: [{ key: await keyOf(orderId, item), quantity: "2" }],
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    // Nothing to put away while it is in inspection.
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
      }),
    ).toBe(0);
    const card = (await getCustomerReturn(owner, received.returnId))!;
    const decided = await decideCustomerReturn(owner, {
      returnId: received.returnId,
      lineId: card.lines[0]!.id,
      outcome: "AVAILABLE",
      quantity: "2",
      idempotencyKey: newId(),
    });
    expect(decided).toMatchObject({
      ok: true,
      summary: expect.stringMatching(/tarea de acomodo/),
    });
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
      }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("who receives is not who decides; another company sees nothing", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const item = await product(owner);
    await enter(owner, item, dock, "5");
    const orderId = await shipped(owner, [{ productId: item, quantity: "3" }]);
    const operator = await member(owner.organizationId, "operator");
    const received = await receive(operator, {
      orderId,
      locationId: dock,
      lines: [{ key: await keyOf(orderId, item), quantity: "1" }],
    });
    expect(received).toMatchObject({ ok: true });
    if (!received.ok) return;
    const card = (await getCustomerReturn(operator, received.returnId))!;
    await expect(
      decideCustomerReturn(operator, {
        returnId: received.returnId,
        lineId: card.lines[0]!.id,
        outcome: "AVAILABLE",
        quantity: "1",
        idempotencyKey: newId(),
      }),
    ).rejects.toThrow();
    const viewer = await member(owner.organizationId, "viewer");
    await expect(
      receive(viewer, {
        locationId: dock,
        lines: [{ productId: item, quantity: "1" }],
      }),
    ).rejects.toThrow();
    expect((await listCustomerReturns(viewer)).total).toBe(1);

    const stranger = await company();
    expect(await getCustomerReturn(stranger, received.returnId)).toBeNull();
    expect(await getReturnableOrder(stranger, orderId)).toBeNull();
    const strangerDock = await place(stranger, "Recepción", "RECEIVING");
    expect(
      await receive(stranger, {
        orderId,
        locationId: strangerDock,
        lines: [{ key: await keyOf(orderId, item), quantity: "1" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await decideCustomerReturn(stranger, {
        returnId: received.returnId,
        lineId: card.lines[0]!.id,
        outcome: "AVAILABLE",
        quantity: "1",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("the database keeps the rules: in inspection, immutable, never more decided than returned", async () => {
    const owner = await company();
    lastActor = owner;
    const dock = await place(owner, "Recepción", "RECEIVING");
    const item = await product(owner);
    await enter(owner, item, dock, "5");
    const orderId = await shipped(owner, [{ productId: item, quantity: "2" }]);
    const received = await receive(owner, {
      orderId,
      locationId: dock,
      lines: [{ key: await keyOf(orderId, item), quantity: "2" }],
    });
    if (!received.ok) throw new Error("receive");
    const line = await db.customerReturnLine.findFirstOrThrow({
      where: { returnId: received.returnId },
    });
    await expect(
      db.customerReturnLine.update({
        where: { id: line.id },
        data: { quantity: "1" },
      }),
    ).rejects.toThrow();
    await expect(
      db.customerReturn.update({
        where: { id: received.returnId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      db.customerReturn.delete({ where: { id: received.returnId } }),
    ).rejects.toThrow();
  });
});

describe("notices (WMS-39)", () => {
  it("who may decide a return hears it is waiting", async () => {
    const owner = await company();
    const dock = await place(owner, "Recepción", "RECEIVING");
    const item = await product(owner);
    const operator = await member(owner.organizationId, "operator");
    const supervisor = await member(owner.organizationId, "supervisor");
    const viewer = await member(owner.organizationId, "viewer");
    const received = await receive(operator, {
      locationId: dock,
      lines: [{ productId: item, quantity: "2" }],
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    const noticesOf = (actor: InventoryActor) =>
      db.notification.findMany({
        where: {
          organizationId: owner.organizationId,
          recipientUserId: actor.userId,
          typeKey: "inventory.customer_return",
          href: `/pedidos/devoluciones/${received.returnId}`,
        },
      });
    expect(await noticesOf(supervisor)).toHaveLength(1);
    expect(await noticesOf(owner)).toHaveLength(1);
    // Who received it and who may not decide it do not.
    expect(await noticesOf(operator)).toHaveLength(0);
    expect(await noticesOf(viewer)).toHaveLength(0);
    const [notice] = await noticesOf(supervisor);
    expect(notice!.text).toMatch(
      /devolución DV-\d{4} \(1 producto\) en Recepción: está por revisar/,
    );
  });
});
