import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  changeStockStatus,
  confirmPick,
  createOutboundOrder,
  createTask,
  deliverTask,
  pickUpTask,
  receiveCustomerReturn,
  reconcileStock,
  registerEntry,
  registerExit,
  registerQuickExit,
  registerTransfer,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  archiveFacility,
  archiveLocation,
  createFacility,
  createLocation,
  editLocation,
  reactivateFacility,
  switchFacility,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import {
  releaseProductionOrder,
  reportMaterialScrap,
  reportProduction,
  reverseProductionReport,
} from "@/modules/production";
import {
  cancelInspection,
  decideInspection,
  startInspection,
} from "@/modules/quality";
import { db } from "@/server";

import * as production from "../setup/production";

// WMS-76 (ADR 0074): operations that lock the same rows in a different way
// (by the primary key, or through the unique index (organizationId, id))
// used to deadlock. Every case runs the real services at the same time,
// several rounds, and expects no deadlock nor raw error.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `candados.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa candados ${++counter}`,
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
      productLimit: 200,
      users: 10,
      facilities: 200,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de candados",
    },
  );
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  return { organizationId: created.organizationId, userId: owner };
}

async function product(actor: InventoryActor) {
  const made = await createProduct(actor, {
    sku: `CND-${++counter}`,
    name: `Producto ${counter}`,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

async function shelf(actor: InventoryActor) {
  const made = await createLocation(actor, {
    level: 3,
    name: `Estante ${++counter}`,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity = "50",
) {
  const done = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
}

async function draftOrder(
  actor: InventoryActor,
  productId: string,
  quantity = "1",
) {
  const made = await createOutboundOrder(actor, {
    recipient: "Sucursal",
    priority: "NORMAL",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const line = await setOutboundLine(actor, made.orderId, {
    productId,
    quantity,
  });
  if (!line.ok) throw new Error(JSON.stringify(line));
  return made.orderId;
}

async function setTo(actor: InventoryActor, key: string, value: string) {
  const set = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!set.ok) throw new Error(set.error);
}

/** An order released with whatever there is (cross-docking waits for it). */
async function waiting(
  actor: InventoryActor,
  productId: string,
  quantity: string,
) {
  const order = await draftOrder(actor, productId, quantity);
  const released = await releaseOutboundOrder(actor, order, {
    takeWhatThereIs: true,
  });
  if (!released.ok) throw new Error(JSON.stringify(released));
  return order;
}

/** Runs everything at once; returns the raw errors (deadlocks among them). */
async function together(work: Array<() => Promise<unknown>>) {
  const settled = await Promise.allSettled(work.map((run) => run()));
  return settled
    .filter((one): one is PromiseRejectedResult => one.status === "rejected")
    .map((one) => String((one.reason as Error)?.message ?? one.reason));
}

let actor: InventoryActor;

beforeAll(async () => {
  actor = await company();
}, 60_000);

afterAll(() => db.$disconnect());

describe("locks in one order (WMS-76)", () => {
  it("relocating never deadlocks with an exit, a status change or releasing an order on the same shelf", async () => {
    // Different products on the same two shelves: the product locks do not
    // put them in line, only the shelves do.
    const moving = await product(actor);
    const back = await product(actor);
    const leaving = await product(actor);
    const damaged = await product(actor);
    const ordered = await product(actor);
    const a = await shelf(actor);
    const b = await shelf(actor);
    for (const item of [moving, back, leaving, damaged, ordered]) {
      await enter(actor, item, a, "500");
      await enter(actor, item, b, "500");
    }
    const errors: string[] = [];
    for (let round = 0; round < 10; round++) {
      const order = await draftOrder(actor, ordered);
      errors.push(
        ...(await together([
          () =>
            registerTransfer(actor, {
              productId: moving,
              locationId: a,
              toLocationId: b,
              quantity: "1",
              acceptCapacity: true,
            }),
          () =>
            registerTransfer(actor, {
              productId: back,
              locationId: b,
              toLocationId: a,
              quantity: "1",
              acceptCapacity: true,
            }),
          () =>
            registerExit(actor, {
              productId: leaving,
              locationId: a,
              quantity: "1",
            }),
          () =>
            changeStockStatus(actor, {
              productId: damaged,
              locationId: b,
              from: "AVAILABLE",
              to: "DAMAGED",
              quantity: "1",
              reason: "Golpe",
              idempotencyKey: newId(),
            }),
          () => releaseOutboundOrder(actor, order),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 180_000);

  it("a quick exit of many products never deadlocks with relocations of those products", async () => {
    const items = await Promise.all(
      Array.from({ length: 6 }, () => product(actor)),
    );
    const a = await shelf(actor);
    const b = await shelf(actor);
    for (const item of items) {
      await enter(actor, item, a, "100");
      await enter(actor, item, b, "100");
    }
    const errors: string[] = [];
    for (let round = 0; round < 6; round++) {
      errors.push(
        ...(await together([
          () =>
            registerQuickExit(actor, {
              lines: items.flatMap((productId) => [
                { productId, locationId: a, quantity: "1" },
                { productId, locationId: b, quantity: "1" },
              ]),
              reason: "Venta",
              idempotencyKey: newId(),
            }),
          ...items.map(
            (productId, n) => () =>
              registerTransfer(actor, {
                productId,
                locationId: n % 2 ? a : b,
                toLocationId: n % 2 ? b : a,
                quantity: "1",
                acceptCapacity: true,
              }),
          ),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 180_000);

  it("delivering tasks at once, both ways between the same shelves, never deadlocks", async () => {
    const items = await Promise.all(
      Array.from({ length: 4 }, () => product(actor)),
    );
    const a = await shelf(actor);
    const b = await shelf(actor);
    for (const item of items) {
      await enter(actor, item, a, "100");
      await enter(actor, item, b, "100");
    }
    const errors: string[] = [];
    for (let round = 0; round < 6; round++) {
      const tasks: string[] = [];
      for (const [n, item] of items.entries()) {
        const made = await createTask(actor, {
          productId: item,
          fromLocationId: n % 2 ? a : b,
          toLocationId: n % 2 ? b : a,
          quantity: "1",
          priority: "NORMAL",
          acceptCapacity: true,
        });
        if (!made.ok) throw new Error(JSON.stringify(made));
        for (const step of [acceptTask, pickUpTask]) {
          const done = await step(actor, made.taskId);
          if (!done.ok) throw new Error(JSON.stringify(done));
        }
        tasks.push(made.taskId);
      }
      errors.push(
        ...(await together([
          ...tasks.map((taskId) => () => deliverTask(actor, taskId)),
          () =>
            registerQuickExit(actor, {
              lines: items.map((productId, n) => ({
                productId,
                locationId: n % 2 ? b : a,
                quantity: "1",
              })),
              reason: "Venta",
              idempotencyKey: newId(),
            }),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 180_000);

  it("the first order of a new warehouse never deadlocks with changes to warehouses and locations", async () => {
    const owner = await company();
    const errors: string[] = [];
    for (let round = 0; round < 6; round++) {
      const made = await createFacility(owner, {
        name: `Almacén ${++counter}`,
        code: `A${counter}`,
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      const moved = await switchFacility(owner, made.facilityId);
      if (!moved.ok) throw new Error(JSON.stringify(moved));
      const item = await product(owner);
      const place = await shelf(owner);
      await enter(owner, item, place, "20");
      const first = await draftOrder(owner, item);
      const second = await draftOrder(owner, item);
      const spare = await createFacility(owner, {
        name: `Vacío ${++counter}`,
        code: `V${counter}`,
      });
      if (!spare.ok) throw new Error(JSON.stringify(spare));
      errors.push(
        ...(await together([
          () => releaseOutboundOrder(owner, first),
          () => releaseOutboundOrder(owner, second),
          () => editLocation(owner, place, { name: `Estante ${++counter}` }),
          () => createLocation(owner, { level: 1, name: `Zona ${++counter}` }),
          () =>
            createFacility(owner, {
              name: `Otro ${++counter}`,
              code: `O${counter}`,
            }),
          () => archiveFacility(owner, spare.facilityId),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 180_000);

  it("changing the active warehouse never deadlocks with creating or archiving one", async () => {
    const owner = await company();
    const errors: string[] = [];
    for (let round = 0; round < 10; round++) {
      const target = await createFacility(owner, {
        name: `Destino ${++counter}`,
        code: `D${counter}`,
      });
      const spare = await createFacility(owner, {
        name: `Sobra ${++counter}`,
        code: `S${counter}`,
      });
      if (!target.ok || !spare.ok) throw new Error("facility setup failed");
      errors.push(
        ...(await together([
          () => switchFacility(owner, target.facilityId),
          () => archiveFacility(owner, spare.facilityId),
          () =>
            createFacility(owner, {
              name: `Nuevo ${++counter}`,
              code: `N${counter}`,
            }),
          () => switchFacility(owner, spare.facilityId),
        ])),
      );
    }
    expect(errors).toEqual([]);
  }, 180_000);
  it("reactivating a warehouse never deadlocks with switching, creating, archiving or the location tree (WMS-85)", async () => {
    // Reactivating takes every warehouse (the one door) and then its
    // locations without waiting, as archiving does: nothing may close a
    // circle with it, and an entry into one of its shelves either waits it
    // out or is refused.
    const owner = await company();
    const item = await product(owner);
    const errors: string[] = [];
    for (let round = 0; round < 10; round++) {
      const target = await createFacility(owner, {
        name: `Vuelve ${++counter}`,
        code: `V${counter}`,
      });
      const spare = await createFacility(owner, {
        name: `Sobra ${++counter}`,
        code: `S${counter}`,
      });
      if (!target.ok || !spare.ok) throw new Error("facility setup failed");
      const moved = await switchFacility(owner, target.facilityId);
      if (!moved.ok) throw new Error("switch failed");
      const inTarget = await shelf(owner);
      const main = await db.facility.findFirstOrThrow({
        where: { organizationId: owner.organizationId, isDefault: true },
        select: { id: true },
      });
      await switchFacility(owner, main.id);
      const inMain = await shelf(owner);
      const archived = await archiveFacility(owner, target.facilityId);
      if (!archived.ok) throw new Error(JSON.stringify(archived));
      errors.push(
        ...(await together([
          () => reactivateFacility(owner, target.facilityId),
          () => archiveFacility(owner, spare.facilityId),
          () =>
            createFacility(owner, {
              name: `Nuevo ${++counter}`,
              code: `N${counter}`,
            }),
          () => switchFacility(owner, target.facilityId),
          () =>
            registerEntry(owner, {
              productId: item,
              locationId: inTarget,
              quantity: "1",
              acceptRepeat: true,
              acceptCapacity: true,
            }),
          () =>
            registerEntry(owner, {
              productId: item,
              locationId: inMain,
              quantity: "1",
              acceptRepeat: true,
              acceptCapacity: true,
            }),
          () => editLocation(owner, inMain, { name: `Editado ${++counter}` }),
        ])),
      );
      const stockedArchived = await db.stockBalance.count({
        where: {
          organizationId: owner.organizationId,
          quantity: { gt: 0 },
          location: { archivedAt: { not: null } },
        },
      });
      expect(stockedArchived).toBe(0);
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 300_000);
  it("archiving a warehouse never deadlocks with an entry that then locks the shelf of its putaway task (WMS-82)", async () => {
    // The entry locks «General» of the warehouse and, at the end, the shelf
    // its putaway task recommends: two locations one after the other.
    // Archiving takes every location of the warehouse without waiting, so
    // it answers «try again» instead of closing a circle.
    const owner = await company();
    const set = await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.putaway.mode",
      "tasks",
    );
    if (!set.ok) throw new Error(set.error);
    const item = await product(owner);
    const errors: string[] = [];
    for (let round = 0; round < 20; round++) {
      const made = await createFacility(owner, {
        name: `Por archivar ${++counter}`,
        code: `P${counter}`,
      });
      if (!made.ok) throw new Error("facility setup failed");
      const moved = await switchFacility(owner, made.facilityId);
      if (!moved.ok) throw new Error("switch failed");
      for (let n = 0; n < 3; n++) await shelf(owner);
      errors.push(
        ...(await together([
          () =>
            registerEntry(owner, {
              productId: item,
              quantity: "4",
              acceptRepeat: true,
              acceptCapacity: true,
            }),
          () => archiveFacility(owner, made.facilityId),
        ])),
      );
      const archived = await db.facility.findUniqueOrThrow({
        where: { id: made.facilityId },
        select: { archivedAt: true },
      });
      const stocked = await db.stockBalance.count({
        where: {
          organizationId: owner.organizationId,
          quantity: { gt: 0 },
          location: { facilityId: made.facilityId },
        },
      });
      expect(archived.archivedAt !== null && stocked > 0).toBe(false);
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 180_000);
  it("delivering a put-away to a shelf never deadlocks with an entry to the same dock (WMS-82 review, C1)", async () => {
    // Shelf E created before dock M (E < M). The put-away M→E locks
    // [E, M]; an entry of another product to M locks M and creates its
    // put-away towards E. No hidden lock on E may come after M.
    const owner = await company();
    await setTo(owner, "inventory.putaway.mode", "tasks");
    const shelfCode = `E${++counter}`;
    const shelfE = await createLocation(owner, {
      level: 3,
      name: `Estante E ${counter}`,
      code: shelfCode,
    });
    const dock = await createLocation(owner, {
      level: 1,
      name: `Muelle ${++counter}`,
      type: "RECEIVING",
    });
    if (!shelfE.ok || !dock.ok) throw new Error("location setup failed");
    const errors: string[] = [];
    for (let round = 0; round < 20; round++) {
      const first = await product(owner);
      const second = await product(owner);
      await enter(owner, first, dock.locationId, "3");
      const task = await db.warehouseTask.findFirstOrThrow({
        where: {
          organizationId: owner.organizationId,
          productId: first,
          kind: "PUTAWAY",
        },
        select: { id: true },
      });
      expect(await acceptTask(owner, task.id)).toMatchObject({ ok: true });
      expect(await pickUpTask(owner, task.id)).toMatchObject({ ok: true });
      errors.push(
        ...(await together([
          () =>
            deliverTask(owner, task.id, {
              locationCode: shelfCode,
              acceptCapacity: true,
            }),
          () => enter(owner, second, dock.locationId, "2"),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 180_000);

  it("delivering a cross-dock pick never deadlocks with an entry to the same dock that serves another order (WMS-82 review, C1)", async () => {
    const owner = await company();
    await setTo(owner, "inventory.putaway.mode", "tasks");
    await setTo(owner, "inventory.crossdock.mode", "on");
    await shelf(owner);
    // «Preparación» first (the first release creates it), the dock after.
    const warmUp = await product(owner);
    await waiting(owner, warmUp, "1");
    const dock = await createLocation(owner, {
      level: 1,
      name: `Muelle ${++counter}`,
      type: "RECEIVING",
    });
    if (!dock.ok) throw new Error("location setup failed");
    const dockName = (
      await db.location.findUniqueOrThrow({ where: { id: dock.locationId } })
    ).name;
    const errors: string[] = [];
    for (let round = 0; round < 20; round++) {
      const first = await product(owner);
      const second = await product(owner);
      await waiting(owner, first, "2");
      await waiting(owner, second, "2");
      await enter(owner, first, dock.locationId, "2");
      const task = await db.warehouseTask.findFirstOrThrow({
        where: {
          organizationId: owner.organizationId,
          productId: first,
          kind: "PICK",
        },
        select: { id: true },
      });
      const sku = (await db.product.findUniqueOrThrow({ where: { id: first } }))
        .sku;
      expect(await acceptTask(owner, task.id)).toMatchObject({ ok: true });
      expect(
        await confirmPick(owner, task.id, {
          productCode: sku,
          locationCode: dockName,
          quantity: "2",
        }),
      ).toMatchObject({ ok: true });
      errors.push(
        ...(await together([
          () => deliverTask(owner, task.id),
          () => enter(owner, second, dock.locationId, "2"),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);

  it("the first release of a new warehouse never deadlocks with a customer return on the same shelf (WMS-82 review, A1)", async () => {
    const owner = await company();
    const errors: string[] = [];
    for (let round = 0; round < 20; round++) {
      const made = await createFacility(owner, {
        name: `Nuevo surtido ${++counter}`,
        code: `R${counter}`,
      });
      if (!made.ok) throw new Error("facility setup failed");
      const moved = await switchFacility(owner, made.facilityId);
      if (!moved.ok) throw new Error("switch failed");
      const place = await shelf(owner);
      const ordered = await product(owner);
      const returned = await product(owner);
      await enter(owner, ordered, place, "5");
      const order = await draftOrder(owner, ordered, "2");
      errors.push(
        ...(await together([
          () => releaseOutboundOrder(owner, order),
          () =>
            receiveCustomerReturn(owner, {
              returnedBy: "Cliente",
              reason: "No era lo que pidió",
              locationId: place,
              idempotencyKey: newId(),
              lines: [{ productId: returned, quantity: "1" }],
            }),
        ])),
      );
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);
  it("archiving a warehouse never deadlocks with a team change of someone who works there (WMS-82)", async () => {
    // Archiving updates the memberships that work in the warehouse and
    // writes its audit line (which points to the company); a team change
    // locks the company and then the membership.
    const owner = await company();
    const memberId = await newUser();
    const membership = await db.membership.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        userId: memberId,
        status: "ACTIVE",
      },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        membershipId: membership.id,
        role: "operator",
      },
    });
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
      select: { id: true },
    });
    const errors: string[] = [];
    for (let round = 0; round < 20; round++) {
      const made = await createFacility(owner, {
        name: `Con gente ${++counter}`,
        code: `G${counter}`,
      });
      if (!made.ok) throw new Error("facility setup failed");
      await db.membership.update({
        where: { id: membership.id },
        data: { activeFacilityId: made.facilityId },
      });
      errors.push(
        ...(await together([
          () => archiveFacility(owner, made.facilityId),
          () =>
            setMemberScope(owner.organizationId, owner.userId, {
              userId: memberId,
              facilities: round % 2 === 0 ? [{ facilityId: main.id }] : [],
            }),
        ])),
      );
    }
    expect(errors).toEqual([]);
  }, 180_000);

  it("reporting production never deadlocks with exits, moves, releases, scrap, reversals and changes of the area (WMS-29)", async () => {
    const { owner, area, shelf, crate, board, screw } =
      await production.workshop();
    await production.setting(owner, "production.report.photo", "optional");
    const other = await production.product(owner, "Otro");
    const moved = await production.product(owner, "Movido");
    await production.enter(owner, other, shelf, "500");
    await production.enter(owner, moved, shelf, "500");
    await production.enter(owner, board, shelf, "900");
    await production.enter(owner, screw, shelf, "900");
    const errors: string[] = [];
    let previous: string | null = null;
    for (let round = 0; round < 6; round++) {
      const first = await production.order(owner, crate, area, "4");
      const second = await production.order(owner, crate, area, "2");
      const released = await releaseProductionOrder(owner, first);
      if (!released.ok) throw new Error(JSON.stringify(released));
      const line = (await production.linesOf(first))[0]!;
      const toReverse: string | null = previous;
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(
        [
          reportProduction(owner, first, {
            good: "2",
            idempotencyKey: newId(),
          }),
          registerExit(owner, {
            productId: other,
            locationId: shelf,
            quantity: "1",
          }),
          registerTransfer(owner, {
            productId: moved,
            locationId: shelf,
            toLocationId: area,
            quantity: "1",
            acceptCapacity: true,
          }),
          editLocation(owner, area, { name: `Línea ${++counter}` }),
          releaseProductionOrder(owner, second),
          reportMaterialScrap(owner, first, {
            orderLineId: line.id,
            quantity: "1",
            reason: "Se rompió",
            idempotencyKey: newId(),
          }),
          toReverse
            ? reverseProductionReport(owner, toReverse, "Prueba de candados")
            : Promise.resolve(null),
        ],
      );
      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(
            String((result.reason as Error)?.message ?? result.reason),
          );
        }
      }
      const reported = results[0] as PromiseSettledResult<
        Awaited<ReturnType<typeof reportProduction>>
      >;
      previous =
        reported.status === "fulfilled" && reported.value.ok
          ? reported.value.reportId
          : null;
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);

  it("reporting production never deadlocks with «Surtir a producción» deliveries, exits from the area or archiving a shelf (WMS-29)", async () => {
    const { owner, area, shelf, crate, board, screw } =
      await production.workshop();
    await production.setting(owner, "production.report.photo", "optional");
    await production.setting(owner, "production.materials.mode", "issue");
    const other = await production.product(owner, "En la línea");
    await production.enter(owner, other, area, "500");
    await production.enter(owner, board, shelf, "900");
    await production.enter(owner, screw, shelf, "900");
    const errors: string[] = [];
    for (let round = 0; round < 5; round++) {
      const id = await production.order(owner, crate, area, "2");
      const released = await releaseProductionOrder(owner, id);
      if (!released.ok) throw new Error(JSON.stringify(released));
      const tasks = await db.warehouseTask.findMany({
        where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
        orderBy: { id: "asc" },
      });
      // One delivered first, the other at the same time as the report.
      for (const task of tasks) {
        await acceptTask(owner, task.id);
        await pickUpTask(owner, task.id);
      }
      await deliverTask(owner, tasks[0]!.id);
      const empty = await production.place(owner, "Vacío");
      const results = await Promise.allSettled([
        deliverTask(owner, tasks[1]!.id),
        reportProduction(owner, id, { good: "1", idempotencyKey: newId() }),
        registerExit(owner, {
          productId: other,
          locationId: area,
          quantity: "1",
        }),
        archiveLocation(owner, empty),
        editLocation(owner, area, { name: `Línea ${++counter}` }),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(
            String((result.reason as Error)?.message ?? result.reason),
          );
        }
      }
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);

  it("scrap of one material never deadlocks with delivering another material of the same order to the line (WMS-29)", async () => {
    const { owner, area, shelf, crate, board, screw } =
      await production.workshop();
    await production.setting(owner, "production.materials.mode", "issue");
    await production.enter(owner, board, shelf, "1000");
    await production.enter(owner, screw, shelf, "1000");
    const errors: string[] = [];
    for (let round = 0; round < 12; round++) {
      const id = await production.order(owner, crate, area, "2");
      const released = await releaseProductionOrder(owner, id);
      if (!released.ok) throw new Error(JSON.stringify(released));
      const tasks = await db.warehouseTask.findMany({
        where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
        orderBy: { id: "asc" },
      });
      for (const task of tasks) {
        await acceptTask(owner, task.id);
        await pickUpTask(owner, task.id);
      }
      const boards = tasks.find((task) => task.productId === board)!;
      const screws = tasks.find((task) => task.productId === screw)!;
      await deliverTask(owner, boards.id);
      const line = (await production.linesOf(id)).find(
        (each) => each.productId === board,
      )!;
      const results = await Promise.allSettled([
        reportMaterialScrap(owner, id, {
          orderLineId: line.id,
          quantity: "1",
          reason: "Se rompió",
          idempotencyKey: newId(),
        }),
        deliverTask(owner, screws.id),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(
            String((result.reason as Error)?.message ?? result.reason),
          );
        }
      }
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);

  it("reversing a report never deadlocks with delivering a material it consumed none of (WMS-29)", async () => {
    const { owner, area, shelf, board } = await production.workshop();
    await production.setting(owner, "production.report.photo", "optional");
    await production.setting(owner, "production.materials.mode", "issue");
    const box = await production.product(owner, "Caja");
    const washer = await production.product(owner, "Arandela");
    // Half a washer per box: the second box consumes none (rounded up once).
    await production.recipe(
      owner,
      box,
      [
        [board, "8"],
        [washer, "1"],
      ],
      "2",
    );
    await production.enter(owner, board, shelf, "1000");
    await production.enter(owner, washer, shelf, "1000");
    const errors: string[] = [];
    for (let round = 0; round < 10; round++) {
      // Released with nothing in the area: a task per material. Then free
      // stock reaches the area and the reports take it.
      const id = await production.order(owner, box, area, "4");
      const released = await releaseProductionOrder(owner, id);
      if (!released.ok) throw new Error(JSON.stringify(released));
      await production.enter(owner, board, area, "8");
      await production.enter(owner, washer, area, "1");
      const first = await reportProduction(owner, id, {
        good: "1",
        idempotencyKey: newId(),
      });
      const second = await reportProduction(owner, id, {
        good: "1",
        idempotencyKey: newId(),
      });
      if (!first.ok || !second.ok) {
        throw new Error(JSON.stringify([first, second]));
      }
      const washers = await db.warehouseTask.findFirstOrThrow({
        where: {
          kind: "ISSUE",
          productId: washer,
          productionOrderLine: { orderId: id },
        },
      });
      await acceptTask(owner, washers.id);
      await pickUpTask(owner, washers.id);
      const results = await Promise.allSettled([
        reverseProductionReport(owner, second.reportId, "Prueba de candados"),
        deliverTask(owner, washers.id),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(
            String((result.reason as Error)?.message ?? result.reason),
          );
        }
      }
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);

  it("deciding a verification never deadlocks with reports, reversals, status changes, exits and changes of the area (WMS-30B)", async () => {
    const { owner, area, shelf, crate, board, screw } =
      await production.workshop(["inventory", "production", "quality"]);
    await production.setting(owner, "production.report.photo", "optional");
    const other = await production.product(owner, "Otro en la línea");
    await production.enter(owner, other, area, "500");
    await production.enter(owner, board, shelf, "2000");
    await production.enter(owner, screw, shelf, "2000");
    const quarantine = await production.place(owner, "Cuarentena", {
      type: "QUARANTINE",
    });
    const errors: string[] = [];
    const id = await production.order(owner, crate, area, "200");
    const released = await releaseProductionOrder(owner, id);
    if (!released.ok) throw new Error(JSON.stringify(released));
    const reportLine = async (reportId: string) =>
      (
        await db.productionReportLine.findFirstOrThrow({
          where: { reportId, kind: "OUTPUT" },
        })
      ).id;
    let spare: string | null = null;
    for (let round = 0; round < 6; round++) {
      const lot = await reportProduction(owner, id, {
        good: "4",
        idempotencyKey: newId(),
      });
      if (!lot.ok) throw new Error(JSON.stringify(lot));
      const started = await startInspection(owner, {
        productId: crate,
        locationId: area,
        origin: "PRODUCTION",
        lineId: await reportLine(lot.reportId),
        idempotencyKey: newId(),
      });
      if (!started.ok) throw new Error(JSON.stringify(started));
      const toReverse: string | null = spare;
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(
        [
          decideInspection(owner, {
            inspectionId: started.inspectionId,
            idempotencyKey: newId(),
            outcomes: [
              { status: "AVAILABLE", quantity: "2", toLocationId: shelf },
              {
                status: "QUARANTINE",
                quantity: "1",
                reason: "Revisar",
                toLocationId: quarantine,
              },
              { status: "REJECTED", quantity: "1", reason: "No cumple" },
            ],
          }),
          reportProduction(owner, id, { good: "1", idempotencyKey: newId() }),
          toReverse
            ? reverseProductionReport(owner, toReverse, "Prueba de candados")
            : Promise.resolve(null),
          changeStockStatus(owner, {
            productId: other,
            locationId: area,
            from: "AVAILABLE",
            to: "DAMAGED",
            quantity: "1",
            reason: "Golpe",
            idempotencyKey: newId(),
          }),
          registerExit(owner, {
            productId: other,
            locationId: area,
            quantity: "1",
          }),
          registerTransfer(owner, {
            productId: board,
            locationId: shelf,
            toLocationId: quarantine,
            quantity: "1",
            acceptCapacity: true,
          }),
          editLocation(owner, area, { name: `Línea ${++counter}` }),
        ],
      );
      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(
            String((result.reason as Error)?.message ?? result.reason),
          );
        }
      }
      const reported = results[1] as PromiseSettledResult<
        Awaited<ReturnType<typeof reportProduction>>
      >;
      spare =
        reported.status === "fulfilled" && reported.value.ok
          ? reported.value.reportId
          : null;
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
    void cancelInspection;
  }, 240_000);
});
