import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { newId } from "@/lib";
import {
  CONTAINERS_MODE,
  PICKING_MODE,
  PUTAWAY_MODE,
  TASK_PHOTO,
  acceptTask,
  confirmPick,
  createOutboundOrder,
  createTask,
  createWave,
  deliverTask,
  deliverWavePicks,
  discardTaskPhoto,
  getTask,
  pickUpTask,
  reachesTask,
  reconcileStock,
  registerEntry,
  releaseOutboundOrder,
  replenishNow,
  saveReplenishmentRule,
  setOutboundLine,
  taskPhotoMode,
  uploadIncidentPhoto,
  uploadTaskPhoto,
  type InventoryActor,
} from "@/modules/inventory";
import {
  activateRecipeVersion,
  createProductionOrder,
  createRecipe,
  releaseProductionOrder,
  setRecipeInput,
} from "@/modules/production";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import {
  evidenceOwners,
  moduleRegistry,
  operationSettings,
} from "@/modules/registry";
import { GET as viewPhoto } from "@/app/api/archivos/[id]/ver/route";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { createFileLink, purgeOrphanPhotos } from "@/platform/files";
import { createLocation, getDefaultLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { TEST_JPEG, TEST_PNG } from "../setup/images";

// WMS-37B (ADR 0076): a photo of where a task was left, taken on its last
// step and linked by the delivery in its own transaction. The company
// decides if it is asked (off, optional, required); a photo that does not
// serve undoes the delivery; a retry neither asks nor links again; who
// does not reach the task does not see its photos.

/** Who a request runs for at a shared terminal (WMS-38), or nobody. */
let terminalUser: string | null = null;
vi.mock("@/platform/auth", async (original) => ({
  ...(await original<typeof import("@/platform/auth")>()),
  terminalUserOfRequest: async () => terminalUser,
}));

/** Who the routes see as signed in (null: nobody). */
let signedIn: { user: { id: string }; organization: { id: string } } | null =
  null;
vi.mock("@/platform/tenancy", async (original) => ({
  ...(await original<typeof import("@/platform/tenancy")>()),
  requireOrganizationContext: async () => {
    if (!signedIn) throw new Error("redirect:/ingresar");
    return signedIn;
  },
}));
const open = (actor: InventoryActor, fileId: string) => {
  signedIn = {
    user: { id: actor.userId },
    organization: { id: actor.organizationId },
  };
  return viewPhoto(
    new Request(`http://localhost/api/archivos/${fileId}/ver`) as never,
    { params: Promise.resolve({ id: fileId }) },
  );
};

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `fototareas.${++counter}.${stamp}@example.test`,
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
    name: `Fotos de tareas ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser("Plataforma");
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 100,
      users: 20,
      facilities: 3,
      modules,
      validUntil: null,
      reason: "Prueba de fotos de tareas",
    },
  );
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  scope: { facilityId: string; locationId?: string }[] = [],
): Promise<InventoryActor> {
  const userId = await newUser(`Persona ${role}`);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  for (const row of scope) {
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId,
        membershipId: membership.id,
        facilityId: row.facilityId,
        locationId: row.locationId ?? null,
      },
    });
  }
  return { organizationId, userId };
}

async function setting(actor: InventoryActor, key: string, value: string) {
  const set = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!set.ok) throw new Error(JSON.stringify(set));
}

async function product(actor: InventoryActor) {
  const sku = `FT-${++counter}`;
  const made = await createProduct(actor, { sku, name: `Artículo ${sku}` });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { id: made.productId, sku };
}

async function place(
  actor: InventoryActor,
  name: string,
  extra: {
    code?: string;
    type?: string;
    parentId?: string;
    level?: number;
  } = {},
) {
  const made = await createLocation(actor, {
    level: extra.level ?? 3,
    name: `${name} ${++counter}`,
    code: extra.code ?? `FT-${counter}`,
    ...(extra.type ? { type: extra.type } : {}),
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
) {
  const entry = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
}

const ok = <T extends { ok: boolean }>(result: T): T => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
};

async function photo(
  actor: InventoryActor,
  taskId: string,
  bytes: Uint8Array = TEST_JPEG,
) {
  const uploaded = await uploadTaskPhoto(actor, taskId, {
    name: bytes === TEST_PNG ? "foto.png" : "foto.jpg",
    bytes,
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  return uploaded.fileId;
}

const photosOf = (taskId: string) =>
  db.evidencePhoto.findMany({
    where: { warehouseTaskId: taskId },
    orderBy: { position: "asc" },
  });

const statusOf = async (taskId: string) =>
  (await db.warehouseTask.findUniqueOrThrow({ where: { id: taskId } })).status;

/** A task of one kind, picked up by `worker`, and how to deliver it. */
type Ready = {
  taskId: string;
  deliver: (
    actor: InventoryActor,
    photoIds?: string[],
  ) => ReturnType<typeof deliverTask>;
};

type Kind = {
  name: string;
  modules: string[];
  setup: (owner: InventoryActor) => Promise<Record<string, string>>;
  task: (
    owner: InventoryActor,
    worker: InventoryActor,
    scene: Record<string, string>,
  ) => Promise<Ready>;
};

const plain =
  (taskId: string) => (actor: InventoryActor, photoIds?: string[]) =>
    deliverTask(actor, taskId, { photoIds });

async function takeAndPickUp(worker: InventoryActor, taskId: string) {
  ok(await acceptTask(worker, taskId));
  ok(await pickUpTask(worker, taskId));
}

const KINDS: Kind[] = [
  {
    name: "a transfer",
    modules: ["inventory"],
    setup: async (owner) => ({
      from: await place(owner, "Estante A"),
      to: await place(owner, "Estante B"),
    }),
    task: async (owner, worker, scene) => {
      const item = await product(owner);
      await enter(owner, item.id, scene.from!, "10");
      const made = ok(
        await createTask(owner, {
          productId: item.id,
          fromLocationId: scene.from!,
          toLocationId: scene.to!,
          quantity: "4",
        }),
      ) as { taskId: string };
      await takeAndPickUp(worker, made.taskId);
      return { taskId: made.taskId, deliver: plain(made.taskId) };
    },
  },
  {
    name: "a pick",
    modules: ["inventory"],
    setup: async (owner) => ({
      shelf: await place(owner, "Estante", { code: `SURT-${counter}` }),
    }),
    task: async (owner, worker, scene) => {
      const item = await product(owner);
      await enter(owner, item.id, scene.shelf!, "10");
      const order = ok(
        await createOutboundOrder(owner, {
          recipient: `Sucursal ${++counter}`,
          priority: "NORMAL",
        }),
      ) as { orderId: string };
      ok(
        await setOutboundLine(owner, order.orderId, {
          productId: item.id,
          quantity: "3",
        }),
      );
      ok(await releaseOutboundOrder(owner, order.orderId));
      const task = await db.warehouseTask.findFirstOrThrow({
        where: { kind: "PICK", outboundLine: { orderId: order.orderId } },
        include: { fromLocation: true },
      });
      ok(await acceptTask(worker, task.id));
      ok(
        await confirmPick(worker, task.id, {
          productCode: item.sku,
          locationCode: task.fromLocation.code!,
          quantity: "3",
        }),
      );
      return { taskId: task.id, deliver: plain(task.id) };
    },
  },
  {
    name: "a put-away",
    modules: ["inventory"],
    setup: async (owner) => {
      await setting(owner, PUTAWAY_MODE.key, "tasks");
      const code = `ACOM-${counter}`;
      await place(owner, "Rack", { code });
      return { general: (await getDefaultLocation(owner))!.id, code };
    },
    task: async (owner, worker, scene) => {
      const item = await product(owner);
      await enter(owner, item.id, scene.general!, "5");
      const task = await db.warehouseTask.findFirstOrThrow({
        where: { kind: "PUTAWAY", productId: item.id },
      });
      await takeAndPickUp(worker, task.id);
      return {
        taskId: task.id,
        deliver: (actor, photoIds) =>
          deliverTask(actor, task.id, { locationCode: scene.code!, photoIds }),
      };
    },
  },
  {
    name: "a replenishment",
    modules: ["inventory"],
    setup: async (owner) => ({
      storage: await place(owner, "Reserva"),
    }),
    task: async (owner, worker, scene) => {
      const item = await product(owner);
      const face = await place(owner, "Frente", { type: "PICKING" });
      await enter(owner, item.id, scene.storage!, "50");
      ok(
        await saveReplenishmentRule(owner, {
          productCode: item.sku,
          locationId: face,
          minQuantity: "5",
          maxQuantity: "20",
        }),
      );
      await replenishNow(owner);
      const task = await db.warehouseTask.findFirstOrThrow({
        where: { kind: "REPLENISH", productId: item.id },
      });
      await takeAndPickUp(worker, task.id);
      return { taskId: task.id, deliver: plain(task.id) };
    },
  },
  {
    name: "a material for production",
    modules: ["inventory", "production"],
    setup: async (owner) => {
      await setting(owner, "production.materials.mode", "issue");
      return {
        area: await place(owner, "Línea", { type: "PRODUCTION", level: 1 }),
        shelf: await place(owner, "Rack"),
      };
    },
    task: async (owner, worker, scene) => {
      const made = await product(owner);
      const board = await product(owner);
      await enter(owner, board.id, scene.shelf!, "40");
      const recipe = await createRecipe(owner, made.id, { baseQuantity: "1" });
      if (!recipe.ok) throw new Error(JSON.stringify(recipe));
      ok(
        await setRecipeInput(owner, recipe.versionId, {
          productId: board.id,
          quantity: "2",
        }),
      );
      ok(await activateRecipeVersion(owner, recipe.versionId));
      const order = await createProductionOrder(owner, {
        productId: made.id,
        quantity: "3",
        areaLocationId: scene.area!,
      });
      if (!order.ok) throw new Error(JSON.stringify(order));
      ok(await releaseProductionOrder(owner, order.orderId));
      const task = await db.warehouseTask.findFirstOrThrow({
        where: {
          kind: "ISSUE",
          productionOrderLine: { orderId: order.orderId },
        },
      });
      await takeAndPickUp(worker, task.id);
      return { taskId: task.id, deliver: plain(task.id) };
    },
  },
  {
    name: "a pallet",
    modules: ["inventory", "purchasing"],
    setup: async (owner) => {
      await setting(owner, PUTAWAY_MODE.key, "tasks");
      await setting(owner, CONTAINERS_MODE.key, "on");
      const code = `TAR-${counter}`;
      await place(owner, "Rack", { code });
      const supplier = await createSupplier(owner, {
        name: `Proveedor ${newId().slice(-6)}`,
      });
      if (!supplier.ok) throw new Error("supplier setup failed");
      return { code, supplierId: supplier.supplierId };
    },
    task: async (owner, worker, scene) => {
      const item = await product(owner);
      const order = await createPurchaseOrder(owner, {
        supplierId: scene.supplierId!,
      });
      if (!order.ok) throw new Error("order setup failed");
      ok(
        await addOrderLine(owner, order.orderId, {
          productId: item.id,
          capture: "base",
          quantity: "6",
        }),
      );
      ok(await submitPurchaseOrder(owner, order.orderId));
      const [line] = await db.purchaseOrderLine.findMany({
        where: { orderId: order.orderId },
      });
      ok(
        await receivePurchaseOrder(owner, order.orderId, {
          idempotencyKey: newId(),
          lines: [{ orderLineId: line!.id, quantity: "6" }],
          container: { code: "", kind: "" },
        }),
      );
      const task = await db.warehouseTask.findFirstOrThrow({
        where: {
          organizationId: owner.organizationId,
          kind: "PUTAWAY",
          status: "PENDING",
          containerId: { not: null },
        },
      });
      await takeAndPickUp(worker, task.id);
      return {
        taskId: task.id,
        deliver: (actor, photoIds) =>
          deliverTask(actor, task.id, { locationCode: scene.code!, photoIds }),
      };
    },
  },
];

beforeEach(() => {
  terminalUser = null;
  signedIn = null;
});

afterAll(() => db.$disconnect());

describe.each(KINDS)("delivering $name", (kind) => {
  it("off, optional and required", async () => {
    const owner = await company(kind.modules);
    const worker = await member(owner.organizationId, "operator");
    const scene = await kind.setup(owner);

    // Optional, the default: delivered without a photo, or with one.
    expect(await taskPhotoMode(worker)).toBe("optional");
    const bare = await kind.task(owner, worker, scene);
    expect(await bare.deliver(worker)).toMatchObject({ ok: true });
    expect(await photosOf(bare.taskId)).toEqual([]);
    const shown = await kind.task(owner, worker, scene);
    const fileId = await photo(worker, shown.taskId);
    const second = await photo(worker, shown.taskId, TEST_PNG);
    const delivered = await shown.deliver(worker, [fileId, second]);
    expect(delivered).toMatchObject({
      ok: true,
      summary: expect.stringContaining("Se guardaron 2 fotos."),
    });
    expect(
      (await photosOf(shown.taskId)).map((row) => ({
        fileId: row.fileId,
        purpose: row.purpose,
        createdByUserId: row.createdByUserId,
      })),
    ).toEqual([
      { fileId, purpose: "task_photo", createdByUserId: worker.userId },
      { fileId: second, purpose: "task_photo", createdByUserId: worker.userId },
    ]);
    // The screen shows who took them and when.
    const view = await getTask(owner, shown.taskId);
    expect(view?.photos).toHaveLength(2);
    expect(view?.photos[0]).toMatchObject({
      fileId,
      byName: "Persona operator",
    });

    // Required: without a photo nothing moves; with one it goes.
    await setting(owner, TASK_PHOTO.key, "required");
    const strict = await kind.task(owner, worker, scene);
    const movements = await db.stockMovement.count({
      where: { organizationId: owner.organizationId },
    });
    expect(await strict.deliver(worker)).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: { photos: "Toma una foto de dónde la dejaste." },
    });
    expect(await statusOf(strict.taskId)).toBe("PICKED_UP");
    expect(
      await db.stockMovement.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(movements);
    const proof = await photo(worker, strict.taskId);
    expect(await strict.deliver(worker, [proof])).toMatchObject({ ok: true });
    expect(await statusOf(strict.taskId)).toBe("DELIVERED");
    expect(await photosOf(strict.taskId)).toHaveLength(1);
    // A retry neither asks for a photo nor links another one.
    const late = await photo(worker, strict.taskId).catch((error) => error);
    expect(String(late)).toContain("ya no la estás entregando");
    expect(await strict.deliver(worker)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await photosOf(strict.taskId)).toHaveLength(1);

    // Off: nothing is asked and no photo is taken.
    await setting(owner, TASK_PHOTO.key, "off");
    const none = await kind.task(owner, worker, scene);
    expect(
      await uploadTaskPhoto(worker, none.taskId, {
        name: "foto.jpg",
        bytes: TEST_JPEG,
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("no pide fotos") });
    expect(await none.deliver(worker)).toMatchObject({ ok: true });
    expect(await photosOf(none.taskId)).toEqual([]);

    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 120_000);
});

describe("which photos serve", () => {
  async function scene() {
    const owner = await company();
    const worker = await member(owner.organizationId, "operator");
    const other = await member(owner.organizationId, "operator");
    const from = await place(owner, "Estante A");
    const to = await place(owner, "Estante B");
    const task = async (who = worker) => {
      const item = await product(owner);
      await enter(owner, item.id, from, "10");
      const made = ok(
        await createTask(owner, {
          productId: item.id,
          fromLocationId: from,
          toLocationId: to,
          quantity: "2",
        }),
      ) as { taskId: string };
      await takeAndPickUp(who, made.taskId);
      return made.taskId;
    };
    return { owner, worker, other, task };
  }

  it("refuses a photo of another person, company, purpose or task, moving nothing", async () => {
    const { owner, worker, other, task } = await scene();
    const mine = await task();
    const theirs = await task(other);
    const theirPhoto = await photo(other, theirs);
    const strangerTask = await scene().then(async (elsewhere) => ({
      elsewhere,
      id: await elsewhere.task(),
    }));
    const strangerPhoto = await photo(
      strangerTask.elsewhere.worker,
      strangerTask.id,
    );
    const incident = await uploadIncidentPhoto(worker, {
      name: "foto.jpg",
      bytes: TEST_JPEG,
    });
    if (!incident.ok) throw new Error(incident.error);
    for (const fileId of [
      theirPhoto,
      strangerPhoto,
      incident.fileId,
      newId(),
    ]) {
      expect(await deliverTask(worker, mine, { photoIds: [fileId] })).toEqual({
        ok: false,
        reason: "invalid",
        fieldErrors: {
          photos:
            "Una de las fotos ya no está disponible. Quítala y tómala otra vez.",
        },
      });
      expect(await statusOf(mine)).toBe("PICKED_UP");
    }
    // A photo already linked to another task.
    const used = await photo(other, theirs);
    ok(await deliverTask(other, theirs, { photoIds: [used] }));
    const again = await task(other);
    expect(await deliverTask(other, again, { photoIds: [used] })).toMatchObject(
      { ok: false, fieldErrors: { photos: expect.any(String) } },
    );
    expect(await statusOf(again)).toBe("PICKED_UP");
    // More than three.
    const many = await task();
    const four = [];
    for (let i = 0; i < 4; i++) four.push(await photo(worker, many));
    expect(await deliverTask(worker, many, { photoIds: four })).toMatchObject({
      ok: false,
      fieldErrors: { photos: "Se pueden agregar hasta 3 fotos a la vez." },
    });
    expect(await statusOf(many)).toBe("PICKED_UP");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 120_000);

  it("a photo taken for one task does not serve another (review)", async () => {
    const { owner, worker, task } = await scene();
    await setting(owner, TASK_PHOTO.key, "required");
    const first = await task();
    const second = await task();
    const third = await task();
    // Three photos while delivering the first task.
    const shots = [
      await photo(worker, first),
      await photo(worker, first),
      await photo(worker, first),
    ];
    const movements = await db.stockMovement.count({
      where: { organizationId: owner.organizationId },
    });
    for (const [id, fileId] of [
      [second, shots[1]!],
      [third, shots[2]!],
    ] as const) {
      expect(await deliverTask(worker, id, { photoIds: [fileId] })).toEqual({
        ok: false,
        reason: "invalid",
        fieldErrors: {
          photos:
            "Una de las fotos ya no está disponible. Quítala y tómala otra vez.",
        },
      });
      expect(await statusOf(id)).toBe("PICKED_UP");
    }
    expect(
      await db.stockMovement.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(movements);
    // Its own task takes it; the others need their own photo.
    ok(await deliverTask(worker, first, { photoIds: [shots[0]!] }));
    ok(
      await deliverTask(worker, second, {
        photoIds: [await photo(worker, second)],
      }),
    );
    expect(
      (await db.storedFile.findUniqueOrThrow({ where: { id: shots[0]! } }))
        .pendingOwnerId,
    ).toBe(first);
    // At once: a photo of the first task offered to two deliveries.
    const fourth = await task();
    const fifth = await task();
    const proof = await photo(worker, fourth);
    const both = await Promise.all([
      deliverTask(worker, fifth, { photoIds: [proof] }),
      deliverTask(worker, fourth, { photoIds: [proof] }),
    ]);
    expect(both[0]).toMatchObject({ ok: false });
    expect(both[1]).toMatchObject({ ok: true });
    expect(await statusOf(fifth)).toBe("PICKED_UP");
    expect(await photosOf(fourth)).toHaveLength(1);
    // What a photo was taken for never changes.
    await expect(
      db.storedFile.update({
        where: { id: shots[1]! },
        data: { pendingOwnerId: third },
      }),
    ).rejects.toThrow(/never changes/);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);

  it("a photo is uploaded only for one's own task, picked up", async () => {
    const { owner, worker, other, task } = await scene();
    const theirs = await task(other);
    const refused = {
      ok: false,
      error:
        "Esta tarea ya no la estás entregando: vuelve a abrir la pantalla.",
    };
    const upload = (actor: InventoryActor, id: string) =>
      uploadTaskPhoto(actor, id, { name: "foto.jpg", bytes: TEST_JPEG });
    expect(await upload(worker, theirs)).toEqual(refused);
    expect(await upload(worker, newId())).toEqual(refused);
    // Taken but not picked up yet.
    const item = await product(owner);
    const from = await place(owner, "Estante C");
    await enter(owner, item.id, from, "5");
    const fresh = ok(
      await createTask(owner, {
        productId: item.id,
        fromLocationId: from,
        toLocationId: await place(owner, "Estante D"),
        quantity: "1",
      }),
    ) as { taskId: string };
    ok(await acceptTask(worker, fresh.taskId));
    expect(await upload(worker, fresh.taskId)).toEqual(refused);
    // Discarding: only one's own and unlinked.
    const mine = await task();
    const fileId = await photo(worker, mine);
    expect(await discardTaskPhoto(other, fileId)).toEqual({ ok: false });
    expect(await discardTaskPhoto(worker, fileId)).toEqual({ ok: true });
    expect(
      await deliverTask(worker, mine, { photoIds: [fileId] }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
    // Somebody who only reads tasks does not upload.
    const viewer = await member(owner.organizationId, "viewer");
    await expect(upload(viewer, mine)).rejects.toThrow();
  }, 60_000);

  it("two deliveries at once with the same photo: one links it, the other moves nothing", async () => {
    const { owner, worker, task } = await scene();
    const first = await task();
    const second = await task();
    const fileId = await photo(worker, first);
    const results = await Promise.all([
      deliverTask(worker, first, { photoIds: [fileId] }),
      deliverTask(worker, second, { photoIds: [fileId] }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await db.evidencePhoto.count({ where: { fileId } })).toBe(1);
    const statuses = [await statusOf(first), await statusOf(second)].sort();
    expect(statuses).toEqual(["DELIVERED", "PICKED_UP"]);
    // The same task twice at once: one delivery, one retry.
    const third = await task();
    const proof = await photo(worker, third);
    const twice = await Promise.all([
      deliverTask(worker, third, { photoIds: [proof] }),
      deliverTask(worker, third, { photoIds: [proof] }),
    ]);
    expect(twice.every((result) => result.ok)).toBe(true);
    expect(
      twice.filter((result) => "repeated" in result && result.repeated),
    ).toHaveLength(1);
    expect(await photosOf(third)).toHaveLength(1);
    expect(
      await db.stockMovement.count({
        where: {
          organizationId: owner.organizationId,
          idempotencyKey: `task:${third}`,
        },
      }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);

  it("the database refuses a photo on a task not delivered or of another person", async () => {
    const { worker, other, task } = await scene();
    const open = await task();
    const fileId = await photo(worker, open);
    const row = (createdByUserId: string, warehouseTaskId: string) =>
      db.evidencePhoto.create({
        data: {
          id: newId(),
          organizationId: worker.organizationId,
          fileId,
          purpose: "task_photo",
          warehouseTaskId,
          position: 0,
          createdByUserId,
        },
      });
    await expect(row(worker.userId, open)).rejects.toThrow(/not delivered/);
    ok(await deliverTask(worker, open));
    await expect(row(other.userId, open)).rejects.toThrow(/another person/);
    // A photo taken for another task, inserted by hand: refused too.
    const elsewhere = await task();
    const strayPhoto = await photo(worker, elsewhere);
    await expect(
      db.evidencePhoto.create({
        data: {
          id: newId(),
          organizationId: worker.organizationId,
          fileId: strayPhoto,
          purpose: "task_photo",
          warehouseTaskId: open,
          position: 1,
          createdByUserId: worker.userId,
        },
      }),
    ).rejects.toThrow(/another record/);
    // Of another purpose's owner column: refused by the CHECK.
    await expect(
      db.evidencePhoto.create({
        data: {
          id: newId(),
          organizationId: worker.organizationId,
          fileId,
          purpose: "incident_photo",
          warehouseTaskId: open,
          position: 0,
          createdByUserId: worker.userId,
        },
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("a photo never linked goes away after a day", async () => {
    const { worker, task } = await scene();
    const mine = await task();
    const fileId = await photo(worker, mine);
    const tomorrow = new Date(Date.now() + 25 * 3600 * 1000);
    expect(
      await purgeOrphanPhotos(worker.organizationId, { now: tomorrow }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await db.storedFile.findUniqueOrThrow({ where: { id: fileId } }))
        .deletedAt,
    ).not.toBeNull();
  }, 60_000);
});

describe("who sees the photos", () => {
  it("only who reaches the task, also with the link made by hand", async () => {
    const owner = await company();
    const facility = await db.facility.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    const zoneA = await place(owner, "Zona A", { level: 1 });
    const zoneB = await place(owner, "Zona B", { level: 1 });
    const from = await place(owner, "Estante B1", { parentId: zoneB });
    const to = await place(owner, "Estante B2", { parentId: zoneB });
    const worker = await member(owner.organizationId, "operator");
    const item = await product(owner);
    await enter(owner, item.id, from, "10");
    const made = ok(
      await createTask(owner, {
        productId: item.id,
        fromLocationId: from,
        toLocationId: to,
        quantity: "2",
      }),
    ) as { taskId: string };
    await takeAndPickUp(worker, made.taskId);
    const fileId = await photo(worker, made.taskId);
    ok(await deliverTask(worker, made.taskId, { photoIds: [fileId] }));

    const supervisor = await member(owner.organizationId, "supervisor");
    const limited = await member(owner.organizationId, "supervisor", [
      { facilityId: facility.id, locationId: zoneA },
    ]);
    const foreign = await company();

    expect(await reachesTask(supervisor, made.taskId)).toBe(true);
    expect(await reachesTask(limited, made.taskId)).toBe(false);
    expect(await reachesTask(foreign, made.taskId)).toBe(false);

    expect(
      await createFileLink(supervisor, fileId, { owners: evidenceOwners }),
    ).toMatchObject({ ok: true });
    expect(
      await createFileLink(limited, fileId, { owners: evidenceOwners }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await createFileLink(foreign, fileId, { owners: evidenceOwners }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await getTask(limited, made.taskId)).toBeNull();

    expect((await open(supervisor, fileId)).status).toBe(303);
    expect((await open(limited, fileId)).status).toBe(404);
    expect((await open(foreign, fileId)).status).toBe(404);
  }, 60_000);
});

describe("at a shared terminal (WMS-38)", () => {
  it("the floor takes the photo and delivers with its PIN session", async () => {
    const owner = await company();
    const worker = await member(owner.organizationId, "forklift");
    const from = await place(owner, "Estante A");
    const to = await place(owner, "Estante B");
    const item = await product(owner);
    await enter(owner, item.id, from, "10");
    await setting(owner, TASK_PHOTO.key, "required");
    const made = ok(
      await createTask(owner, {
        productId: item.id,
        fromLocationId: from,
        toLocationId: to,
        quantity: "2",
      }),
    ) as { taskId: string };
    terminalUser = worker.userId;
    await takeAndPickUp(worker, made.taskId);
    const fileId = await photo(worker, made.taskId);
    expect(
      await deliverTask(worker, made.taskId, { photoIds: [fileId] }),
    ).toMatchObject({ ok: true });
    expect(await photosOf(made.taskId)).toHaveLength(1);
    expect((await getTask(worker, made.taskId))?.photos).toHaveLength(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);
});

describe("waves (WMS-25)", () => {
  it("with the photo required the group is not delivered; each task is", async () => {
    const owner = await company();
    await setting(owner, PICKING_MODE.key, "waves");
    const worker = await member(owner.organizationId, "operator");
    const item = await product(owner);
    const shelf = await place(owner, "Estante", { code: `OLA-${counter}` });
    await enter(owner, item.id, shelf, "50");
    const orders: string[] = [];
    for (const quantity of ["3", "4"]) {
      const order = ok(
        await createOutboundOrder(owner, {
          recipient: `Sucursal ${++counter}`,
          priority: "NORMAL",
        }),
      ) as { orderId: string };
      ok(
        await setOutboundLine(owner, order.orderId, {
          productId: item.id,
          quantity,
        }),
      );
      orders.push(order.orderId);
    }
    const wave = ok(await createWave(owner, { orderIds: orders })) as {
      waveId: string;
    };
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "PICK", outboundLine: { orderId: { in: orders } } },
      include: { fromLocation: true },
      orderBy: { number: "asc" },
    });
    for (const task of tasks) {
      ok(await acceptTask(worker, task.id));
      ok(
        await confirmPick(worker, task.id, {
          productCode: item.sku,
          locationCode: task.fromLocation.code!,
          quantity: task.quantity!.toString(),
        }),
      );
    }
    await setting(owner, TASK_PHOTO.key, "required");
    const ids = tasks.map((task) => task.id);
    expect(await deliverWavePicks(worker, wave.waveId, ids)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("deja cada tarea desde su ficha"),
    });
    expect(await Promise.all(ids.map(statusOf))).toEqual([
      "PICKED_UP",
      "PICKED_UP",
    ]);
    const fileId = await photo(worker, ids[0]!);
    ok(await deliverTask(worker, ids[0]!, { photoIds: [fileId] }));
    // Optional again: the rest of the group goes together, without photo.
    await setting(owner, TASK_PHOTO.key, "optional");
    expect(await deliverWavePicks(worker, wave.waveId, ids)).toMatchObject({
      ok: true,
      count: 1,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);
});
