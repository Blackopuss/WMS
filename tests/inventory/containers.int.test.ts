import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CONTAINERS_MODE,
  PUTAWAY_MODE,
  acceptTask,
  applyCount,
  captureCount,
  closeContainer,
  containersVisible,
  createPendingPutawayTasks,
  deliverTask,
  findContainerByCode,
  findTraceMatches,
  getContainer,
  getCount,
  listContainerEvents,
  listContainers,
  moveContainer,
  openCount,
  packStock,
  pickUpTask,
  reconcileStock,
  registerAdjustment,
  registerEntry,
  registerExit,
  registerTransfer,
  reverseMovement,
  unpackStock,
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
  archiveLocation,
  createLocation,
  getDefaultLocation,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-53 (ADR 0043): a container (pallet, box) groups part of the stock of
// its location without being part of the balance's key. Moving it moves
// exactly what it holds; what is inside is never taken loose; and what it
// says is never more than the balance (triggers and reconciliation).

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `tarimas.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory"],
  options: { containers?: boolean } = { containers: true },
): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa tarimas ${counter}`,
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
      reason: "Prueba de tarimas",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  const actor = { organizationId: created.organizationId, userId: owner };
  if (options.containers !== false) {
    await setting(actor, CONTAINERS_MODE.key, "on");
  }
  return actor;
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
  const sku = `TAR-${++counter}`;
  const made = await createProduct(actor, {
    sku,
    name: `Artículo ${sku}`,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

async function place(
  actor: InventoryActor,
  name: string,
  options: {
    level?: number;
    parentId?: string;
    code?: string;
    type?: string;
  } = {},
) {
  const made = await createLocation(actor, {
    level: options.level ?? 3,
    name,
    parentId: options.parentId,
    code: options.code,
    type: options.type,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

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

const lotOf = async (productId: string, code: string) =>
  (await db.lot.findFirstOrThrow({ where: { productId, code } })).id;

/** Every balance of a product, as «location|lot: quantity». */
async function balances(productId: string) {
  const rows = await db.stockBalance.findMany({
    where: { productId, quantity: { gt: 0 } },
    orderBy: [{ locationId: "asc" }, { lotKey: "asc" }],
    select: { locationId: true, lotKey: true, quantity: true },
  });
  return Object.fromEntries(
    rows.map((row) => [
      `${row.locationId}|${row.lotKey}`,
      row.quantity.toString(),
    ]),
  );
}

async function pack(
  actor: InventoryActor,
  input: Parameters<typeof packStock>[1],
) {
  const result = await packStock(actor, input);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.containerId;
}

/** A pallet on «Estante 1» with three products: plain, by lot, by serial. */
async function palletScene(actor: InventoryActor) {
  const shelf = await place(actor, "Estante 1", { code: "E-01" });
  const other = await place(actor, "Estante 2", { code: "E-02" });
  const plain = await product(actor);
  const byLot = await product(actor, { tracking: "LOT" });
  const bySerial = await product(actor, { tracking: "SERIAL" });
  await enter(actor, plain, shelf, "10");
  await enter(actor, byLot, shelf, "5", { lotCode: "L-1" });
  await enter(actor, byLot, shelf, "3", { lotCode: "L-2" });
  await enter(actor, bySerial, shelf, "3", { serials: "S-1\nS-2\nS-3" });
  const l1 = await lotOf(byLot, "L-1");
  const pallet = await pack(actor, {
    locationId: shelf,
    productId: plain,
    quantity: "6",
  });
  await pack(actor, {
    locationId: shelf,
    containerId: pallet,
    productId: byLot,
    lotId: l1,
    quantity: "5",
  });
  await pack(actor, {
    locationId: shelf,
    containerId: pallet,
    productId: bySerial,
    quantity: "2",
    serials: "S-1\nS-2",
  });
  return { shelf, other, plain, byLot, bySerial, l1, pallet };
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("a company that does not use containers", () => {
  it("sees nothing new and packs nothing; everything works as before", async () => {
    const actor = await company(["inventory"], { containers: false });
    const shelf = await place(actor, "Estante 1");
    const item = await product(actor);
    await enter(actor, item, shelf, "5");
    expect(await containersVisible(actor)).toBe(false);
    expect(
      await packStock(actor, {
        locationId: shelf,
        productId: item,
        quantity: "2",
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("apagadas"),
    });
    expect(
      await registerExit(actor, {
        productId: item,
        locationId: shelf,
        quantity: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db.container.count({
        where: { organizationId: actor.organizationId },
      }),
    ).toBe(0);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("packing", () => {
  it("groups loose stock without moving it; the code is consecutive or the label's", async () => {
    const actor = await company();
    const scene = await palletScene(actor);
    const before = await db.stockMovement.count({
      where: { organizationId: actor.organizationId },
    });
    const box = await getContainer(actor, scene.pallet);
    expect(box).toMatchObject({
      code: "C-0001",
      kind: "Tarima",
      name: "Tarima C-0001",
      open: true,
      locationId: scene.shelf,
    });
    expect(
      box!.items.map((item) => [item.productId, item.quantity, item.serials]),
    ).toEqual([
      [scene.plain, "6", []],
      [scene.byLot, "5", []],
      [scene.bySerial, "2", ["S-1", "S-2"]],
    ]);
    // Packing wrote no movement and no balance changed.
    expect(
      await db.stockMovement.count({
        where: { organizationId: actor.organizationId },
      }),
    ).toBe(before);
    expect(await balances(scene.plain)).toEqual({ [`${scene.shelf}|`]: "10" });
    // A typed label; the system's shape is refused.
    const typed = await packStock(actor, {
      locationId: scene.shelf,
      containerCode: "lpn 77",
      kind: "caja",
      productId: scene.plain,
      quantity: "1",
    });
    expect(typed).toMatchObject({ ok: true });
    expect(await findContainerByCode(actor, " LPN 77 ")).toMatchObject({
      name: "Caja LPN 77",
    });
    expect(
      await packStock(actor, {
        locationId: scene.shelf,
        containerCode: "C-0099",
        productId: scene.plain,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { containerCode: expect.stringContaining("sistema") },
    });
    // Never more than what is loose and free: 10 − 6 − 1 = 3.
    expect(
      await packStock(actor, {
        locationId: scene.shelf,
        productId: scene.plain,
        quantity: "4",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("tarimas o cajas") },
    });
    // A serial already packed is not packed again.
    expect(
      await packStock(actor, {
        locationId: scene.shelf,
        productId: scene.bySerial,
        quantity: "1",
        serials: "S-1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("C-0001") },
    });
    const history = await listContainerEvents(actor, scene.pallet);
    expect(history!.items.map((event) => event.kind)).toEqual([
      "PACKED",
      "PACKED",
      "PACKED",
      "CREATED",
    ]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("what is inside is never taken loose, by any operation", async () => {
    const actor = await company();
    const scene = await palletScene(actor);
    // Exit: 10 there, 6 packed → 4 loose.
    expect(
      await registerExit(actor, {
        productId: scene.plain,
        locationId: scene.shelf,
        quantity: "5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("tarimas o cajas") },
    });
    expect(
      await registerExit(actor, {
        productId: scene.plain,
        locationId: scene.shelf,
        quantity: "4",
      }),
    ).toMatchObject({ ok: true });
    // Relocation of the packed lot: nothing loose.
    expect(
      await registerTransfer(actor, {
        productId: scene.byLot,
        lotId: scene.l1,
        locationId: scene.shelf,
        toLocationId: scene.other,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    // Another lot is loose and moves.
    expect(
      await registerTransfer(actor, {
        productId: scene.byLot,
        lotId: await lotOf(scene.byLot, "L-2"),
        locationId: scene.shelf,
        toLocationId: scene.other,
        quantity: "3",
      }),
    ).toMatchObject({ ok: true });
    // A packed serial does not leave; a loose one does.
    expect(
      await registerExit(actor, {
        productId: scene.bySerial,
        locationId: scene.shelf,
        quantity: "1",
        serials: "S-2",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.stringContaining("C-0001") },
    });
    expect(
      await registerExit(actor, {
        productId: scene.bySerial,
        locationId: scene.shelf,
        quantity: "1",
        serials: "S-3",
      }),
    ).toMatchObject({ ok: true });
    // An adjustment never leaves the balance below what is packed.
    expect(
      await registerAdjustment(actor, {
        productId: scene.plain,
        locationId: scene.shelf,
        quantity: "5",
        reason: "Conteo físico",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("tarimas o cajas") },
    });
    // Nor does a count.
    const count = await openCount(actor, { locationId: scene.shelf });
    if (!count.ok) throw new Error("count");
    expect(
      await captureCount(actor, {
        countId: count.countId,
        productId: scene.plain,
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    // WMS-55: the count says what of the system is inside the pallet.
    const counted = await getCount(actor, count.countId);
    expect(
      counted?.lines.find((line) => line.productId === scene.plain)?.contained,
    ).toEqual({ quantity: "6", label: expect.stringContaining("6") });
    expect(
      await applyCount(actor, { countId: count.countId, reason: "Cierre" }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("tarimas o cajas"),
    });
    // The database refuses it too: no operation can skip the rule.
    const row = await db.stockBalance.findFirstOrThrow({
      where: { productId: scene.plain, locationId: scene.shelf },
    });
    await expect(
      db.stockBalance.update({
        where: { id: row.id },
        data: { quantity: "5" },
      }),
    ).rejects.toThrow(/containers/);
    await expect(
      db.containerItem.updateMany({
        where: { containerId: scene.pallet, productId: scene.plain },
        data: { quantity: "7" },
      }),
    ).rejects.toThrow(/containers/);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);
});

describe("moving a container", () => {
  it("moves exactly what it holds, with one movement, by scanning two labels", async () => {
    const actor = await company();
    const scene = await palletScene(actor);
    const key = newId();
    const moved = await moveContainer(actor, {
      containerCode: "c-0001",
      locationCode: "e-02",
      idempotencyKey: key,
    });
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    // One movement, two lines per product and lot, its serials.
    const movement = await db.stockMovement.findUniqueOrThrow({
      where: { id: moved.movementId! },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
    expect(movement).toMatchObject({
      type: "TRANSFER",
      containerId: scene.pallet,
      reference: "C-0001",
    });
    expect(
      movement.lines.map((line) => [
        line.productId,
        line.locationId,
        line.direction,
        line.baseQuantity.toString(),
        line.lotKey,
      ]),
    ).toEqual([
      [scene.plain, scene.shelf, "OUT", "6", ""],
      [scene.plain, scene.other, "IN", "6", ""],
      [scene.byLot, scene.shelf, "OUT", "5", scene.l1],
      [scene.byLot, scene.other, "IN", "5", scene.l1],
      [scene.bySerial, scene.shelf, "OUT", "2", ""],
      [scene.bySerial, scene.other, "IN", "2", ""],
    ]);
    // Exactly its content moved; what was loose stayed.
    expect(await balances(scene.plain)).toEqual({
      [`${scene.shelf}|`]: "4",
      [`${scene.other}|`]: "6",
    });
    expect(await balances(scene.byLot)).toEqual({
      [`${scene.shelf}|${await lotOf(scene.byLot, "L-2")}`]: "3",
      [`${scene.other}|${scene.l1}`]: "5",
    });
    const units = await db.serialUnit.findMany({
      where: { productId: scene.bySerial },
      orderBy: { serial: "asc" },
      select: { serial: true, locationId: true, containerId: true },
    });
    expect(units).toEqual([
      { serial: "S-1", locationId: scene.other, containerId: scene.pallet },
      { serial: "S-2", locationId: scene.other, containerId: scene.pallet },
      { serial: "S-3", locationId: scene.shelf, containerId: null },
    ]);
    expect(await getContainer(actor, scene.pallet)).toMatchObject({
      locationId: scene.other,
    });
    // A retry answers the same; the same key elsewhere is another move.
    expect(
      await moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-02",
        idempotencyKey: key,
      }),
    ).toMatchObject({ ok: true, repeated: true, movementId: moved.movementId });
    expect(
      await moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-01",
        idempotencyKey: key,
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("ya se usó"),
    });
    // It is not reversed: it is moved back.
    expect(
      await reverseMovement(actor, {
        movementId: moved.movementId!,
        reason: "Error",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("tarima") });
    expect(
      await moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "Estante 1",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await balances(scene.plain)).toEqual({ [`${scene.shelf}|`]: "10" });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("taking out and taking apart keep every detail; a closed one does not move", async () => {
    const actor = await company();
    const scene = await palletScene(actor);
    const box = (await getContainer(actor, scene.pallet))!;
    const plainItem = box.items.find((item) => item.productId === scene.plain)!;
    const serialItem = box.items.find(
      (item) => item.productId === scene.bySerial,
    )!;
    expect(
      await unpackStock(actor, {
        containerId: scene.pallet,
        itemId: plainItem.id,
        quantity: "7",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    expect(
      await unpackStock(actor, {
        containerId: scene.pallet,
        itemId: plainItem.id,
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await unpackStock(actor, {
        containerId: scene.pallet,
        itemId: serialItem.id,
        quantity: "1",
        serials: "S-3",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.any(String) },
    });
    expect(
      await unpackStock(actor, {
        containerId: scene.pallet,
        itemId: serialItem.id,
        quantity: "1",
        serials: "S-2",
      }),
    ).toMatchObject({ ok: true });
    // Now 6 loose of the plain product leave.
    expect(
      await registerExit(actor, {
        productId: scene.plain,
        locationId: scene.shelf,
        quantity: "6",
      }),
    ).toMatchObject({ ok: true });
    const closed = await closeContainer(actor, scene.pallet);
    expect(closed).toMatchObject({ ok: true });
    expect(await closeContainer(actor, scene.pallet)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await getContainer(actor, scene.pallet)).toMatchObject({
      open: false,
      items: [],
    });
    expect(
      await db.serialUnit.count({ where: { containerId: scene.pallet } }),
    ).toBe(0);
    // Everything that was inside is loose, by product and lot, where it was.
    expect(await balances(scene.byLot)).toEqual({
      [`${scene.shelf}|${scene.l1}`]: "5",
      [`${scene.shelf}|${await lotOf(scene.byLot, "L-2")}`]: "3",
    });
    expect(
      await registerExit(actor, {
        productId: scene.byLot,
        lotId: scene.l1,
        locationId: scene.shelf,
        quantity: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-02",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("desarm"),
    });
    const history = await listContainerEvents(actor, scene.pallet);
    expect(history!.items[0]).toMatchObject({ kind: "CLOSED" });
    expect(history!.items.filter((e) => e.kind === "UNPACKED")).toHaveLength(5);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("two moves at once, and taking loose stock while it moves", async () => {
    const actor = await company();
    const scene = await palletScene(actor);
    const third = await place(actor, "Estante 3", { code: "E-03" });
    // Same pallet, same place, twice: one moves it, the other finds it there.
    const both = await Promise.all([
      moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-02",
        idempotencyKey: newId(),
      }),
      moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-02",
        idempotencyKey: newId(),
      }),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({
      fieldErrors: { locationCode: expect.stringContaining("ya está") },
    });
    // Moving it while the loose stock left behind is taken: both happen.
    const [moved, exited] = await Promise.all([
      moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-03",
        idempotencyKey: newId(),
      }),
      registerExit(actor, {
        productId: scene.plain,
        locationId: scene.shelf,
        quantity: "4",
      }),
    ]);
    expect(moved).toMatchObject({ ok: true });
    expect(exited).toMatchObject({ ok: true });
    expect(await balances(scene.plain)).toEqual({ [`${third}|`]: "6" });
    // Taking what is in it where it now is: refused while it moves or after.
    const [again, taken] = await Promise.all([
      moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "E-01",
        idempotencyKey: newId(),
      }),
      registerExit(actor, {
        productId: scene.plain,
        locationId: third,
        quantity: "1",
      }),
    ]);
    expect(again).toMatchObject({ ok: true });
    expect(taken).toMatchObject({ ok: false });
    expect(await balances(scene.plain)).toEqual({ [`${scene.shelf}|`]: "6" });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);
});

describe("an empty pallet", () => {
  it("stays where it is until taken apart: its place is not archived", async () => {
    const actor = await company();
    const spot = await place(actor, "Estante 9", { code: "E-09" });
    const item = await product(actor);
    await enter(actor, item, spot, "1");
    const pallet = await pack(actor, {
      locationId: spot,
      productId: item,
      quantity: "1",
    });
    const box = (await getContainer(actor, pallet))!;
    expect(
      await unpackStock(actor, {
        containerId: pallet,
        itemId: box.items[0]!.id,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerExit(actor, {
        productId: item,
        locationId: spot,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(await archiveLocation(actor, spot)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("tarima"),
    });
    expect(await closeContainer(actor, pallet)).toMatchObject({ ok: true });
    expect(await archiveLocation(actor, spot)).toMatchObject({ ok: true });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);
});

describe("receiving on a pallet", () => {
  it("one put-away task for the pallet; delivering it moves everything to the scanned place", async () => {
    const actor = await company(["inventory", "purchasing"]);
    await setting(actor, PUTAWAY_MODE.key, "tasks");
    const general = (await getDefaultLocation(actor))!.id;
    const shelf = await place(actor, "Estante 1", { code: "E-01" });
    const one = await product(actor);
    const two = await product(actor, { tracking: "LOT" });
    const order = await sentOrder(actor, [
      { productId: one, quantity: "4" },
      { productId: two, quantity: "6" },
    ]);
    const current = await db.purchaseOrderLine.findMany({
      where: { orderId: order },
      orderBy: { lineNumber: "asc" },
    });
    const received = await receivePurchaseOrder(actor, order, {
      idempotencyKey: newId(),
      lines: [
        { orderLineId: current[0]!.id, quantity: "4" },
        { orderLineId: current[1]!.id, quantity: "6", lotCode: "R-9" },
      ],
      container: { code: "", kind: "" },
    });
    expect(received).toMatchObject({ ok: true });
    expect(JSON.stringify(received)).toContain("tarima C-0001");
    const box = await db.container.findFirstOrThrow({
      where: { organizationId: actor.organizationId },
      include: { items: true },
    });
    expect(box).toMatchObject({ code: "C-0001", locationId: general });
    expect(box.items).toHaveLength(2);
    // One task, for the pallet; none per product.
    const tasks = await db.warehouseTask.findMany({
      where: { organizationId: actor.organizationId },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: "PUTAWAY",
      containerId: box.id,
      productId: null,
      quantity: null,
      fromLocationId: general,
      toLocationId: shelf,
    });
    // «Crear tareas de acomodo» does not repeat it.
    expect(await createPendingPutawayTasks(actor)).toMatchObject({
      created: 0,
    });
    // While its task is open, the pallet does not change nor move by hand.
    expect(
      await moveContainer(actor, {
        containerId: box.id,
        locationCode: "E-01",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false, formError: expect.stringContaining("tarea") });
    const operator = await member(actor.organizationId, "operator");
    const taskId = tasks[0]!.id;
    expect(await acceptTask(operator, taskId)).toMatchObject({ ok: true });
    expect(await pickUpTask(operator, taskId)).toMatchObject({ ok: true });
    const delivered = await deliverTask(operator, taskId, {
      locationCode: "E-01",
    });
    expect(delivered).toMatchObject({ ok: true });
    expect(
      await deliverTask(operator, taskId, { locationCode: "E-01" }),
    ).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(
      await db.warehouseTask.findUniqueOrThrow({ where: { id: taskId } }),
    ).toMatchObject({ status: "DELIVERED", placedLocationId: shelf });
    expect(await balances(one)).toEqual({ [`${shelf}|`]: "4" });
    expect(await balances(two)).toEqual({
      [`${shelf}|${await lotOf(two, "R-9")}`]: "6",
    });
    expect(await getContainer(actor, box.id)).toMatchObject({
      locationId: shelf,
    });
    // Taking it apart leaves the detail by product and lot.
    expect(await closeContainer(actor, box.id)).toMatchObject({ ok: true });
    expect(
      await registerExit(actor, {
        productId: two,
        lotId: await lotOf(two, "R-9"),
        locationId: shelf,
        quantity: "6",
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("a pallet waiting without a task gets one from «Crear tareas de acomodo»", async () => {
    const actor = await company();
    const general = (await getDefaultLocation(actor))!.id;
    await place(actor, "Estante 1", { code: "E-01" });
    const item = await product(actor);
    await enter(actor, item, general, "8");
    const pallet = await pack(actor, {
      locationId: general,
      productId: item,
      quantity: "8",
    });
    await setting(actor, PUTAWAY_MODE.key, "tasks");
    const made = await createPendingPutawayTasks(actor);
    expect(made).toMatchObject({ ok: true, created: 1 });
    expect(
      await db.warehouseTask.findMany({
        where: { organizationId: actor.organizationId },
        select: { containerId: true, productId: true },
      }),
    ).toEqual([{ containerId: pallet, productId: null }]);
    expect(await createPendingPutawayTasks(actor)).toMatchObject({
      created: 0,
    });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);
});

describe("isolation", () => {
  it("another company and a person outside its zones do not see it", async () => {
    const actor = await company();
    const scene = await palletScene(actor);
    const other = await company();
    expect(await getContainer(other, scene.pallet)).toBeNull();
    expect(await findContainerByCode(other, "C-0001")).toBeNull();
    expect(
      await moveContainer(other, {
        containerId: scene.pallet,
        locationCode: "E-02",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await unpackStock(other, {
        containerId: scene.pallet,
        itemId: newId(),
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });

    // WMS-20: a person limited to another zone.
    const zone = await place(actor, "Zona B", { level: 1 });
    const zoneShelf = await place(actor, "Estante B", {
      parentId: zone,
      code: "B-01",
    });
    const zoned = await member(actor.organizationId, "supervisor");
    const facilityId = (
      await db.location.findUniqueOrThrow({ where: { id: zone } })
    ).facilityId;
    const scoped = await setMemberScope(actor.organizationId, actor.userId, {
      userId: zoned.userId,
      facilities: [{ facilityId, zoneIds: [zone] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    expect(await getContainer(zoned, scene.pallet)).toBeNull();
    expect((await listContainers(zoned)).total).toBe(0);
    expect((await findTraceMatches(zoned, "C-0001")).matches).toEqual([]);
    expect(
      await moveContainer(zoned, {
        containerId: scene.pallet,
        locationCode: "B-01",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: false });
    // Once it is in their zone, the person limited to it sees it.
    expect(
      await moveContainer(actor, {
        containerId: scene.pallet,
        locationCode: "B-01",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await getContainer(zoned, scene.pallet)).toMatchObject({
      locationId: zoneShelf,
    });
    expect((await findTraceMatches(zoned, "C-0001")).matches).toMatchObject([
      { kind: "container" },
    ]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
    expect(await reconcileStock(other.organizationId)).toEqual([]);
  }, 60_000);
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
