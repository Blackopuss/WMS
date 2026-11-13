import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import {
  CAPACITY_MODE,
  PUTAWAY_MODE,
  PUTAWAY_PREFERENCE,
  TASK_HOLD,
  acceptTask,
  cancelTask,
  countMyTasks,
  createPendingPutawayTasks,
  createTask,
  deliverTask,
  getProductStock,
  getTask,
  listTasks,
  listUnplacedStock,
  pickUpTask,
  putawayTarget,
  reconcileStock,
  registerEntry,
  registerExit,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  createLocation,
  getDefaultLocation,
  setLocationLimits,
  type LocationLimitsInput,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-52 (ADR 0042): with put-away by tasks, what arrives at a place «de
// paso» gets a task that recommends where to keep it; the person confirms
// by scanning where they left it. With the default (by hand) nothing changes.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `acomodo.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory"],
): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa acomodo ${counter}`,
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
      reason: "Prueba de acomodo",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role = "operator",
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

async function setting(actor: InventoryActor, key: string, value: string) {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

const withTasks = (actor: InventoryActor) =>
  setting(actor, PUTAWAY_MODE.key, "tasks");

async function product(
  actor: InventoryActor,
  extra: {
    name?: string;
    category?: string;
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const sku = `ACO-${++counter}`;
  const made = await createProduct(actor, {
    sku,
    name: extra.name ?? `Artículo ${sku}`,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

/** A location: level 1 = zone, 3 = shelf (the default levels). */
async function place(
  actor: InventoryActor,
  name: string,
  options: {
    level?: number;
    parentId?: string;
    type?: string;
    code?: string;
    limits?: LocationLimitsInput;
  } = {},
) {
  const made = await createLocation(actor, {
    level: options.level ?? 3,
    name,
    parentId: options.parentId,
    type: options.type,
    code: options.code,
    limits: options.limits,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

const generalOf = async (actor: InventoryActor) =>
  (await getDefaultLocation(actor))!.id;

/** An entry that must go through, whatever warning it meets. */
async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: { lotCode?: string; serials?: string } = {},
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    ...extra,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}

const putawayTasks = (actor: InventoryActor) =>
  db.warehouseTask.findMany({
    where: { organizationId: actor.organizationId, kind: "PUTAWAY" },
    orderBy: { number: "asc" },
  });

const stockAt = async (locationId: string, productId: string) => {
  const rows = await db.stockBalance.findMany({
    where: { locationId, productId },
    select: { quantity: true },
  });
  return rows.reduce((sum, row) => sum.plus(row.quantity.toString()), dec(0));
};

const recommend = (
  actor: InventoryActor,
  input: {
    productId: string;
    lotId?: string | null;
    quantity: string;
    fromLocationId: string;
  },
) =>
  forOrganization(actor.organizationId).$transaction(async (tx) => {
    const card = await tx.product.findFirstOrThrow({
      where: { id: input.productId },
      select: { categoryId: true },
    });
    const from = await tx.location.findFirstOrThrow({
      where: { id: input.fromLocationId },
      select: { facilityId: true },
    });
    return putawayTarget(tx, {
      userId: actor.userId,
      productId: input.productId,
      categoryId: card.categoryId,
      lotId: input.lotId ?? null,
      quantity: dec(input.quantity),
      fromLocationId: input.fromLocationId,
      facilityId: from.facilityId,
    });
  });

/** Takes the task, picks the load up and leaves it where `code` says. */
async function putAway(
  actor: InventoryActor,
  taskId: string,
  code: string,
  extra: { serials?: string; acceptCapacity?: boolean } = {},
) {
  expect(await acceptTask(actor, taskId)).toMatchObject({ ok: true });
  expect(
    await pickUpTask(actor, taskId, { serials: extra.serials }),
  ).toMatchObject({ ok: true });
  return deliverTask(actor, taskId, {
    locationCode: code,
    acceptCapacity: extra.acceptCapacity,
  });
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("putawayTarget, a known scenario", () => {
  it("same product, then category, then the emptiest; capacity and restrictions count; none = null", async () => {
    const actor = await company();
    const general = await generalOf(actor);
    const bolt = await product(actor, { category: "Categoría A" });
    const nut = await product(actor, { category: "Categoría A" });
    const other = await product(actor, { category: "Categoría B" });
    const same = await place(actor, "Estante 1");
    const family = await place(actor, "Estante 2");
    const empty = await place(actor, "Estante 3");
    const crowded = await place(actor, "Estante 4");
    // Never recommended: a receiving place, a quarantine and a zone with
    // shelves inside (only leaves are).
    await place(actor, "Andén", { type: "RECEIVING" });
    await place(actor, "Cuarentena", { type: "QUARANTINE" });
    const zone = await place(actor, "Zona Z", { level: 1 });
    const inZone = await place(actor, "Estante Z1", { parentId: zone });
    await enter(actor, bolt, same, "3");
    await enter(actor, nut, family, "2");
    await enter(actor, other, crowded, "50");
    await enter(actor, other, inZone, "60");

    const ask = () =>
      recommend(actor, {
        productId: bolt,
        quantity: "5",
        fromLocationId: general,
      });
    expect(await ask()).toEqual({ locationId: same });

    // The place of the same product would go over its capacity.
    expect(
      await setLocationLimits(actor, same, { maxUnits: "6" }),
    ).toMatchObject({ ok: true });
    expect(await ask()).toEqual({ locationId: family });

    // The place of its category only admits another product.
    const otherSku = (
      await db.product.findUniqueOrThrow({ where: { id: other } })
    ).sku;
    expect(
      await setLocationLimits(actor, family, { products: otherSku }),
    ).toMatchObject({ ok: true });
    expect(await ask()).toEqual({ locationId: empty });

    // The company prefers the emptiest: same answer here, by units only.
    await setting(actor, PUTAWAY_PREFERENCE.key, "emptiest");
    expect(await ask()).toEqual({ locationId: empty });
    await setting(actor, PUTAWAY_PREFERENCE.key, "together");

    // Nowhere admits it: no recommendation, never an invented one.
    for (const id of [empty, crowded, inZone]) {
      expect(
        await setLocationLimits(actor, id, { products: otherSku }),
      ).toMatchObject({ ok: true });
    }
    expect(await ask()).toBeNull();

    // A task is still created, without a place; the person chooses.
    await withTasks(actor);
    await enter(actor, bolt, general, "5");
    const [task] = await putawayTasks(actor);
    expect(task).toMatchObject({
      fromLocationId: general,
      toLocationId: general,
      status: "PENDING",
    });
    expect(await getTask(actor, task!.id)).toMatchObject({
      kind: "PUTAWAY",
      recommendedPath: null,
      toPath: "Sin lugar recomendado",
    });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("a product by lot goes next to the same lot first", async () => {
    const actor = await company();
    const general = await generalOf(actor);
    const lotted = await product(actor, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    const otherLot = await place(actor, "Estante A");
    const sameLot = await place(actor, "Estante B");
    await enter(actor, lotted, otherLot, "1", { lotCode: "L-1" });
    await enter(actor, lotted, sameLot, "9", { lotCode: "L-2" });
    const lot = await db.lot.findFirstOrThrow({
      where: { organizationId: actor.organizationId, code: "L-2" },
    });
    expect(
      await recommend(actor, {
        productId: lotted,
        lotId: lot.id,
        quantity: "4",
        fromLocationId: general,
      }),
    ).toEqual({ locationId: sameLot });
  }, 30_000);
});

describe("tasks when goods arrive", () => {
  it("by hand (the default) nothing changes", async () => {
    const actor = await company(["inventory", "purchasing"]);
    const general = await generalOf(actor);
    const item = await product(actor);
    await place(actor, "Estante 1");
    await enter(actor, item, general, "10");
    const orderId = await sentOrder(actor, [
      { productId: item, quantity: "4" },
    ]);
    const received = await receivePurchaseOrder(actor, orderId, {
      idempotencyKey: newId(),
    });
    expect(received).toMatchObject({ ok: true });
    expect(JSON.stringify(received)).not.toContain("acomodo");
    expect(await putawayTasks(actor)).toHaveLength(0);
    const list = await listUnplacedStock(actor);
    expect(list).toMatchObject({ withTasks: false, total: 1 });
    expect(list.items[0]).toMatchObject({ quantity: "14", task: null });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("a receipt creates a task per line and nothing waits without one; the goods are held for it", async () => {
    const actor = await company(["inventory", "purchasing"]);
    await withTasks(actor);
    const general = await generalOf(actor);
    const one = await product(actor);
    const two = await product(actor);
    const shelf = await place(actor, "Estante 1", { code: "E-01" });
    const orderId = await sentOrder(actor, [
      { productId: one, quantity: "4" },
      { productId: two, quantity: "6" },
    ]);
    const received = await receivePurchaseOrder(actor, orderId, {
      idempotencyKey: newId(),
    });
    expect(received).toMatchObject({ ok: true });
    expect(JSON.stringify(received)).toContain(
      "Se crearon 2 tareas de acomodo",
    );
    const tasks = await putawayTasks(actor);
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task).toMatchObject({
        kind: "PUTAWAY",
        status: "PENDING",
        fromLocationId: general,
        toLocationId: shelf,
      });
    }
    // Nothing waits without its task.
    const list = await listUnplacedStock(actor);
    expect(list.withTasks).toBe(true);
    expect(list.items.every((row) => row.task?.covers)).toBe(true);
    // Held in its place: nobody takes it out by another way…
    expect(
      await registerExit(actor, {
        productId: one,
        locationId: general,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("apartado") },
    });
    // …but it is still available stock of the product (nothing to buy).
    expect(await getProductStock(actor, one)).toMatchObject({
      available: "4",
      reserved: "0",
    });
    // It counts for the people of the warehouse like any task.
    const operator = await member(actor.organizationId);
    expect(await countMyTasks(operator)).toMatchObject({ available: 2 });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("an entry to a place «de paso» creates its task; to a storage place it does not", async () => {
    const actor = await company();
    await withTasks(actor);
    const dock = await place(actor, "Andén 1", { type: "RECEIVING" });
    const shelf = await place(actor, "Estante 1");
    const item = await product(actor);
    const entry = await enter(actor, item, dock, "8");
    expect(entry.summary).toContain("Se creó la tarea de acomodo T-");
    await enter(actor, item, shelf, "3");
    const tasks = await putawayTasks(actor);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      fromLocationId: dock,
      toLocationId: shelf,
      quantity: expect.anything(),
    });
    expect(tasks[0]!.quantity!.toString()).toBe("8");
  }, 30_000);

  it("a warehouse with nowhere to keep goods gets no task", async () => {
    const actor = await company();
    await withTasks(actor);
    const item = await product(actor);
    await enter(actor, item, await generalOf(actor), "5");
    expect(await putawayTasks(actor)).toHaveLength(0);
  }, 30_000);
});

describe("confirming a put-away", () => {
  async function ready() {
    const actor = await company();
    await withTasks(actor);
    const general = await generalOf(actor);
    const item = await product(actor);
    const shelf = await place(actor, "Estante 1", { code: "E-01" });
    const other = await place(actor, "Estante 2", { code: "E-02" });
    await enter(actor, item, general, "10");
    const [task] = await putawayTasks(actor);
    return { actor, general, item, shelf, other, taskId: task!.id };
  }

  it("scanning the recommended place moves it once; again is a repeat", async () => {
    const { actor, general, item, shelf, taskId } = await ready();
    const operator = await member(actor.organizationId);
    const done = await putAway(operator, taskId, "e-01");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.stringify(done)).toContain("Acomodaste 10 piezas");
    expect(
      await deliverTask(operator, taskId, { locationCode: "E-01" }),
    ).toMatchObject({ ok: true, repeated: true });
    const task = await db.warehouseTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(task).toMatchObject({
      status: "DELIVERED",
      placedLocationId: shelf,
    });
    expect(
      await db.stockMovement.count({
        where: { organizationId: actor.organizationId, type: "TRANSFER" },
      }),
    ).toBe(1);
    expect((await stockAt(shelf, item)).toString()).toBe("10");
    expect((await stockAt(general, item)).toString()).toBe("0");
    expect(
      await db.stockReservation.count({
        where: { sourceType: TASK_HOLD, sourceId: taskId, state: "ACTIVE" },
      }),
    ).toBe(0);
    expect(await getTask(operator, taskId)).toMatchObject({
      placedPath: expect.stringContaining("Estante 1"),
      toPath: expect.stringContaining("Estante 1"),
    });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("two people at once: one takes it; two deliveries at once: one moves", async () => {
    const { actor, taskId } = await ready();
    const first = await member(actor.organizationId);
    const second = await member(actor.organizationId);
    const taken = await Promise.all([
      acceptTask(first, taskId),
      acceptTask(second, taskId),
    ]);
    expect(taken.filter((answer) => answer.ok)).toHaveLength(1);
    const owner = taken[0]!.ok ? first : second;
    expect(await pickUpTask(owner, taskId)).toMatchObject({ ok: true });
    const delivered = await Promise.all([
      deliverTask(owner, taskId, { locationCode: "E-01" }),
      deliverTask(owner, taskId, { locationCode: "E-01" }),
    ]);
    expect(delivered.every((answer) => answer.ok)).toBe(true);
    expect(
      delivered.filter((answer) => answer.ok && answer.repeated),
    ).toHaveLength(1);
    expect(
      await db.stockMovement.count({
        where: { organizationId: actor.organizationId, type: "TRANSFER" },
      }),
    ).toBe(1);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("another place: admitted by path or name and recorded; refused when it does not admit it", async () => {
    const { actor, shelf, other, taskId } = await ready();
    const another = await product(actor);
    const anotherSku = (
      await db.product.findUniqueOrThrow({ where: { id: another } })
    ).sku;
    await place(actor, "Estante 3", { limits: { products: anotherSku } });
    expect(await acceptTask(actor, taskId)).toMatchObject({ ok: true });
    expect(await pickUpTask(actor, taskId)).toMatchObject({ ok: true });
    // Nothing typed, nowhere known, a place «de paso», a restricted one.
    expect(await deliverTask(actor, taskId, {})).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("Escanea") },
    });
    expect(
      await deliverTask(actor, taskId, { locationCode: "NO-EXISTE" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("No encontramos") },
    });
    expect(
      await deliverTask(actor, taskId, { locationCode: "General" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("Sigue en") },
    });
    expect(
      await deliverTask(actor, taskId, { locationCode: "Estante 3" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        locationCode: expect.stringContaining("solo admite ciertos productos"),
      },
    });
    // Over a capacity the company warns about: asked, then accepted.
    expect(
      await setLocationLimits(actor, other, { maxUnits: "4" }),
    ).toMatchObject({ ok: true });
    expect(
      await deliverTask(actor, taskId, { locationCode: "estante 2" }),
    ).toMatchObject({ ok: false, reason: "over_capacity" });
    const done = await deliverTask(actor, taskId, {
      locationCode: "Estante 2",
      acceptCapacity: true,
    });
    expect(done).toMatchObject({ ok: true });
    const task = await db.warehouseTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    // The recommendation stays; where it really went is recorded.
    expect(task).toMatchObject({
      toLocationId: shelf,
      placedLocationId: other,
    });
    expect(await getTask(actor, taskId)).toMatchObject({
      recommendedPath: expect.stringContaining("Estante 1"),
      placedPath: expect.stringContaining("Estante 2"),
    });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("blocked by the company, another place over its capacity is refused", async () => {
    const { actor, other, taskId } = await ready();
    await setting(actor, CAPACITY_MODE.key, "block");
    expect(
      await setLocationLimits(actor, other, { maxUnits: "4" }),
    ).toMatchObject({ ok: true });
    expect(
      await putAway(actor, taskId, "E-02", { acceptCapacity: true }),
    ).toMatchObject({ ok: false });
    expect(
      (await db.warehouseTask.findUniqueOrThrow({ where: { id: taskId } }))
        .status,
    ).toBe("PICKED_UP");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("cancelling lets the goods go; «Crear tareas de acomodo» covers them again, once", async () => {
    const { actor, general, item, taskId } = await ready();
    expect(
      await cancelTask(actor, taskId, "Se acomodará después"),
    ).toMatchObject({ ok: true });
    expect(
      await db.stockReservation.count({
        where: { sourceType: TASK_HOLD, sourceId: taskId, state: "ACTIVE" },
      }),
    ).toBe(0);
    expect((await listUnplacedStock(actor)).items[0]).toMatchObject({
      task: null,
    });
    // It can leave by hand again.
    expect(
      await registerExit(actor, {
        productId: item,
        locationId: general,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(await createPendingPutawayTasks(actor)).toMatchObject({
      ok: true,
      created: 1,
    });
    expect(await createPendingPutawayTasks(actor)).toMatchObject({
      ok: true,
      created: 0,
    });
    const open = (await putawayTasks(actor)).filter(
      (task) => task.status === "PENDING",
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.quantity!.toString()).toBe("9");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("what was already waiting", () => {
  it("covers what waits before turning tasks on; at once twice, still once", async () => {
    const actor = await company();
    const general = await generalOf(actor);
    const dock = await place(actor, "Andén", { type: "RECEIVING" });
    await place(actor, "Estante 1");
    const one = await product(actor);
    const two = await product(actor);
    await enter(actor, one, general, "5");
    await enter(actor, two, dock, "7");
    expect(await createPendingPutawayTasks(actor)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("apagadas"),
    });
    await withTasks(actor);
    const both = await Promise.all([
      createPendingPutawayTasks(actor),
      createPendingPutawayTasks(actor),
    ]);
    expect(
      both.reduce((sum, answer) => sum + (answer.ok ? answer.created : 0), 0),
    ).toBe(2);
    expect(await putawayTasks(actor)).toHaveLength(2);
    // Who may not create tasks is told so by the service.
    const operator = await member(actor.organizationId, "operator");
    await expect(createPendingPutawayTasks(operator)).rejects.toThrow();
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("lots and serials", () => {
  it("a task of a product by lot carries its lot and moves it", async () => {
    const actor = await company();
    await withTasks(actor);
    const general = await generalOf(actor);
    const shelf = await place(actor, "Estante 1", { code: "L-E1" });
    const lotted = await product(actor, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    await enter(actor, lotted, general, "6", { lotCode: "L-77" });
    const [task] = await putawayTasks(actor);
    const lot = await db.lot.findFirstOrThrow({
      where: { organizationId: actor.organizationId, code: "L-77" },
    });
    expect(task).toMatchObject({ lotId: lot.id, toLocationId: shelf });
    expect(await putAway(actor, task!.id, "L-E1")).toMatchObject({ ok: true });
    expect(
      await db.stockBalance.findFirst({
        where: { locationId: shelf, productId: lotted, lotId: lot.id },
        select: { quantity: true },
      }),
    ).toMatchObject({ quantity: expect.anything() });
    expect((await stockAt(shelf, lotted)).toString()).toBe("6");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("a task of a product by serial scans its units and moves exactly those", async () => {
    const actor = await company();
    await withTasks(actor);
    const general = await generalOf(actor);
    const shelf = await place(actor, "Estante 1", { code: "S-E1" });
    const unit = await product(actor, { tracking: "SERIAL" });
    await enter(actor, unit, general, "2", { serials: "SN-1\nSN-2" });
    const [task] = await putawayTasks(actor);
    expect(await acceptTask(actor, task!.id)).toMatchObject({ ok: true });
    expect(
      await pickUpTask(actor, task!.id, { serials: "SN-9" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.any(String) },
    });
    expect(
      await pickUpTask(actor, task!.id, { serials: "sn-1\nsn-2" }),
    ).toMatchObject({ ok: true });
    expect(
      await deliverTask(actor, task!.id, { locationCode: "S-E1" }),
    ).toMatchObject({ ok: true });
    const units = await db.serialUnit.findMany({
      where: { organizationId: actor.organizationId, productId: unit },
      select: { locationId: true },
    });
    expect(units.map((row) => row.locationId)).toEqual([shelf, shelf]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("between companies and zones", () => {
  it("a task of another company does not exist; its places are not found", async () => {
    const actor = await company();
    await withTasks(actor);
    const general = await generalOf(actor);
    await place(actor, "Estante 1", { code: "MIO-1" });
    const item = await product(actor);
    await enter(actor, item, general, "3");
    const [task] = await putawayTasks(actor);
    const stranger = await company();
    await place(stranger, "Estante ajeno", { code: "AJENO-1" });
    expect(await acceptTask(stranger, task!.id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await deliverTask(stranger, task!.id, { locationCode: "MIO-1" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await getTask(stranger, task!.id)).toBeNull();
    // Its own place, scanned in the other company, is not found.
    expect(await acceptTask(actor, task!.id)).toMatchObject({ ok: true });
    expect(await pickUpTask(actor, task!.id)).toMatchObject({ ok: true });
    expect(
      await deliverTask(actor, task!.id, { locationCode: "AJENO-1" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("No encontramos") },
    });
    expect(await createPendingPutawayTasks(stranger)).toMatchObject({
      ok: false,
    });
    expect((await listTasks(stranger, { view: "available" })).total).toBe(0);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("the recommendation never proposes nor accepts a place outside the person's zones", async () => {
    const owner = await company();
    await withTasks(owner);
    const dock = await place(owner, "Andén", {
      level: 1,
      type: "RECEIVING",
      code: "AND",
    });
    const mine = await place(owner, "Zona propia", { level: 1 });
    const myShelf = await place(owner, "Estante propio", {
      parentId: mine,
      code: "P-1",
    });
    const theirs = await place(owner, "Zona ajena", { level: 1 });
    const theirShelf = await place(owner, "Estante ajeno", {
      parentId: theirs,
      code: "X-1",
    });
    const item = await product(owner);
    // The same product already sits outside the zones: it would rank first.
    await enter(owner, item, theirShelf, "5");
    const zoned = await member(owner.organizationId, "supervisor");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: zoned.userId,
      facilities: [
        {
          facilityId: (
            await db.location.findUniqueOrThrow({ where: { id: dock } })
          ).facilityId,
          zoneIds: [dock, mine],
        },
      ],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    await enter(zoned, item, dock, "4");
    const tasks = (await putawayTasks(owner)).filter(
      (task) => task.fromLocationId === dock,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.toLocationId).toBe(myShelf);
    // Scanning a place outside the zones is answered as not found.
    expect(await acceptTask(zoned, tasks[0]!.id)).toMatchObject({ ok: true });
    expect(await pickUpTask(zoned, tasks[0]!.id)).toMatchObject({ ok: true });
    expect(
      await deliverTask(zoned, tasks[0]!.id, { locationCode: "X-1" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("No encontramos") },
    });
    expect(
      await deliverTask(zoned, tasks[0]!.id, { locationCode: "P-1" }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);
});

describe("a transfer task still works as before", () => {
  it("is not a put-away and keeps its destination", async () => {
    const actor = await company();
    await withTasks(actor);
    const a = await place(actor, "Estante A");
    const b = await place(actor, "Estante B");
    const item = await product(actor);
    await enter(actor, item, a, "5");
    const created = await createTask(actor, {
      productId: item,
      fromLocationId: a,
      toLocationId: b,
      quantity: "2",
    });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    expect(await acceptTask(actor, created.taskId)).toMatchObject({ ok: true });
    expect(await pickUpTask(actor, created.taskId)).toMatchObject({ ok: true });
    expect(await deliverTask(actor, created.taskId)).toMatchObject({
      ok: true,
    });
    expect(
      await db.warehouseTask.findUniqueOrThrow({
        where: { id: created.taskId },
      }),
    ).toMatchObject({ kind: "TRANSFER", placedLocationId: null });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

async function sentOrder(
  actor: InventoryActor,
  lines: { productId: string; quantity: string }[],
) {
  const supplier = await createSupplier(actor, {
    name: `Proveedor ${newId().slice(-6)}`,
  });
  if (!supplier.ok) throw new Error("supplier setup failed");
  const order = await createPurchaseOrder(actor, {
    supplierId: supplier.supplierId,
  });
  if (!order.ok) throw new Error("order setup failed");
  for (const line of lines) {
    const added = await addOrderLine(actor, order.orderId, {
      productId: line.productId,
      capture: "base",
      quantity: line.quantity,
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  const sent = await submitPurchaseOrder(actor, order.orderId);
  if (!sent.ok) throw new Error("submit failed");
  return order.orderId;
}
