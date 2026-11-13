import { afterAll, describe, expect, it } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import {
  acceptTask,
  cancelTask,
  confirmPick,
  createOutboundOrder,
  createTask,
  deliverTask,
  getDaySummary,
  getOutboundOrder,
  listMovements,
  listOutboundOrders,
  listTasks,
  pickUpTask,
  registerEntry,
  registerExit,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  getDefaultLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-73: the summary of the day counts what the active warehouse did
// today, a day of the company's calendar, and who did it. Only for who
// runs or supervises; documents and lines, never quantities.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `resumen.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(facilities?: number): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén resumen ${counter}`,
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
      facilities,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba del resumen del día",
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

async function product(owner: InventoryActor, name = "Caja de cartón") {
  const created = await createProduct(owner, { sku: `R-${++counter}`, name });
  if (!created.ok) throw new Error("product setup failed");
  return created.productId;
}

async function rack(owner: InventoryActor, name: string) {
  const result = await createLocation(owner, { level: 3, name });
  if (!result.ok) throw new Error("location setup failed");
  return result.locationId;
}

async function entry(
  actor: InventoryActor,
  productId: string,
  quantity: string,
  locationId?: string,
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    // These tests repeat identical entries on purpose (WMS-71).
    acceptRepeat: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/**
 * A movement confirmed at a chosen moment, with its lines (the fixture
 * writes the date; it does not touch balances).
 */
async function movementAt(
  actor: InventoryActor,
  input: {
    type: "ENTRY" | "EXIT" | "RECEIPT";
    at: Date;
    productId: string;
    locationId: string;
    lines?: number;
  },
) {
  const movementId = newId();
  await db.stockMovement.create({
    data: {
      id: movementId,
      organizationId: actor.organizationId,
      type: input.type,
      createdByUserId: actor.userId,
      createdAt: input.at,
    },
  });
  const { unitCode } = await db.product.findUniqueOrThrow({
    where: { id: input.productId },
    select: { unitCode: true },
  });
  for (let line = 1; line <= (input.lines ?? 1); line++) {
    await db.stockMovementLine.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        movementId,
        lineNumber: line,
        productId: input.productId,
        locationId: input.locationId,
        direction: input.type === "EXIT" ? "OUT" : "IN",
        capturedQuantity: "1",
        factor: "1",
        baseQuantity: "1",
        unitCode,
        createdAt: input.at,
      },
    });
  }
}

const generalOf = async (actor: InventoryActor) =>
  (await getDefaultLocation(actor))!.id;

afterAll(() => db.$disconnect());

