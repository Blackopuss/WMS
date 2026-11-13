import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CROSS_DOCK_MODE,
  CONTAINERS_MODE,
  PUTAWAY_MODE,
  acceptTask,
  cancelOutboundOrder,
  confirmPick,
  createOutboundOrder,
  deliverTask,
  getOutboundOrder,
  reconcileStock,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  getOrderReceipts,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-54 (ADR 0052): with cross-docking on, what arrives at a place «de
// paso» for a released order that waits for it is set aside for its line
// there, with a normal picking task to the staging location; the rest goes
// on to put-away. Off (the default), nothing changes.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${counter + 1}`,
      email: `cruce.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa cruce ${counter}`,
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
      productLimit: 30,
      users: 10,
      modules: ["inventory", "purchasing"],
      validUntil: null,
      reason: "Prueba de cross-docking",
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

/** A company that cross-docks and puts away with tasks, with a shelf. */
async function warehouse(options: { crossDock?: boolean } = {}) {
  const owner = await company();
  const shelf = await createLocation(owner, { level: 3, name: "Estante 1" });
  if (!shelf.ok) throw new Error("location setup failed");
  await setting(owner, PUTAWAY_MODE.key, "tasks");
  if (options.crossDock !== false) {
    await setting(owner, CROSS_DOCK_MODE.key, "on");
  }
  return owner;
}

