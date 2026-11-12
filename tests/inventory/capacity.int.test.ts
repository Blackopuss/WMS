import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CAPACITY_MODE,
  IMPORT_COLUMNS,
  acceptTask,
  applyImport,
  changeStockStatus,
  confirmImport,
  createTask,
  deliverTask,
  getLocationOccupancy,
  listImportFailures,
  pickUpTask,
  reconcileStock,
  registerEntry,
  registerExit,
  registerInitialBalance,
  registerTransfer,
  reverseMovement,
  saveImportMapping,
  startImport,
  type ImportColumnKey,
  type InventoryActor,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { invalidateEntitlements } from "@/platform/entitlements";
import { buildCsv } from "@/platform/files";
import {
  createLocation,
  editLocation,
  getActiveFacility,
  getDefaultLocation,
  setLocationLimits,
  type LocationLimitsInput,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-22B (ADR 0039): what brings stock into a location asks first whether
// it may go there (restrictions always stop) and whether it fits (the
// company decides: warn or block). PC-11: a node adds its descendants once.

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `capacidad.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory"],
): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa capacidad ${++counter}`,
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
      reason: "Prueba de capacidad",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(organizationId: string): Promise<InventoryActor> {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: {
      id: newId(),
      organizationId,
      membershipId: membership.id,
      role: "administrator",
    },
  });
  return { organizationId, userId };
}

