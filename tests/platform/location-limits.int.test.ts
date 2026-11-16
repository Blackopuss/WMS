import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import {
  createProduct,
  getProduct,
  unitVolumeOf,
  unitWeightOf,
  updateProduct,
} from "@/platform/catalog";
import { changeStockStatus, registerEntry } from "@/modules/inventory";
import {
  createLocation,
  editLocation,
  getDefaultLocation,
  moveLocation,
  listLocations,
  setLocationLimits,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-22B (ADR 0039): what a location may hold and admit is configured per
// location, by who may change locations, inside their own company; and a
// product may say what one unit weighs and takes.

const stamp = Date.now();
let counter = 0;
let staff = "";

type Actor = { organizationId: string; userId: string };

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `limites.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<Actor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa límites ${++counter}`,
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
      productLimit: 30,
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de capacidad",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(organizationId: string, role: Role): Promise<Actor> {
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
  actor: Actor,
  sku: string,
  extra: { category?: string; unit?: string } = {},
) {
  const made = await createProduct(actor, {
    sku,
    name: `Producto ${sku}`,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

async function shelf(actor: Actor, name: string) {
  const made = await createLocation(actor, { level: 3, name });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

const nodeOf = async (actor: Actor, locationId: string) =>
  (await listLocations(actor))!.locations.find(
    (location) => location.id === locationId,
  )!;

let one: Actor;
let other: Actor;

beforeAll(async () => {
  one = await company();
  other = await company();
}, 60_000);

afterAll(() => db.$disconnect());

describe("capacity and restrictions of a location", () => {
  it("are saved, shown in the tree and recorded in the audit log", async () => {
    const place = await shelf(one, "Estante con límites");
    const bolt = await product(one, "LIM-1", { category: "Tornillería" });
    await product(one, "LIM-2", { category: "Químicos" });
    const category = await db.productCategory.findFirstOrThrow({
      where: { organizationId: one.organizationId, name: "Químicos" },
    });

    expect(await nodeOf(one, place)).toMatchObject({
      capacity: { units: null, weight: null, volume: null },
      restrictedTo: { products: [], categories: [] },
    });
    expect(
      await setLocationLimits(one, place, {
        maxUnits: "1,500",
        maxWeight: "250.5",
        maxVolume: "",
        // Capitals do not matter; neither do repeats or empty lines.
        products: "lim-1\n\nLIM-1\n",
        categoryIds: [category.id],
      }),
    ).toMatchObject({ ok: true });
    expect(await nodeOf(one, place)).toMatchObject({
      capacity: { units: "1500", weight: "250.5", volume: null },
      restrictedTo: {
        products: [{ id: bolt, sku: "LIM-1" }],
        categories: [{ id: category.id, name: "Químicos" }],
      },
    });

    // The same again changes nothing and says so.
    expect(
      await setLocationLimits(one, place, {
        maxUnits: "1500",
        maxWeight: "250.500",
        products: "LIM-1",
        categoryIds: [category.id],
      }),
    ).toMatchObject({ ok: false, reason: "unchanged" });

    // Emptying everything removes the limits.
    expect(await setLocationLimits(one, place, {})).toMatchObject({ ok: true });
    expect(await nodeOf(one, place)).toMatchObject({
      capacity: { units: null, weight: null, volume: null },
      restrictedTo: { products: [], categories: [] },
    });
    expect(
      await db.locationCapacity.count({ where: { locationId: place } }),
    ).toBe(0);
    expect(
      await db.locationRestriction.count({ where: { locationId: place } }),
    ).toBe(0);

    const trail = await listAuditTrail(one.organizationId, { limit: 20 });
    const changes = trail.filter(
      (entry) => entry.action === "location.limits_changed",
    );
    expect(changes).toHaveLength(2);
    // Newest first: the removal, then the first setting.
    expect(changes[0]?.facts).toEqual([
      "Ubicación: Estante con límites",
      "Capacidad: 1,500 unidades · 250.5 kg → Sin límite",
      "Solo admite: Categorías: Químicos. Productos: LIM-1 → Cualquier producto",
    ]);
    expect(changes[1]?.facts).toContain(
      "Capacidad: Sin límite → 1,500 unidades · 250.5 kg",
    );
    expect(changes[1]?.label).toBe(
      "Cambió la capacidad o las restricciones de una ubicación",
    );
  });

  it("a new location may be created with them", async () => {
    await product(one, "LIM-3");
    const made = await createLocation(one, {
      level: 3,
      name: "Estante nuevo con capacidad",
      limits: { maxUnits: "40", products: "LIM-3" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await nodeOf(one, made.locationId)).toMatchObject({
      capacity: { units: "40" },
      restrictedTo: { products: [{ sku: "LIM-3" }] },
    });

    // A problem in them creates nothing.
    const before = await db.location.count({
      where: { organizationId: one.organizationId },
    });
    expect(
      await createLocation(one, {
        level: 3,
        name: "Estante que no nace",
        limits: { maxWeight: "mucho" },
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: { maxWeight: expect.stringContaining("mayor que cero") },
    });
    expect(
      await db.location.count({
        where: { organizationId: one.organizationId },
      }),
    ).toBe(before);
  });

  it("rejects what is not a limit, each in its field", async () => {
    const place = await shelf(one, "Estante de validación");
    for (const [field, value, message] of [
      ["maxUnits", "0", "mayor que cero"],
      ["maxUnits", "-5", "mayor que cero"],
      ["maxWeight", "1.23456", "3 decimales"],
      ["maxVolume", "abc", "mayor que cero"],
      ["maxUnits", "9999999999999", "demasiado grande"],
    ] as const) {
      expect(
        await setLocationLimits(one, place, { [field]: value }),
      ).toMatchObject({
        ok: false,
        reason: "invalid",
        fieldErrors: { [field]: expect.stringContaining(message) },
      });
    }
    expect(
      await setLocationLimits(one, place, { products: "NO-EXISTE\nTAMPOCO" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        products: expect.stringContaining("NO-EXISTE, TAMPOCO"),
      },
    });
    expect(
      await setLocationLimits(one, place, { categoryIds: [newId()] }),
    ).toMatchObject({
      ok: false,
      reason: "not_found",
      fieldErrors: { categoryIds: expect.any(String) },
    });
    expect(
      await db.locationCapacity.count({ where: { locationId: place } }),
    ).toBe(0);
  });

  it("«General» takes neither capacity nor restrictions", async () => {
    const general = (await getDefaultLocation(one))!.id;
    expect(
      await setLocationLimits(one, general, { maxUnits: "10" }),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
      formError: expect.stringContaining("General"),
    });
  });

  it("only who may change locations sets them", async () => {
    const place = await shelf(one, "Estante de permisos");
    const operator = await member(one.organizationId, "operator");
    await expect(
      setLocationLimits(operator, place, { maxUnits: "10" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    const warehouse = await member(one.organizationId, "administrator");
    expect(
      await setLocationLimits(warehouse, place, { maxUnits: "10" }),
    ).toMatchObject({ ok: true });
  });

  it("never reaches another company: its locations, products or categories", async () => {
    const mine = await shelf(one, "Estante propio");
    const theirs = await shelf(other, "Estante ajeno");
    await product(other, "AJENO-1", { category: "Ajena" });
    const theirCategory = await db.productCategory.findFirstOrThrow({
      where: { organizationId: other.organizationId, name: "Ajena" },
    });

    // Their location does not exist for us.
    expect(
      await setLocationLimits(one, theirs, { maxUnits: "5" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // Nor their product code, nor their category.
    expect(
      await setLocationLimits(one, mine, { products: "AJENO-1" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { products: expect.any(String) },
    });
    expect(
      await setLocationLimits(one, mine, { categoryIds: [theirCategory.id] }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await db.locationCapacity.count({
        where: { organizationId: other.organizationId },
      }),
    ).toBe(0);
    expect(
      await db.locationRestriction.count({ where: { locationId: mine } }),
    ).toBe(0);

    // And what they set is theirs alone.
    expect(
      await setLocationLimits(other, theirs, { maxUnits: "7" }),
    ).toMatchObject({ ok: true });
    const tree = await listLocations(one);
    expect(tree!.locations.some((location) => location.id === theirs)).toBe(
      false,
    );
  });
});

describe("weight and volume of a product", () => {
  it("are optional, exact and kept with the card", async () => {
    const made = await createProduct(one, {
      sku: "PESO-1",
      name: "Caja de clavos",
      weight: "0.25",
      volume: "1,200.5",
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await getProduct(one, made.productId)).toMatchObject({
      unitWeight: "0.25",
      unitVolume: "1200.5",
    });

    // Not sending them keeps them; sending them empty clears them.
    expect(
      await updateProduct(one, made.productId, {
        sku: "PESO-1",
        name: "Caja de clavos de 1 kg",
      }),
    ).toMatchObject({ ok: true });
    expect(await getProduct(one, made.productId)).toMatchObject({
      unitWeight: "0.25",
      unitVolume: "1200.5",
    });
    expect(
      await updateProduct(one, made.productId, {
        sku: "PESO-1",
        name: "Caja de clavos de 1 kg",
        weight: "",
        volume: "3",
      }),
    ).toMatchObject({ ok: true });
    expect(await getProduct(one, made.productId)).toMatchObject({
      unitWeight: null,
      unitVolume: "3",
    });
  });

  it("rejects what is not a weight, in its field", async () => {
    for (const [field, value] of [
      ["weight", "0"],
      ["weight", "-1"],
      ["volume", "pesado"],
      ["weight", "0.1234567"],
    ] as const) {
      expect(
        await createProduct(one, {
          sku: `PESO-MAL-${field}-${value}`,
          name: "No nace",
          [field]: value,
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid",
        fieldErrors: { [field]: expect.any(String) },
      });
    }
  });

  it("a product controlled by weight or by volume already says it", async () => {
    const byWeight = await createProduct(one, {
      sku: "PESO-KG",
      name: "Arena",
      unit: "g",
      // Ignored: its unit says what one gram weighs.
      weight: "5",
    });
    if (!byWeight.ok) throw new Error(JSON.stringify(byWeight));
    const sand = await db.product.findUniqueOrThrow({
      where: { id: byWeight.productId },
    });
    expect(sand.unitWeight).toBeNull();
    expect(unitWeightOf(sand)?.toString()).toBe("0.001");
    expect(unitVolumeOf(sand)).toBeNull();

    const byVolume = await createProduct(one, {
      sku: "PESO-L",
      name: "Aceite",
      unit: "l",
      weight: "0.92",
    });
    if (!byVolume.ok) throw new Error(JSON.stringify(byVolume));
    const oil = await db.product.findUniqueOrThrow({
      where: { id: byVolume.productId },
    });
    expect(unitVolumeOf(oil)?.toString()).toBe("1");
    expect(unitWeightOf(oil)?.toString()).toBe("0.92");
  });
});

describe("a use that takes nothing available (WMS-75 review)", () => {
  async function enter(actor: Actor, productId: string, locationId: string) {
    const done = await registerEntry(actor, {
      productId,
      locationId,
      quantity: "3",
      acceptRepeat: true,
      acceptCapacity: true,
    });
    if (!done.ok) throw new Error(JSON.stringify(done));
  }

  it("a place, or a zone with something inside, with available stock does not become quarantine or restoration", async () => {
    const actor = await company();
    for (const type of ["QUARANTINE", "REPAIR"] as const) {
      const n = ++counter;
      const item = await product(actor, `USO-${n}`);
      // Available right there.
      const bench = await shelf(actor, `Banco ${n}`);
      await enter(actor, item, bench);
      expect(await editLocation(actor, bench, { type })).toMatchObject({
        ok: false,
        reason: "not_allowed",
        fieldErrors: {
          type: expect.stringMatching(
            /existencias disponibles de un producto.*Cámbialas de estado o muévelas antes/,
          ),
        },
      });
      // Available inside: the zone does not change either.
      const zone = await createLocation(actor, { level: 1, name: `Zona ${n}` });
      if (!zone.ok) throw new Error(JSON.stringify(zone));
      const inner = await createLocation(actor, {
        level: 3,
        name: `Estante ${n}`,
        parentId: zone.locationId,
      });
      if (!inner.ok) throw new Error(JSON.stringify(inner));
      await enter(actor, item, inner.locationId);
      expect(
        await editLocation(actor, zone.locationId, { type }),
      ).toMatchObject({ ok: false, reason: "not_allowed" });
      // Once it is not available, it may.
      const changed = await changeStockStatus(actor, {
        productId: item,
        locationId: bench,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "3",
        reason: "Golpeado",
        idempotencyKey: newId(),
      });
      expect(changed).toMatchObject({ ok: true });
      expect(await editLocation(actor, bench, { type })).toMatchObject({
        ok: true,
      });
      // An empty place may too.
      const empty = await shelf(actor, `Vacío ${n}`);
      expect(await editLocation(actor, empty, { type })).toMatchObject({
        ok: true,
      });
      expect(
        (await db.location.findUniqueOrThrow({ where: { id: bench } })).type,
      ).toBe(type);
    }
  }, 60_000);

  const available = async (locationId: string) =>
    (
      await db.stockBalance.aggregate({
        where: { locationId, status: "AVAILABLE" },
        _sum: { quantity: true },
      })
    )._sum.quantity?.toString() ?? "0";

  async function zoneWithShelf(actor: Actor, n: number) {
    const zone = await createLocation(actor, { level: 1, name: `Z${n}` });
    if (!zone.ok) throw new Error(JSON.stringify(zone));
    const inner = await createLocation(actor, {
      level: 3,
      name: `E${n}`,
      parentId: zone.locationId,
    });
    if (!inner.ok) throw new Error(JSON.stringify(inner));
    return { zone: zone.locationId, shelf: inner.locationId };
  }

  it("a place with available stock does not move under one; an empty one does", async () => {
    const actor = await company();
    const n = ++counter;
    const item = await product(actor, `MOV-${n}`);
    const bench = await createLocation(actor, {
      level: 1,
      name: `Taller ${n}`,
      type: "REPAIR",
    });
    if (!bench.ok) throw new Error(JSON.stringify(bench));
    const aisle = await createLocation(actor, { level: 2, name: `P${n}` });
    if (!aisle.ok) throw new Error(JSON.stringify(aisle));
    const inner = await createLocation(actor, {
      level: 3,
      name: `E${n}`,
      parentId: aisle.locationId,
    });
    if (!inner.ok) throw new Error(JSON.stringify(inner));
    await enter(actor, item, inner.locationId);
    expect(
      await moveLocation(actor, aisle.locationId, {
        parentId: bench.locationId,
      }),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
      fieldErrors: { parentId: expect.stringMatching(/de restauración/) },
    });
    const empty = await createLocation(actor, { level: 2, name: `V${n}` });
    if (!empty.ok) throw new Error(JSON.stringify(empty));
    expect(
      await moveLocation(actor, empty.locationId, {
        parentId: bench.locationId,
      }),
    ).toMatchObject({ ok: true });
    expect(await available(inner.locationId)).toBe("3");
  }, 60_000);

  it("changing the use while stock arrives never deadlocks nor leaves anything available inside", async () => {
    const actor = await company();
    const item = await product(actor, `CON-${++counter}`);
    for (let round = 0; round < 8; round++) {
      const n = ++counter;
      const { zone, shelf } = await zoneWithShelf(actor, n);
      // Something not available already there, to release in some rounds.
      await enter(actor, item, shelf);
      await changeStockStatus(actor, {
        productId: item,
        locationId: shelf,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "3",
        reason: "Golpeado",
        idempotencyKey: newId(),
      });
      const arrival =
        round % 2 === 0
          ? registerEntry(actor, {
              productId: item,
              locationId: shelf,
              quantity: "2",
              acceptRepeat: true,
              acceptCapacity: true,
            })
          : changeStockStatus(actor, {
              productId: item,
              locationId: shelf,
              from: "DAMAGED",
              to: "AVAILABLE",
              quantity: "1",
              reason: "Estaba bien",
              idempotencyKey: newId(),
            });
      const [edited, arrived] = await Promise.all([
        editLocation(actor, zone, {
          type: round % 4 < 2 ? "REPAIR" : "QUARANTINE",
        }),
        arrival,
      ]);
      // Exactly one of the two went through.
      expect([edited.ok, arrived.ok].filter(Boolean)).toHaveLength(1);
      if (edited.ok) expect(await available(shelf)).toBe("0");
    }
  }, 120_000);

  it("moving under one while stock arrives never deadlocks nor leaves anything available inside", async () => {
    const actor = await company();
    const item = await product(actor, `CMV-${++counter}`);
    const bench = await createLocation(actor, {
      level: 1,
      name: `Taller ${++counter}`,
      type: "QUARANTINE",
    });
    if (!bench.ok) throw new Error(JSON.stringify(bench));
    for (let round = 0; round < 6; round++) {
      const n = ++counter;
      const aisle = await createLocation(actor, { level: 2, name: `P${n}` });
      if (!aisle.ok) throw new Error(JSON.stringify(aisle));
      const inner = await createLocation(actor, {
        level: 3,
        name: `E${n}`,
        parentId: aisle.locationId,
      });
      if (!inner.ok) throw new Error(JSON.stringify(inner));
      const [moved, arrived] = await Promise.all([
        moveLocation(actor, aisle.locationId, { parentId: bench.locationId }),
        registerEntry(actor, {
          productId: item,
          locationId: inner.locationId,
          quantity: "2",
          acceptRepeat: true,
          acceptCapacity: true,
        }),
      ]);
      expect([moved.ok, arrived.ok].filter(Boolean)).toHaveLength(1);
      if (moved.ok) expect(await available(inner.locationId)).toBe("0");
    }
  }, 120_000);
});
