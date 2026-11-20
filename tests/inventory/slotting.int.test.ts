import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import {
  CONTAINERS_MODE,
  SLOTTING_CONSOLIDATE,
  SLOTTING_FAST_CLASSES,
  SUGGESTION_CHANGED,
  acceptSlottingSuggestion,
  acceptTask,
  createTask,
  deliverTask,
  listSlottingSuggestions,
  packStock,
  pickUpTask,
  reconcileStock,
  registerEntry,
  registerExit,
  saveReplenishmentRule,
  type InventoryActor,
  type SlottingSuggestion,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  createFacility,
  createLocation,
  switchFacility,
  type LocationLimitsInput,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-65 (ADR 0086): relocation suggestions are derived, never stored;
// accepting one creates a plain transfer task with `createTask`, once.

const DAY = 86_400_000;
const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `reubicar.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa reubicación ${counter}`,
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
      productLimit: 400,
      users: 10,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de reubicación",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
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
  const sku = `RUB-${++counter}`;
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
    type?: "STORAGE" | "PICKING";
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
  extra: { lotCode?: string; lotExpiresOn?: string } = {},
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

async function exit(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  lotId?: string,
) {
  const result = await registerExit(actor, {
    productId,
    locationId,
    quantity,
    lotId,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

const list = async (actor: InventoryActor, now?: Date) =>
  (await listSlottingSuggestions(actor, now ? { now } : {})).suggestions;

const ofProduct = (rows: SlottingSuggestion[], productId: string) =>
  rows.filter((row) => row.productId === productId);

const accept = (actor: InventoryActor, row: SlottingSuggestion, now?: Date) =>
  acceptSlottingSuggestion(
    actor,
    {
      kind: row.kind,
      productId: row.productId,
      fromLocationId: row.fromLocationId,
      lotId: row.lotId,
      toLocationId: row.toLocationId,
    },
    now ? { now } : {},
  );

async function deliver(actor: InventoryActor, taskId: string) {
  expect(await acceptTask(actor, taskId)).toMatchObject({ ok: true });
  expect(await pickUpTask(actor, taskId)).toMatchObject({ ok: true });
  expect(await deliverTask(actor, taskId)).toMatchObject({ ok: true });
}

/** A fast product: stock in a storage place and one exit (class A). */
async function fastProduct(
  actor: InventoryActor,
  from: string,
  stock = "50",
  out = "5",
) {
  const item = await product(actor);
  await enter(actor, item.id, from, stock);
  await exit(actor, item.id, from, out);
  return item;
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("relocation suggestions (WMS-65)", () => {
  it("brings closer what leaves often, to the first empty picking place in walking order", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack 1", { code: "A-01" });
    const far = await place(owner, "Surtido 2", {
      type: "PICKING",
      code: "S-02",
    });
    const near = await place(owner, "Surtido 1", {
      type: "PICKING",
      code: "S-01",
    });
    const item = await fastProduct(owner, shelf);

    const rows = ofProduct(await list(owner), item.id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "closer",
        fromLocationId: shelf,
        toLocationId: near,
        quantity: "45",
        reason: "Sale seguido (clase A) y no tiene lugar de surtido.",
      }),
    ]);
    expect(far).toBeDefined();

    // Accepting creates a plain transfer task; again, the same task.
    const first = await accept(owner, rows[0]!);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    const task = await db.warehouseTask.findUniqueOrThrow({
      where: { id: first.taskId },
    });
    expect(task).toMatchObject({
      kind: "TRANSFER",
      status: "PENDING",
      productId: item.id,
      fromLocationId: shelf,
      toLocationId: near,
      createdByUserId: owner.userId,
    });
    expect(task.quantity!.toString()).toBe("45");
    expect(task.note).toContain("Sugerencia de reubicación");
    expect(await accept(owner, rows[0]!)).toMatchObject({
      ok: true,
      taskId: first.taskId,
      repeated: true,
    });
    // What is on its way is not suggested again.
    expect(ofProduct(await list(owner), item.id)).toEqual([]);

    await deliver(owner, first.taskId);
    // Now it has a picking place: nothing more to bring closer.
    expect(ofProduct(await list(owner), item.id)).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("two accepts at once create one task", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    await place(owner, "Surtido", { type: "PICKING", code: "S-01" });
    const item = await fastProduct(owner, shelf);
    const [row] = ofProduct(await list(owner), item.id);
    const both = await Promise.all([accept(owner, row!), accept(owner, row!)]);
    expect(both.every((result) => result.ok)).toBe(true);
    const ids = new Set(both.map((result) => (result.ok ? result.taskId : "")));
    expect(ids.size).toBe(1);
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, productId: item.id },
      }),
    ).toBe(1);
  });

  it("two products never get the same destination, also accepted at once", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    const face = await place(owner, "Surtido", {
      type: "PICKING",
      code: "S-01",
    });
    const one = await fastProduct(owner, shelf);
    const two = await fastProduct(owner, shelf);
    const rows = (await list(owner)).filter((row) => row.kind === "closer");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toLocationId).toBe(face);
    // Someone hand-crafts the other product's suggestion to the same place.
    const other = rows[0]!.productId === one.id ? two.id : one.id;
    const results = await Promise.all([
      accept(owner, rows[0]!),
      accept(owner, { ...rows[0]!, productId: other }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, toLocationId: face },
      }),
    ).toBe(1);
  });

  it("a full or restricted picking place is skipped; capacity trims the amount", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    const other = await product(owner);
    await place(owner, "Solo otro", {
      type: "PICKING",
      code: "S-01",
      limits: { products: other.sku },
    });
    const small = await place(owner, "Chico", {
      type: "PICKING",
      code: "S-02",
      limits: { maxUnits: "10" },
    });
    const item = await fastProduct(owner, shelf);
    const rows = ofProduct(await list(owner), item.id);
    expect(rows).toEqual([
      expect.objectContaining({ toLocationId: small, quantity: "10" }),
    ]);
  });

  it("a place that is not empty, has a replenishment rule or a task to it is not a destination", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    const busy = await place(owner, "Ocupado", {
      type: "PICKING",
      code: "S-01",
    });
    const ruled = await place(owner, "Con regla", {
      type: "PICKING",
      code: "S-02",
    });
    const awaited = await place(owner, "Esperado", {
      type: "PICKING",
      code: "S-03",
    });
    const filler = await product(owner);
    await enter(owner, filler.id, busy, "1");
    const ruledItem = await product(owner);
    expect(
      await saveReplenishmentRule(owner, {
        productCode: ruledItem.sku,
        locationId: ruled,
        minQuantity: "1",
        maxQuantity: "5",
      }),
    ).toMatchObject({ ok: true });
    const moving = await product(owner);
    await enter(owner, moving.id, shelf, "3");
    expect(
      await createTask(owner, {
        productId: moving.id,
        fromLocationId: shelf,
        toLocationId: awaited,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    const item = await fastProduct(owner, shelf);
    expect(ofProduct(await list(owner), item.id)).toEqual([]);
  });

  it("what is set aside or in a pallet is not free to move", async () => {
    const owner = await company();
    await setting(owner, CONTAINERS_MODE.key, "on");
    const shelf = await place(owner, "Rack", { code: "A-01" });
    await place(owner, "Surtido", { type: "PICKING", code: "S-01" });
    const item = await fastProduct(owner, shelf, "10", "2");
    expect(
      await packStock(owner, {
        locationId: shelf,
        productId: item.id,
        quantity: "8",
      }),
    ).toMatchObject({ ok: true });
    expect(ofProduct(await list(owner), item.id)).toEqual([]);
  });

  it("with lots, the one that expires first is the one brought closer", async () => {
    const owner = await company();
    const late = await place(owner, "Rack tarde", { code: "A-01" });
    const early = await place(owner, "Rack pronto", { code: "A-02" });
    await place(owner, "Surtido", { type: "PICKING", code: "S-01" });
    const item = await product(owner, {
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    });
    await enter(owner, item.id, late, "20", {
      lotCode: "L-TARDE",
      lotExpiresOn: "2031-06-01",
    });
    await enter(owner, item.id, early, "20", {
      lotCode: "L-PRONTO",
      lotExpiresOn: "2030-01-01",
    });
    const lateLot = await db.lot.findFirstOrThrow({
      where: { organizationId: owner.organizationId, code: "L-TARDE" },
    });
    await exit(owner, item.id, late, "5", lateLot.id);
    const rows = ofProduct(await list(owner), item.id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "closer",
        fromLocationId: early,
        lotCode: "L-PRONTO",
        quantity: "20",
      }),
    ]);
    // A lot that expires even earlier arrives: the shown origin is no
    // longer the first one, so accepting it answers that it changed.
    const sooner = await place(owner, "Rack antes", { code: "A-03" });
    await enter(owner, item.id, sooner, "4", {
      lotCode: "L-ANTES",
      lotExpiresOn: "2029-01-01",
    });
    expect(await accept(owner, rows[0]!)).toMatchObject({
      ok: false,
      reason: "changed",
    });
    const fresh = ofProduct(await list(owner), item.id);
    expect(fresh).toEqual([
      expect.objectContaining({ fromLocationId: sooner, lotCode: "L-ANTES" }),
    ]);
    const done = await accept(owner, fresh[0]!);
    expect(done).toMatchObject({ ok: true });
    if (!done.ok) return;
    await deliver(owner, done.taskId);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("two suggestions of one product never contradict each other", async () => {
    const owner = await company();
    const little = await place(owner, "Rack X", { code: "A-01" });
    const most = await place(owner, "Rack Y", { code: "A-02" });
    const face = await place(owner, "Surtido", {
      type: "PICKING",
      code: "S-01",
    });
    const item = await product(owner);
    await enter(owner, item.id, little, "2");
    await enter(owner, item.id, most, "11");
    await exit(owner, item.id, most, "1");
    // Brought closer from Y; joining X into Y would undo it.
    expect(ofProduct(await list(owner), item.id)).toEqual([
      expect.objectContaining({
        kind: "closer",
        fromLocationId: most,
        toLocationId: face,
      }),
    ]);
    const closer = ofProduct(await list(owner), item.id)[0]!;
    expect(await accept(owner, closer)).toMatchObject({ ok: true });
    // A hand-made «join X into Y» meets the open task leaving Y.
    expect(
      await accept(owner, {
        ...closer,
        kind: "consolidate",
        fromLocationId: little,
        toLocationId: most,
        lotId: null,
      }),
    ).toMatchObject({ ok: false });
  });

  it("takes out of picking what has not moved, unless a rule keeps it there", async () => {
    const owner = await company();
    const face = await place(owner, "Surtido", {
      type: "PICKING",
      code: "S-01",
    });
    const kept = await place(owner, "Surtido fijo", {
      type: "PICKING",
      code: "S-02",
    });
    const shelf = await place(owner, "Rack", { code: "A-01" });
    const slow = await product(owner);
    await enter(owner, slow.id, face, "7");
    const ruled = await product(owner);
    await enter(owner, ruled.id, kept, "4");
    expect(
      await saveReplenishmentRule(owner, {
        productCode: ruled.sku,
        locationId: kept,
        minQuantity: "1",
        maxQuantity: "5",
      }),
    ).toMatchObject({ ok: true });

    // Today it just arrived: it moved.
    expect((await list(owner)).filter((row) => row.kind === "idle")).toEqual(
      [],
    );
    const later = new Date(Date.now() + 120 * DAY);
    const rows = (await list(owner, later)).filter(
      (row) => row.kind === "idle",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        productId: slow.id,
        fromLocationId: face,
        toLocationId: shelf,
        quantity: "7",
        reason:
          "No ha tenido movimiento en 90 días y ocupa un lugar de surtido.",
      }),
    ]);
    const done = await accept(owner, rows[0]!, later);
    expect(done).toMatchObject({ ok: true });
    if (!done.ok) return;
    await deliver(owner, done.taskId);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("joins the same lot spread over storage places, into the one holding most", async () => {
    const owner = await company();
    const little = await place(owner, "Rack 1", { code: "A-01" });
    const most = await place(owner, "Rack 2", { code: "A-02" });
    const item = await product(owner);
    await enter(owner, item.id, little, "3");
    await enter(owner, item.id, most, "10");
    const rows = ofProduct(await list(owner), item.id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "consolidate",
        fromLocationId: little,
        toLocationId: most,
        quantity: "3",
        reason: "Está repartido en 2 ubicaciones de almacenaje.",
      }),
    ]);
    await setting(owner, SLOTTING_CONSOLIDATE.key, "off");
    expect(ofProduct(await list(owner), item.id)).toEqual([]);
    await setting(owner, SLOTTING_CONSOLIDATE.key, "on");
    const done = await accept(owner, rows[0]!);
    expect(done).toMatchObject({ ok: true });
    if (!done.ok) return;
    await deliver(owner, done.taskId);
    expect(ofProduct(await list(owner), item.id)).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("class B counts as fast only when the company says so", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    await place(owner, "Surtido 1", { type: "PICKING", code: "S-01" });
    await place(owner, "Surtido 2", { type: "PICKING", code: "S-02" });
    // Cuts 80/15/5 by exit lines: 8 exits are A, 2 exits are B.
    const busy = await product(owner);
    await enter(owner, busy.id, shelf, "100");
    for (let i = 0; i < 8; i++) await exit(owner, busy.id, shelf, "1");
    const medium = await product(owner);
    await enter(owner, medium.id, shelf, "100");
    for (let i = 0; i < 2; i++) await exit(owner, medium.id, shelf, "1");
    const closer = async () =>
      (await list(owner))
        .filter((row) => row.kind === "closer")
        .map((row) => row.productId);
    expect(await closer()).toEqual([busy.id]);
    await setting(owner, SLOTTING_FAST_CLASSES.key, "ab");
    expect(await closer()).toEqual([busy.id, medium.id]);
  });

  it("only the active warehouse and, for a limited person, only their zones", async () => {
    const owner = await company();
    const zoneA = await place(owner, "Zona A", { level: 1 });
    const zoneB = await place(owner, "Zona B", { level: 1 });
    const shelfA = await place(owner, "Rack A", {
      parentId: zoneA,
      code: "A-01",
    });
    const faceA = await place(owner, "Surtido A", {
      parentId: zoneA,
      type: "PICKING",
      code: "S-09",
    });
    const faceB = await place(owner, "Surtido B", {
      parentId: zoneB,
      type: "PICKING",
      code: "S-01",
    });
    const item = await fastProduct(owner, shelfA);
    expect(ofProduct(await list(owner), item.id)).toEqual([
      expect.objectContaining({ toLocationId: faceB }),
    ]);

    const zoned = await member(owner.organizationId, "supervisor");
    const facilityId = (
      await db.location.findUniqueOrThrow({ where: { id: zoneA } })
    ).facilityId;
    expect(
      await setMemberScope(owner.organizationId, owner.userId, {
        userId: zoned.userId,
        facilities: [{ facilityId, zoneIds: [zoneA] }],
      }),
    ).toMatchObject({ ok: true });
    const seen = await list(zoned);
    expect(ofProduct(seen, item.id)).toEqual([
      expect.objectContaining({ toLocationId: faceA }),
    ]);
    expect(JSON.stringify(seen)).not.toContain(faceB);
    // The owner's suggestion names zone B: for them it changed, also once
    // the owner turned it into a task (nothing of zone B is revealed).
    const ownerRow = ofProduct(await list(owner), item.id)[0]!;
    expect(await accept(zoned, ownerRow)).toMatchObject({
      ok: false,
      reason: "changed",
    });
    expect(await accept(owner, ownerRow)).toMatchObject({ ok: true });
    expect(await accept(zoned, ownerRow)).toEqual({
      ok: false,
      reason: "changed",
      formError: SUGGESTION_CHANGED,
    });

    // Another warehouse: nothing of the first one.
    const second = await createFacility(owner, { name: "Bodega B", code: "B" });
    if (!second.ok) throw new Error(JSON.stringify(second));
    await switchFacility(owner, second.facilityId);
    expect(await list(owner)).toEqual([]);
  });

  it("who sees and who creates the task; nothing of another company", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    await place(owner, "Surtido", { type: "PICKING", code: "S-01" });
    const item = await fastProduct(owner, shelf);
    const [row] = ofProduct(await list(owner), item.id);

    for (const role of ["operator", "forklift", "buyer"] as const) {
      const person = await member(owner.organizationId, role);
      await expect(list(person)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(accept(person, row!)).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const role of ["viewer", "manager"] as const) {
      const person = await member(owner.organizationId, role);
      expect(ofProduct(await list(person), item.id)).toHaveLength(1);
      await expect(accept(person, row!)).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const role of ["warehouse", "supervisor", "administrator"] as const) {
      const person = await member(owner.organizationId, role);
      expect(ofProduct(await list(person), item.id)).toHaveLength(1);
    }

    const stranger = await company();
    expect(await accept(stranger, row!)).toMatchObject({
      ok: false,
      reason: "changed",
    });
    expect(
      await db.warehouseTask.count({
        where: { organizationId: stranger.organizationId },
      }),
    ).toBe(0);
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
  });

  it("with the plan expired it is seen and nothing is created", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    await place(owner, "Surtido", { type: "PICKING", code: "S-01" });
    const item = await fastProduct(owner, shelf);
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * DAY),
        validUntil: new Date(Date.now() - DAY),
      },
    });
    invalidateEntitlements(owner.organizationId);
    const [row] = ofProduct(await list(owner), item.id);
    expect(row).toBeDefined();
    await expect(accept(owner, row!)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reads the database a fixed number of times plus a few per suggestion", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    const other = await place(owner, "Rack 2", { code: "A-02" });
    for (let i = 1; i <= 2; i++) {
      await place(owner, `Surtido ${i}`, { type: "PICKING", code: `S-0${i}` });
    }
    for (let i = 0; i < 2; i++) await fastProduct(owner, shelf, "10", "1");
    const spread = await product(owner);
    await enter(owner, spread.id, shelf, "2");
    await enter(owner, spread.id, other, "5");
    const queries = await countingQueries();
    const measure = async () => {
      queries.reset();
      const rows = await list(owner);
      return { rows: rows.length, statements: queries.count() };
    };
    try {
      const few = await measure();
      expect(few.rows).toBe(3);
      expect(few.statements).toBeLessThanOrEqual(70);
      // Four suggestions more cost at most three statements each.
      for (let i = 3; i <= 7; i++) {
        await place(owner, `Surtido ${i}`, {
          type: "PICKING",
          code: `S-0${i}`,
        });
      }
      for (let i = 0; i < 5; i++) await fastProduct(owner, shelf, "10", "1");
      const more = await measure();
      // Seven products with one exit each: six are class A (cuts 80/15/5).
      expect(more.rows).toBe(7);
      expect(more.statements - few.statements).toBeLessThanOrEqual(12);
    } finally {
      queries.restore();
    }
  });
  it("many idle products and one storage place: one suggestion, bounded reads", async () => {
    const owner = await company();
    const faces = [];
    for (let i = 1; i <= 3; i++) {
      faces.push(
        await place(owner, `Surtido ${i}`, {
          type: "PICKING",
          code: `S-0${i}`,
        }),
      );
    }
    await place(owner, "Rack", { code: "A-01" });
    for (let i = 0; i < 150; i++) {
      const item = await product(owner);
      await enter(owner, item.id, faces[i % 3]!, "1");
    }
    const later = new Date(Date.now() + 120 * DAY);
    const queries = await countingQueries();
    try {
      queries.reset();
      const rows = await list(owner, later);
      expect(rows.filter((row) => row.kind === "idle")).toHaveLength(1);
      expect(queries.count()).toBeLessThanOrEqual(55);
    } finally {
      queries.restore();
    }
  }, 240_000);

  it("many fast products and restricted picking places: nothing, bounded reads", async () => {
    const owner = await company();
    const shelf = await place(owner, "Rack", { code: "A-01" });
    const other = await product(owner);
    for (let i = 1; i <= 10; i++) {
      await place(owner, `Solo otro ${i}`, {
        type: "PICKING",
        code: `S-${String(i).padStart(2, "0")}`,
        limits: { products: other.sku },
      });
    }
    for (let i = 0; i < 100; i++) await fastProduct(owner, shelf, "2", "1");
    const queries = await countingQueries();
    try {
      queries.reset();
      expect(await list(owner)).toEqual([]);
      expect(queries.count()).toBeLessThanOrEqual(55);
    } finally {
      queries.restore();
    }
  }, 240_000);
});

/**
 * Counts the statements this test sends to MySQL: every one goes through
 * the queryable of the driver adapter (its prototype is shared by the
 * application's client), and integration tests run one file at a time.
 */
async function countingQueries() {
  const adapter = await new PrismaMariaDb({
    host: process.env.DATABASE_HOST!,
    port: Number(process.env.DATABASE_PORT ?? 3306),
    user: process.env.DATABASE_APP_USER!,
    password: process.env.DATABASE_APP_PASSWORD!,
    database: process.env.DATABASE_NAME!,
    connectionLimit: 1,
    allowPublicKeyRetrieval: true,
  }).connect();
  const queryable = Object.getPrototypeOf(Object.getPrototypeOf(adapter));
  await adapter.dispose();
  const reads = vi.spyOn(queryable, "queryRaw");
  const writes = vi.spyOn(queryable, "executeRaw");
  return {
    count: () => reads.mock.calls.length + writes.mock.calls.length,
    reset: () => {
      reads.mockClear();
      writes.mockClear();
    },
    restore: () => {
      reads.mockRestore();
      writes.mockRestore();
    },
  };
}