async function product(
  actor: InventoryActor,
  extra: {
    name?: string;
    category?: string;
    unit?: string;
    weight?: string;
    volume?: string;
  } = {},
) {
  const sku = `CAP-${++counter}`;
  const made = await createProduct(actor, {
    sku,
    name: extra.name ?? `Producto ${sku}`,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

/** A location: level 1 = zone, 2 = aisle, 3 = shelf (the default levels). */
async function place(
  actor: InventoryActor,
  name: string,
  options: {
    level?: number;
    parentId?: string;
    type?: string;
    limits?: LocationLimitsInput;
  } = {},
) {
  const made = await createLocation(actor, {
    level: options.level ?? 3,
    name,
    parentId: options.parentId,
    type: options.type,
    limits: options.limits,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

async function setMode(actor: InventoryActor, mode: "warn" | "block") {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    CAPACITY_MODE.key,
    mode,
  );
  if (!result.ok) throw new Error(result.error);
}

/** What a location holds of a product, every state added up. */
async function stockAt(locationId: string, productId?: string) {
  const rows = await db.stockBalance.findMany({
    where: { locationId, ...(productId ? { productId } : {}) },
    select: { quantity: true },
  });
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

const movements = (actor: InventoryActor) =>
  db.stockMovement.count({ where: { organizationId: actor.organizationId } });

const key = () => `cap-${newId()}`;

/** An entry that must go through, whatever warning it meets. */
async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    // Fixtures repeat entries on purpose (WMS-71) and may fill a place.
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.movementId;
}

beforeEach(async () => {
  await db.job.deleteMany({});
});

afterAll(async () => {
  invalidateEntitlements();
  await db.$disconnect();
});

describe("capacity in units", () => {
  it("warns: without acceptance nothing is written, with it the entry goes in", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const shelf = await place(actor, "Estante 100", {
      limits: { maxUnits: "100" },
    });

    // Up to the capacity, nothing to say.
    expect(
      await registerEntry(actor, {
        productId: bolt,
        locationId: shelf,
        quantity: "80",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(actor, {
        productId: bolt,
        locationId: shelf,
        quantity: "20",
      }),
    ).toMatchObject({ ok: true });

    // One more does not fit: it asks, and writes nothing.
    const before = await movements(actor);
    const asked = await registerEntry(actor, {
      productId: bolt,
      locationId: shelf,
      quantity: "5",
      idempotencyKey: key(),
    });
    expect(asked).toEqual({
      ok: false,
      reason: "over_capacity",
      fieldErrors: {},
      formError:
        "Con esto, «Estante 100» tendría 105 unidades y su capacidad es de 100 unidades.",
    });
    expect(await stockAt(shelf)).toBe(100);
    expect(await movements(actor)).toBe(before);

    // Accepted: it is registered, and the answer says where it stands.
    const accepted = await registerEntry(actor, {
      productId: bolt,
      locationId: shelf,
      quantity: "5",
      acceptCapacity: true,
    });
    expect(accepted).toMatchObject({
      ok: true,
      summary: expect.stringContaining(
        "«Estante 100» quedó por encima de su capacidad: 105 de 100 unidades.",
      ),
    });
    expect(await stockAt(shelf)).toBe(105);
    expect(await movements(actor)).toBe(before + 1);

    // An exit never asks: it makes room.
    expect(
      await registerExit(actor, {
        productId: bolt,
        locationId: shelf,
        quantity: "10",
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("blocks when the company chose so, even if someone accepts", async () => {
    const actor = await company();
    const other = await company();
    const bolt = await product(actor);
    const shelf = await place(actor, "Estante 10", {
      limits: { maxUnits: "10" },
    });
    await setMode(actor, "block");

    for (const acceptCapacity of [false, true]) {
      expect(
        await registerEntry(actor, {
          productId: bolt,
          locationId: shelf,
          quantity: "11",
          acceptCapacity,
        }),
      ).toEqual({
        ok: false,
        reason: "not_allowed",
        fieldErrors: {
          locationId:
            "Con esto, «Estante 10» tendría 11 unidades y su capacidad es de 10 unidades. Elige otra ubicación o una cantidad menor.",
        },
        formError: undefined,
      });
    }
    expect(await stockAt(shelf)).toBe(0);
    expect(
      await registerEntry(actor, {
        productId: bolt,
        locationId: shelf,
        quantity: "10",
      }),
    ).toMatchObject({ ok: true });

    // The setting is of that company: another one still only warns.
    const theirs = await product(other);
    const theirShelf = await place(other, "Estante 10", {
      limits: { maxUnits: "10" },
    });
    expect(
      await registerEntry(other, {
        productId: theirs,
        locationId: theirShelf,
        quantity: "11",
      }),
    ).toMatchObject({ ok: false, reason: "over_capacity" });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("a relocation asks about where it goes, in both modes", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const source = await place(actor, "Origen");
    const target = await place(actor, "Destino 50", {
      limits: { maxUnits: "50" },
    });
    await enter(actor, bolt, source, "200");

    const move = (quantity: string, acceptCapacity = false) =>
      registerTransfer(actor, {
        productId: bolt,
        locationId: source,
        toLocationId: target,
        quantity,
        acceptCapacity,
      });
    expect(await move("50")).toMatchObject({ ok: true });
    expect(await move("1")).toMatchObject({
      ok: false,
      reason: "over_capacity",
      formError: expect.stringContaining("«Destino 50» tendría 51 unidades"),
    });
    expect(await stockAt(target)).toBe(50);
    expect(await move("1", true)).toMatchObject({
      ok: true,
      summary: expect.stringContaining("por encima de su capacidad"),
    });
    expect(await stockAt(target)).toBe(51);
    expect(await stockAt(source)).toBe(149);

    await setMode(actor, "block");
    expect(await move("1", true)).toMatchObject({
      ok: false,
      reason: "not_allowed",
      fieldErrors: {
        toLocationId: expect.stringContaining("Elige otra ubicación"),
      },
    });
    // Taking it back out is never a problem.
    expect(
      await registerTransfer(actor, {
        productId: bolt,
        locationId: target,
        toLocationId: source,
        quantity: "51",
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("an initial balance asks too", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const shelf = await place(actor, "Estante inicial", {
      limits: { maxUnits: "30" },
    });
    expect(
      await registerInitialBalance(actor, {
        productId: bolt,
        locationId: shelf,
        quantity: "31",
      }),
    ).toMatchObject({ ok: false, reason: "over_capacity" });
    expect(await stockAt(shelf)).toBe(0);
    expect(
      await registerInitialBalance(actor, {
        productId: bolt,
        locationId: shelf,
        quantity: "31",
        acceptCapacity: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await stockAt(shelf)).toBe(31);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("the capacity of a zone counts everything inside it; moving inside adds nothing", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const nut = await product(actor);
    const zone = await place(actor, "Zona 100", {
      level: 1,
      limits: { maxUnits: "100" },
    });
    const aisle = await place(actor, "Pasillo 1", { level: 2, parentId: zone });
    const a = await place(actor, "Estante A", { parentId: aisle });
    const b = await place(actor, "Estante B", { parentId: zone });
    const outside = await place(actor, "Estante fuera");
    await enter(actor, bolt, outside, "500");

    expect(
      await registerEntry(actor, {
        productId: bolt,
        locationId: a,
        quantity: "60",
      }),
    ).toMatchObject({ ok: true });
    // Another product, another shelf: the same zone.
    expect(
      await registerEntry(actor, {
        productId: nut,
        locationId: b,
        quantity: "41",
      }),
    ).toEqual({
      ok: false,
      reason: "over_capacity",
      fieldErrors: {},
      formError:
        "Con esto, «Zona 100» (donde está «Estante B») tendría 101 unidades y su capacidad es de 100 unidades.",
    });
    expect(
      await registerEntry(actor, {
        productId: nut,
        locationId: b,
        quantity: "40",
      }),
    ).toMatchObject({ ok: true });

    // Full. Moving between its shelves adds nothing to the zone…
    expect(
      await registerTransfer(actor, {
        productId: bolt,
        locationId: a,
        toLocationId: b,
        quantity: "60",
      }),
    ).toMatchObject({ ok: true });
    // …bringing more from outside does, to a shelf or to the zone itself.
    for (const toLocationId of [a, zone]) {
      expect(
        await registerTransfer(actor, {
          productId: bolt,
          locationId: outside,
          toLocationId,
          quantity: "1",
        }),
      ).toMatchObject({ ok: false, reason: "over_capacity" });
    }
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("two arrivals at once under the same limit are decided one after the other", async () => {
    const actor = await company();
    await setMode(actor, "block");
    const zone = await place(actor, "Zona justa", {
      level: 1,
      limits: { maxUnits: "100" },
    });
    const shelves = await Promise.all(
      [1, 2, 3, 4].map(async (n) => ({
        shelf: await place(actor, `Estante ${n}`, { parentId: zone }),
        productId: await product(actor),
      })),
    );
    // Four different products to four different shelves: nothing but the
    // capacity of the zone puts them in line. Only one of 60 fits in 100.
    const results = await Promise.all(
      shelves.map(({ shelf, productId }) =>
        registerEntry(actor, { productId, locationId: shelf, quantity: "60" }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.reason === "not_allowed"),
    ).toHaveLength(3);
    const held = await Promise.all(shelves.map(({ shelf }) => stockAt(shelf)));
    expect(held.reduce((sum, each) => sum + each, 0)).toBe(60);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("capacity in weight and volume", () => {
  it("weighs each product by its card; one without weight does not count", async () => {
    const actor = await company();
    const heavy = await product(actor, { weight: "2.5" });
    const unknown = await product(actor);
    const sand = await product(actor, { unit: "kg" });
    const shelf = await place(actor, "Estante 100 kg", {
      limits: { maxWeight: "100" },
    });

    // 30 × 2.5 kg = 75 kg.
    expect(
      await registerEntry(actor, {
        productId: heavy,
        locationId: shelf,
        quantity: "30",
      }),
    ).toMatchObject({ ok: true });
    // A product that does not say its weight adds nothing, however many.
    expect(
      await registerEntry(actor, {
        productId: unknown,
        locationId: shelf,
        quantity: "5000",
      }),
    ).toMatchObject({ ok: true });
    // One controlled in kilograms weighs what it measures: 75 + 20.5 fits…
    expect(
      await registerEntry(actor, {
        productId: sand,
        locationId: shelf,
        quantity: "20.5",
      }),
    ).toMatchObject({ ok: true });
    // …and 2 more of the heavy one (5 kg) do not: 100.5 kg.
    expect(
      await registerEntry(actor, {
        productId: heavy,
        locationId: shelf,
        quantity: "2",
      }),
    ).toEqual({
      ok: false,
      reason: "over_capacity",
      fieldErrors: {},
      formError:
        "Con esto, «Estante 100 kg» tendría 100.5 kg y su capacidad es de 100 kg.",
    });
    // Exactly to the limit is fine: 75 + 20.5 + 4.5 = 100.
    expect(
      await registerEntry(actor, {
        productId: sand,
        locationId: shelf,
        quantity: "4.5",
      }),
    ).toMatchObject({ ok: true });

    const report = await getLocationOccupancy(actor);
    expect(report.byLocation[shelf]).toEqual({
      units: "5055",
      weight: "100",
      volume: "0",
      unweighed: true,
      unsized: true,
      over: [],
    });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("volume: liters of the product against cubic meters of the location", async () => {
    const actor = await company();
    const box = await product(actor, { volume: "250" });
    const oil = await product(actor, { unit: "l" });
    const shelf = await place(actor, "Estante 1 m³", {
      limits: { maxVolume: "1", maxUnits: "1000" },
    });
    // 3 boxes of 250 L = 0.75 m³; 200 L of oil more = 0.95 m³.
    await registerEntry(actor, {
      productId: box,
      locationId: shelf,
      quantity: "3",
    });
    expect(
      await registerEntry(actor, {
        productId: oil,
        locationId: shelf,
        quantity: "200",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(actor, {
        productId: oil,
        locationId: shelf,
        quantity: "50.5",
      }),
    ).toMatchObject({
      ok: false,
      reason: "over_capacity",
      formError:
        "Con esto, «Estante 1 m³» tendría 1.0005 m³ y su capacidad es de 1 m³.",
    });
    expect((await getLocationOccupancy(actor)).byLocation[shelf]).toMatchObject(
      { units: "203", volume: "0.95", unsized: false, over: [] },
    );
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });
});

describe("restrictions always stop", () => {
  it("quarantine: nothing available goes in, and stock is released on its way out", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const normal = await place(actor, "Estante normal");
    const cage = await place(actor, "Jaula", { type: "QUARANTINE" });
    // A quarantine zone is quarantine with everything inside it.
    const zone = await place(actor, "Zona de cuarentena", {
      level: 1,
      type: "QUARANTINE",
    });
    const inside = await place(actor, "Estante interior", { parentId: zone });
    await enter(actor, bolt, normal, "100");
    // Whatever the company chose for capacity: this is not a warning.
    const refusal = {
      ok: false,
      reason: "not_allowed",
    } as const;

    // Available stock does not come in: not by an entry…
    expect(
      await registerEntry(actor, {
        productId: bolt,
        locationId: cage,
        quantity: "5",
        acceptCapacity: true,
      }),
    ).toEqual({
      ...refusal,
      fieldErrors: {
        locationId:
          "«Jaula» es de cuarentena: solo recibe existencias que no están disponibles.",
      },
      formError: undefined,
    });
    // …nor by a relocation, to it or to what a quarantine zone holds.
    expect(
      await registerTransfer(actor, {
        productId: bolt,
        locationId: normal,
        toLocationId: cage,
        quantity: "5",
      }),
    ).toMatchObject({
      ...refusal,
      fieldErrors: { toLocationId: expect.any(String) },
    });
    expect(
      await registerTransfer(actor, {
        productId: bolt,
        locationId: normal,
        toLocationId: inside,
        quantity: "5",
      }),
    ).toMatchObject({
      ...refusal,
      fieldErrors: {
        toLocationId:
          "«Estante interior» está dentro de «Zona de cuarentena», que es de cuarentena: solo recibe existencias que no están disponibles.",
      },
    });
    expect(await stockAt(cage)).toBe(0);
    expect(await stockAt(inside)).toBe(0);

    // What is not available does: put in quarantine and taken there.
    const quarantined = await changeStockStatus(actor, {
      productId: bolt,
      locationId: normal,
      from: "AVAILABLE",
      to: "QUARANTINE",
      toLocationId: cage,
      quantity: "30",
      reason: "Llegó con el empaque abierto",
      idempotencyKey: key(),
    });
    expect(quarantined).toMatchObject({
      ok: true,
      summary:
        "30 piezas de " +
        (await db.product.findUniqueOrThrow({ where: { id: bolt } })).name +
        " pasaron de Disponible en Estante normal a En cuarentena en Jaula.",
    });
    expect(
      await db.stockBalance.findMany({
        where: { productId: bolt, quantity: { gt: 0 } },
        orderBy: { quantity: "asc" },
        select: { locationId: true, status: true, quantity: true },
      }),
    ).toMatchObject([
      { locationId: cage, status: "QUARANTINE" },
      { locationId: normal, status: "AVAILABLE" },
    ]);
    expect(await stockAt(cage)).toBe(30);
    expect(await stockAt(normal)).toBe(70);

    // Between states that are not available, inside the cage: fine.
    expect(
      await changeStockStatus(actor, {
        productId: bolt,
        locationId: cage,
        from: "QUARANTINE",
        to: "INSPECTION",
        quantity: "10",
        reason: "Calidad lo está revisando",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });

    // Released right there it would be available stock in quarantine: no.
    expect(
      await changeStockStatus(actor, {
        productId: bolt,
        locationId: cage,
        from: "QUARANTINE",
        to: "AVAILABLE",
        quantity: "20",
        reason: "Calidad lo liberó",
        idempotencyKey: key(),
      }),
    ).toEqual({
      ...refusal,
      fieldErrors: {
        to: "«Jaula» es de cuarentena: solo recibe existencias que no están disponibles. Para liberarlas, elige también dónde quedan.",
      },
      formError: undefined,
    });
    // Released on its way out: one movement, both changes.
    const before = await movements(actor);
    expect(
      await changeStockStatus(actor, {
        productId: bolt,
        locationId: cage,
        from: "QUARANTINE",
        to: "AVAILABLE",
        toLocationId: normal,
        quantity: "20",
        reason: "Calidad lo liberó",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await movements(actor)).toBe(before + 1);
    expect(await stockAt(cage)).toBe(10);
    expect(await stockAt(normal)).toBe(90);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("a change of state that also moves is retried once and reversed whole", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const normal = await place(actor, "Estante normal");
    const cage = await place(actor, "Jaula", { type: "QUARANTINE" });
    const elsewhere = await place(actor, "Otro estante");
    await enter(actor, bolt, normal, "40");
    const idempotencyKey = key();
    const change = {
      productId: bolt,
      locationId: normal,
      from: "AVAILABLE",
      to: "DAMAGED",
      toLocationId: cage,
      quantity: "15",
      reason: "Se cayó la tarima",
      idempotencyKey,
    };
    const first = await changeStockStatus(actor, change);
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(await changeStockStatus(actor, change)).toMatchObject({
      ok: true,
      repeated: true,
      movementId: first.movementId,
    });
    // The same key for another destination is not a retry.
    expect(
      await changeStockStatus(actor, { ...change, toLocationId: elsewhere }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await stockAt(cage)).toBe(15);

    // Reversing it brings it back available to where it was: allowed there.
    expect(
      await reverseMovement(actor, {
        movementId: first.movementId,
        reason: "No estaba dañado",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await stockAt(cage)).toBe(0);
    expect(await stockAt(normal)).toBe(40);

    // Only someone who may relocate may also move it.
    const other = await company();
    await expect(
      changeStockStatus(other, { ...change, idempotencyKey: key() }),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("a location limited to products or categories takes nothing else, nor does what it holds", async () => {
    const actor = await company();
    const allowed = await product(actor, { name: "Tornillo" });
    const chemical = await product(actor, {
      name: "Solvente",
      category: "Químicos",
    });
    const paint = await product(actor, {
      name: "Pintura",
      category: "Pinturas",
    });
    const category = await db.productCategory.findFirstOrThrow({
      where: { organizationId: actor.organizationId, name: "Químicos" },
    });
    const general = (await getDefaultLocation(actor))!.id;
    const sku = (id: string) =>
      db.product.findUniqueOrThrow({ where: { id } }).then((row) => row.sku);

    const onlyBolt = await place(actor, "Solo tornillo", {
      limits: { products: await sku(allowed) },
    });
    const zone = await place(actor, "Zona de químicos", {
      level: 1,
      limits: { categoryIds: [category.id] },
    });
    const shelf = await place(actor, "Estante Q1", { parentId: zone });
    const shelf2 = await place(actor, "Estante Q2", { parentId: zone });

    // By product.
    expect(
      await registerEntry(actor, {
        productId: allowed,
        locationId: onlyBolt,
        quantity: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(actor, {
        productId: paint,
        locationId: onlyBolt,
        quantity: "5",
        acceptCapacity: true,
      }),
    ).toEqual({
      ok: false,
      reason: "not_allowed",
      fieldErrors: {
        locationId:
          "«Solo tornillo» solo admite ciertos productos: Pintura no está entre ellos.",
      },
      formError: undefined,
    });

    // By category, for everything the zone holds.
    expect(
      await registerEntry(actor, {
        productId: chemical,
        locationId: shelf,
        quantity: "8",
      }),
    ).toMatchObject({ ok: true });
    await enter(actor, paint, general, "20");
    expect(
      await registerTransfer(actor, {
        productId: paint,
        locationId: general,
        toLocationId: shelf,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
      fieldErrors: {
        toLocationId:
          "«Estante Q1» está dentro de «Zona de químicos», que solo admite ciertos productos: Pintura no está entre ellos.",
      },
    });
    // A product without category is not of that category either.
    expect(
      await registerInitialBalance(actor, {
        productId: allowed,
        locationId: zone,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await stockAt(shelf, paint)).toBe(0);

    // What was already inside before the rule moves within the zone (it
    // enters nothing new) and may leave; it does not come back.
    await setLocationLimits(actor, zone, {});
    await registerTransfer(actor, {
      productId: paint,
      locationId: general,
      toLocationId: shelf,
      quantity: "4",
    });
    await setLocationLimits(actor, zone, { categoryIds: [category.id] });
    expect(
      await registerTransfer(actor, {
        productId: paint,
        locationId: shelf,
        toLocationId: shelf2,
        quantity: "4",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerTransfer(actor, {
        productId: paint,
        locationId: shelf2,
        toLocationId: general,
        quantity: "4",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerTransfer(actor, {
        productId: paint,
        locationId: general,
        toLocationId: shelf2,
        quantity: "4",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });
});

describe("the other operations that bring stock in", () => {
  it("a purchase receipt warns for all its lines together, or is blocked", async () => {
    const actor = await company(["inventory", "purchasing"]);
    const bolt = await product(actor);
    const nut = await product(actor);
    const shelf = await place(actor, "Estante de recibo", {
      limits: { maxUnits: "10" },
    });
    const cage = await place(actor, "Jaula", { type: "QUARANTINE" });
    const supplier = await createSupplier(actor, { name: "Proveedor" });
    if (!supplier.ok) throw new Error("supplier setup failed");
    const order = await createPurchaseOrder(actor, {
      supplierId: supplier.supplierId,
    });
    if (!order.ok) throw new Error("order setup failed");
    for (const productId of [bolt, nut]) {
      const added = await addOrderLine(actor, order.orderId, {
        productId,
        capture: "base",
        quantity: "6",
      });
      if (!added.ok) throw new Error(JSON.stringify(added));
    }
    const sent = await submitPurchaseOrder(actor, order.orderId);
    if (!sent.ok) throw new Error("submit failed");
    const receipts = () =>
      db.purchaseReceipt.count({ where: { orderId: order.orderId } });

    // A restriction is a refusal, on the line that breaks it.
    const lines = await db.purchaseOrderLine.findMany({
      where: { orderId: order.orderId },
      orderBy: { lineNumber: "asc" },
    });
    expect(
      await receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey: key(),
        locationId: shelf,
        acceptCapacity: true,
        lines: [
          { orderLineId: lines[0]!.id, quantity: "1" },
          { orderLineId: lines[1]!.id, quantity: "1", locationId: cage },
        ],
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      lineErrors: {
        [lines[1]!.id]: expect.stringContaining("es de cuarentena"),
      },
    });

    // 6 + 6 in a shelf for 10: neither line alone goes over, together yes.
    const idempotencyKey = key();
    expect(
      await receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey,
        locationId: shelf,
      }),
    ).toEqual({
      ok: false,
      reason: "over_capacity",
      fieldErrors: {},
      formError:
        "Con esto, «Estante de recibo» tendría 12 unidades y su capacidad es de 10 unidades.",
    });
    expect(await receipts()).toBe(0);
    expect(await stockAt(shelf)).toBe(0);

    await setMode(actor, "block");
    expect(
      await receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey,
        locationId: shelf,
        acceptCapacity: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      formError: expect.stringContaining("Elige otra ubicación"),
    });
    expect(await receipts()).toBe(0);

    await setMode(actor, "warn");
    expect(
      await receivePurchaseOrder(actor, order.orderId, {
        idempotencyKey,
        locationId: shelf,
        acceptCapacity: true,
      }),
    ).toMatchObject({
      ok: true,
      status: "RECEIVED",
      summary: expect.stringContaining("por encima de su capacidad"),
    });
    expect(await receipts()).toBe(1);
    expect(await stockAt(shelf)).toBe(12);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("a transfer task asks when it is created; its delivery only reports", async () => {
    const actor = await company();
    const bolt = await product(actor);
    const paint = await product(actor, { name: "Pintura" });
    const source = await place(actor, "Origen");
    const target = await place(actor, "Destino 20", {
      limits: { maxUnits: "20" },
    });
    const cage = await place(actor, "Jaula", { type: "QUARANTINE" });
    await enter(actor, bolt, source, "100");
    await enter(actor, paint, source, "100");
    const tasks = () =>
      db.warehouseTask.count({
        where: { organizationId: actor.organizationId },
      });
    const task = (quantity: string, acceptCapacity = false, to = target) =>
      createTask(actor, {
        productId: bolt,
        fromLocationId: source,
        toLocationId: to,
        quantity,
        acceptCapacity,
      });

    // A restriction stops the task before anyone walks.
    expect(await task("5", true, cage)).toMatchObject({
      ok: false,
      reason: "not_allowed",
      fieldErrors: { toLocationId: expect.stringContaining("cuarentena") },
    });
    // Over the capacity: it asks; in block mode it refuses.
    expect(await task("21")).toMatchObject({
      ok: false,
      reason: "over_capacity",
      formError: expect.stringContaining("«Destino 20» tendría 21 unidades"),
    });
    await setMode(actor, "block");
    expect(await task("21", true)).toMatchObject({
      ok: false,
      reason: "not_allowed",
      fieldErrors: { toLocationId: expect.any(String) },
    });
    expect(await tasks()).toBe(0);

    // A task that fits is created; meanwhile the destination fills up.
    const created = await task("15");
    if (!created.ok) throw new Error(JSON.stringify(created));
    await setMode(actor, "warn");
    await enter(actor, paint, target, "10");
    await setMode(actor, "block");

    // The load is already there: the delivery goes through, and says it.
    expect(await acceptTask(actor, created.taskId)).toMatchObject({ ok: true });
    expect(await pickUpTask(actor, created.taskId)).toMatchObject({ ok: true });
    expect(await deliverTask(actor, created.taskId)).toMatchObject({
      ok: true,
      summary: expect.stringContaining(
        "«Destino 20» quedó por encima de su capacidad: 25 de 20 unidades.",
      ),
    });
    expect(await stockAt(target)).toBe(25);

    // A restriction set after the task was created still stops its delivery.
    const second = await createTask(actor, {
      productId: paint,
      fromLocationId: source,
      toLocationId: cage,
      quantity: "1",
    });
    expect(second).toMatchObject({ ok: false, reason: "not_allowed" });
    const plain = await place(actor, "Destino libre");
    const third = await createTask(actor, {
      productId: paint,
      fromLocationId: source,
      toLocationId: plain,
      quantity: "3",
    });
    if (!third.ok) throw new Error(JSON.stringify(third));
    expect(
      await editLocation(actor, plain, { type: "QUARANTINE" }),
    ).toMatchObject({ ok: true });
    await acceptTask(actor, third.taskId);
    await pickUpTask(actor, third.taskId);
    expect(await deliverTask(actor, third.taskId)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("es de cuarentena"),
    });
    expect(await stockAt(plain)).toBe(0);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("a reversal that puts stock back is not stopped by capacity, but by a restriction", async () => {
    const actor = await company();
    await setMode(actor, "block");
    const bolt = await product(actor, { name: "Tornillo" });
    const nut = await product(actor);
    const shelf = await place(actor, "Estante 10", {
      limits: { maxUnits: "10" },
    });
    const other = await place(actor, "Estante libre");
    await enter(actor, bolt, shelf, "10");
    const exit = await registerExit(actor, {
      productId: bolt,
      locationId: shelf,
      quantity: "6",
    });
    if (!exit.ok) throw new Error(JSON.stringify(exit));
    // The room it left is taken by something else.
    expect(
      await registerEntry(actor, {
        productId: nut,
        locationId: shelf,
        quantity: "6",
      }),
    ).toMatchObject({ ok: true });

    // The exit was a mistake: undoing it is not new stock.
    expect(
      await reverseMovement(actor, {
        movementId: exit.movementId,
        reason: "Se registró en el producto equivocado",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: true,
      summary: expect.stringContaining(
        "«Estante 10» quedó por encima de su capacidad: 16 de 10 unidades.",
      ),
    });
    expect(await stockAt(shelf)).toBe(16);

    // A relocation whose origin no longer admits the product cannot be undone.
    await enter(actor, bolt, other, "5");
    const move = await registerTransfer(actor, {
      productId: bolt,
      locationId: other,
      toLocationId: shelf,
      quantity: "5",
      acceptCapacity: true,
    });
    expect(move).toMatchObject({ ok: false, reason: "not_allowed" });
    await setMode(actor, "warn");
    const moved = await registerTransfer(actor, {
      productId: bolt,
      locationId: other,
      toLocationId: shelf,
      quantity: "5",
      acceptCapacity: true,
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    const nutSku = (await db.product.findUniqueOrThrow({ where: { id: nut } }))
      .sku;
    await setLocationLimits(actor, other, { products: nutSku });
    expect(
      await reverseMovement(actor, {
        movementId: moved.movementId,
        reason: "No debía moverse",
        idempotencyKey: key(),
      }),
    ).toEqual({
      ok: false,
      reason: "not_allowed",
      error:
        "No se puede reversar: «Estante libre» solo admite ciertos productos: Tornillo no está entre ellos.",
    });
    expect(await stockAt(other)).toBe(0);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });

  it("imported stock: a restriction fails that product whole; capacity is not asked", async () => {
    const actor = await company();
    const KEYS = IMPORT_COLUMNS.map((column) => column.key);
    const HEADERS = IMPORT_COLUMNS.map((column) => column.header);
    await product(actor, { category: "Químicos" });
    const category = await db.productCategory.findFirstOrThrow({
      where: { organizationId: actor.organizationId, name: "Químicos" },
    });
    await place(actor, "Jaula", { type: "QUARANTINE" });
    await place(actor, "Solo químicos", {
      limits: { categoryIds: [category.id], maxUnits: "5" },
    });
    const rows: Partial<Record<ImportColumnKey, string>>[] = [
      // Available stock to a quarantine location: no.
      {
        sku: "IMP-CUA",
        name: "A cuarentena",
        initialStock: "5",
        location: "Jaula",
      },
      // A new product of another category to a limited location: no.
      {
        sku: "IMP-PIN",
        name: "Pintura importada",
        category: "Pinturas",
        initialStock: "5",
        location: "Solo químicos",
      },
      // Of the right category, and well over the capacity: it enters.
      {
        sku: "IMP-QUI",
        name: "Solvente importado",
        category: "químicos",
        initialStock: "50",
        location: "Solo químicos",
      },
    ];
    const started = await startImport(actor, {
      name: "inventario.csv",
      bytes: buildCsv(
        [
          HEADERS,
          ...rows.map((line) =>
            KEYS.map((each) => line[each] ?? (each === "unit" ? "pieza" : "")),
          ),
        ],
        { neutralize: false },
      ),
    });
    if (!started.ok) throw new Error(started.error);
    const saved = await saveImportMapping(actor, {
      importId: started.importId,
      mapping: Object.fromEntries(KEYS.map((each, index) => [each, index])),
      decimalSeparator: ".",
    });
    if (!saved.ok) throw new Error("mapping not saved");
    const confirmed = await confirmImport(actor, started.importId);
    if (!confirmed.ok) throw new Error(confirmed.error);

    expect(await applyImport(actor.organizationId, started.importId)).toEqual({
      ok: true,
      status: "DONE",
      processed: 3,
      failed: 2,
    });
    const failures = await listImportFailures(actor, started.importId);
    expect(failures.map((failure) => [failure.sku, failure.error])).toEqual([
      [
        "IMP-CUA",
        "«Jaula» es de cuarentena: solo recibe existencias que no están disponibles. (Fila 2).",
      ],
      [
        "IMP-PIN",
        "«Solo químicos» solo admite ciertos productos: Pintura importada no está entre ellos. (Fila 3).",
      ],
    ]);
    // The products that failed were not even created.
    expect(
      await db.product.count({
        where: {
          organizationId: actor.organizationId,
          sku: { in: ["IMP-CUA", "IMP-PIN"] },
        },
      }),
    ).toBe(0);
    const solvent = await db.product.findFirstOrThrow({
      where: { organizationId: actor.organizationId, sku: "IMP-QUI" },
    });
    expect(
      await db.stockBalance.findMany({
        where: { productId: solvent.id },
        select: { quantity: true, location: { select: { name: true } } },
      }),
    ).toMatchObject([{ location: { name: "Solo químicos" } }]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 30_000);
});

describe("occupancy by node (PC-11)", () => {
  it("each node adds what it holds and what its descendants hold, once", async () => {
    const actor = await company();
    const other = await company();
    const bolt = await product(actor, { weight: "0.5", volume: "2" });
    const cable = await product(actor, { unit: "m" });
    // Zona › Pasillo › Estante ×2, and a second zone; stock at every level.
    const zone = await place(actor, "Zona A", {
      level: 1,
      limits: { maxUnits: "500", maxWeight: "100" },
    });
    const aisle = await place(actor, "Pasillo 1", {
      level: 2,
      parentId: zone,
      limits: { maxUnits: "100" },
    });
    const shelf1 = await place(actor, "Estante 1", {
      parentId: aisle,
      limits: { maxUnits: "40" },
    });
    const shelf2 = await place(actor, "Estante 2", { parentId: aisle });
    const zoneB = await place(actor, "Zona B", { level: 1 });
    const shelfB = await place(actor, "Estante B1", { parentId: zoneB });
    const empty = await place(actor, "Estante vacío", { parentId: zoneB });
    const general = (await getDefaultLocation(actor))!.id;

    await enter(actor, bolt, shelf1, "50");
    await enter(actor, bolt, shelf2, "30");
    await enter(actor, cable, shelf2, "12.5");
    await enter(actor, bolt, aisle, "25");
    await enter(actor, bolt, zone, "10");
    await enter(actor, cable, shelfB, "7.5");
    await enter(actor, bolt, general, "3");
    // Part of it in another state, in the same shelf: still there.
    expect(
      await changeStockStatus(actor, {
        productId: bolt,
        locationId: shelf1,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "20",
        reason: "Empaque roto",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });

    const report = await getLocationOccupancy(actor);
    expect(report.truncated).toBe(false);
    const of = (id: string) => report.byLocation[id];
    // Leaves: what they hold themselves. Shelf 1 is over its 40.
    expect(of(shelf1)).toEqual({
      units: "50",
      weight: "25",
      volume: "0.1",
      unweighed: false,
      unsized: false,
      over: ["units"],
    });
    expect(of(shelf2)).toMatchObject({
      units: "42.5",
      weight: "15",
      unweighed: true,
      over: [],
    });
    // The aisle: its 25 + both shelves = 117.5 (over its 100).
    expect(of(aisle)).toMatchObject({
      units: "117.5",
      weight: "52.5",
      unweighed: true,
      over: ["units"],
    });
    // The zone: its 10 + the aisle. Within its 500 and its 100 kg.
    expect(of(zone)).toMatchObject({
      units: "127.5",
      weight: "57.5",
      volume: "0.23",
      over: [],
    });
    expect(of(zoneB)).toMatchObject({ units: "7.5", weight: "0" });
    expect(of(shelfB)).toMatchObject({ units: "7.5" });
    expect(of(general)).toMatchObject({ units: "3" });
    // Nothing held, nothing listed.
    expect(of(empty)).toBeUndefined();

    // Not duplicated: the roots add up to every balance of the warehouse.
    const everything = await db.stockBalance.aggregate({
      where: { organizationId: actor.organizationId },
      _sum: { quantity: true },
    });
    expect(
      [zone, zoneB, general].reduce(
        (sum, id) => sum + Number(of(id)!.units),
        0,
      ),
    ).toBe(Number(everything._sum.quantity));
    expect(Number(everything._sum.quantity)).toBe(138);

    // Someone limited to zone B sees zone B and nothing of zone A.
    const limited = await member(actor.organizationId);
    const facility = await getActiveFacility(actor);
    const scoped = await setMemberScope(actor.organizationId, actor.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: facility.id, zoneIds: [zoneB] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const theirs = await getLocationOccupancy(limited);
    expect(Object.keys(theirs.byLocation).sort()).toEqual(
      [zoneB, shelfB].sort(),
    );
    expect(theirs.byLocation[zoneB]).toMatchObject({ units: "7.5" });

    // Another company sees nothing of this one, whatever warehouse it asks.
    expect(await getLocationOccupancy(other)).toEqual({
      byLocation: {},
      truncated: false,
    });
    await expect(
      getLocationOccupancy(other, { facilityId: facility.id }),
    ).resolves.toEqual({ byLocation: {}, truncated: false });
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  });
});

describe("two companies", () => {
  it("the rules of one never decide for the other", async () => {
    const one = await company();
    const two = await company();
    const mine = await product(one);
    const theirs = await product(two);
    const myShelf = await place(one, "Estante", { limits: { maxUnits: "1" } });
    const theirShelf = await place(two, "Estante");
    await setMode(one, "block");

    // Company two has no limit on its shelf of the same name.
    expect(
      await registerEntry(two, {
        productId: theirs,
        locationId: theirShelf,
        quantity: "500",
      }),
    ).toMatchObject({ ok: true });
    // And a location or a product of the other does not exist for it.
    expect(
      await registerEntry(two, {
        productId: theirs,
        locationId: myShelf,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await registerEntry(one, {
        productId: mine,
        locationId: myShelf,
        quantity: "2",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await stockAt(myShelf)).toBe(0);
  });

  it("every company of these tests reconciles", async () => {
    for (const organizationId of companies) {
      expect(await reconcileStock(organizationId)).toEqual([]);
    }
  }, 60_000);
});
