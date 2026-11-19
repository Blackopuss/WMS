import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  STOCK_STATUS_FILTER_OPTIONS,
  changeStockStatus,
  chosenStockStatus,
  productsInStatusWhere,
  registerEntry,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct, listProducts } from "@/platform/catalog";
import { createLocation } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-87: the «Estado de las existencias» filter of the product list
// (INV-12): a value of the address counts only if it is a state; the
// condition is built by Inventario inside the person's warehouse and
// scope, and the catalog cuts the page in the database.

const stamp = Date.now();
let counter = 0;

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `filtro-estado.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function setup() {
  const userId = await newUser();
  const created = await createOrganization(userId, {
    name: `Filtro ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser();
  await db.platformStaff.create({ data: { userId: staff } });
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba del filtro por estado",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId };
}

afterAll(() => db.$disconnect());

describe("filter of the list by the state of the stock (WMS-87)", () => {
  it("only a state is a value; the list is cut by the products with stock in it, inside the zone of the person", async () => {
    const owner: InventoryActor = await setup();
    const zoneOne = await createLocation(owner, { level: 1, name: "Zona 1" });
    const zoneTwo = await createLocation(owner, { level: 1, name: "Zona 2" });
    if (!zoneOne.ok || !zoneTwo.ok) throw new Error("zones");
    const shelfOne = await createLocation(owner, {
      level: 3,
      name: "Estante 1",
      parentId: zoneOne.locationId,
    });
    const shelfTwo = await createLocation(owner, {
      level: 3,
      name: "Estante 2",
      parentId: zoneTwo.locationId,
    });
    if (!shelfOne.ok || !shelfTwo.ok) throw new Error("shelves");

    const make = async (sku: string) => {
      const made = await createProduct(owner, { sku, name: `Prod ${sku}` });
      if (!made.ok) throw new Error(JSON.stringify(made));
      return made.productId;
    };
    const [one, two, three] = [
      await make("FE-1"),
      await make("FE-2"),
      await make("FE-3"),
    ];
    const enter = async (productId: string, locationId: string) => {
      const done = await registerEntry(owner, {
        productId,
        locationId,
        quantity: "5",
        unitCost: "10",
        acceptRepeat: true,
        acceptCapacity: true,
      });
      if (!done.ok) throw new Error(JSON.stringify(done));
    };
    await enter(one, shelfOne.locationId);
    await enter(two, shelfTwo.locationId);
    await enter(three, shelfOne.locationId);
    const damage = async (productId: string, locationId: string) => {
      const done = await changeStockStatus(owner, {
        productId,
        locationId,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "2",
        reason: "Golpeado",
        idempotencyKey: newId(),
      });
      if (!done.ok) throw new Error(JSON.stringify(done));
    };
    await damage(one, shelfOne.locationId);
    await damage(two, shelfTwo.locationId);

    // Only a state counts as a filter value.
    expect(chosenStockStatus("DAMAGED")).toBe("DAMAGED");
    expect(chosenStockStatus("daño")).toBeNull();
    expect(chosenStockStatus(["DAMAGED"])).toBeNull();
    expect(chosenStockStatus(undefined)).toBeNull();
    expect(STOCK_STATUS_FILTER_OPTIONS.map((option) => option.id)).toContain(
      "REPAIR",
    );

    const skus = async (actor: InventoryActor, status: "DAMAGED" | "REPAIR") =>
      (
        await listProducts(actor, {
          also: await productsInStatusWhere(actor, status),
        })
      ).items
        .map((item) => item.sku)
        .sort();
    expect(await skus(owner, "DAMAGED")).toEqual(["FE-1", "FE-2"]);
    expect(await skus(owner, "REPAIR")).toEqual([]);
    // Combined with the search and counted by the database.
    const searched = await listProducts(owner, {
      search: "FE-2",
      also: await productsInStatusWhere(owner, "DAMAGED"),
    });
    expect(searched).toMatchObject({ total: 1, items: [{ sku: "FE-2" }] });
    expect(
      await listProducts(owner, {
        pageSize: 1,
        also: await productsInStatusWhere(owner, "DAMAGED"),
      }),
    ).toMatchObject({ total: 2, pageCount: 2 });

    // Someone limited to Zona 1 only finds what is in it.
    const zonedUser = await newUser();
    const membership = await db.membership.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        userId: zonedUser,
      },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        membershipId: membership.id,
        role: "administrator",
      },
    });
    const facility = await db.facility.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: zonedUser,
      facilities: [{ facilityId: facility.id, zoneIds: [zoneOne.locationId] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const zoned = { organizationId: owner.organizationId, userId: zonedUser };
    expect(await skus(zoned, "DAMAGED")).toEqual(["FE-1"]);
  }, 60_000);
});
