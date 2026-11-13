import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  blockTask,
  cancelOutboundOrder,
  cancelTask,
  confirmPick,
  createOutboundOrder,
  deliverTask,
  getOutboundOrder,
  getProductStock,
  getTask,
  pickUpTask,
  reconcileStock,
  registerEntry,
  registerTransfer,
  releaseOutboundOrder,
  releaseTask,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  archiveLocation,
  createLocation,
  editLocation,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-14 (spec 5.2): releasing an order creates its picking tasks — where
// to take each line from, fullest location first — and keeps that stock
// reserved there. The person confirms product, location and quantity;
// the delivery moves what was picked to «Preparación», reserved for the
// order, and releases what was not picked.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `surtido.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén surtido ${counter}`,
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
      reason: "Prueba de surtido",
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

/** A product with 30 pieces in rack A and 20 in rack B. */
async function scenario() {
  const owner = await company();
  const created = await createProduct(owner, {
    sku: `CAJ-${++counter}`,
    name: "Caja de cartón",
    barcode: `750${stamp % 1_000_000}${counter}`.slice(0, 13),
  });
  if (!created.ok) throw new Error("product setup failed");
  const rack = async (name: string) => {
    const result = await createLocation(owner, { level: 3, name });
    if (!result.ok) throw new Error("location setup failed");
    return result.locationId;
  };
  const a = await rack("Rack A");
  const b = await rack("Rack B");
  for (const [locationId, quantity] of [
    [a, "30"],
    [b, "20"],
  ] as const) {
    const entry = await registerEntry(owner, {
      productId: created.productId,
      locationId,
      quantity,
    });
    if (!entry.ok) throw new Error("entry setup failed");
  }
  return { owner, productId: created.productId, a, b };
}

