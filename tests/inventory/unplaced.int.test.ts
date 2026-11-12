import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  UNPLACED_PAGE_SIZE,
  changeStockStatus,
  countUnplacedStock,
  listUnplacedStock,
  reconcileStock,
  registerEntry,
  registerExit,
  registerTransfer,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  createFacility,
  createLocation,
  getDefaultLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-72: what waits in «General» or in receiving of the warehouse the
// person works in, derived from the balances.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `acomodo.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  options: { withoutPlan?: boolean } = {},
): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa acomodo ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const actor = { organizationId: created.organizationId, userId: owner };
  // Without a plan the company has no module at all.
  if (options.withoutPlan) return actor;
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 200,
      users: 10,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de existencias sin acomodar",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return actor;
}

async function member(organizationId: string, role?: Role) {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  if (role) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  return { organizationId, userId };
}

/** A location at the root of the warehouse the actor works in. */
async function place(actor: InventoryActor, name: string, type?: string) {
  const made = await createLocation(actor, {
    level: 1,
    name,
    ...(type ? { type } : {}),
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

/** A product, with an entry in a location («General» when none is given). */
async function product(
  actor: InventoryActor,
  name: string,
  quantity = "",
  locationId?: string,
) {
  const result = await createProduct(actor, { sku: `A-${++counter}`, name });
  if (!result.ok) throw new Error("product setup failed");
  if (quantity) await enter(actor, result.productId, quantity, locationId);
  return result.productId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  quantity: string,
  locationId?: string,
) {
  // Always the General of the warehouse the person works in.
  const entry = await registerEntry(actor, {
    productId,
    quantity,
    locationId: locationId ?? (await getDefaultLocation(actor))!.id,
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
}

const waiting = async (actor: InventoryActor) =>
  (await listUnplacedStock(actor)).items.map(
    (item) => `${item.name} @ ${item.locationPath}: ${item.quantityLabel}`,
  );

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("stock waiting to be put away", () => {
  it("a warehouse that only has General has nothing waiting", async () => {
    const owner = await company();
    await product(owner, "Tornillo", "40");
    expect(await listUnplacedStock(owner)).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      pageCount: 1,
      hasPlaces: false,
    });
    expect(await countUnplacedStock(owner)).toBe(0);
    // A receiving dock is not a place to store: still nothing to put away.
    await place(owner, "Andén", "RECEIVING");
    expect(await countUnplacedStock(owner)).toBe(0);
    expect((await listUnplacedStock(owner)).hasPlaces).toBe(false);
  }, 60_000);

  it("lists what is in General or in receiving until it is relocated", async () => {
    const owner = await company();
    const rack = await place(owner, "Rack 1");
    const dock = await place(owner, "Andén", "RECEIVING");
    const general = (await getDefaultLocation(owner))!.id;
    const tornillo = await product(owner, "Tornillo", "40");
    const cable = await product(owner, "Cable", "12", dock);
    await enter(owner, cable, "3");
    // Already in its place, and a product without stock: not listed.
    await product(owner, "Martillo", "5", rack);
    await product(owner, "Clavo");

    const list = await listUnplacedStock(owner);
    expect(list).toMatchObject({ total: 2, page: 1, hasPlaces: true });
    expect(await countUnplacedStock(owner)).toBe(2);
    // Products in name order; of one product, General first.
    expect(await waiting(owner)).toEqual([
      "Cable @ General: 3 piezas",
      "Cable @ Andén: 12 piezas",
      "Tornillo @ General: 40 piezas",
    ]);
    expect(list.items[2]).toMatchObject({
      productId: tornillo,
      locationId: general,
      quantity: "40",
      unitCode: expect.any(String),
    });

    // Part of it is put away: the rest keeps waiting.
    expect(
      await registerTransfer(owner, {
        productId: tornillo,
        locationId: general,
        toLocationId: rack,
        quantity: "30",
      }),
    ).toMatchObject({ ok: true });
    expect(await waiting(owner)).toContain("Tornillo @ General: 10 piezas");
    // All of it: it is gone from the list.
    expect(
      await registerTransfer(owner, {
        productId: tornillo,
        locationId: general,
        toLocationId: rack,
        quantity: "10",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerTransfer(owner, {
        productId: cable,
        locationId: dock,
        toLocationId: rack,
        quantity: "12",
      }),
    ).toMatchObject({ ok: true });
    expect(await waiting(owner)).toEqual(["Cable @ General: 3 piezas"]);
    expect(await countUnplacedStock(owner)).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 60_000);

  it("says since when: the entry of the oldest goods still there", async () => {
    const owner = await company();
    await place(owner, "Rack 1");
    const general = (await getDefaultLocation(owner))!.id;
    const tornillo = await product(owner, "Tornillo", "10");
    await enter(owner, tornillo, "5");
    await enter(owner, tornillo, "2");
    const entries = await db.stockMovementLine.findMany({
      where: { productId: tornillo, locationId: general, direction: "IN" },
      orderBy: { id: "asc" },
      select: { createdAt: true },
    });
    const since = async () => (await listUnplacedStock(owner)).items[0]?.since;
    // 17 there: the first entry still waits.
    expect(await since()).toEqual(entries[0]!.createdAt);
    // 11 left: what went out was the oldest, so the second entry is next.
    const exit = await registerExit(owner, {
      productId: tornillo,
      quantity: "11",
      locationId: general,
    });
    expect(exit).toMatchObject({ ok: true });
    expect(await since()).toEqual(entries[1]!.createdAt);
    // Only what the last entry brought is left.
    expect(
      await registerExit(owner, {
        productId: tornillo,
        quantity: "4",
        locationId: general,
      }),
    ).toMatchObject({ ok: true });
    expect(await since()).toEqual(entries[2]!.createdAt);
  }, 60_000);

  it("counts only what can be moved: available stock", async () => {
    const owner = await company();
    await place(owner, "Rack 1");
    const general = (await getDefaultLocation(owner))!.id;
    const vidrio = await product(owner, "Vidrio", "6");
    expect(
      await changeStockStatus(owner, {
        productId: vidrio,
        locationId: general,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "6",
        reason: "Se rompió al descargar",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await waiting(owner)).toEqual([]);
    expect(await countUnplacedStock(owner)).toBe(0);
  }, 60_000);

  it("pages the products in the database", async () => {
    const owner = await company();
    await place(owner, "Rack 1");
    const names = Array.from(
      { length: UNPLACED_PAGE_SIZE + 2 },
      (_, index) => `Producto ${String(index + 1).padStart(2, "0")}`,
    );
    for (const name of names) await product(owner, name, "1");
    const first = await listUnplacedStock(owner);
    expect(first).toMatchObject({
      total: names.length,
      page: 1,
      pageCount: 2,
    });
    expect(first.items.map((item) => item.name)).toEqual(
      names.slice(0, UNPLACED_PAGE_SIZE),
    );
    const second = await listUnplacedStock(owner, { page: 2 });
    expect(second.items.map((item) => item.name)).toEqual(
      names.slice(UNPLACED_PAGE_SIZE),
    );
    // A page out of range shows the last one.
    expect((await listUnplacedStock(owner, { page: 99 })).page).toBe(2);
  }, 120_000);

  it("shows only the warehouse the person works in", async () => {
    const owner = await company();
    await place(owner, "Rack principal");
    await product(owner, "Tornillo", "40");
    const north = await createFacility(owner, {
      name: "Bodega Norte",
      code: "NORTE",
    });
    if (!north.ok) throw new Error(JSON.stringify(north));
    const colleague = await member(owner.organizationId, "warehouse");

    expect(await switchFacility(owner, north.facilityId)).toMatchObject({
      ok: true,
    });
    // The north warehouse only has its General: nothing waits there, and
    // nothing of the main one shows up.
    await product(owner, "Cable", "7");
    expect(await listUnplacedStock(owner)).toMatchObject({
      total: 0,
      hasPlaces: false,
      facilityName: "Bodega Norte",
    });
    expect(await countUnplacedStock(owner)).toBe(0);
    // With a rack in the north, only what is in the north's General.
    await place(owner, "Rack norte");
    expect(await waiting(owner)).toEqual(["Cable @ General: 7 piezas"]);
    // Who works in the main warehouse sees only the main one.
    expect(await waiting(colleague)).toEqual(["Tornillo @ General: 40 piezas"]);
    expect(await countUnplacedStock(colleague)).toBe(1);
  }, 60_000);

  it("never shows stock of another company", async () => {
    const one = await company();
    const other = await company();
    await place(one, "Rack 1");
    await place(other, "Rack 1");
    await product(one, "Tornillo", "40");
    await product(other, "Cable", "7");
    expect(await waiting(one)).toEqual(["Tornillo @ General: 40 piezas"]);
    expect(await waiting(other)).toEqual(["Cable @ General: 7 piezas"]);
    expect(await countUnplacedStock(one)).toBe(1);
    // Somebody of one company asking about the other is refused.
    await expect(
      listUnplacedStock({
        organizationId: other.organizationId,
        userId: one.userId,
      }),
    ).rejects.toThrow();
    await expect(
      countUnplacedStock({
        organizationId: other.organizationId,
        userId: one.userId,
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("refuses who has no permission to see stock", async () => {
    const owner = await company();
    await place(owner, "Rack 1");
    await product(owner, "Tornillo", "40");
    const noRole = await member(owner.organizationId);
    await expect(listUnplacedStock(noRole)).rejects.toThrow();
    await expect(countUnplacedStock(noRole)).rejects.toThrow();
    // Every role of the warehouse reads stock: Consulta sees the list.
    const viewer = await member(owner.organizationId, "viewer");
    expect(await countUnplacedStock(viewer)).toBe(1);
  }, 60_000);

  it("refuses a company without the module", async () => {
    const owner = await company({ withoutPlan: true });
    await expect(listUnplacedStock(owner)).rejects.toThrow();
    await expect(countUnplacedStock(owner)).rejects.toThrow();
  }, 60_000);
});
