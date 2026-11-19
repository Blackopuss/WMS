import { afterAll, describe, expect, it } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import {
  KPI_IDLE_DAYS,
  acceptTask,
  confirmPick,
  createOutboundOrder,
  createShipment,
  createTask,
  deliverTask,
  dispatchShipment,
  getWarehouseIndicators,
  pickUpTask,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import {
  keptAtTerminal,
  setMemberScope,
  type Role,
} from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createFacility, createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-32 (ADR 0082): every indicator against a scenario whose result was
// worked out by hand; scope, roles, costs and the company's calendar.

const DAY = 86_400_000;
const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `indicadores.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(facilities?: number): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén indicadores ${counter}`,
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
      users: 20,
      facilities,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de indicadores",
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

async function product(owner: InventoryActor, name: string) {
  const created = await createProduct(owner, { sku: `K-${++counter}`, name });
  if (!created.ok) throw new Error("product setup failed");
  return created.productId;
}

async function place(owner: InventoryActor, name: string, parentId?: string) {
  const result = await createLocation(owner, {
    level: parentId ? 3 : 1,
    name,
    ...(parentId ? { parentId } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function entry(
  actor: InventoryActor,
  productId: string,
  quantity: string,
  locationId: string,
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
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

/**
 * A movement of one line at a chosen moment (the fixture writes history;
 * it does not touch balances, so what the indicators derive is exactly
 * what the hand calculation says).
 */
async function movementAt(
  actor: InventoryActor,
  input: {
    type: "ENTRY" | "EXIT" | "SHIPMENT" | "REVERSAL";
    at: Date;
    productId: string;
    locationId: string;
    quantity: string;
    unitCost?: string;
    reverses?: string;
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
      reversesMovementId: input.reverses ?? null,
      reason: input.type === "REVERSAL" ? "Prueba de indicadores" : null,
    },
  });
  await db.stockMovementLine.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      movementId,
      lineNumber: 1,
      productId: input.productId,
      locationId: input.locationId,
      direction:
        input.type === "EXIT" || input.type === "SHIPMENT" ? "OUT" : "IN",
      capturedQuantity: input.quantity,
      factor: "1",
      baseQuantity: input.quantity,
      unitCode: "piece",
      unitCost: input.unitCost ?? null,
      createdAt: input.at,
    },
  });
  return movementId;
}

/** Today in Mexico City (the default zone of a company), year-month-day. */
const mexicoDay = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

afterAll(() => db.$disconnect());

describe("getWarehouseIndicators", () => {
  it("busiest products with their rotation; value only with costs", async () => {
    const owner = await company();
    const supervisor = await member(owner.organizationId, "supervisor");
    const zone = await place(owner, "Zona A");
    const shelf = await place(owner, "Estante A1", zone);
    const pliers = await product(owner, "Pinza");
    const tape = await product(owner, "Cinta");
    await entry(owner, pliers, "100", shelf);

    // The period: the 7 days ending 20 days from now.
    const now = new Date(Date.now() + 20 * DAY);
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const write = (
      input: Omit<Parameters<typeof movementAt>[1], "locationId">,
    ) => movementAt(owner, { ...input, locationId: shelf });
    // Before the period: changes nothing.
    await write({ type: "EXIT", at: at(10), productId: pliers, quantity: "7" });
    // Inside: +20 −30 −10 −5 +5 (the last exit was reversed).
    await write({
      type: "ENTRY",
      at: at(4),
      productId: pliers,
      quantity: "20",
    });
    await write({
      type: "EXIT",
      at: at(3),
      productId: pliers,
      quantity: "30",
      unitCost: "2",
    });
    await write({
      type: "SHIPMENT",
      at: at(2),
      productId: pliers,
      quantity: "10",
      unitCost: "2",
    });
    const undone = await write({
      type: "EXIT",
      at: at(1),
      productId: pliers,
      quantity: "5",
      unitCost: "2",
    });
    await write({
      type: "REVERSAL",
      at: new Date(at(1).getTime() + 60_000),
      productId: pliers,
      quantity: "5",
      reverses: undone,
    });
    // After the period: +8.
    await write({
      type: "ENTRY",
      at: new Date(now.getTime() + 2 * DAY),
      productId: pliers,
      quantity: "8",
    });
    // Tape: three exits of one, no stock left.
    for (const days of [1, 2, 3]) {
      await write({
        type: "EXIT",
        at: at(days),
        productId: tape,
        quantity: "1",
      });
    }

    // Pliers: end = 100 − 8 = 92; start = 92 − (−20) = 112; average 102;
    // out 40 → 40 ÷ 102 = 0.39; 7 ÷ 0.39 = 18 days.
    // Tape: end 0, start 3, average 1.5 → 3 ÷ 1.5 = 2.00; 7 ÷ 2 = 4 days.
    const seen = await getWarehouseIndicators(owner, { preset: "7", now });
    expect(seen.period).toMatchObject({ days: 7, preset: "7" });
    expect(seen.exits.lines).toBe(5);
    expect(seen.exits.value).toBe("$80.00");
    expect(seen.exits.top).toEqual([
      {
        productId: tape,
        name: "Cinta",
        sku: expect.any(String),
        exitLines: 3,
        exitQuantity: "3 piezas",
        averageStock: "1.5 piezas",
        rotation: "2.00",
        daysOfInventory: "4",
        exitValue: "$0.00",
      },
      {
        productId: pliers,
        name: "Pinza",
        sku: expect.any(String),
        exitLines: 2,
        exitQuantity: "40 piezas",
        averageStock: "102 piezas",
        rotation: "0.39",
        daysOfInventory: "18",
        exitValue: "$80.00",
      },
    ]);

    // Without costs the fields do not exist.
    const plain = await getWarehouseIndicators(supervisor, {
      preset: "7",
      now,
    });
    expect(plain.exits).not.toHaveProperty("value");
    for (const row of plain.exits.top)
      expect(row).not.toHaveProperty("exitValue");
    expect(plain.exits.top.map((row) => row.rotation)).toEqual([
      "2.00",
      "0.39",
    ]);

    // One product: only its row and its exits.
    const one = await getWarehouseIndicators(owner, {
      preset: "7",
      now,
      productId: pliers,
    });
    expect(one.product).toMatchObject({ id: pliers, name: "Pinza" });
    expect(one.exits.lines).toBe(2);
    expect(one.exits.top.map((row) => row.productId)).toEqual([pliers]);
    // A product of another company is ignored.
    const other = await company();
    const foreign = await product(other, "Ajeno");
    const ignored = await getWarehouseIndicators(owner, {
      preset: "7",
      now,
      productId: foreign,
    });
    expect(ignored.product).toBeNull();
    expect(ignored.exits.lines).toBe(5);
    // The other company sees none of it.
    const theirs = await getWarehouseIndicators(other, { preset: "7", now });
    expect(theirs.exits).toMatchObject({ lines: 0, top: [] });
  }, 120_000);

  it("products with stock that did not move in the company's days", async () => {
    const owner = await company();
    const supervisor = await member(owner.organizationId, "supervisor");
    const shelf = await place(owner, "Zona B");
    const resting = await product(owner, "Reposa");
    const moving = await product(owner, "Se mueve");
    await entry(owner, resting, "5", shelf);
    await entry(owner, moving, "5", shelf);
    const now = new Date(Date.now() + 40 * DAY);

    // 90 days by default: both moved within them.
    expect(KPI_IDLE_DAYS.defaultValue).toBe("90");
    expect((await getWarehouseIndicators(owner, { now })).idle).toMatchObject({
      days: 90,
      count: 0,
      rows: [],
    });

    await setting(owner, KPI_IDLE_DAYS.key, "30");
    await movementAt(owner, {
      type: "ENTRY",
      at: new Date(now.getTime() - 5 * DAY),
      productId: moving,
      locationId: shelf,
      quantity: "1",
    });
    const idle = (await getWarehouseIndicators(owner, { now })).idle;
    expect(idle).toMatchObject({ days: 30, count: 1 });
    expect(idle.rows).toEqual([
      {
        productId: resting,
        name: "Reposa",
        sku: expect.any(String),
        stock: "5 piezas",
        lastMovementAt: expect.any(Date),
        value: "$0.00",
      },
    ]);
    const plain = (await getWarehouseIndicators(supervisor, { now })).idle;
    expect(plain.count).toBe(1);
    expect(plain.rows[0]).not.toHaveProperty("value");
  }, 60_000);

  it("orders complete and on time against their day of departure", async () => {
    const owner = await company();
    const shelf = await place(owner, "Zona C");
    const plenty = await product(owner, "Abundante");
    const scarce = await product(owner, "Escaso");
    await entry(owner, plenty, "100", shelf);
    await entry(owner, scarce, "6", shelf);
    const today = mexicoDay(new Date());
    const shift = (days: number) =>
      new Date(Date.parse(`${today}T12:00:00Z`) + days * DAY)
        .toISOString()
        .slice(0, 10);

    const order = async (
      productId: string,
      quantity: string,
      dueOn?: string,
    ) => {
      const made = await createOutboundOrder(owner, {
        recipient: "Sucursal",
        ...(dueOn ? { dueOn } : {}),
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
    };
    // Complete and on time; short (6 of 10) but on time; complete and
    // late; complete without a day of departure.
    const orders = [
      await order(plenty, "10", shift(1)),
      await order(scarce, "10", today),
      await order(plenty, "5", shift(-1)),
      await order(plenty, "5"),
    ];
    const picks = await db.warehouseTask.findMany({
      where: { organizationId: owner.organizationId, kind: "PICK" },
      orderBy: { number: "asc" },
      include: { product: true, fromLocation: true },
    });
    for (const task of picks) {
      expect(await acceptTask(owner, task.id)).toMatchObject({ ok: true });
      expect(
        await confirmPick(owner, task.id, {
          productCode: task.product!.sku,
          locationCode: task.fromLocation.name,
          quantity: task.quantity!.toString(),
        }),
      ).toMatchObject({ ok: true });
      expect(await deliverTask(owner, task.id)).toMatchObject({ ok: true });
    }
    const shipment = await createShipment(owner, { orderIds: orders });
    if (!shipment.ok) throw new Error(JSON.stringify(shipment));
    expect(await dispatchShipment(owner, shipment.shipmentId)).toMatchObject({
      ok: true,
    });

    const seen = await getWarehouseIndicators(owner, { preset: "7" });
    expect(seen.orders).toEqual({
      shipped: 4,
      read: 4,
      complete: 3,
      withDueDay: 3,
      onTime: 2,
      completeOnTime: 1,
      completeShare: "75.0",
      onTimeShare: "66.7",
      completeOnTimeShare: "33.3",
      truncated: false,
    });
    expect(seen.picking).toMatchObject({ orders: 4, count: 4 });
    expect(seen.picking.medianMs).not.toBeNull();
    // Not in another warehouse's period: a month ago nothing left.
    const before = await getWarehouseIndicators(owner, {
      from: shift(-40),
      to: shift(-35),
    });
    expect(before.orders.shipped).toBe(0);
  }, 120_000);

  it("work per person and per zone, inside the person's zones", async () => {
    const owner = await company(2);
    const zoneA = await place(owner, "Zona Norte");
    const zoneB = await place(owner, "Zona Sur");
    const a1 = await place(owner, "Estante N1", zoneA);
    const a2 = await place(owner, "Estante N2", zoneA);
    const b1 = await place(owner, "Estante S1", zoneB);
    const box = await product(owner, "Caja");
    await entry(owner, box, "50", a1);
    await entry(owner, box, "50", b1);
    const first = await member(owner.organizationId, "operator", "Ana");
    const second = await member(owner.organizationId, "operator", "Beto");

    const move = async (
      by: InventoryActor,
      from: string,
      to: string,
      minutes: number,
    ) => {
      const made = await createTask(owner, {
        productId: box,
        fromLocationId: from,
        toLocationId: to,
        quantity: "1",
        priority: "NORMAL",
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      expect(await acceptTask(by, made.taskId)).toMatchObject({ ok: true });
      expect(await pickUpTask(by, made.taskId)).toMatchObject({ ok: true });
      // How long it took, written behind the service before it closes.
      await db.warehouseTask.update({
        where: { id: made.taskId },
        data: { acceptedAt: new Date(Date.now() - minutes * 60_000) },
      });
      expect(await deliverTask(by, made.taskId)).toMatchObject({ ok: true });
    };
    await move(first, a1, a2, 10);
    await move(second, b1, a1, 30);

    const seen = await getWarehouseIndicators(owner, { preset: "7" });
    const kinds = { TRANSFER: 1, PICK: 0, PUTAWAY: 0, REPLENISH: 0, ISSUE: 0 };
    expect(seen.people).toEqual([
      {
        userId: first.userId,
        name: "Ana",
        tasks: 1,
        byKind: kinds,
        movements: 1,
        medianTaskMs: expect.closeTo(600_000, -4),
      },
      {
        userId: second.userId,
        name: "Beto",
        tasks: 1,
        byKind: kinds,
        movements: 1,
        medianTaskMs: expect.closeTo(1_800_000, -4),
      },
      {
        userId: owner.userId,
        name: "Titular",
        tasks: 0,
        byKind: { ...kinds, TRANSFER: 0 },
        movements: 2,
        medianTaskMs: null,
      },
    ]);
    // North: entry, both sides of Ana's move and Beto's arrival; South:
    // entry and Beto's departure.
    expect(seen.zones).toEqual([
      {
        zoneId: zoneA,
        name: "Zona Norte",
        tasks: 1,
        movementLines: 4,
        medianTaskMs: expect.closeTo(600_000, -4),
      },
      {
        zoneId: zoneB,
        name: "Zona Sur",
        tasks: 1,
        movementLines: 2,
        medianTaskMs: expect.closeTo(1_800_000, -4),
      },
    ]);

    // One person: only what that person did.
    const ana = await getWarehouseIndicators(owner, {
      preset: "7",
      personId: first.userId,
    });
    expect(ana.person).toEqual({ userId: first.userId, name: "Ana" });
    expect(ana.people?.map((row) => row.userId)).toEqual([first.userId]);
    expect(ana.zones).toEqual([
      {
        zoneId: zoneA,
        name: "Zona Norte",
        tasks: 1,
        movementLines: 2,
        medianTaskMs: expect.closeTo(600_000, -4),
      },
    ]);
    // Someone of another company is not a person here.
    const other = await company();
    expect(
      (
        await getWarehouseIndicators(owner, {
          preset: "7",
          personId: other.userId,
        })
      ).person,
    ).toBeNull();

    // A supervisor limited to the north zone sees only it.
    const north = await member(owner.organizationId, "supervisor", "Norte");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: north.userId,
      facilities: [
        {
          facilityId: (
            await db.location.findUniqueOrThrow({
              where: { id: zoneA },
            })
          ).facilityId,
          zoneIds: [zoneA],
        },
      ],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const limited = await getWarehouseIndicators(north, { preset: "7" });
    expect(limited.zones.map((row) => row.zoneId)).toEqual([zoneA]);
    expect(
      limited.people?.map((row) => [row.name, row.tasks, row.movements]),
    ).toEqual([
      ["Ana", 1, 1],
      ["Beto", 0, 1],
      ["Titular", 0, 1],
    ]);
    // A warehouse outside the scope is ignored.
    const second2 = await createFacility(owner, {
      name: "Bodega 2",
      code: "B2",
    });
    if (!second2.ok) throw new Error(JSON.stringify(second2));
    expect(limited.facilities).toHaveLength(1);
    const asked = await getWarehouseIndicators(north, {
      preset: "7",
      facilityId: second2.facilityId,
    });
    expect(asked.facility.id).toBe(limited.facility.id);
    // The owner can choose it: nothing happened there.
    const there = await getWarehouseIndicators(owner, {
      preset: "7",
      facilityId: second2.facilityId,
    });
    expect(there.facility.id).toBe(second2.facilityId);
    expect(there.zones).toEqual([]);
    expect(there.facilities).toHaveLength(2);
  }, 120_000);

  it("is for who runs or supervises; how each person worked not at a terminal", async () => {
    const owner = await company();
    for (const role of [
      "operator",
      "forklift",
      "warehouse",
      "buyer",
      "viewer",
      "production_operator",
      "production_supervisor",
      "quality_inspector",
    ] as const) {
      const person = await member(owner.organizationId, role);
      await expect(getWarehouseIndicators(person)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    for (const role of ["administrator", "supervisor", "manager"] as const) {
      const person = await member(owner.organizationId, role);
      const seen = await getWarehouseIndicators(person);
      expect(seen.people).toBeDefined();
      expect(seen.accuracy).toBeDefined();
    }
    const stranger = await company();
    await expect(
      getWarehouseIndicators({
        organizationId: owner.organizationId,
        userId: stranger.userId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(keptAtTerminal("inventory.kpi.read")).toBe(true);
    expect(keptAtTerminal("inventory.worker_performance.read")).toBe(false);
  }, 60_000);

  it("a period is days of the company's calendar, not of UTC", async () => {
    const owner = await company();
    const shelf = await place(owner, "Zona D");
    const item = await product(owner, "Reloj");
    // Mexico City is UTC−6: Friday 6 starts at 06:00 UTC.
    const now = new Date("2030-11-12T18:00:00Z");
    for (const at of ["2030-11-06T05:59:00Z", "2030-11-06T06:01:00Z"]) {
      await movementAt(owner, {
        type: "EXIT",
        at: new Date(at),
        productId: item,
        locationId: shelf,
        quantity: "1",
      });
    }
    const week = await getWarehouseIndicators(owner, { preset: "7", now });
    expect(week.period).toMatchObject({ from: "2030-11-06", to: "2030-11-12" });
    expect(week.exits.lines).toBe(1);
    const fifth = await getWarehouseIndicators(owner, {
      from: "2030-11-05",
      to: "2030-11-05",
      now,
    });
    expect(fifth.exits.lines).toBe(1);
    // In Tijuana (UTC−8) both fall on the 5th.
    await db.organization.update({
      where: { id: owner.organizationId },
      data: { timeZone: "America/Tijuana" },
    });
    expect(
      (await getWarehouseIndicators(owner, { preset: "7", now })).exits.lines,
    ).toBe(0);
  }, 60_000);
});