async function released(
  owner: InventoryActor,
  productId: string,
  quantity: string,
  options: { takeWhatThereIs?: boolean } = {},
) {
  const made = await createOutboundOrder(owner, {
    recipient: "Sucursal Norte",
    priority: "URGENT",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  await setOutboundLine(owner, made.orderId, { productId, quantity });
  const result = await releaseOutboundOrder(owner, made.orderId, options);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return made.orderId;
}

const tasksOf = (organizationId: string) =>
  db.warehouseTask.findMany({
    where: { organizationId, kind: "PICK" },
    orderBy: { number: "asc" },
  });

const staging = (organizationId: string) =>
  db.location.findFirstOrThrow({
    where: { organizationId, isStaging: true },
  });

const balanceIn = async (productId: string, locationId: string) =>
  (
    await db.stockBalance.findFirst({
      where: { productId, locationId, status: "AVAILABLE" },
      select: { quantity: true },
    })
  )?.quantity.toString() ?? "0";

/** Takes, confirms and delivers a picking task. */
async function pick(
  actor: InventoryActor,
  taskId: string,
  input: { location: string; quantity: string; shortReason?: string },
) {
  const task = await db.warehouseTask.findUniqueOrThrow({
    where: { id: taskId },
    include: { product: true },
  });
  expect(await acceptTask(actor, taskId)).toMatchObject({ ok: true });
  expect(
    await confirmPick(actor, taskId, {
      productCode: task.product!.sku,
      locationCode: input.location,
      quantity: input.quantity,
      shortReason: input.shortReason,
    }),
  ).toMatchObject({ ok: true });
  return deliverTask(actor, taskId);
}

afterAll(() => db.$disconnect());

describe("releasing an order", () => {
  it("creates its picking tasks, fullest location first, and moves nothing", async () => {
    const { owner, productId, a, b } = await scenario();
    const orderId = await released(owner, productId, "40");
    const tasks = await tasksOf(owner.organizationId);
    const place = await staging(owner.organizationId);
    // At the root, in the widest level, with its own use (WMS-22A).
    expect(place).toMatchObject({
      name: "Preparación",
      type: "STAGING",
      parentId: null,
    });
    expect(
      await db.locationLevel.findUniqueOrThrow({
        where: { id: place.levelId! },
      }),
    ).toMatchObject({ depth: 1, name: "Zona" });
    expect(
      tasks.map((task) => [
        task.fromLocationId,
        task.toLocationId,
        task.quantity!.toString(),
        task.status,
        task.priority,
      ]),
    ).toEqual([
      [a, place.id, "30", "PENDING", "URGENT"],
      [b, place.id, "10", "PENDING", "URGENT"],
    ]);
    // Reserved where it will be taken from; nothing moved.
    const reservations = await db.stockReservation.findMany({
      where: { organizationId: owner.organizationId, state: "ACTIVE" },
      orderBy: { locationId: "asc" },
    });
    expect(
      reservations
        .map((row) => [row.locationId, row.remaining.toString()])
        .sort(),
    ).toEqual(
      [
        [a, "30"],
        [b, "10"],
      ].sort(),
    );
    expect(await balanceIn(productId, a)).toBe("30");
    // A manual move cannot take what is held for the order.
    expect(
      await registerTransfer(owner, {
        productId,
        locationId: a,
        toLocationId: b,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    const order = await getOutboundOrder(owner, orderId);
    expect(order?.tasks.map((task) => task.statusLabel)).toEqual([
      "Disponible",
      "Disponible",
    ]);
    // The staging location is not archived.
    expect(await archiveLocation(owner, place.id)).toMatchObject({
      ok: false,
    });
  });
});

describe("picking", () => {
  it("confirms product, location and quantity, and the order ends picked", async () => {
    const { owner, productId, a, b } = await scenario();
    const operator = await member(owner.organizationId, "operator");
    const orderId = await released(owner, productId, "40");
    const [first, second] = await tasksOf(owner.organizationId);
    const place = await staging(owner.organizationId);

    expect(await acceptTask(operator, first!.id)).toMatchObject({ ok: true });
    expect(await getOutboundOrder(owner, orderId)).toMatchObject({
      status: "PICKING",
    });
    // A plain «picked up» is not enough for a picking task.
    expect(await pickUpTask(operator, first!.id)).toMatchObject({
      ok: false,
    });
    const confirm = (input: Partial<Parameters<typeof confirmPick>[2]>) =>
      confirmPick(operator, first!.id, {
        productCode: "",
        locationCode: "Rack A",
        quantity: "30",
        ...input,
      });
    expect(await confirm({ productCode: "OTRO" })).toMatchObject({
      ok: false,
      fieldErrors: {
        productCode: expect.stringMatching(/Ese no es el producto/),
      },
    });
    const product = await db.product.findUniqueOrThrow({
      where: { id: productId },
    });
    expect(
      await confirm({ productCode: product.sku, locationCode: "Rack B" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        locationCode: "No es la ubicación de la tarea: ve a Rack A.",
      },
    });
    expect(
      await confirm({ productCode: product.sku, quantity: "31" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    // The barcode works as well as the key, and the location's code
    // (WMS-22A) as well as its name.
    expect(await editLocation(owner, a, { code: "ra-01" })).toMatchObject({
      ok: true,
    });
    expect(
      await confirm({ productCode: product.barcode!, locationCode: "ra-01" }),
    ).toMatchObject({ ok: true });

    expect(await deliverTask(operator, first!.id)).toMatchObject({ ok: true });
    expect(await balanceIn(productId, a)).toBe("0");
    expect(await balanceIn(productId, place.id)).toBe("30");
    expect(await getOutboundOrder(owner, orderId)).toMatchObject({
      status: "PICKING",
      lineItems: [{ pickedText: "30 piezas" }],
    });

    expect(
      await pick(operator, second!.id, { location: "Rack B", quantity: "10" }),
    ).toMatchObject({ ok: true });
    expect(await balanceIn(productId, b)).toBe("10");
    expect(await balanceIn(productId, place.id)).toBe("40");
    // Everything picked stays reserved for the order, in Preparación.
    const held = await db.stockReservation.findMany({
      where: { organizationId: owner.organizationId, state: "ACTIVE" },
    });
    expect(
      held.map((row) => [row.locationId, row.remaining.toString()]),
    ).toEqual([
      [place.id, "30"],
      [place.id, "10"],
    ]);
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "50",
      available: "10",
    });
    expect(await getOutboundOrder(owner, orderId)).toMatchObject({
      status: "PICKED",
      lineItems: [{ pickedText: "40 piezas" }],
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a picking task is delivered once, even twice at the same time (PC-6)", async () => {
    const { owner, productId } = await scenario();
    const operator = await member(owner.organizationId, "operator");
    await released(owner, productId, "5");
    const [task] = await tasksOf(owner.organizationId);
    const product = await db.product.findUniqueOrThrow({
      where: { id: productId },
    });
    await acceptTask(operator, task!.id);
    const input = {
      productCode: product.sku,
      locationCode: "Rack A",
      quantity: "5",
    };
    expect(await confirmPick(operator, task!.id, input)).toMatchObject({
      ok: true,
    });
    expect(await confirmPick(operator, task!.id, input)).toMatchObject({
      ok: true,
      repeated: true,
    });
    const results = await Promise.all([
      deliverTask(operator, task!.id),
      deliverTask(operator, task!.id),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && result.repeated),
    ).toHaveLength(1);
    expect(
      await db.stockMovement.count({
        where: { organizationId: owner.organizationId, type: "TRANSFER" },
      }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("picking less needs a reason and frees what was not taken", async () => {
    const { owner, productId, a } = await scenario();
    const operator = await member(owner.organizationId, "operator");
    const orderId = await released(owner, productId, "12");
    const [task] = await tasksOf(owner.organizationId);
    const product = await db.product.findUniqueOrThrow({
      where: { id: productId },
    });
    await acceptTask(operator, task!.id);
    expect(
      await confirmPick(operator, task!.id, {
        productCode: product.sku,
        locationCode: "Rack A",
        quantity: "8",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { shortReason: expect.any(String) },
    });
    expect(
      await confirmPick(operator, task!.id, {
        productCode: product.sku,
        locationCode: "Rack A",
        quantity: "8",
        shortReason: "Cuatro cajas mojadas",
      }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(operator, task!.id)).toMatchObject({ ok: true });
    expect(await balanceIn(productId, a)).toBe("22");
    // 8 held in Preparación for the order; the other 4 are free again.
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "50",
      available: "42",
    });
    const order = await getOutboundOrder(owner, orderId);
    expect(order).toMatchObject({
      status: "PICKED",
      lineItems: [{ pickedText: "8 piezas" }],
      tasks: [{ pickedText: "8 piezas", shortReason: "Cuatro cajas mojadas" }],
    });
    expect(await getTask(owner, task!.id)).toMatchObject({
      kind: "PICK",
      order: { id: orderId, numberText: "PS-0001" },
      pickedText: "8 piezas",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a task with a problem is released for someone else, or cancelled and its stock freed", async () => {
    const { owner, productId } = await scenario();
    const operator = await member(owner.organizationId, "operator");
    const supervisor = await member(owner.organizationId, "supervisor");
    const orderId = await released(owner, productId, "40");
    const [first, second] = await tasksOf(owner.organizationId);
    await pick(operator, first!.id, { location: "Rack A", quantity: "30" });

    await acceptTask(operator, second!.id);
    await blockTask(operator, second!.id, "No encuentro el rack");
    expect(await releaseTask(supervisor, second!.id)).toMatchObject({
      ok: true,
    });
    await acceptTask(operator, second!.id);
    await blockTask(operator, second!.id, "El rack está vacío");
    expect(
      await cancelTask(supervisor, second!.id, "No hay en el rack"),
    ).toMatchObject({ ok: true });
    // The 10 held in rack B are free again; the order is picked with what
    // was taken.
    expect(await getProductStock(owner, productId)).toMatchObject({
      available: "20",
    });
    expect(await getOutboundOrder(owner, orderId)).toMatchObject({
      status: "PICKED",
      lineItems: [{ pickedText: "30 piezas" }],
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("cancelling an order before picking starts cancels its tasks and frees the stock", async () => {
    const { owner, productId } = await scenario();
    const orderId = await released(owner, productId, "40");
    expect(
      await cancelOutboundOrder(owner, orderId, "El cliente ya no lo quiere"),
    ).toMatchObject({ ok: true });
    const tasks = await tasksOf(owner.organizationId);
    expect(tasks.map((task) => task.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);
    expect(await getProductStock(owner, productId)).toMatchObject({
      available: "50",
    });
    expect(
      await db.stockReservation.count({
        where: { organizationId: owner.organizationId, state: "ACTIVE" },
      }),
    ).toBe(0);
  });

  it("only what is free is planned; the staging location is not a source", async () => {
    const { owner, productId } = await scenario();
    const operator = await member(owner.organizationId, "operator");
    // First order picks 30 into Preparación.
    await released(owner, productId, "30");
    const [task] = await tasksOf(owner.organizationId);
    await pick(operator, task!.id, { location: "Rack A", quantity: "30" });
    // A second order for 25 finds only 20 free (rack B) and says so.
    const made = await createOutboundOrder(owner, { recipient: "Otro" });
    if (!made.ok) throw new Error("order setup failed");
    await setOutboundLine(owner, made.orderId, { productId, quantity: "25" });
    expect(await releaseOutboundOrder(owner, made.orderId)).toMatchObject({
      ok: false,
      reason: "short",
      shortages: [{ asked: "25 piezas", free: "20 piezas" }],
    });
    expect(
      await releaseOutboundOrder(owner, made.orderId, {
        takeWhatThereIs: true,
      }),
    ).toMatchObject({ ok: true });
    const tasks = await tasksOf(owner.organizationId);
    expect(tasks.at(-1)?.quantity!.toString()).toBe("20");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a picking task is only done by who has it, with permission", async () => {
    const { owner, productId } = await scenario();
    const operator = await member(owner.organizationId, "operator");
    const viewer = await member(owner.organizationId, "viewer");
    const other = await member(owner.organizationId, "operator");
    await released(owner, productId, "5");
    const [task] = await tasksOf(owner.organizationId);
    await expect(acceptTask(viewer, task!.id)).rejects.toThrow();
    await acceptTask(operator, task!.id);
    expect(
      await confirmPick(other, task!.id, {
        productCode: "x",
        locationCode: "Rack A",
        quantity: "5",
      }),
    ).toMatchObject({
      ok: false,
      formError: "Esta tarea la tiene otra persona.",
    });
    const stranger = await company();
    expect(
      await confirmPick(stranger, task!.id, {
        productCode: "x",
        locationCode: "Rack A",
        quantity: "5",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });
});
