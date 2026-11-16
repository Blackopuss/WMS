import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  changeStockStatus,
  createOutboundOrder,
  createTask,
  deliverTask,
  pickUpTask,
  reconcileStock,
  registerEntry,
  registerExit,
  registerQuickExit,
  registerTransfer,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  archiveFacility,
  createFacility,
  createLocation,
  editLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

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
});
