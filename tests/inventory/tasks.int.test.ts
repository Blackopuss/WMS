import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  assignTask,
  blockTask,
  cancelTask,
  countMyTasks,
  createTask,
  deliverTask,
  getStockByLocation,
  getTask,
  listTaskPeople,
  listTasks,
  pickUpTask,
  reconcileStock,
  registerEntry,
  registerExit,
  releaseTask,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-06 (spec 5.3): a supervisor asks for a move, a person takes it,
// picks it up and delivers it; only the delivery moves stock, once.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `tareas.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén ${counter}`,
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
      reason: "Prueba de tareas",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  name = "Persona",
): Promise<InventoryActor> {
  const userId = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/** A product with 50 pieces in rack A; rack B is empty. */
async function scenario(owner: InventoryActor) {
  const created = await createProduct(owner, {
    sku: `T-${++counter}`,
    name: "Tarima de triplay",
  });
  if (!created.ok) throw new Error("product setup failed");
  const rack = async (name: string) => {
    const result = await createLocation(owner, { level: 3, name });
    if (!result.ok) throw new Error("location setup failed");
    return result.locationId;
  };
  const a = await rack(`Rack A${++counter}`);
  const b = await rack(`Rack B${counter}`);
  const entry = await registerEntry(owner, {
    productId: created.productId,
    locationId: a,
    quantity: "50",
  });
  if (!entry.ok) throw new Error("entry setup failed");
  return { productId: created.productId, a, b };
}

async function newTask(
  supervisor: InventoryActor,
  place: Awaited<ReturnType<typeof scenario>>,
  extra: { quantity?: string; assignToUserId?: string; priority?: string } = {},
) {
  const result = await createTask(supervisor, {
    productId: place.productId,
    fromLocationId: place.a,
    toLocationId: place.b,
    quantity: extra.quantity ?? "12",
    priority: extra.priority ?? "NORMAL",
    assignToUserId: extra.assignToUserId,
    note: "Junto a la puerta 3",
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.taskId;
}

afterAll(() => db.$disconnect());

describe("createTask", () => {
  it("asks for a move without moving anything", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const supervisor = await member(owner.organizationId, "supervisor");
    const taskId = await newTask(supervisor, place, { priority: "URGENT" });
    const task = await getTask(supervisor, taskId);
    expect(task).toMatchObject({
      numberText: "T-0001",
      status: "PENDING",
      statusLabel: "Disponible",
      urgent: true,
      quantityText: "12 piezas",
      note: "Junto a la puerta 3",
      assignedToUserId: null,
    });
    expect(await getStockByLocation(owner, place.productId)).toEqual({
      [place.a]: "50",
    });
    // The second one takes the next number.
    await newTask(supervisor, place);
    expect((await listTasks(supervisor, { view: "available" })).total).toBe(2);
  });

  it("refuses what is not there, the same place and nonsense quantities", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const base = {
      productId: place.productId,
      fromLocationId: place.a,
      toLocationId: place.b,
      priority: "NORMAL" as const,
    };
    expect(await createTask(owner, { ...base, quantity: "51" })).toMatchObject({
      ok: false,
      fieldErrors: {
        quantity: expect.stringMatching(/^Solo hay 50 piezas en Rack A/),
      },
    });
    expect(
      await createTask(owner, {
        ...base,
        fromLocationId: place.b,
        toLocationId: place.a,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringMatching(/^No hay existencias/) },
    });
    expect(
      await createTask(owner, {
        ...base,
        toLocationId: place.a,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { toLocationId: expect.any(String) },
    });
    expect(await createTask(owner, { ...base, quantity: "1.5" })).toMatchObject(
      { ok: false, fieldErrors: { quantity: expect.any(String) } },
    );
  });

  it("is only for who may create tasks, and assigns only to who may do them", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const operator = await member(owner.organizationId, "operator");
    const buyer = await member(owner.organizationId, "buyer");
    await expect(newTask(operator, place)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(
      await createTask(owner, {
        productId: place.productId,
        fromLocationId: place.a,
        toLocationId: place.b,
        quantity: "2",
        assignToUserId: buyer.userId,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { assignToUserId: expect.any(String) },
    });
    const people = await listTaskPeople(owner);
    expect(people.map((p) => p.id)).toContain(operator.userId);
    expect(people.map((p) => p.id)).toContain(owner.userId);
    expect(people.map((p) => p.id)).not.toContain(buyer.userId);
  });
});

describe("doing a task", () => {
  it("accept → pick up → deliver writes one transfer, even if repeated", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const forklift = await member(owner.organizationId, "forklift", "Lupe");
    const taskId = await newTask(owner, place);

    // Delivering before picking up is not possible.
    expect(await acceptTask(forklift, taskId)).toMatchObject({ ok: true });
    expect(await deliverTask(forklift, taskId)).toMatchObject({
      ok: false,
      formError: "Primero confirma que recogiste la carga.",
    });
    expect(await acceptTask(forklift, taskId)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await countMyTasks(forklift)).toEqual({
      mine: 1,
      available: 0,
      blocked: 0,
    });
    expect(await pickUpTask(forklift, taskId)).toMatchObject({ ok: true });
    expect(await deliverTask(forklift, taskId)).toMatchObject({
      ok: true,
      summary: expect.stringMatching(/^Entregaste la tarea T-0001/),
    });
    expect(await deliverTask(forklift, taskId)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await getStockByLocation(owner, place.productId)).toEqual({
      [place.a]: "38",
      [place.b]: "12",
    });
    const task = await getTask(owner, taskId);
    expect(task).toMatchObject({
      status: "DELIVERED",
      assignedToName: "Lupe",
    });
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { id: task!.movementId! },
    });
    expect(movement).toMatchObject({
      type: "TRANSFER",
      reference: "T-0001",
      createdByUserId: forklift.userId,
      idempotencyKey: `task:${taskId}`,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("two people never take the same task, nor deliver it twice at once", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const one = await member(owner.organizationId, "forklift");
    const two = await member(owner.organizationId, "operator");
    const taskId = await newTask(owner, place);
    const taken = await Promise.all([
      acceptTask(one, taskId),
      acceptTask(two, taskId),
    ]);
    expect(taken.filter((r) => r.ok)).toHaveLength(1);
    expect(taken.find((r) => !r.ok)).toMatchObject({
      formError: "Otra persona ya tomó esta tarea.",
    });
    const winner = taken[0]!.ok ? one : two;
    const loser = taken[0]!.ok ? two : one;
    expect(await pickUpTask(loser, taskId)).toMatchObject({
      ok: false,
      formError: "Esta tarea la tiene otra persona.",
    });
    await pickUpTask(winner, taskId);
    const delivered = await Promise.all([
      deliverTask(winner, taskId),
      deliverTask(winner, taskId),
    ]);
    expect(delivered.every((r) => r.ok)).toBe(true);
    expect(delivered.filter((r) => r.ok && r.repeated)).toHaveLength(1);
    expect(
      await db.stockMovement.count({
        where: { organizationId: owner.organizationId, type: "TRANSFER" },
      }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("an assigned task is only for its person", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const lupe = await member(owner.organizationId, "forklift");
    const other = await member(owner.organizationId, "forklift");
    const taskId = await newTask(owner, place, { assignToUserId: lupe.userId });
    expect((await getTask(owner, taskId))?.status).toBe("ASSIGNED");
    expect(await acceptTask(other, taskId)).toMatchObject({
      ok: false,
      formError: "Esta tarea está asignada a otra persona.",
    });
    expect((await listTasks(lupe, { view: "mine" })).total).toBe(1);
    expect((await listTasks(other, { view: "mine" })).total).toBe(0);
    // Taken back, anyone may take it.
    expect(await assignTask(owner, taskId, null)).toMatchObject({ ok: true });
    expect(await acceptTask(other, taskId)).toMatchObject({ ok: true });
    expect(await assignTask(owner, taskId, lupe.userId)).toMatchObject({
      ok: false,
    });
  });

  it("when the stock left meanwhile, nothing moves and the problem is reported", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const forklift = await member(owner.organizationId, "forklift");
    const taskId = await newTask(owner, place, { quantity: "40" });
    await acceptTask(forklift, taskId);
    await pickUpTask(forklift, taskId);
    const exit = await registerExit(owner, {
      productId: place.productId,
      locationId: place.a,
      quantity: "20",
    });
    expect(exit.ok).toBe(true);
    expect(await deliverTask(forklift, taskId)).toMatchObject({
      ok: false,
      formError: expect.stringMatching(/reporta el problema\.$/),
    });
    expect((await getTask(owner, taskId))?.status).toBe("PICKED_UP");
    expect(await blockTask(forklift, taskId, "")).toMatchObject({
      ok: false,
      fieldErrors: { reason: "Escribe qué pasó." },
    });
    expect(
      await blockTask(forklift, taskId, "Solo había 30 en el rack"),
    ).toMatchObject({ ok: true });
    expect(await countMyTasks(owner)).toMatchObject({ blocked: 1 });
    // The supervisor releases it: anyone may take it again.
    const operator = await member(owner.organizationId, "operator");
    expect(await releaseTask(operator, taskId).catch((e) => e)).toMatchObject({
      code: "permission_denied",
    });
    expect(await releaseTask(owner, taskId)).toMatchObject({ ok: true });
    expect(await getTask(owner, taskId)).toMatchObject({
      status: "PENDING",
      assignedToUserId: null,
      blockedReason: "Solo había 30 en el rack",
    });
    expect(await cancelTask(owner, taskId, "")).toMatchObject({
      ok: false,
      fieldErrors: { reason: "Escribe por qué se cancela." },
    });
    expect(await cancelTask(owner, taskId, "Se movió a mano")).toMatchObject({
      ok: true,
    });
    expect(await acceptTask(operator, taskId)).toMatchObject({
      ok: false,
      formError: "Esta tarea está cancelada.",
    });
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: owner.organizationId,
          action: {
            in: ["inventory.task_released", "inventory.task_cancelled"],
          },
        },
      }),
    ).toBe(2);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a load in hand is not cancelled", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const taskId = await newTask(owner, place);
    await acceptTask(owner, taskId);
    await pickUpTask(owner, taskId);
    expect(await cancelTask(owner, taskId, "Ya no hace falta")).toMatchObject({
      ok: false,
      formError: "La carga ya se recogió: entrégala o reporta el problema.",
    });
  });
});

describe("in the database", () => {
  it("what a task moves never changes, it is never deleted and skips no step", async () => {
    const owner = await company();
    const place = await scenario(owner);
    const taskId = await newTask(owner, place);
    await expect(
      db.warehouseTask.update({
        where: { id: taskId },
        data: { quantity: "13" },
      }),
    ).rejects.toThrow();
    await expect(
      db.warehouseTask.update({
        where: { id: taskId },
        data: { status: "PICKED_UP", assignedToUserId: owner.userId },
      }),
    ).rejects.toThrow();
    await expect(
      db.warehouseTask.delete({ where: { id: taskId } }),
    ).rejects.toThrow();
  });
});

describe("between companies", () => {
  it("nobody reaches the tasks of another company", async () => {
    const ours = await company();
    const theirs = await company();
    const place = await scenario(theirs);
    const taskId = await newTask(theirs, place);
    expect(await getTask(ours, taskId)).toBeNull();
    for (const result of await Promise.all([
      acceptTask(ours, taskId),
      cancelTask(ours, taskId, "No es mía"),
      assignTask(ours, taskId, ours.userId),
      deliverTask(ours, taskId),
    ])) {
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect((await listTasks(ours, { view: "open" })).total).toBe(0);
    expect(
      await createTask(ours, {
        productId: place.productId,
        fromLocationId: place.a,
        toLocationId: place.b,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });
});
