import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  PICKING_MODE,
  assignWaveTasks,
  cancelOutboundOrder,
  cancelWave,
  confirmPick,
  confirmWavePick,
  createOutboundOrder,
  createWave,
  deliverTask,
  deliverWavePicks,
  getWave,
  listOpenWaves,
  listTasks,
  listWaveCandidates,
  nextTaskFor,
  reconcileStock,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  takeWaveTasks,
  acceptTask,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-25 (ADR 0054): a wave groups orders so they are picked together, in
// walking order and with one scan for what several orders take of the
// same shelf. Every picking task stays of one line of one order, so what
// is picked adds up by order and cancelling an order releases only its own.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `olas.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(waves = true): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén olas ${counter}`,
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
      reason: "Prueba de olas",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  const actor = { organizationId: created.organizationId, userId: owner };
  if (waves) {
    const set = await updateOperationSetting(
      actor,
      operationSettings,
      PICKING_MODE.key,
      "waves",
    );
    if (!set.ok) throw new Error(JSON.stringify(set));
  }
  return actor;
}

async function member(
  organizationId: string,
  role: Role,
): Promise<InventoryActor> {
  const userId = await newUser(`Persona ${counter}`);
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
  extra: { tracking?: "LOT"; lotExpiry?: "OPTIONAL" } = {},
) {
  const sku = `OLA-${++counter}`;
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
    code?: string;
    parentId?: string;
    type?: "STORAGE" | "PICKING";
  } = {},
) {
  const made = await createLocation(actor, {
    level: options.level ?? 3,
    name,
    code: options.code,
    parentId: options.parentId,
    type: options.type ?? "STORAGE",
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
  const entry = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    ...extra,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
}

async function draft(
  actor: InventoryActor,
  lines: { productId: string; quantity: string }[],
  options: { urgent?: boolean; dueOn?: string } = {},
) {
  const made = await createOutboundOrder(actor, {
    recipient: `Sucursal ${++counter}`,
    priority: options.urgent ? "URGENT" : "NORMAL",
    dueOn: options.dueOn,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  for (const line of lines) {
    const set = await setOutboundLine(actor, made.orderId, line);
    if (!set.ok) throw new Error(JSON.stringify(set));
  }
  return made.orderId;
}

const orderStatus = async (id: string) =>
  (await db.outboundOrder.findUniqueOrThrow({ where: { id } })).status;

const tasksOf = (orderId: string) =>
  db.warehouseTask.findMany({
    where: { kind: "PICK", outboundLine: { orderId } },
    orderBy: { number: "asc" },
  });

const heldFor = async (orderId: string) => {
  const rows = await db.stockReservation.findMany({
    where: {
      sourceType: "outbound_order_line",
      state: "ACTIVE",
      sourceId: {
        in: (await db.outboundOrderLine.findMany({ where: { orderId } })).map(
          (line) => line.id,
        ),
      },
    },
  });
  return rows.map((row) => ({
    locationId: row.locationId,
    remaining: row.remaining.toString(),
  }));
};

const stagingOf = async (organizationId: string) =>
  (
    await db.location.findFirstOrThrow({
      where: { organizationId, isStaging: true },
    })
  ).id;

/** A product with 100 pieces at A-01-02 and three drafts of 10, 12 and 8. */
async function threeOrders() {
  const owner = await company();
  const item = await product(owner);
  const shelf = await place(owner, "Estante 2", { code: "A-01-02" });
  await enter(owner, item.id, shelf, "100");
  const orders = [
    await draft(owner, [{ productId: item.id, quantity: "10" }]),
    await draft(owner, [{ productId: item.id, quantity: "12" }]),
    await draft(owner, [{ productId: item.id, quantity: "8" }]),
  ];
  return { owner, item, shelf, orders };
}

afterAll(() => db.$disconnect());

describe("with picking order by order (the default)", () => {
  it("nothing changes and no wave can be made", async () => {
    const owner = await company(false);
    const item = await product(owner);
    const shelf = await place(owner, "Estante 1", { code: "A-01-01" });
    await enter(owner, item.id, shelf, "20");
    const order = await draft(owner, [{ productId: item.id, quantity: "5" }]);
    expect(await createWave(owner, { orderIds: [order] })).toEqual({
      ok: false,
      reason: "not_allowed",
      formError: expect.stringMatching(/apagado/),
    });
    expect(await orderStatus(order)).toBe("DRAFT");
    expect(
      await db.pickWave.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    // Release, pick and deliver work as in WMS-14.
    expect(await releaseOutboundOrder(owner, order)).toMatchObject({
      ok: true,
    });
    const [task] = await tasksOf(order);
    expect(await acceptTask(owner, task!.id)).toMatchObject({ ok: true });
    expect(
      await confirmPick(owner, task!.id, {
        productCode: item.sku,
        locationCode: "A-01-01",
        quantity: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(owner, task!.id)).toMatchObject({ ok: true });
    expect(await orderStatus(order)).toBe("PICKED");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("a wave of three orders of the same product", () => {
  it("is picked with one scan and adds up by order", async () => {
    const { owner, item, orders } = await threeOrders();
    const candidates = await listWaveCandidates(owner);
    expect(candidates.items.map((row) => row.id).sort()).toEqual(
      [...orders].sort(),
    );
    const made = await createWave(owner, { orderIds: orders });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(made.summary).toMatch(/OL-0001 con 3 pedidos y 3 tareas/);
    for (const order of orders) {
      expect(await orderStatus(order)).toBe("RELEASED");
    }
    // Already in an open wave: not offered again.
    expect((await listWaveCandidates(owner)).items).toEqual([]);
    expect(await listOpenWaves(owner)).toEqual([
      { id: made.waveId, numberText: "OL-0001" },
    ]);

    const view = await getWave(owner, made.waveId);
    expect(view).toMatchObject({
      status: "OPEN",
      pickTotal: 1,
      toLeave: null,
    });
    const [group] = view!.picks;
    expect(group).toMatchObject({
      quantityText: "30 piezas",
      takeText: "30 piezas",
      fromCode: "A-01-02",
    });
    expect(group!.parts.map((part) => part.quantityText)).toEqual([
      "10 piezas",
      "12 piezas",
      "8 piezas",
    ]);
    expect(view!.next?.key).toBe(group!.key);

    const picked = await confirmWavePick(owner, made.waveId, {
      taskIds: group!.takeIds,
      productCode: item.sku,
      locationCode: "a-01-02",
    });
    expect(picked).toMatchObject({ ok: true, count: 3 });
    if (!picked.ok) throw new Error("picked");
    expect(picked.summary).toMatch(/Surtiste 30 piezas .* para 3 pedidos/);
    // Each task with its own quantity, each order picking.
    for (const [index, order] of orders.entries()) {
      const [task] = await tasksOf(order);
      expect(task).toMatchObject({ status: "PICKED_UP" });
      expect(task!.pickedQuantity!.toString()).toBe(["10", "12", "8"][index]);
      expect(await orderStatus(order)).toBe("PICKING");
    }
    // Retrying is not picking twice.
    expect(
      await confirmWavePick(owner, made.waveId, {
        taskIds: group!.takeIds,
        productCode: item.sku,
        locationCode: "A-01-02",
      }),
    ).toMatchObject({ ok: true, repeated: true, count: 0 });

    const carrying = await getWave(owner, made.waveId);
    expect(carrying!.picks).toEqual([]);
    expect(carrying!.toLeave).toMatchObject({
      text: "3 tareas surtidas",
      place: "Preparación",
    });
    const left = await deliverWavePicks(
      owner,
      made.waveId,
      carrying!.toLeave!.taskIds,
    );
    expect(left).toMatchObject({ ok: true, count: 3 });

    const staging = await stagingOf(owner.organizationId);
    for (const [index, order] of orders.entries()) {
      expect(await orderStatus(order)).toBe("PICKED");
      expect(await heldFor(order)).toEqual([
        { locationId: staging, remaining: ["10", "12", "8"][index] },
      ]);
    }
    // The wave ended by itself and let go of its orders.
    const wave = await db.pickWave.findUniqueOrThrow({
      where: { id: made.waveId },
    });
    expect(wave.status).toBe("DONE");
    expect(
      await db.pickWaveOrder.count({
        where: { waveId: made.waveId, openOrderId: { not: null } },
      }),
    ).toBe(0);
    expect(await listOpenWaves(owner)).toEqual([]);
    const trail = await listAuditTrail(owner.organizationId, { limit: 10 });
    expect(trail.map((entry) => entry.action)).toContain(
      "inventory.wave_created",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("confirming together leaves nothing half done when one fails", async () => {
    const { owner, item, orders } = await threeOrders();
    const made = await createWave(owner, { orderIds: orders });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const [group] = (await getWave(owner, made.waveId))!.picks;
    // A wrong place: nothing is taken.
    expect(
      await confirmWavePick(owner, made.waveId, {
        taskIds: group!.takeIds,
        productCode: item.sku,
        locationCode: "B-09-09",
      }),
    ).toMatchObject({ ok: false });
    // Someone else takes one of them meanwhile: the rest is not taken.
    const ana = await member(owner.organizationId, "operator");
    const [second] = await tasksOf(orders[1]!);
    expect(await acceptTask(ana, second!.id)).toMatchObject({ ok: true });
    const failed = await confirmWavePick(owner, made.waveId, {
      taskIds: group!.takeIds,
      productCode: item.sku,
      locationCode: "A-01-02",
    });
    expect(failed).toMatchObject({
      ok: false,
      formError: expect.stringMatching(/la tiene otra persona/),
    });
    for (const order of [orders[0]!, orders[2]!]) {
      const [task] = await tasksOf(order);
      expect(task).toMatchObject({
        status: "PENDING",
        assignedToUserId: null,
        pickedQuantity: null,
      });
      expect(await orderStatus(order)).toBe("RELEASED");
    }
    // The screen now offers only what this person can take.
    const [again] = (await getWave(owner, made.waveId))!.picks;
    expect(again!.takeIds).toHaveLength(2);
    expect(again!.takeText).toBe("18 piezas");
    expect(
      await confirmWavePick(owner, made.waveId, {
        taskIds: again!.takeIds,
        productCode: item.sku,
        locationCode: "A-01-02",
      }),
    ).toMatchObject({ ok: true, count: 2 });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("cancelling an order of the wave releases only its own", async () => {
    const { owner, item, orders } = await threeOrders();
    const made = await createWave(owner, { orderIds: orders });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const cancelled = await cancelOutboundOrder(
      owner,
      orders[1]!,
      "El cliente ya no lo quiere",
    );
    expect(cancelled).toMatchObject({ ok: true });
    expect(await heldFor(orders[1]!)).toEqual([]);
    expect((await tasksOf(orders[1]!))[0]!.status).toBe("CANCELLED");
    for (const [index, order] of [orders[0]!, orders[2]!].entries()) {
      expect(await orderStatus(order)).toBe("RELEASED");
      expect((await heldFor(order))[0]!.remaining).toBe(["10", "8"][index]);
    }
    const view = await getWave(owner, made.waveId);
    expect(view!.status).toBe("OPEN");
    expect(view!.picks[0]!.quantityText).toBe("18 piezas");
    const [group] = view!.picks;
    await confirmWavePick(owner, made.waveId, {
      taskIds: group!.takeIds,
      productCode: item.sku,
      locationCode: "A-01-02",
    });
    const carrying = await getWave(owner, made.waveId);
    expect(
      await deliverWavePicks(owner, made.waveId, carrying!.toLeave!.taskIds),
    ).toMatchObject({ ok: true, count: 2 });
    expect(
      (await db.pickWave.findUniqueOrThrow({ where: { id: made.waveId } }))
        .status,
    ).toBe("DONE");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("cancelling the wave only ungroups its orders", async () => {
    const { owner, orders } = await threeOrders();
    const made = await createWave(owner, { orderIds: orders });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await cancelWave(owner, made.waveId, "no")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      await cancelWave(owner, made.waveId, "Se surten por separado"),
    ).toMatchObject({ ok: true });
    expect(
      await cancelWave(owner, made.waveId, "Se surten por separado"),
    ).toMatchObject({ ok: true, repeated: true });
    for (const order of orders) {
      expect(await orderStatus(order)).toBe("RELEASED");
      expect((await tasksOf(order))[0]!.status).toBe("PENDING");
    }
    // They may go in another wave.
    expect(await createWave(owner, { orderIds: orders })).toMatchObject({
      ok: true,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("creating a wave", () => {
  it("never puts an order in two open waves, not even at once", async () => {
    const { owner, orders } = await threeOrders();
    const [first, second] = await Promise.all([
      createWave(owner, { orderIds: [orders[0]!, orders[1]!] }),
      createWave(owner, { orderIds: [orders[1]!, orders[2]!] }),
    ]);
    const answers = [first, second];
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.find((answer) => !answer.ok)).toMatchObject({
      ok: false,
      fieldErrors: { orderIds: expect.stringMatching(/ya está en la ola/) },
    });
    expect(
      await db.pickWaveOrder.count({
        where: { orderId: orders[1]!, openOrderId: { not: null } },
      }),
    ).toBe(1);
    // A third order alone was not released by the refused wave.
    const loser = answers.find((answer) => !answer.ok)!;
    expect(loser).toBeTruthy();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("releases urgent drafts first and refuses all when one does not reach", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await place(owner, "Estante 2", { code: "A-01-02" });
    await enter(owner, item.id, shelf, "15");
    const normal = await draft(owner, [{ productId: item.id, quantity: "10" }]);
    const urgent = await draft(
      owner,
      [{ productId: item.id, quantity: "10" }],
      { urgent: true },
    );
    // 20 asked, 15 there: the urgent one sets aside first, the other is short.
    const refused = await createWave(owner, { orderIds: [normal, urgent] });
    expect(refused).toMatchObject({
      ok: false,
      fieldErrors: {
        orderIds: expect.stringMatching(/pide 10 piezas y hay 5/),
      },
    });
    if (refused.ok) throw new Error("refused");
    expect(refused.fieldErrors!.orderIds).toMatch(/^PS-0001/);
    expect(await orderStatus(normal)).toBe("DRAFT");
    expect(await orderStatus(urgent)).toBe("DRAFT");
    expect(
      await db.stockReservation.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    // Released with what there is from its screen, it then joins.
    expect(
      await releaseOutboundOrder(owner, normal, { takeWhatThereIs: true }),
    ).toMatchObject({ ok: true });
    expect(
      await createWave(owner, { orderIds: [normal, urgent] }),
    ).toMatchObject({ ok: false });
    expect(await createWave(owner, { orderIds: [normal] })).toMatchObject({
      ok: true,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("refuses an order with nothing to pick and one already picking", async () => {
    const { owner, item, orders } = await threeOrders();
    await releaseOutboundOrder(owner, orders[0]!);
    const [task] = await tasksOf(orders[0]!);
    await acceptTask(owner, task!.id);
    expect(await createWave(owner, { orderIds: [orders[0]!] })).toMatchObject({
      ok: false,
      fieldErrors: { orderIds: expect.stringMatching(/ya no está por surtir/) },
    });
    const empty = await draft(owner, []);
    expect(await createWave(owner, { orderIds: [empty] })).toMatchObject({
      ok: false,
    });
    expect(item).toBeTruthy();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("walking order and zones", () => {
  it("orders the picks by the code of their place and takes by zone", async () => {
    const owner = await company();
    const zoneA = await place(owner, "Zona A", { level: 1 });
    const zoneB = await place(owner, "Zona B", { level: 1 });
    const far = await place(owner, "Estante 10", {
      code: "A-01-10",
      parentId: zoneA,
    });
    const near = await place(owner, "Estante 2", {
      code: "A-01-02",
      parentId: zoneA,
    });
    const other = await place(owner, "Estante B", {
      code: "B-01-01",
      parentId: zoneB,
    });
    const items = [
      await product(owner),
      await product(owner),
      await product(owner),
    ];
    await enter(owner, items[0]!.id, far, "10");
    await enter(owner, items[1]!.id, other, "10");
    await enter(owner, items[2]!.id, near, "10");
    const order = await draft(
      owner,
      items.map((item) => ({ productId: item.id, quantity: "2" })),
    );
    const made = await createWave(owner, { orderIds: [order] });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const view = await getWave(owner, made.waveId);
    expect(view!.picks.map((pick) => pick.fromCode)).toEqual([
      "A-01-02",
      "A-01-10",
      "B-01-01",
    ]);
    expect(view!.zones.map((zone) => zone.name)).toEqual(["Zona A", "Zona B"]);
    const inA = await getWave(owner, made.waveId, { zone: zoneA });
    expect(inA!.zone).toBe(zoneA);
    expect(inA!.picks.map((pick) => pick.fromCode)).toEqual([
      "A-01-02",
      "A-01-10",
    ]);
    // An unknown zone is ignored.
    expect((await getWave(owner, made.waveId, { zone: "x" }))!.zone).toBe(null);

    const ana = await member(owner.organizationId, "operator");
    const beto = await member(owner.organizationId, "operator");
    expect(await takeWaveTasks(ana, made.waveId, zoneA)).toMatchObject({
      ok: true,
      count: 2,
    });
    expect(
      await assignWaveTasks(owner, made.waveId, zoneB, beto.userId),
    ).toMatchObject({ ok: true, count: 1 });
    // Nothing left available in the zone.
    expect(await takeWaveTasks(beto, made.waveId, zoneA)).toMatchObject({
      ok: true,
      count: 0,
    });
    const anas = await listTasks(ana, { view: "mine" });
    expect(anas.items.map((task) => task.fromPath)).toEqual([
      "Zona A › Estante 2",
      "Zona A › Estante 10",
    ]);
    const next = await nextTaskFor(ana, anas.items[0]!.id);
    expect(next?.id).toBe(anas.items[1]!.id);
    expect(
      (await listTasks(beto, { view: "mine" })).items.map((t) => t.fromPath),
    ).toEqual(["Zona B › Estante B"]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("where picking takes from (ADR 0054, pending of ADR 0051)", () => {
  it("prefers a picking location, and without one nothing changes", async () => {
    const owner = await company(false);
    const item = await product(owner);
    const rack = await place(owner, "Rack", { code: "R-01" });
    await enter(owner, item.id, rack, "50");
    const plain = await draft(owner, [{ productId: item.id, quantity: "4" }]);
    await releaseOutboundOrder(owner, plain);
    expect((await tasksOf(plain))[0]!.fromLocationId).toBe(rack);

    const face = await place(owner, "Cara", { code: "S-01", type: "PICKING" });
    await enter(owner, item.id, face, "5");
    const order = await draft(owner, [{ productId: item.id, quantity: "4" }]);
    await releaseOutboundOrder(owner, order);
    // The fullest (the rack) would go first; the picking place does.
    expect((await tasksOf(order))[0]!.fromLocationId).toBe(face);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("what expires first still leaves first", async () => {
    const owner = await company(false);
    const item = await product(owner, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    const rack = await place(owner, "Rack", { code: "R-01" });
    const face = await place(owner, "Cara", { code: "S-01", type: "PICKING" });
    await enter(owner, item.id, rack, "10", {
      lotCode: "MARZO",
      lotExpiresOn: "2030-03-01",
    });
    await enter(owner, item.id, face, "10", {
      lotCode: "JUNIO",
      lotExpiresOn: "2030-06-01",
    });
    await enter(owner, item.id, face, "2", {
      lotCode: "MARZO",
      lotExpiresOn: "2030-03-01",
    });
    const order = await draft(owner, [{ productId: item.id, quantity: "5" }]);
    await releaseOutboundOrder(owner, order);
    const tasks = await tasksOf(order);
    // March first — in the picking place first, then the rack — never June.
    expect(
      tasks.map((task) => [task.fromLocationId, task.quantity!.toString()]),
    ).toEqual([
      [face, "2"],
      [rack, "3"],
    ]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("between companies", () => {
  it("a wave of another company does not exist", async () => {
    const { owner, item, orders } = await threeOrders();
    const made = await createWave(owner, { orderIds: orders });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const stranger = await company();
    expect(await getWave(stranger, made.waveId)).toBeNull();
    expect(await listOpenWaves(stranger)).toEqual([]);
    expect(await cancelWave(stranger, made.waveId, "No es mía")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    const ids = (await getWave(owner, made.waveId))!.picks[0]!.takeIds;
    expect(
      await confirmWavePick(stranger, made.waveId, {
        taskIds: ids,
        productCode: item.sku,
        locationCode: "A-01-02",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await takeWaveTasks(stranger, made.waveId)).toMatchObject({
      ok: false,
    });
    // Orders of another company cannot go in a wave.
    expect(await createWave(stranger, { orderIds: orders })).toMatchObject({
      ok: false,
    });
    expect(
      (await db.warehouseTask.findMany({ where: { id: { in: ids } } })).every(
        (task) => task.status === "PENDING",
      ),
    ).toBe(true);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});
