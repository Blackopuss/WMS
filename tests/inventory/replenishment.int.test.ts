import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import {
  REPLENISHMENT_MODE,
  TASK_HOLD,
  acceptTask,
  cancelTask,
  countMyTasks,
  deliverTask,
  getReplenishmentRule,
  getTask,
  listPickingPlaces,
  listReplenishmentRules,
  listTasks,
  pickUpTask,
  reconcileStock,
  registerEntry,
  registerExit,
  removeReplenishmentRule,
  replenishNow,
  replenishmentVisible,
  runReplenishmentRound,
  saveReplenishmentRule,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { scheduledRounds } from "@/modules/registry/rounds";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { runScheduledRounds } from "@/platform/jobs";
import {
  createFacility,
  createLocation,
  listFacilities,
  switchFacility,
  type LocationLimitsInput,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-23/24 (ADR 0051): rules keep picking locations filled; «Reponer
// ahora» and the hourly round create REPLENISH tasks from storage, never
// twice for the same need.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `reposicion.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa reposición ${counter}`,
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
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de reposición",
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

async function product(
  actor: InventoryActor,
  extra: {
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const sku = `REP-${++counter}`;
  const made = await createProduct(actor, {
    sku,
    name: `Artículo ${sku}`,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { id: made.productId, sku };
}

async function place(
  actor: InventoryActor,
  name: string,
  options: {
    level?: number;
    parentId?: string;
    type?: "STORAGE" | "PICKING" | "RECEIVING";
    code?: string;
    limits?: LocationLimitsInput;
  } = {},
) {
  const made = await createLocation(actor, {
    level: options.level ?? 3,
    name,
    parentId: options.parentId,
    type: options.type ?? "STORAGE",
    code: options.code,
    limits: options.limits,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
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
    ...extra,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

async function rule(
  actor: InventoryActor,
  sku: string,
  locationId: string,
  min: string,
  max: string,
  multiple = "",
) {
  const saved = await saveReplenishmentRule(actor, {
    productCode: sku,
    locationId,
    minQuantity: min,
    maxQuantity: max,
    multiple,
  });
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return saved.ruleId;
}

const replenishTasks = (actor: InventoryActor) =>
  db.warehouseTask.findMany({
    where: { organizationId: actor.organizationId, kind: "REPLENISH" },
    orderBy: { number: "asc" },
  });

const openReplenish = async (actor: InventoryActor) =>
  (await replenishTasks(actor)).filter((task) =>
    ["PENDING", "ASSIGNED", "ACCEPTED", "PICKED_UP", "BLOCKED"].includes(
      task.status,
    ),
  );

const stockAt = async (locationId: string, productId: string) => {
  const rows = await db.stockBalance.findMany({
    where: { locationId, productId },
    select: { quantity: true },
  });
  return rows
    .reduce((sum, row) => sum.plus(row.quantity.toString()), dec(0))
    .toString();
};

const stateOf = async (actor: InventoryActor, ruleId: string) =>
  (await getReplenishmentRule(actor, ruleId))!.state;

/** Takes the task, picks the load up and leaves it at its destination. */
async function doTask(actor: InventoryActor, taskId: string, serials?: string) {
  expect(await acceptTask(actor, taskId)).toMatchObject({ ok: true });
  expect(await pickUpTask(actor, taskId, { serials })).toMatchObject({
    ok: true,
  });
  return deliverTask(actor, taskId);
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("rules", () => {
  it("only for an active picking place; minimum below maximum; the multiple fits between them", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    const save = (input: Record<string, string>) =>
      saveReplenishmentRule(actor, {
        productCode: item.sku,
        locationId: face,
        minQuantity: "10",
        maxQuantity: "40",
        ...input,
      });
    expect(await save({ locationId: shelf })).toMatchObject({
      ok: false,
      fieldErrors: {
        locationId: expect.stringContaining("no es una ubicación de surtido"),
      },
    });
    expect(await save({ maxQuantity: "10" })).toMatchObject({
      ok: false,
      fieldErrors: { maxQuantity: expect.any(String) },
    });
    expect(await save({ multiple: "31" })).toMatchObject({
      ok: false,
      fieldErrors: { multiple: expect.stringContaining("No cabe") },
    });
    expect(await save({ minQuantity: "0" })).toMatchObject({
      ok: false,
      fieldErrors: { minQuantity: expect.any(String) },
    });
    expect(await save({ productCode: "NO-EXISTE" })).toMatchObject({
      ok: false,
      fieldErrors: { productCode: expect.any(String) },
    });
    const made = await save({ multiple: "12" });
    expect(made).toMatchObject({ ok: true });
    // One rule per product and place.
    expect(await save({})).toMatchObject({
      ok: false,
      fieldErrors: {
        productCode: expect.stringContaining("ya tiene una regla"),
      },
    });
    const ruleId = (made as { ruleId: string }).ruleId;
    // Editing changes the quantities, never product nor place.
    expect(
      await saveReplenishmentRule(actor, {
        ruleId,
        minQuantity: "5",
        maxQuantity: "20",
        multiple: "",
      }),
    ).toMatchObject({ ok: true });
    const view = await getReplenishmentRule(actor, ruleId);
    expect(view).toMatchObject({
      minQuantity: "5",
      maxQuantity: "20",
      multiple: null,
      locationId: face,
    });
    // A place that only admits other products gets no rule.
    const other = await product(actor);
    const narrow = await place(actor, "Surtido 2", {
      type: "PICKING",
      limits: { products: other.sku },
    });
    expect(
      await saveReplenishmentRule(actor, {
        productCode: item.sku,
        locationId: narrow,
        minQuantity: "1",
        maxQuantity: "5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationId: expect.stringContaining("solo admite") },
    });
    expect((await listPickingPlaces(actor)).map((p) => p.id).sort()).toEqual(
      [face, narrow].sort(),
    );
    expect(await replenishmentVisible(actor)).toBe(true);
    // Removing: gone, and written in the trail.
    expect(await removeReplenishmentRule(actor, ruleId)).toMatchObject({
      ok: true,
    });
    expect(await getReplenishmentRule(actor, ruleId)).toBeNull();
    const trail = await db.auditEvent.findMany({
      where: {
        organizationId: actor.organizationId,
        action: { startsWith: "inventory.replenishment_rule" },
      },
    });
    expect(trail.map((row) => row.action).sort()).toEqual([
      "inventory.replenishment_rule_removed",
      "inventory.replenishment_rule_saved",
      "inventory.replenishment_rule_saved",
    ]);
  }, 30_000);

  it("a company without picking places sees nothing new", async () => {
    const actor = await company();
    await place(actor, "Rack 1");
    expect(await replenishmentVisible(actor)).toBe(false);
    expect((await listReplenishmentRules(actor)).total).toBe(0);
    expect(await replenishNow(actor)).toMatchObject({ ok: true, created: 0 });
  }, 30_000);
});

describe("the decision, a known scenario", () => {
  it("below its minimum: up to the maximum, in multiples, from the fullest storage place, held there", async () => {
    const actor = await company();
    const big = await place(actor, "Rack grande");
    const small = await place(actor, "Rack chico");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    await enter(actor, item.id, big, "50");
    await enter(actor, item.id, small, "20");
    await enter(actor, item.id, face, "4");
    const ruleId = await rule(actor, item.sku, face, "10", "40", "12");
    expect(await stateOf(actor, ruleId)).toBe("due");
    const [view] = (await listReplenishmentRules(actor)).items;
    expect(view).toMatchObject({
      hereText: "4 piezas",
      comingText: null,
      bringText: "36 piezas",
    });

    const done = await replenishNow(actor);
    expect(done).toMatchObject({ ok: true, created: 1 });
    const [task] = await replenishTasks(actor);
    expect(task).toMatchObject({
      kind: "REPLENISH",
      status: "PENDING",
      fromLocationId: big,
      toLocationId: face,
    });
    expect(task!.quantity!.toString()).toBe("36");
    // Held at its origin: nobody else takes it.
    const hold = await db.stockReservation.findFirst({
      where: { sourceType: TASK_HOLD, sourceId: task!.id, state: "ACTIVE" },
    });
    expect(hold?.locationId).toBe(big);
    expect(
      await registerExit(actor, {
        productId: item.id,
        locationId: big,
        quantity: "20",
      }),
    ).toMatchObject({ ok: false });
    expect(await stateOf(actor, ruleId)).toBe("coming");
    // Nothing moved yet.
    expect(await stockAt(face, item.id)).toBe("4");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("never over the capacity of the place: the largest multiple that fits", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", {
      type: "PICKING",
      limits: { maxUnits: "30" },
    });
    const item = await product(actor);
    await enter(actor, item.id, shelf, "100");
    await enter(actor, item.id, face, "4");
    await rule(actor, item.sku, face, "10", "40", "12");
    expect(await replenishNow(actor)).toMatchObject({ created: 1 });
    const [task] = await replenishTasks(actor);
    // 4 + 24 = 28 ≤ 30; three boxes (40) would not fit.
    expect(task!.quantity!.toString()).toBe("24");

    // Full of something else: no room at all.
    const tight = await place(actor, "Surtido 2", {
      type: "PICKING",
      limits: { maxUnits: "5" },
    });
    const filler = await product(actor);
    await enter(actor, filler.id, tight, "5");
    const tightRule = await rule(actor, item.sku, tight, "2", "10");
    expect(await stateOf(actor, tightRule)).toBe("no_room");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("without free stock in storage: no task, «Sin existencias para reponer»", async () => {
    const actor = await company();
    await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    // What waits in «General» or receiving is not where goods are kept.
    const dock = await place(actor, "Andén", { type: "RECEIVING" });
    await enter(actor, item.id, dock, "50");
    const ruleId = await rule(actor, item.sku, face, "5", "20");
    expect(await stateOf(actor, ruleId)).toBe("no_stock");
    expect(await replenishNow(actor)).toMatchObject({ ok: true, created: 0 });
    expect(await replenishTasks(actor)).toHaveLength(0);
  }, 30_000);

  it("the lot that expires first leaves first, even from the emptier place", async () => {
    const actor = await company();
    const big = await place(actor, "Rack grande");
    const small = await place(actor, "Rack chico");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor, {
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    });
    await enter(actor, item.id, big, "50", {
      lotCode: "TARDE",
      lotExpiresOn: "2031-01-01",
    });
    await enter(actor, item.id, small, "8", {
      lotCode: "PRONTO",
      lotExpiresOn: "2030-01-01",
    });
    await rule(actor, item.sku, face, "5", "20");
    expect(await replenishNow(actor)).toMatchObject({ created: 2 });
    const tasks = await replenishTasks(actor);
    const lots = await db.lot.findMany({
      where: { organizationId: actor.organizationId },
      select: { id: true, code: true },
    });
    const codeOf = new Map(lots.map((lot) => [lot.id, lot.code]));
    expect(
      tasks.map((task) => [
        codeOf.get(task.lotId!),
        task.fromLocationId,
        task.quantity!.toString(),
      ]),
    ).toEqual([
      ["PRONTO", small, "8"],
      ["TARDE", big, "12"],
    ]);
    // Delivering both fills the place; each lot is where it should be.
    for (const task of tasks) {
      expect(await doTask(actor, task.id)).toMatchObject({ ok: true });
    }
    expect(await stockAt(face, item.id)).toBe("20");
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("tasks", () => {
  it("delivering leaves the place replenished; the rule reads «Bien»; Inicio counts it", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    await enter(actor, item.id, shelf, "30");
    const ruleId = await rule(actor, item.sku, face, "5", "20");
    await replenishNow(actor);
    const [task] = await replenishTasks(actor);
    const worker = await member(actor.organizationId, "operator");
    expect((await countMyTasks(worker)).available).toBe(1);
    const listed = await listTasks(worker, { view: "available" });
    expect(listed.items[0]).toMatchObject({ kind: "REPLENISH" });
    const delivered = await doTask(worker, task!.id);
    expect(delivered).toMatchObject({
      ok: true,
      summary: expect.stringContaining("Repusiste 20 piezas"),
    });
    expect(await stockAt(face, item.id)).toBe("20");
    expect(await stockAt(shelf, item.id)).toBe("10");
    expect(await stateOf(actor, ruleId)).toBe("ok");
    // Its hold was used, nothing stays set aside.
    expect(
      await db.stockReservation.count({
        where: { sourceType: TASK_HOLD, sourceId: task!.id, state: "ACTIVE" },
      }),
    ).toBe(0);
    // Again: delivered once, and nothing else to do.
    expect(await deliverTask(worker, task!.id)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await replenishNow(actor)).toMatchObject({ created: 0 });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("cancelling lets the goods go, and the next run decides again", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    await enter(actor, item.id, shelf, "30");
    await rule(actor, item.sku, face, "5", "20");
    await replenishNow(actor);
    const [task] = await replenishTasks(actor);
    expect(
      await cancelTask(actor, task!.id, "Se surte a mano hoy"),
    ).toMatchObject({ ok: true });
    expect(
      await db.stockReservation.count({
        where: { sourceType: TASK_HOLD, sourceId: task!.id, state: "ACTIVE" },
      }),
    ).toBe(0);
    expect(await replenishNow(actor)).toMatchObject({ created: 1 });
    expect(await openReplenish(actor)).toHaveLength(1);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);

  it("a product by serial scans its units at pick-up and moves exactly those", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor, { tracking: "SERIAL" });
    await enter(actor, item.id, shelf, "3", { serials: "S-1\nS-2\nS-3" });
    await rule(actor, item.sku, face, "1", "2");
    await replenishNow(actor);
    const [task] = await replenishTasks(actor);
    expect(task!.quantity!.toString()).toBe("2");
    expect(await acceptTask(actor, task!.id)).toMatchObject({ ok: true });
    expect(await pickUpTask(actor, task!.id, { serials: "S-9" })).toMatchObject(
      { ok: false, fieldErrors: { serials: expect.any(String) } },
    );
    expect(
      await pickUpTask(actor, task!.id, { serials: "S-1\nS-3" }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(actor, task!.id)).toMatchObject({ ok: true });
    const units = await db.serialUnit.findMany({
      where: { organizationId: actor.organizationId, productId: item.id },
      orderBy: { serial: "asc" },
      select: { serial: true, locationId: true },
    });
    expect(units).toEqual([
      { serial: "S-1", locationId: face },
      { serial: "S-2", locationId: shelf },
      { serial: "S-3", locationId: face },
    ]);
    const view = await getTask(actor, task!.id);
    expect(view).toMatchObject({ kind: "REPLENISH", serials: ["S-1", "S-3"] });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("repeating never duplicates", () => {
  it("what is on its way counts: again, and twice at once, create nothing more", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const second = await place(actor, "Surtido 2", { type: "PICKING" });
    const item = await product(actor);
    const other = await product(actor);
    await enter(actor, item.id, shelf, "100");
    await enter(actor, other.id, shelf, "100");
    await rule(actor, item.sku, face, "5", "20");
    await rule(actor, item.sku, second, "5", "30");
    await rule(actor, other.sku, face, "2", "10");
    await setting(actor, REPLENISHMENT_MODE.key, "round");
    const results = await Promise.all([
      runReplenishmentRound(actor.organizationId),
      runReplenishmentRound(actor.organizationId),
      replenishNow(actor),
    ]);
    const created = results.reduce(
      (sum, result) => sum + ("created" in result ? result.created : 0),
      0,
    );
    expect(created).toBe(3);
    const tasks = await openReplenish(actor);
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((task) => task.number)).size).toBe(3);
    expect(await runReplenishmentRound(actor.organizationId)).toEqual({
      ran: true,
      created: 0,
    });
    expect(await replenishNow(actor)).toMatchObject({ created: 0 });
    // The worker's way: every round of the registry, company by company.
    await runScheduledRounds(
      scheduledRounds,
      (round, organizationId, error) => {
        throw new Error(`${round} ${organizationId} ${String(error)}`);
      },
    );
    expect(await openReplenish(actor)).toHaveLength(3);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("the round does nothing while the company has it off (the default)", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    await enter(actor, item.id, shelf, "30");
    await rule(actor, item.sku, face, "5", "20");
    expect(await runReplenishmentRound(actor.organizationId)).toEqual({
      ran: false,
      why: "off",
    });
    expect(await replenishTasks(actor)).toHaveLength(0);
  }, 30_000);

  it("the round covers every warehouse of the company", async () => {
    const actor = await company();
    const shelfA = await place(actor, "Rack A");
    const faceA = await place(actor, "Surtido A", { type: "PICKING" });
    const item = await product(actor);
    await enter(actor, item.id, shelfA, "30");
    await rule(actor, item.sku, faceA, "5", "20");
    const mainId = (await listFacilities(actor)).find((f) => f.isDefault)!.id;
    const second = await createFacility(actor, { name: "Bodega B", code: "B" });
    if (!second.ok) throw new Error(JSON.stringify(second));
    await switchFacility(actor, second.facilityId);
    const shelfB = await place(actor, "Rack B");
    const faceB = await place(actor, "Surtido B", { type: "PICKING" });
    await enter(actor, item.id, shelfB, "30");
    await rule(actor, item.sku, faceB, "5", "10");
    // From the warehouse B, «Reponer ahora» only covers B.
    expect(await replenishNow(actor)).toMatchObject({ created: 1 });
    expect((await openReplenish(actor)).map((t) => t.toLocationId)).toEqual([
      faceB,
    ]);
    await switchFacility(actor, mainId);
    await setting(actor, REPLENISHMENT_MODE.key, "round");
    expect(await runReplenishmentRound(actor.organizationId)).toEqual({
      ran: true,
      created: 1,
    });
    const tasks = await openReplenish(actor);
    expect(tasks.map((t) => [t.fromLocationId, t.toLocationId])).toEqual([
      [shelfB, faceB],
      [shelfA, faceA],
    ]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);
});

describe("between companies and zones", () => {
  it("a rule of another company does not exist; its run touches nothing of the other", async () => {
    const actor = await company();
    const shelf = await place(actor, "Rack 1");
    const face = await place(actor, "Surtido 1", { type: "PICKING" });
    const item = await product(actor);
    await enter(actor, item.id, shelf, "30");
    const ruleId = await rule(actor, item.sku, face, "5", "20");
    const stranger = await company();
    expect(await getReplenishmentRule(stranger, ruleId)).toBeNull();
    expect(
      await saveReplenishmentRule(stranger, {
        ruleId,
        minQuantity: "1",
        maxQuantity: "2",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await removeReplenishmentRule(stranger, ruleId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // Its product key and place id do not reach the other company.
    expect(
      await saveReplenishmentRule(stranger, {
        productCode: item.sku,
        locationId: face,
        minQuantity: "1",
        maxQuantity: "2",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { productCode: expect.any(String) },
    });
    expect(await replenishNow(stranger)).toMatchObject({ created: 0 });
    await setting(stranger, REPLENISHMENT_MODE.key, "round");
    await runReplenishmentRound(stranger.organizationId);
    expect(await replenishTasks(actor)).toHaveLength(0);
    expect((await listReplenishmentRules(stranger)).total).toBe(0);
  }, 30_000);

  it("«Reponer ahora» of a person with zones only touches rules and storage inside them", async () => {
    const owner = await company();
    const mine = await place(owner, "Zona propia", { level: 1 });
    const theirs = await place(owner, "Zona ajena", { level: 1 });
    const myShelf = await place(owner, "Rack propio", { parentId: mine });
    const theirShelf = await place(owner, "Rack ajeno", { parentId: theirs });
    const myFace = await place(owner, "Surtido propio", {
      parentId: mine,
      type: "PICKING",
    });
    const theirFace = await place(owner, "Surtido ajeno", {
      parentId: theirs,
      type: "PICKING",
    });
    const item = await product(owner);
    // The fullest storage place is outside the zones: never offered.
    await enter(owner, item.id, theirShelf, "90");
    await enter(owner, item.id, myShelf, "10");
    await rule(owner, item.sku, myFace, "5", "20");
    const outsideRule = await rule(owner, item.sku, theirFace, "5", "20");
    const zoned = await member(owner.organizationId, "supervisor");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: zoned.userId,
      facilities: [
        {
          facilityId: (
            await db.location.findUniqueOrThrow({ where: { id: mine } })
          ).facilityId,
          zoneIds: [mine],
        },
      ],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    expect(await getReplenishmentRule(zoned, outsideRule)).toBeNull();
    expect((await listReplenishmentRules(zoned)).total).toBe(1);
    expect((await listPickingPlaces(zoned)).map((p) => p.id)).toEqual([myFace]);
    expect(
      await saveReplenishmentRule(zoned, {
        productCode: item.sku,
        locationId: theirFace,
        minQuantity: "1",
        maxQuantity: "3",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await replenishNow(zoned)).toMatchObject({ created: 1 });
    const tasks = await openReplenish(owner);
    expect(tasks.map((t) => [t.fromLocationId, t.toLocationId])).toEqual([
      [myShelf, myFace],
    ]);
    expect(tasks[0]!.quantity!.toString()).toBe("10");
    // The round, as the owner, covers the rest.
    await setting(owner, REPLENISHMENT_MODE.key, "round");
    expect(await runReplenishmentRound(owner.organizationId)).toEqual({
      ran: true,
      created: 1,
    });
    expect(
      (await openReplenish(owner)).map((t) => [
        t.fromLocationId,
        t.toLocationId,
      ]),
    ).toEqual([
      [myShelf, myFace],
      [theirShelf, theirFace],
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);
});