let skus = 0;
async function product(
  actor: InventoryActor,
  extra: {
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const created = await createProduct(actor, {
    sku: `X-${++skus}`,
    name: `Clavo ${skus}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

/** An order released with nothing (or what there is) set aside. */
async function waitingOrder(
  owner: InventoryActor,
  productId: string,
  quantity: string,
  extra: { priority?: "URGENT"; dueOn?: string } = {},
) {
  const made = await createOutboundOrder(owner, {
    recipient: "Sucursal",
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const line = await setOutboundLine(owner, made.orderId, {
    productId,
    quantity,
  });
  if (!line.ok) throw new Error(JSON.stringify(line));
  const released = await releaseOutboundOrder(owner, made.orderId, {
    takeWhatThereIs: true,
  });
  if (!released.ok) throw new Error(JSON.stringify(released));
  return made.orderId;
}

async function purchase(
  owner: InventoryActor,
  productId: string,
  quantity: string,
) {
  const supplier = await createSupplier(owner, {
    name: `Proveedor ${newId().slice(-6)}`,
  });
  if (!supplier.ok) throw new Error("supplier setup failed");
  const order = await createPurchaseOrder(owner, {
    supplierId: supplier.supplierId,
  });
  if (!order.ok) throw new Error("order setup failed");
  const added = await addOrderLine(owner, order.orderId, {
    productId,
    capture: "base",
    quantity,
  });
  if (!added.ok) throw new Error(JSON.stringify(added));
  const sent = await submitPurchaseOrder(owner, order.orderId);
  if (!sent.ok) throw new Error("submit failed");
  const orderLineId = (await getOrderReceipts(owner, order.orderId))!.lines[0]!
    .orderLineId;
  return { orderId: order.orderId, orderLineId };
}

async function receive(
  owner: InventoryActor,
  bought: { orderId: string; orderLineId: string },
  line: {
    quantity: string;
    damaged?: string;
    lotCode?: string;
    lotExpiresOn?: string;
  },
  extra: { container?: { kind: string } } = {},
) {
  return receivePurchaseOrder(owner, bought.orderId, {
    idempotencyKey: newId(),
    lines: [{ orderLineId: bought.orderLineId, ...line }],
    ...extra,
  });
}

const picks = (organizationId: string) =>
  db.warehouseTask.findMany({
    where: { organizationId, kind: "PICK" },
    orderBy: { number: "asc" },
    include: {
      outboundLine: { select: { orderId: true } },
      fromLocation: { select: { name: true, isDefault: true } },
      toLocation: { select: { isStaging: true } },
    },
  });

const putaways = (organizationId: string) =>
  db.warehouseTask.findMany({
    where: { organizationId, kind: "PUTAWAY" },
    orderBy: { number: "asc" },
  });

const heldFor = async (orderId: string) => {
  const rows = await db.stockReservation.findMany({
    where: {
      state: "ACTIVE",
      sourceType: "outbound_order_line",
      sourceId: {
        in: (
          await db.outboundOrderLine.findMany({
            where: { orderId },
            select: { id: true },
          })
        ).map((line) => line.id),
      },
    },
  });
  return rows.reduce((sum, row) => sum + Number(row.remaining), 0);
};

afterAll(() => db.$disconnect());

describe("cross-docking (WMS-54)", () => {
  it("serves the urgent order first and sends the rest to put-away", async () => {
    const owner = await warehouse();
    const productId = await product(owner);
    const normal = await waitingOrder(owner, productId, "8");
    const urgent = await waitingOrder(owner, productId, "6", {
      priority: "URGENT",
    });
    const bought = await purchase(owner, productId, "20");

    // 10 arrive: 6 to the urgent one, 4 to the other; nothing left.
    const first = await receive(owner, bought, { quantity: "10" });
    expect(first).toMatchObject({ ok: true });
    expect(first.ok && first.crossDock?.map((s) => s.orderId)).toEqual([
      urgent,
      normal,
    ]);
    expect(first.ok && first.summary).toContain("van directo al pedido");
    const tasks = await picks(owner.organizationId);
    expect(
      tasks.map((task) => [
        task.outboundLine!.orderId,
        task.quantity!.toString(),
        task.fromLocation.isDefault,
        task.toLocation.isStaging,
        task.crossDockMovementId !== null,
      ]),
    ).toEqual([
      [urgent, "6", true, true, true],
      [normal, "4", true, true, true],
    ]);
    expect(await heldFor(urgent)).toBe(6);
    expect(await heldFor(normal)).toBe(4);
    expect(await putaways(owner.organizationId)).toEqual([]);

    // 10 more: the normal order still waits for 4; 6 go to put-away.
    const second = await receive(owner, bought, { quantity: "10" });
    expect(second).toMatchObject({ ok: true, status: "RECEIVED" });
    expect(await heldFor(normal)).toBe(8);
    expect(
      (await putaways(owner.organizationId)).map((t) => t.quantity!.toString()),
    ).toEqual(["6"]);

    const view = await getOutboundOrder(owner, normal);
    expect(view!.lineItems[0]).toMatchObject({
      shortText: null,
      crossDockText: expect.stringContaining("8 piezas llegaron con OC-"),
    });
    expect(view!.tasks[0]!.crossDockText).toMatch(/^Llegó con OC-/);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("goes the usual way to picked, packed or not", async () => {
    const owner = await warehouse();
    const productId = await product(owner);
    const orderId = await waitingOrder(owner, productId, "5");
    const bought = await purchase(owner, productId, "5");
    expect(await receive(owner, bought, { quantity: "5" })).toMatchObject({
      ok: true,
    });
    const [task] = await picks(owner.organizationId);
    const sku = (await db.product.findUniqueOrThrow({
      where: { id: productId },
    }))!.sku;
    expect(await acceptTask(owner, task!.id)).toMatchObject({ ok: true });
    expect(
      await confirmPick(owner, task!.id, {
        productCode: sku,
        locationCode: "General",
        quantity: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(owner, task!.id)).toMatchObject({ ok: true });
    const order = await db.outboundOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(order.status).toBe("PICKED");
    // Set aside in staging for its line, as any picked order.
    const staging = await db.location.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isStaging: true },
    });
    const there = await db.stockReservation.findMany({
      where: { productId, state: "ACTIVE" },
    });
    expect(
      there.map((row) => [row.locationId, row.remaining.toString()]),
    ).toEqual([[staging.id, "5"]]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("also serves an order that is already being picked, and a manual entry", async () => {
    const owner = await warehouse();
    const productId = await product(owner);
    const shelf = await db.location.findFirstOrThrow({
      where: { organizationId: owner.organizationId, name: "Estante 1" },
    });
    // 3 on the shelf: the order takes them and waits for 4 more.
    const entered = await registerEntry(owner, {
      productId,
      locationId: shelf.id,
      quantity: "3",
    });
    expect(entered).toMatchObject({ ok: true });
    const orderId = await waitingOrder(owner, productId, "7");
    const [first] = await picks(owner.organizationId);
    expect(await acceptTask(owner, first!.id)).toMatchObject({ ok: true });
    expect(
      (await db.outboundOrder.findUniqueOrThrow({ where: { id: orderId } }))
        .status,
    ).toBe("PICKING");
    // A manual entry to «General» serves it too.
    const general = await db.location.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    const manual = await registerEntry(owner, {
      productId,
      locationId: general.id,
      quantity: "10",
      acceptRepeat: true,
    });
    expect(manual.ok && manual.summary).toContain("directo al pedido");
    expect(await heldFor(orderId)).toBe(7);
    expect(
      (await putaways(owner.organizationId)).map((t) => t.quantity!.toString()),
    ).toEqual(["6"]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("never sends what arrived damaged, on a pallet or of an expired lot", async () => {
    const owner = await warehouse();
    await setting(owner, CONTAINERS_MODE.key, "on");
    const productId = await product(owner);
    const byLot = await product(owner, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    const orderId = await waitingOrder(owner, productId, "10");
    const lotOrder = await waitingOrder(owner, byLot, "10");
    const bought = await purchase(owner, productId, "30");
    // 4 healthy of 6: only those go.
    expect(
      await receive(owner, bought, { quantity: "6", damaged: "2" }),
    ).toMatchObject({ ok: true });
    expect(await heldFor(orderId)).toBe(4);
    // On a pallet: all of it to put-away.
    expect(
      await receive(
        owner,
        bought,
        { quantity: "5" },
        {
          container: { kind: "Tarima" },
        },
      ),
    ).toMatchObject({ ok: true });
    expect(await heldFor(orderId)).toBe(4);
    // An expired lot is not sent (the company does not pick them).
    const lots = await purchase(owner, byLot, "10");
    expect(
      await receive(owner, lots, {
        quantity: "5",
        lotCode: "VIEJO",
        lotExpiresOn: "2020-01-01",
      }),
    ).toMatchObject({ ok: true });
    expect(await heldFor(lotOrder)).toBe(0);
    expect(
      await receive(owner, lots, {
        quantity: "5",
        lotCode: "NUEVO",
        lotExpiresOn: "2099-01-01",
      }),
    ).toMatchObject({ ok: true });
    expect(await heldFor(lotOrder)).toBe(5);
    const lotTask = (await picks(owner.organizationId)).find(
      (task) => task.productId === byLot,
    );
    const nuevo = await db.lot.findFirstOrThrow({
      where: { productId: byLot, code: "NUEVO" },
    });
    expect(lotTask!.lotId).toBe(nuevo.id);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("changes nothing when the company does not cross-dock", async () => {
    const owner = await warehouse({ crossDock: false });
    const productId = await product(owner);
    const made = await createOutboundOrder(owner, { recipient: "Sucursal" });
    if (!made.ok) throw new Error("order setup failed");
    await setOutboundLine(owner, made.orderId, { productId, quantity: "5" });
    // Without anything free, it is not released, as before.
    expect(
      await releaseOutboundOrder(owner, made.orderId, {
        takeWhatThereIs: true,
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    const bought = await purchase(owner, productId, "5");
    expect(await receive(owner, bought, { quantity: "5" })).toMatchObject({
      ok: true,
    });
    expect(await picks(owner.organizationId)).toEqual([]);
    expect(
      (await putaways(owner.organizationId)).map((t) => t.quantity!.toString()),
    ).toEqual(["5"]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("leaves other companies alone", async () => {
    const one = await warehouse();
    const other = await warehouse();
    const mine = await product(one);
    const theirs = await product(other);
    const theirOrder = await waitingOrder(other, theirs, "5");
    await waitingOrder(one, mine, "5");
    const bought = await purchase(one, mine, "5");
    expect(await receive(one, bought, { quantity: "5" })).toMatchObject({
      ok: true,
    });
    expect(await heldFor(theirOrder)).toBe(0);
    expect(await picks(other.organizationId)).toEqual([]);
    expect(await reconcileStock(one.organizationId)).toEqual([]);
    expect(await reconcileStock(other.organizationId)).toEqual([]);
  });

  it("never sets aside twice nor deadlocks while the order is cancelled or another one released", async () => {
    for (let round = 0; round < 3; round++) {
      const owner = await warehouse();
      const productId = await product(owner);
      const cancelled = await waitingOrder(owner, productId, "6");
      // A draft released at the same time as the receipt.
      const draft = await createOutboundOrder(owner, { recipient: "Otra" });
      if (!draft.ok) throw new Error("order setup failed");
      await setOutboundLine(owner, draft.orderId, { productId, quantity: "6" });
      const bought = await purchase(owner, productId, "8");

      const [received, cancel, release] = await Promise.all([
        receive(owner, bought, { quantity: "8" }),
        cancelOutboundOrder(owner, cancelled, "Ya no lo quieren"),
        releaseOutboundOrder(owner, draft.orderId, { takeWhatThereIs: true }),
      ]);
      expect(received).toMatchObject({ ok: true });
      expect(cancel).toMatchObject({ ok: true });
      expect(release).toMatchObject({ ok: true });

      // The cancelled order holds nothing; what is set aside never goes
      // over what there is.
      expect(await heldFor(cancelled)).toBe(0);
      const active = await db.stockReservation.findMany({
        where: { productId, state: "ACTIVE" },
      });
      const held = active.reduce((sum, row) => sum + Number(row.remaining), 0);
      expect(held).toBeLessThanOrEqual(8);
      expect(await heldFor(draft.orderId)).toBeLessThanOrEqual(6);
      const open = await db.warehouseTask.count({
        where: {
          organizationId: owner.organizationId,
          kind: "PICK",
          outboundLine: { orderId: cancelled },
          status: { notIn: ["CANCELLED"] },
        },
      });
      expect(open).toBe(0);
      expect(await reconcileStock(owner.organizationId)).toEqual([]);
    }
  });
});