describe("getDaySummary", () => {
  it("counts what was done today, as the lists do, and who did it", async () => {
    const owner = await company();
    const supervisor = await member(
      owner.organizationId,
      "supervisor",
      "Sofía Supervisora",
    );
    const operator = await member(
      owner.organizationId,
      "operator",
      "Omar Operador",
    );
    const productId = await product(owner);
    const a = await rack(owner, "Rack A");
    const b = await rack(owner, "Rack B");

    expect(await getDaySummary(owner)).toMatchObject({
      entries: { documents: 0, lines: 0 },
      exits: { documents: 0, lines: 0 },
      receipts: { documents: 0, lines: 0 },
      tasksDone: 0,
      ordersPicked: { documents: 0, lines: 0 },
      people: [],
    });

    // Two entries by the owner, one exit by the operator.
    await entry(owner, productId, "30", a);
    await entry(owner, productId, "20", b);
    expect(
      await registerExit(operator, { productId, locationId: a, quantity: "5" }),
    ).toMatchObject({ ok: true });
    // A receipt of a purchase order with two lines, by the supervisor.
    await movementAt(supervisor, {
      type: "RECEIPT",
      at: new Date(),
      productId,
      locationId: a,
      lines: 2,
    });

    // An order of 40 pieces: 25 from A and 15 from B, picked by the operator.
    const made = await createOutboundOrder(owner, {
      recipient: "Sucursal Norte",
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(owner, made.orderId, { productId, quantity: "40" });
    expect(await releaseOutboundOrder(owner, made.orderId)).toMatchObject({
      ok: true,
    });
    const picks = await db.warehouseTask.findMany({
      where: { organizationId: owner.organizationId, kind: "PICK" },
      orderBy: { number: "asc" },
      include: { product: true, fromLocation: true },
    });
    expect(picks).toHaveLength(2);
    for (const task of picks) {
      expect(await acceptTask(operator, task.id)).toMatchObject({ ok: true });
      expect(
        await confirmPick(operator, task.id, {
          productCode: task.product!.sku,
          locationCode: task.fromLocation.name,
          quantity: task.quantity!.toString(),
        }),
      ).toMatchObject({ ok: true });
      expect(await deliverTask(operator, task.id)).toMatchObject({ ok: true });
    }
    expect((await getOutboundOrder(owner, made.orderId))?.status).toBe(
      "PICKED",
    );
    // A second order, released and not picked yet: it does not count.
    const waiting = await createOutboundOrder(owner, {
      recipient: "Sucursal Sur",
    });
    if (!waiting.ok) throw new Error(JSON.stringify(waiting));
    await setOutboundLine(owner, waiting.orderId, { productId, quantity: "1" });
    expect(await releaseOutboundOrder(owner, waiting.orderId)).toMatchObject({
      ok: true,
    });

    // A move asked by the supervisor and done by the operator, and one
    // that was cancelled (not work done).
    const task = async () => {
      const result = await createTask(supervisor, {
        productId,
        fromLocationId: b,
        toLocationId: a,
        quantity: "1",
        priority: "NORMAL",
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.taskId;
    };
    const moved = await task();
    expect(await acceptTask(operator, moved)).toMatchObject({ ok: true });
    expect(await pickUpTask(operator, moved)).toMatchObject({ ok: true });
    expect(await deliverTask(operator, moved)).toMatchObject({ ok: true });
    expect(
      await cancelTask(supervisor, await task(), "Ya no hace falta"),
    ).toMatchObject({ ok: true });

    const summary = await getDaySummary(supervisor);
    expect(summary).toMatchObject({
      entries: { documents: 2, lines: 2 },
      exits: { documents: 1, lines: 1 },
      receipts: { documents: 1, lines: 2 },
      tasksDone: 3,
      ordersPicked: { documents: 1, lines: 1 },
    });
    // The busiest first: the operator's exit and three deliveries (each
    // one a transfer), the owner's two entries, the supervisor's receipt.
    expect(summary.people).toEqual([
      {
        userId: operator.userId,
        name: "Omar Operador",
        movements: 4,
        tasksDone: 3,
      },
      { userId: owner.userId, name: "Titular", movements: 2, tasksDone: 0 },
      {
        userId: supervisor.userId,
        name: "Sofía Supervisora",
        movements: 1,
        tasksDone: 0,
      },
    ]);

    // «Listo cuando»: the same numbers as the lists filtered by today.
    const today = { from: summary.day, to: summary.day };
    for (const [type, counted] of [
      ["ENTRY", summary.entries],
      ["EXIT", summary.exits],
      ["RECEIPT", summary.receipts],
    ] as const) {
      expect((await listMovements(owner, { ...today, type })).total).toBe(
        counted.documents,
      );
    }
    expect((await listOutboundOrders(owner, { status: "PICKED" })).total).toBe(
      summary.ordersPicked.documents,
    );
    // The owner and Gerencia read the same.
    const manager = await member(owner.organizationId, "manager");
    // The lists narrowed to the day: the same numbers the tiles link to.
    const doneToday = await listTasks(owner, {
      view: "closed",
      day: summary.day,
    });
    expect(doneToday).toMatchObject({
      total: summary.tasksDone,
      day: summary.day,
    });
    const pickedToday = await listOutboundOrders(owner, {
      pickedOn: summary.day,
    });
    expect(pickedToday).toMatchObject({
      total: summary.ordersPicked.documents,
      pickedOn: summary.day,
      status: null,
    });
    // Another day has nothing; what is not a day narrows nothing.
    expect(
      (await listTasks(owner, { view: "closed", day: "2000-01-01" })).total,
    ).toBe(0);
    expect(
      (await listOutboundOrders(owner, { pickedOn: "2000-01-01" })).total,
    ).toBe(0);
    expect(
      await listTasks(owner, { view: "closed", day: "ayer" }),
    ).toMatchObject({ day: null });
    // A day that does not exist is ignored, not an error.
    expect(
      await listTasks(owner, { view: "closed", day: "2026-13-45" }),
    ).toMatchObject({ day: null });
    expect(
      await listOutboundOrders(owner, { pickedOn: "2026-02-30" }),
    ).toMatchObject({ pickedOn: null });
    expect(await listOutboundOrders(owner, { pickedOn: "ayer" })).toMatchObject(
      { pickedOn: null },
    );

    expect(await getDaySummary(owner)).toEqual(summary);
    expect(await getDaySummary(manager)).toEqual(summary);
  }, 120_000);

  it("is not for the floor nor for roles that only consult", async () => {
    const owner = await company();
    await entry(owner, await product(owner), "3");
    for (const role of [
      "operator",
      "forklift",
      "warehouse",
      "buyer",
      "viewer",
    ] as const) {
      const person = await member(owner.organizationId, role);
      await expect(getDaySummary(person)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    for (const role of ["administrator", "supervisor", "manager"] as const) {
      const person = await member(owner.organizationId, role);
      expect((await getDaySummary(person)).entries.documents).toBe(1);
    }
    // Someone of another company is nobody here.
    const stranger = await company();
    await expect(
      getDaySummary({
        organizationId: owner.organizationId,
        userId: stranger.userId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }, 60_000);

  it("the day starts and ends in the company's time zone", async () => {
    // Mexico City is UTC−6 all year: Thursday 12 starts at 06:00 UTC.
    const now = new Date("2026-11-12T18:00:00Z");
    const moments = [
      "2026-11-12T05:59:00Z", // 23:59 of the 11th in Mexico City
      "2026-11-12T06:01:00Z", // 00:01 of the 12th
      "2026-11-12T07:00:00Z", // 01:00 of the 12th; 23:00 of the 11th in Tijuana
      "2026-11-13T05:59:00Z", // 23:59 of the 12th
      "2026-11-13T06:01:00Z", // 00:01 of the 13th; 22:01 of the 12th in Tijuana
    ];
    const scenario = async (timeZone?: string) => {
      const owner = await company();
      if (timeZone) {
        await db.organization.update({
          where: { id: owner.organizationId },
          data: { timeZone },
        });
      }
      const productId = await product(owner);
      const locationId = await generalOf(owner);
      for (const at of moments) {
        await movementAt(owner, {
          type: "ENTRY",
          at: new Date(at),
          productId,
          locationId,
        });
      }
      return owner;
    };

    const mexico = await scenario();
    expect(await getDaySummary(mexico, { now })).toMatchObject({
      day: "2026-11-12",
      entries: { documents: 3, lines: 3 },
      people: [{ userId: mexico.userId, movements: 3, tasksDone: 0 }],
    });
    // One minute before midnight it is still the 11th; one after, the 12th.
    expect(
      await getDaySummary(mexico, { now: new Date("2026-11-12T05:59:30Z") }),
    ).toMatchObject({ day: "2026-11-11", entries: { documents: 1 } });
    expect(
      await getDaySummary(mexico, { now: new Date("2026-11-13T06:00:30Z") }),
    ).toMatchObject({ day: "2026-11-13", entries: { documents: 1 } });

    // The same moments in Tijuana (UTC−8 in November): its 12th starts at
    // 08:00 UTC.
    const tijuana = await scenario("America/Tijuana");
    expect(await getDaySummary(tijuana, { now })).toMatchObject({
      day: "2026-11-12",
      entries: { documents: 2, lines: 2 },
    });
  }, 60_000);

  it("never counts another company", async () => {
    const one = await company();
    const other = await company();
    const first = await product(one);
    await entry(one, first, "5");
    await entry(one, first, "5");
    await entry(other, await product(other), "7");
    expect(
      await registerExit(other, {
        productId: (
          await db.product.findFirstOrThrow({
            where: { organizationId: other.organizationId },
          })
        ).id,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });

    expect(await getDaySummary(one)).toMatchObject({
      entries: { documents: 2, lines: 2 },
      exits: { documents: 0, lines: 0 },
      people: [{ userId: one.userId, movements: 2 }],
    });
    expect(await getDaySummary(other)).toMatchObject({
      entries: { documents: 1, lines: 1 },
      exits: { documents: 1, lines: 1 },
      people: [{ userId: other.userId, movements: 2 }],
    });
  }, 60_000);

  it("counts only the warehouse the person works in", async () => {
    const owner = await company(3);
    const second = await createFacility(owner, {
      name: "Bodega Norte",
      code: "norte",
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    // A colleague stays in the main warehouse.
    const colleague = await member(
      owner.organizationId,
      "supervisor",
      "Colega",
    );
    const productId = await product(owner);

    await entry(owner, productId, "10");
    expect(await switchFacility(owner, second.facilityId)).toMatchObject({
      ok: true,
    });
    const northGeneral = await generalOf(owner);
    await entry(owner, productId, "4", northGeneral);
    await entry(owner, productId, "6", northGeneral);
    expect(
      await registerExit(owner, {
        productId,
        locationId: northGeneral,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    // A task done in the north warehouse.
    const northRack = await rack(owner, "Rack norte");
    const task = await createTask(owner, {
      productId,
      fromLocationId: northGeneral,
      toLocationId: northRack,
      quantity: "2",
      priority: "NORMAL",
    });
    if (!task.ok) throw new Error(JSON.stringify(task));
    expect(await acceptTask(owner, task.taskId)).toMatchObject({ ok: true });
    expect(await pickUpTask(owner, task.taskId)).toMatchObject({ ok: true });
    expect(await deliverTask(owner, task.taskId)).toMatchObject({ ok: true });

    const north = await getDaySummary(owner);
    expect(north).toMatchObject({
      entries: { documents: 2, lines: 2 },
      exits: { documents: 1, lines: 1 },
      tasksDone: 1,
      // Two entries, one exit and the transfer of the task.
      people: [{ userId: owner.userId, movements: 4, tasksDone: 1 }],
    });
    // The colleague, in the main warehouse, sees only what happened there.
    expect(await getDaySummary(colleague)).toMatchObject({
      entries: { documents: 1, lines: 1 },
      exits: { documents: 0, lines: 0 },
      tasksDone: 0,
      people: [{ userId: owner.userId, movements: 1, tasksDone: 0 }],
    });
  }, 60_000);
});
