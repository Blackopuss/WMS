import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  createOutboundOrder,
  createTask,
  getStockByLocation,
  listOutboundOrders,
  listStockLocations,
  listTasks,
  reconcileStock,
  registerEntry,
  registerTransfer,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  archiveFacility,
  createFacility,
  createLocation,
  getActiveFacility,
  getDefaultLocation,
  listFacilities,
  listLocations,
  switchFacility,
  updateFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-18 (spec 3.1, 6.5): a company runs several warehouses with the same
// code; each person works in one; stock, moves, tasks and orders of one
// never mix with another.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `almacenes.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(facilities?: number): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa almacenes ${counter}`,
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
      productLimit: 20,
      users: 10,
      facilities,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de almacenes",
    },
  );
  if (!result.ok) throw new Error("provision failed");
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

/** A company with two warehouses; the owner starts in the main one. */
async function twoWarehouses() {
  const owner = await company(3);
  const second = await createFacility(owner, {
    name: "Bodega Norte",
    code: "norte",
    address: "Calle 1",
  });
  if (!second.ok) throw new Error(JSON.stringify(second));
  const main = (await listFacilities(owner)).find((each) => each.isDefault)!;
  return { owner, mainId: main.id, northId: second.facilityId };
}

async function shelf(actor: InventoryActor, name: string) {
  const made = await createLocation(actor, { kind: "SHELF", name });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

afterAll(() => db.$disconnect());

describe("warehouses", () => {
  it("the plan decides how many; each new one comes with its General", async () => {
    const single = await company();
    expect(
      await createFacility(single, { name: "Otra", code: "OTRA" }),
    ).toMatchObject({
      ok: false,
      reason: "limit",
      formError: expect.stringMatching(/1 almacén/),
    });
    const { owner, northId } = await twoWarehouses();
    const north = (await listFacilities(owner)).find((f) => f.id === northId);
    expect(north).toMatchObject({
      name: "Bodega Norte",
      code: "NORTE",
      isDefault: false,
    });
    expect(
      await db.location.findFirst({
        where: { facilityId: northId, isDefault: true },
      }),
    ).toMatchObject({ name: "General", kind: "GENERAL" });
    expect(
      await createFacility(owner, { name: "Repetido", code: "NORTE" }),
    ).toMatchObject({ ok: false, fieldErrors: { code: expect.any(String) } });
    expect(
      await updateFacility(owner, northId, {
        name: "Bodega Norte 2",
        code: "NORTE",
      }),
    ).toMatchObject({ ok: true });
  });

  it("each person works in one warehouse and sees only its locations", async () => {
    const { owner, mainId, northId } = await twoWarehouses();
    expect((await getActiveFacility(owner)).id).toBe(mainId);
    await shelf(owner, "Rack principal");
    expect(await switchFacility(owner, northId)).toMatchObject({ ok: true });
    expect((await getActiveFacility(owner)).id).toBe(northId);
    const northRack = await shelf(owner, "Rack norte");
    // Same name in another warehouse is fine.
    await shelf(owner, "Rack principal");
    const paths = (await listStockLocations(owner)).map((place) => place.path);
    expect(paths).toEqual(["General", "Rack norte", "Rack principal"]);
    expect((await listLocations(owner))?.facility.id).toBe(northId);
    const general = await getDefaultLocation(owner);
    expect(general?.facility.id).toBe(northId);
    expect(
      await db.location.findUniqueOrThrow({ where: { id: northRack } }),
    ).toMatchObject({ facilityId: northId });
    // Another person of the company still works in the main one.
    const colleague = await member(owner.organizationId, "warehouse");
    expect((await getActiveFacility(colleague)).id).toBe(mainId);
    // A warehouse of another company is not found.
    const other = await company();
    expect(await switchFacility(other, northId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("stock, moves and tasks never cross warehouses", async () => {
    const { owner, northId } = await twoWarehouses();
    const product = await createProduct(owner, { sku: "ALM-1", name: "Caja" });
    if (!product.ok) throw new Error("product setup failed");
    const mainRack = await shelf(owner, "Rack A");
    await switchFacility(owner, northId);
    const northRack = await shelf(owner, "Rack B");
    await registerEntry(owner, {
      productId: product.productId,
      locationId: mainRack,
      quantity: "10",
    });
    expect(
      await registerTransfer(owner, {
        productId: product.productId,
        locationId: mainRack,
        toLocationId: northRack,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { toLocationId: expect.stringMatching(/otro almacén/) },
    });
    expect(
      await createTask(owner, {
        productId: product.productId,
        fromLocationId: mainRack,
        toLocationId: northRack,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { toLocationId: expect.stringMatching(/otro almacén/) },
    });
    expect(await getStockByLocation(owner, product.productId)).toEqual({
      [mainRack]: "10",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("an order is picked in its own warehouse, into that warehouse's staging", async () => {
    const { owner, mainId, northId } = await twoWarehouses();
    const product = await createProduct(owner, { sku: "ALM-2", name: "Caja" });
    if (!product.ok) throw new Error("product setup failed");
    const mainRack = await shelf(owner, "Rack A");
    await registerEntry(owner, {
      productId: product.productId,
      locationId: mainRack,
      quantity: "50",
    });
    await switchFacility(owner, northId);
    const northRack = await shelf(owner, "Rack B");
    await registerEntry(owner, {
      productId: product.productId,
      locationId: northRack,
      quantity: "5",
    });
    const made = await createOutboundOrder(owner, { recipient: "Cliente" });
    if (!made.ok) throw new Error("order setup failed");
    await setOutboundLine(owner, made.orderId, {
      productId: product.productId,
      quantity: "8",
    });
    // The main warehouse has 50, but this order leaves from the north one.
    expect(await releaseOutboundOrder(owner, made.orderId)).toMatchObject({
      ok: false,
      reason: "short",
      shortages: [{ asked: "8 piezas", free: "5 piezas" }],
    });
    expect(
      await releaseOutboundOrder(owner, made.orderId, {
        takeWhatThereIs: true,
      }),
    ).toMatchObject({ ok: true });
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { organizationId: owner.organizationId, kind: "PICK" },
      include: { toLocation: true },
    });
    expect(task.fromLocationId).toBe(northRack);
    expect(task.toLocation).toMatchObject({
      facilityId: northId,
      isStaging: true,
    });
    // Lists show the warehouse the person works in.
    expect((await listOutboundOrders(owner)).total).toBe(1);
    expect((await listTasks(owner, { view: "available" })).total).toBe(1);
    await switchFacility(owner, mainId);
    expect((await listOutboundOrders(owner)).total).toBe(0);
    expect((await listTasks(owner, { view: "available" })).total).toBe(0);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a warehouse is archived only empty, and the main one never", async () => {
    const { owner, mainId, northId } = await twoWarehouses();
    const colleague = await member(owner.organizationId, "warehouse");
    await switchFacility(colleague, northId);
    expect(await archiveFacility(owner, mainId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    const product = await createProduct(owner, { sku: "ALM-3", name: "Caja" });
    if (!product.ok) throw new Error("product setup failed");
    const general = await db.location.findFirstOrThrow({
      where: { facilityId: northId, isDefault: true },
    });
    await registerEntry(owner, {
      productId: product.productId,
      locationId: general.id,
      quantity: "1",
    });
    expect(await archiveFacility(owner, northId)).toMatchObject({
      ok: false,
      formError: expect.stringMatching(/existencias/),
    });
    const empty = await createFacility(owner, { name: "Sur", code: "SUR" });
    if (!empty.ok) throw new Error("setup failed");
    await switchFacility(colleague, empty.facilityId);
    expect(await archiveFacility(owner, empty.facilityId)).toMatchObject({
      ok: true,
    });
    // Who worked there is back in the main warehouse.
    expect((await getActiveFacility(colleague)).id).toBe(mainId);
    expect(
      (await listFacilities(owner)).map((facility) => facility.code),
    ).not.toContain("SUR");
    await expect(
      db.facility.delete({ where: { id: empty.facilityId } }),
    ).rejects.toThrow();
  });

  it("only who may change locations manages warehouses", async () => {
    const { owner } = await twoWarehouses();
    const viewer = await member(owner.organizationId, "viewer");
    await expect(
      createFacility(viewer, { name: "X", code: "X" }),
    ).rejects.toThrow();
    // Reading them and choosing where to work is for everyone with stock.
    expect(await listFacilities(viewer)).toHaveLength(2);
  });
});
