import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  PACKING_MODE,
  acceptTask,
  closeContainer,
  confirmPick,
  countOrdersToPack,
  createOutboundOrder,
  deliverTask,
  finishPacking,
  getContainer,
  getOutboundOrder,
  getPackingView,
  listContainers,
  listOutboundOrders,
  moveContainer,
  packScan,
  reconcileStock,
  registerEntry,
  registerExit,
  registerTransfer,
  releaseOutboundOrder,
  reopenPackage,
  reportPackShortage,
  sealPackage,
  setOutboundLine,
  startPacking,
  unpackFromPackage,
  unpackStock,
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

// WMS-15 (ADR 0044): in the staging place, who packs scans what was picked
// into the order's packages — containers with purpose PACKING. Packing
// never moves stock nor changes a balance; never more than what was picked
// goes in; what is missing is written with its reason and released from
// the order's reservation; finishing leaves the order PACKED.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `empaque.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(options: { packing?: boolean } = {}) {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén empaque ${counter}`,
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
      reason: "Prueba de empaque",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  const actor = { organizationId: created.organizationId, userId: owner };
  if (options.packing !== false) await setPacking(actor, "on");
  return actor;
}

async function setPacking(actor: InventoryActor, value: "on" | "off") {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    PACKING_MODE.key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
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

async function product(
  actor: InventoryActor,
  extra: {
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const n = ++counter;
  const created = await createProduct(actor, {
    sku: `EMP-${n}`,
    name: `Artículo ${n}`,
    barcode: `780${stamp % 1_000_000}${n}`.slice(0, 13),
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function rack(actor: InventoryActor, name: string) {
  const result = await createLocation(actor, { level: 3, name });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
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
    acceptRepeat: true,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** An order released with its lines; returns its id. */
async function released(
  actor: InventoryActor,
  lines: { productId: string; quantity: string }[],
) {
  const made = await createOutboundOrder(actor, { recipient: "Sucursal Sur" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  for (const line of lines) {
    const set = await setOutboundLine(actor, made.orderId, line);
    if (!set.ok) throw new Error(JSON.stringify(set));
  }
  const result = await releaseOutboundOrder(actor, made.orderId);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return made.orderId;
}

/** Takes, confirms and delivers every picking task of an order. */
async function pickAll(
  actor: InventoryActor,
  orderId: string,
  serialsOf: (productId: string) => string | undefined = () => undefined,
) {
  const tasks = await db.warehouseTask.findMany({
    where: { kind: "PICK", outboundLine: { orderId } },
    orderBy: { number: "asc" },
    include: { product: true, fromLocation: true, lot: true },
  });
  for (const task of tasks) {
    expect(await acceptTask(actor, task.id)).toMatchObject({ ok: true });
    const confirmed = await confirmPick(actor, task.id, {
      productCode: task.product!.sku,
      locationCode: task.fromLocation.name,
      lotCode: task.lot?.code,
      quantity: task.quantity!.toString(),
      serials: serialsOf(task.productId!),
    });
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
    const delivered = await deliverTask(actor, task.id);
    if (!delivered.ok) throw new Error(JSON.stringify(delivered));
  }
  expect(
    (await db.outboundOrder.findUniqueOrThrow({ where: { id: orderId } }))
      .status,
  ).toBe("PICKED");
}

const staging = (organizationId: string) =>
  db.location.findFirstOrThrow({ where: { organizationId, isStaging: true } });

const balanceAt = async (productId: string, locationId: string) =>
  (
    await db.stockBalance.aggregate({
      where: { productId, locationId },
      _sum: { quantity: true },
    })
  )._sum.quantity?.toString() ?? "0";

const heldAt = async (productId: string, locationId: string) =>
  (
    await db.stockReservation.aggregate({
      where: { productId, locationId, state: "ACTIVE" },
      _sum: { remaining: true },
    })
  )._sum.remaining?.toString() ?? "0";

const packagesOf = (orderId: string) =>
  db.container.findMany({
    where: { outboundOrderId: orderId },
    orderBy: { number: "asc" },
    include: { items: true },
  });

afterAll(() => db.$disconnect());

describe("starting", () => {
  it("only a picked order, only when the company packs, only who may pack", async () => {
    const owner = await company({ packing: false });
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "4" }]);
    // Still picking: not yet.
    expect(await startPacking(owner, orderId)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("todavía no termina de surtirse"),
    });
    await pickAll(owner, orderId);
    // The company does not pack: nothing new, not even the count.
    expect(await startPacking(owner, orderId)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("El empaque está apagado"),
    });
    expect(await countOrdersToPack(owner)).toBe(0);
    await setPacking(owner, "on");
    expect(await countOrdersToPack(owner)).toBe(1);
    expect(
      (await listOutboundOrders(owner, { status: "por-empacar" })).items,
    ).toHaveLength(1);

    const forklift = await member(owner.organizationId, "forklift");
    const manager = await member(owner.organizationId, "manager");
    await expect(startPacking(forklift, orderId)).rejects.toThrow();
    await expect(startPacking(manager, orderId)).rejects.toThrow();
    const operator = await member(owner.organizationId, "operator");
    expect(await startPacking(operator, orderId)).toMatchObject({ ok: true });
    expect(await startPacking(operator, orderId)).toMatchObject({
      ok: true,
      repeated: true,
    });
    // Gerencia reads what is being packed; it does not pack.
    expect(await getPackingView(manager, orderId)).toMatchObject({
      status: "PACKING",
      statusLabel: "Empacando",
    });
    await expect(
      packScan(manager, orderId, { code: "EMP-1" }),
    ).rejects.toThrow();
    expect(await countOrdersToPack(owner)).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("verifying and packing", () => {
  it("scans go into the open package, never more than what was picked, and nothing moves", async () => {
    const owner = await company();
    const item = await product(owner);
    const other = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "30");
    await enter(owner, other, shelf, "5");
    const orderId = await released(owner, [
      { productId: item, quantity: "10" },
    ]);
    await pickAll(owner, orderId);
    const place = await staging(owner.organizationId);
    expect(await startPacking(owner, orderId)).toMatchObject({ ok: true });
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    const barcode = (
      await db.product.findUniqueOrThrow({ where: { id: item } })
    ).barcode!;
    const otherSku = (
      await db.product.findUniqueOrThrow({ where: { id: other } })
    ).sku;

    // The first scan opens a box.
    const first = await packScan(owner, orderId, { code: sku.toLowerCase() });
    expect(first).toMatchObject({
      ok: true,
      summary: expect.stringContaining("Abriste la caja C-0001"),
    });
    expect(
      await packScan(owner, orderId, { code: barcode, quantity: "8" }),
    ).toMatchObject({
      ok: true,
      summary: expect.stringContaining("van 9 de 10 piezas"),
    });
    // Never more than what was picked.
    expect(
      await packScan(owner, orderId, { code: sku, quantity: "2" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        quantity: expect.stringContaining("Solo falta empacar 1 pieza"),
      },
    });
    // Something that is not of the order says what it is.
    expect(await packScan(owner, orderId, { code: otherSku })).toMatchObject({
      ok: false,
      fieldErrors: { code: expect.stringContaining("no es de este pedido") },
    });
    expect(await packScan(owner, orderId, { code: "NADA-123" })).toMatchObject({
      ok: false,
      fieldErrors: { code: expect.stringContaining("No encontramos") },
    });
    expect(await finishPacking(owner, orderId)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("Falta empacar 1 pieza"),
    });

    // Close the box (kind and weight), the next scan opens another.
    const [box] = await packagesOf(orderId);
    expect(
      await sealPackage(owner, orderId, {
        packageId: box!.id,
        kind: "caja grande",
        weight: "x",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { weight: expect.any(String) } });
    expect(
      await sealPackage(owner, orderId, {
        packageId: box!.id,
        kind: "caja grande",
        weight: "12,5",
      }),
    ).toMatchObject({ ok: true, summary: expect.stringContaining("12.5 kg") });
    expect(
      await sealPackage(owner, orderId, { packageId: box!.id }),
    ).toMatchObject({ ok: true, repeated: true });
    // A sealed package takes nothing; take-out needs it open.
    expect(
      await unpackFromPackage(owner, orderId, {
        packageId: box!.id,
        itemId: box!.items[0]!.id,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("ábrelo de nuevo"),
    });
    const second = await packScan(owner, orderId, { code: sku });
    expect(second).toMatchObject({
      ok: true,
      summary: expect.stringContaining("Abriste la caja C-0002"),
    });
    // Only one open at a time.
    expect(await reopenPackage(owner, orderId, box!.id)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("Primero cierra la caja C-0002"),
    });

    // Take one out of the open box: it waits loose, still for the order.
    const boxes = await packagesOf(orderId);
    const open = boxes[1]!;
    expect(
      await unpackFromPackage(owner, orderId, {
        packageId: open.id,
        itemId: open.items[0]!.id,
        quantity: "2",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    expect(
      await unpackFromPackage(owner, orderId, {
        packageId: open.id,
        itemId: open.items[0]!.id,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    let view = await getPackingView(owner, orderId);
    expect(view?.lines[0]).toMatchObject({
      progressText: "9 de 10",
      leftText: "1 pieza",
      done: false,
    });
    expect(view?.complete).toBe(false);
    expect(await packScan(owner, orderId, { code: sku })).toMatchObject({
      ok: true,
    });

    // Nothing moved: the balance and the reservation in staging are the
    // picked 10, and a loose exit cannot take them.
    expect(await balanceAt(item, place.id)).toBe("10");
    expect(await heldAt(item, place.id)).toBe("10");
    expect(
      await registerExit(owner, {
        productId: item,
        locationId: place.id,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });

    expect(await finishPacking(owner, orderId)).toMatchObject({
      ok: true,
      summary: expect.stringContaining("quedó empacado en 2 bultos"),
    });
    expect(await finishPacking(owner, orderId)).toMatchObject({
      ok: true,
      repeated: true,
    });
    view = await getPackingView(owner, orderId);
    expect(view).toMatchObject({ status: "PACKED", complete: true });
    expect(
      view?.packages.map((each) => [each.name, each.open, each.weightText]),
    ).toEqual([
      ["Caja grande C-0001", false, "12.5 kg"],
      ["Caja C-0002", false, null],
    ]);
    expect(
      view?.packages.map((each) => each.items.map((i) => i.quantityText)),
    ).toEqual([["9 piezas"], ["1 pieza"]]);
    expect(await countOrdersToPack(owner)).toBe(0);
    // Its history: created, packed, sealed (and the take-out of the second).
    expect(
      (
        await db.containerEvent.findMany({
          where: { containerId: open.id },
          orderBy: { id: "asc" },
        })
      ).map((event) => event.kind),
    ).toEqual(["CREATED", "PACKED", "UNPACKED", "PACKED", "SEALED"]);
    // No movement was written by packing.
    expect(
      await db.stockMovement.count({
        where: { organizationId: owner.organizationId, type: "EXIT" },
      }),
    ).toBe(0);
    const trail = await listAuditTrail(owner.organizationId, { limit: 20 });
    expect(trail.map((entry) => entry.action)).toContain(
      "inventory.outbound_packed",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("another order still delivers its picking to staging next to a packed one", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "20");
    const first = await released(owner, [{ productId: item, quantity: "5" }]);
    await pickAll(owner, first);
    await startPacking(owner, first);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    expect(
      await packScan(owner, first, { code: sku, quantity: "5" }),
    ).toMatchObject({ ok: true });
    // What is packed is already set aside: it is not subtracted twice.
    const second = await released(owner, [{ productId: item, quantity: "4" }]);
    await pickAll(owner, second);
    const place = await staging(owner.organizationId);
    expect(await balanceAt(item, place.id)).toBe("9");
    expect(await heldAt(item, place.id)).toBe("9");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("differences", () => {
  it("what is missing is written with its reason, released and left loose", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [
      { productId: item, quantity: "10" },
    ]);
    await pickAll(owner, orderId);
    await startPacking(owner, orderId);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    await packScan(owner, orderId, { code: sku, quantity: "9" });
    const line = await db.outboundOrderLine.findFirstOrThrow({
      where: { orderId },
    });
    expect(
      await reportPackShortage(owner, orderId, { lineId: line.id, reason: "" }),
    ).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    expect(
      await reportPackShortage(owner, orderId, {
        lineId: line.id,
        reason: "No apareció en preparación",
      }),
    ).toMatchObject({
      ok: true,
      summary: expect.stringContaining("el faltante: 1 pieza"),
    });
    expect(
      await reportPackShortage(owner, orderId, {
        lineId: line.id,
        reason: "Otra vez",
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("No falta nada"),
    });
    const place = await staging(owner.organizationId);
    // The balance did not change; the reservation now holds the packed 9.
    expect(await balanceAt(item, place.id)).toBe("10");
    expect(await heldAt(item, place.id)).toBe("9");
    // The missing one is loose and free (for an adjustment or a count),
    // and nothing more can be packed.
    expect(await packScan(owner, orderId, { code: sku })).toMatchObject({
      ok: false,
      fieldErrors: {
        code: expect.stringContaining("Ya empacaste todo lo surtido"),
      },
    });
    expect(
      await registerExit(owner, {
        productId: item,
        locationId: place.id,
        quantity: "2",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registerTransfer(owner, {
        productId: item,
        locationId: place.id,
        toLocationId: shelf,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });

    expect(await finishPacking(owner, orderId)).toMatchObject({ ok: true });
    const view = await getPackingView(owner, orderId);
    expect(view?.lines[0]).toMatchObject({
      askedText: "10 piezas",
      pickedText: "10 piezas",
      packedText: "9 piezas",
      missingText: "1 pieza",
      done: true,
    });
    expect(view?.shortages).toMatchObject([
      { quantityText: "1 pieza", reason: "No apareció en preparación" },
    ]);
    const trail = await listAuditTrail(owner.organizationId, { limit: 20 });
    expect(trail.map((entry) => entry.action)).toContain(
      "inventory.outbound_pack_short",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("lots and serials", () => {
  it("a lot must be one the order set aside; the lot code is scanned when there are several", async () => {
    const owner = await company();
    const item = await product(owner, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    const a = await rack(owner, "Rack A");
    const b = await rack(owner, "Rack B");
    await enter(owner, item, a, "5", {
      lotCode: "L-01",
      lotExpiresOn: "2099-01-31",
    });
    await enter(owner, item, b, "5", {
      lotCode: "L-02",
      lotExpiresOn: "2099-06-30",
    });
    await enter(owner, item, b, "5", {
      lotCode: "L-03",
      lotExpiresOn: "2099-12-31",
    });
    const orderId = await released(owner, [{ productId: item, quantity: "8" }]);
    await pickAll(owner, orderId);
    await startPacking(owner, orderId);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    expect(await packScan(owner, orderId, { code: sku })).toMatchObject({
      ok: false,
      fieldErrors: {
        code: expect.stringContaining("varios lotes por empacar (L-01, L-02)"),
      },
    });
    // A lot that was not picked is not of the order.
    expect(await packScan(owner, orderId, { code: "L-03" })).toMatchObject({
      ok: false,
    });
    expect(
      await packScan(owner, orderId, { code: "l-01", quantity: "5" }),
    ).toMatchObject({ ok: true });
    expect(
      await packScan(owner, orderId, { code: "L-01", quantity: "1" }),
    ).toMatchObject({ ok: false });
    // Only L-02 is left: the product alone is enough.
    expect(
      await packScan(owner, orderId, { code: sku, quantity: "3" }),
    ).toMatchObject({ ok: true, summary: expect.stringContaining("L-02") });
    const [box] = await packagesOf(orderId);
    const lots = await db.lot.findMany({ where: { productId: item } });
    const codeOf = new Map(lots.map((lot) => [lot.id, lot.code]));
    expect(
      box!.items
        .map((row) => [codeOf.get(row.lotId!), row.quantity.toString()])
        .sort(),
    ).toEqual([
      ["L-01", "5"],
      ["L-02", "3"],
    ]);
    expect(await finishPacking(owner, orderId)).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a unit by serial is scanned by its serial, only if it was picked for the order", async () => {
    const owner = await company();
    const item = await product(owner, { tracking: "SERIAL" });
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "3", { serials: "P-1\nP-2\nP-3" });
    const orderId = await released(owner, [{ productId: item, quantity: "2" }]);
    await pickAll(owner, orderId, () => "P-1\nP-3");
    await startPacking(owner, orderId);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    expect(await packScan(owner, orderId, { code: sku })).toMatchObject({
      ok: false,
      fieldErrors: { code: expect.stringContaining("va por serie") },
    });
    expect(await packScan(owner, orderId, { code: "P-2" })).toMatchObject({
      ok: false,
      fieldErrors: {
        code: expect.stringContaining("no se surtió para este pedido"),
      },
    });
    expect(await packScan(owner, orderId, { code: "p-1" })).toMatchObject({
      ok: true,
    });
    expect(await packScan(owner, orderId, { code: "P-1" })).toMatchObject({
      ok: false,
      fieldErrors: { code: expect.stringContaining("ya está en Caja C-0001") },
    });
    const [box] = await packagesOf(orderId);
    expect(
      (await db.serialUnit.findFirstOrThrow({ where: { serial: "P-1" } }))
        .containerId,
    ).toBe(box!.id);
    let view = await getPackingView(owner, orderId);
    expect(view?.lines[0]?.leftSerials).toEqual(["P-3"]);
    expect(view?.packages[0]?.items[0]?.serials).toEqual(["P-1"]);
    // Taking it out names the serial and lets it go loose.
    expect(
      await unpackFromPackage(owner, orderId, {
        packageId: box!.id,
        itemId: box!.items[0]!.id,
        quantity: "1",
        serials: "P-3",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { serials: expect.any(String) },
    });
    expect(
      await unpackFromPackage(owner, orderId, {
        packageId: box!.id,
        itemId: box!.items[0]!.id,
        quantity: "1",
        serials: "P-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await db.serialUnit.findFirstOrThrow({ where: { serial: "P-1" } }))
        .containerId,
    ).toBeNull();
    await packScan(owner, orderId, { code: "P-1" });
    // One is missing: its serial is written.
    const line = await db.outboundOrderLine.findFirstOrThrow({
      where: { orderId },
    });
    expect(
      await reportPackShortage(owner, orderId, {
        lineId: line.id,
        reason: "La caja venía vacía",
      }),
    ).toMatchObject({ ok: true });
    view = await getPackingView(owner, orderId);
    expect(view?.shortages).toMatchObject([{ serials: "P-3" }]);
    expect(await finishPacking(owner, orderId)).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("at the same time", () => {
  it("two people scan the last piece: only one counts; two finish: one does", async () => {
    const owner = await company();
    const operator = await member(owner.organizationId, "operator");
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "3" }]);
    await pickAll(owner, orderId);
    await startPacking(owner, orderId);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    // Two first scans at once open a single package.
    const opening = await Promise.all([
      packScan(owner, orderId, { code: sku }),
      packScan(operator, orderId, { code: sku }),
    ]);
    expect(opening.every((result) => result.ok)).toBe(true);
    expect(await packagesOf(orderId)).toHaveLength(1);
    const last = await Promise.all([
      packScan(owner, orderId, { code: sku }),
      packScan(operator, orderId, { code: sku }),
    ]);
    expect(last.filter((result) => result.ok)).toHaveLength(1);
    const [box] = await packagesOf(orderId);
    expect(box!.items[0]!.quantity.toString()).toBe("3");
    const finished = await Promise.all([
      finishPacking(owner, orderId),
      finishPacking(operator, orderId),
    ]);
    expect(finished.every((result) => result.ok)).toBe(true);
    expect(
      finished.filter((result) => result.ok && result.repeated),
    ).toHaveLength(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("packages are handled only from their order", () => {
  it("the pallet screens and services refuse a package and do not list it", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "2" }]);
    await pickAll(owner, orderId);
    await startPacking(owner, orderId);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    await packScan(owner, orderId, { code: sku, quantity: "2" });
    const [box] = await packagesOf(orderId);
    const refusal = {
      ok: false,
      formError: expect.stringContaining("es un bulto del pedido PS-0001"),
    };
    expect(await closeContainer(owner, box!.id)).toMatchObject(refusal);
    expect(
      await unpackStock(owner, {
        containerId: box!.id,
        itemId: box!.items[0]!.id,
        quantity: "1",
      }),
    ).toMatchObject(refusal);
    expect(
      await moveContainer(owner, {
        containerId: box!.id,
        containerCode: box!.code,
        locationCode: "Rack A",
        idempotencyKey: newId(),
      }),
    ).toMatchObject(refusal);
    expect((await listContainers(owner)).items).toEqual([]);
    // Its card says whose it is.
    expect(await getContainer(owner, box!.id)).toMatchObject({
      package: { orderId, orderNumberText: "PS-0001", sealed: false },
    });
    // And the order's card lists it.
    expect(await getOutboundOrder(owner, orderId)).toMatchObject({
      status: "PACKING",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("another company's order does not exist", async () => {
    const owner = await company();
    const stranger = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "2" }]);
    await pickAll(owner, orderId);
    const notFound = { ok: false, reason: "not_found" };
    expect(await startPacking(stranger, orderId)).toMatchObject(notFound);
    await startPacking(owner, orderId);
    expect(await packScan(stranger, orderId, { code: "EMP" })).toMatchObject(
      notFound,
    );
    expect(await finishPacking(stranger, orderId)).toMatchObject(notFound);
    expect(await getPackingView(stranger, orderId)).toBeNull();
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("in the database", () => {
  it("transitions, packages and shortages keep their rules", async () => {
    const owner = await company();
    const item = await product(owner);
    const shelf = await rack(owner, "Rack A");
    await enter(owner, item, shelf, "10");
    const orderId = await released(owner, [{ productId: item, quantity: "2" }]);
    await pickAll(owner, orderId);
    // Packing is a step of its own: PICKED never jumps to PACKED.
    await expect(
      db.outboundOrder.update({
        where: { id: orderId },
        data: { status: "PACKED" },
      }),
    ).rejects.toThrow();
    await startPacking(owner, orderId);
    await expect(
      db.outboundOrder.update({
        where: { id: orderId },
        data: { status: "CANCELLED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundOrder.update({
        where: { id: orderId },
        data: { status: "SHIPPED" },
      }),
    ).rejects.toThrow();
    const sku = (await db.product.findUniqueOrThrow({ where: { id: item } }))
      .sku;
    await packScan(owner, orderId, { code: sku });
    const [box] = await packagesOf(orderId);
    await sealPackage(owner, orderId, { packageId: box!.id });
    // A sealed package takes nothing more.
    await expect(
      db.containerItem.update({
        where: { id: box!.items[0]!.id },
        data: { quantity: "2" },
      }),
    ).rejects.toThrow();
    // Its order never changes; a package has one, a pallet none.
    const otherOrder = await released(owner, [
      { productId: item, quantity: "1" },
    ]);
    await expect(
      db.container.update({
        where: { id: box!.id },
        data: { outboundOrderId: otherOrder },
      }),
    ).rejects.toThrow();
    await expect(
      db.container.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          number: 99,
          code: "C-0099",
          kind: "Caja",
          purpose: "PACKING",
          locationId: shelf,
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
    // A shortage never changes nor is deleted.
    await reopenPackage(owner, orderId, box!.id);
    const line = await db.outboundOrderLine.findFirstOrThrow({
      where: { orderId },
    });
    await reportPackShortage(owner, orderId, {
      lineId: line.id,
      reason: "Se rompió",
    });
    const shortage = await db.outboundPackShortage.findFirstOrThrow({
      where: { orderId },
    });
    await expect(
      db.outboundPackShortage.update({
        where: { id: shortage.id },
        data: { reason: "Otra" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundPackShortage.delete({ where: { id: shortage.id } }),
    ).rejects.toThrow();
    expect(await finishPacking(owner, orderId)).toMatchObject({ ok: true });
    expect(
      (await db.outboundOrder.findUniqueOrThrow({ where: { id: orderId } }))
        .status,
    ).toBe("PACKED");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});
