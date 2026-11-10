import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  getProductStock,
  listStockLocations,
  reconcileStock,
  registerEntry,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  editLocation,
  listLocations,
  saveLocationLevels,
  setStagingLocation,
  switchFacility,
  type LocationResult,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-22A (ADR 0036): each warehouse names its own levels, as many as it
// needs (up to 8); a location only goes inside a wider level; it may have a
// code to scan and a use.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `niveles.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa niveles ${counter}`,
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
      facilities: 2,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de niveles",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(organizationId: string, role: Role) {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

const refusal = (result: LocationResult) =>
  result.ok
    ? "accepted"
    : `${result.reason}: ${result.formError ?? Object.values(result.fieldErrors)[0]}`;

async function levelsOf(actor: InventoryActor) {
  return (await listLocations(actor))!.levels;
}

/** Creates a location and returns its id; fails the test if refused. */
async function add(
  actor: InventoryActor,
  level: number,
  name: string,
  parentId?: string,
  extra: { code?: string; type?: string } = {},
) {
  const result = await createLocation(actor, {
    level,
    name,
    parentId,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

afterAll(() => db.$disconnect());

describe("levels per warehouse", () => {
  it("a warehouse with six levels and another with two live together", async () => {
    const owner = await company();
    // Main warehouse: Zona › Pasillo › Estante become six levels.
    const start = await levelsOf(owner);
    expect(start.map((level) => level.name)).toEqual([
      "Zona",
      "Pasillo",
      "Estante",
    ]);
    expect(
      await saveLocationLevels(owner, {
        levels: [
          { name: "Nave" },
          { id: start[0]!.id, name: "Zona" },
          { id: start[1]!.id, name: "Pasillo" },
          { id: start[2]!.id, name: "Rack" },
          { name: "Nivel" },
          { name: "Posición" },
        ],
      }),
    ).toMatchObject({ ok: true });
    const six = await levelsOf(owner);
    expect(six.map((level) => [level.depth, level.name])).toEqual([
      [1, "Nave"],
      [2, "Zona"],
      [3, "Pasillo"],
      [4, "Rack"],
      [5, "Nivel"],
      [6, "Posición"],
    ]);
    // The old ones keep their ids: their locations stay.
    expect(six[3]!.id).toBe(start[2]!.id);
    let parent: string | undefined;
    for (const [index, name] of [
      "Nave 1",
      "Zona A",
      "Pasillo 3",
      "Rack 12",
      "Nivel 2",
      "Posición 4",
    ].entries()) {
      parent = await add(owner, index + 1, name, parent);
    }
    const deepest = parent!;

    // The second warehouse keeps only two levels.
    const north = await createFacility(owner, { name: "Norte", code: "NTE" });
    if (!north.ok) throw new Error(JSON.stringify(north));
    expect(await switchFacility(owner, north.facilityId)).toMatchObject({
      ok: true,
    });
    const theirs = await levelsOf(owner);
    expect(
      await saveLocationLevels(owner, {
        levels: [
          { id: theirs[0]!.id, name: "Pasillo" },
          { id: theirs[2]!.id, name: "Hueco" },
        ],
      }),
    ).toMatchObject({ ok: true });
    const two = await levelsOf(owner);
    expect(two.map((level) => level.name)).toEqual(["Pasillo", "Hueco"]);
    const aisle = await add(owner, 1, "Pasillo 1");
    await add(owner, 2, "Hueco 7", aisle);
    expect(
      refusal(await createLocation(owner, { level: 3, name: "Otro" })),
    ).toBe("invalid: Elige el nivel de la ubicación.");
    expect(
      (await listLocations(owner))!.locations.map((each) => each.path),
    ).toEqual(["General", "Pasillo 1", "Pasillo 1 › Hueco 7"]);

    // Back in the main one: the path of six names reaches every screen.
    await switchFacility(owner, await mainId(owner));
    const product = await createProduct(owner, {
      sku: `NIV-${counter}`,
      name: "Caja",
      unit: "piece",
    });
    if (!product.ok) throw new Error("product setup failed");
    expect(
      await registerEntry(owner, {
        productId: product.productId,
        locationId: deepest,
        quantity: "5",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    const path = "Nave 1 › Zona A › Pasillo 3 › Rack 12 › Nivel 2 › Posición 4";
    expect(
      (await getProductStock(owner, product.productId))?.locations.map(
        (each) => each.path,
      ),
    ).toContain(path);
    expect(
      (await listStockLocations(owner)).map((each) => each.path),
    ).toContain(path);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("keeps the order of the levels in use and refuses what would break it", async () => {
    const owner = await company();
    const [zona, pasillo, estante] = await levelsOf(owner);
    const zone = await add(owner, 1, "Zona A");
    await add(owner, 3, "Estante 1", zone);
    const save = (levels: { id?: string; name: string }[]) =>
      saveLocationLevels(owner, { levels }).then(refusal);

    expect(
      await save([
        { id: estante!.id, name: "Estante" },
        { id: zona!.id, name: "Zona" },
      ]),
    ).toBe(
      "not_allowed: Los niveles que ya existen no cambian de orden: agrega uno nuevo donde lo necesites.",
    );
    expect(await save([{ id: estante!.id, name: "Estante" }])).toBe(
      "not_allowed: «Zona» tiene una ubicación: no se puede quitar.",
    );
    expect(
      await save([
        { id: zona!.id, name: "Zona" },
        { id: estante!.id, name: "zona" },
      ]),
    ).toBe("invalid: Dos niveles tienen el mismo nombre.");
    expect(await save([])).toBe(
      "invalid: El almacén necesita al menos un nivel.",
    );
    expect(
      await save(
        Array.from({ length: 9 }, (_, index) => ({ name: `N${index}` })),
      ),
    ).toBe("invalid: Un almacén puede tener hasta 8 niveles.");
    expect(await save([{ id: newId(), name: "Ajeno" }])).toBe(
      "not_found: Uno de los niveles ya no existe.",
    );
    expect(
      await save([
        { id: zona!.id, name: "Zona" },
        { id: pasillo!.id, name: "Pasillo" },
        { id: estante!.id, name: "Estante" },
      ]),
    ).toBe("unchanged: No cambiaste nada.");

    // Unused «Pasillo» goes; a «Rack» goes in its place; names change.
    expect(
      await save([
        { id: zona!.id, name: "Área" },
        { name: "Rack" },
        { id: estante!.id, name: "Anaquel" },
      ]),
    ).toBe("accepted");
    expect(
      (await listLocations(owner))!.locations.map((each) => [
        each.path,
        each.level?.name ?? null,
      ]),
    ).toEqual([
      ["General", null],
      ["Zona A", "Área"],
      ["Zona A › Estante 1", "Anaquel"],
    ]);
    const event = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        action: "location.levels_changed",
      },
    });
    expect(event.metadata).toEqual({
      antes: "Zona › Pasillo › Estante",
      ahora: "Área › Rack › Anaquel",
    });
  });

  it("only who manages locations changes the levels", async () => {
    const owner = await company();
    const operator = await member(owner.organizationId, "operator");
    const levels = await levelsOf(owner);
    await expect(
      saveLocationLevels(operator, {
        levels: levels.map((level) => ({ id: level.id, name: "X" })),
      }),
    ).rejects.toThrow();
    expect((await levelsOf(owner)).map((level) => level.name)).toEqual([
      "Zona",
      "Pasillo",
      "Estante",
    ]);
  });
});

describe("code and use of a location", () => {
  it("codes are upper case and unique in their warehouse", async () => {
    const owner = await company();
    const a = await add(owner, 3, "Estante A", undefined, { code: " a-01 " });
    expect(
      (await listLocations(owner))!.locations.find((each) => each.id === a),
    ).toMatchObject({ code: "A-01", type: "STORAGE" });
    expect(
      refusal(
        await createLocation(owner, {
          level: 3,
          name: "Estante B",
          code: "A-01",
        }),
      ),
    ).toBe("duplicate: Ese código ya lo tiene «Estante A». Usa otro.");
    expect(
      refusal(
        await createLocation(owner, {
          level: 3,
          name: "Estante B",
          code: "A 01",
        }),
      ),
    ).toMatch(/^invalid: Usa solo letras/);
    // Another warehouse may use the same code.
    const north = await createFacility(owner, { name: "Norte", code: "NTE" });
    if (!north.ok) throw new Error(JSON.stringify(north));
    await switchFacility(owner, north.facilityId);
    await add(owner, 3, "Estante A", undefined, { code: "A-01" });
    // The database refuses a bad or repeated code even without the service.
    const location = await db.location.findUniqueOrThrow({ where: { id: a } });
    await expect(
      db.location.update({ where: { id: a }, data: { code: "a-01" } }),
    ).rejects.toThrow(/location_code/);
    await expect(
      db.location.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          facilityId: location.facilityId,
          levelId: location.levelId,
          name: "Copia",
          code: "A-01",
        },
      }),
    ).rejects.toThrow(/Unique constraint|Duplicate entry/);
  });

  it("the name, code and use change together; staging keeps its use", async () => {
    const owner = await company();
    const dock = await add(owner, 1, "Andén 1");
    expect(
      await editLocation(owner, dock, {
        name: "Andén norte",
        code: "AND-1",
        type: "DOCK",
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await listLocations(owner))!.locations.find((each) => each.id === dock),
    ).toMatchObject({ name: "Andén norte", code: "AND-1", type: "DOCK" });
    expect(
      refusal(
        await editLocation(owner, dock, {
          name: "Andén norte",
          code: "and-1",
          type: "DOCK",
        }),
      ),
    ).toBe("unchanged: No cambiaste nada.");
    expect(refusal(await editLocation(owner, dock, { type: "PATIO" }))).toBe(
      "invalid: Elige para qué se usa la ubicación.",
    );
    // Staging is chosen in Operación, never typed as a use.
    expect(
      refusal(await editLocation(owner, dock, { type: "STAGING" })),
    ).toMatch(/Configuración › Operación/);
    expect(
      refusal(
        await createLocation(owner, {
          level: 1,
          name: "Mesa",
          type: "STAGING",
        }),
      ),
    ).toMatch(/Configuración › Operación/);
    const table = await add(owner, 1, "Mesa de empaque");
    expect(await setStagingLocation(owner, table)).toMatchObject({ ok: true });
    expect(
      (await listLocations(owner))!.locations.find((each) => each.id === table),
    ).toMatchObject({ isStaging: true, type: "STAGING" });
    expect(
      refusal(await editLocation(owner, table, { type: "STORAGE" })),
    ).toMatch(/^not_allowed: Aquí espera lo surtido/);
    // General keeps its name and use; only its code may change.
    const general = (await listLocations(owner))!.locations[0]!;
    expect(
      refusal(await editLocation(owner, general.id, { type: "DOCK" })),
    ).toBe("not_allowed: «General» no cambia de uso.");
    expect(
      await editLocation(owner, general.id, { code: "GEN" }),
    ).toMatchObject({ ok: true });
    const trail = await db.auditEvent.findMany({
      where: {
        organizationId: owner.organizationId,
        action: "location.details_changed",
      },
      orderBy: { id: "asc" },
    });
    expect(trail[0]?.metadata).toMatchObject({
      codigoAntes: null,
      codigoAhora: "AND-1",
      usoAntes: "Almacenamiento",
      usoAhora: "Andén",
    });
  });

  it("a file may name the location by its code", async () => {
    const owner = await company();
    await add(owner, 3, "Estante azul", undefined, { code: "EA-1" });
    const found = (await listStockLocations(owner)).find(
      (each) => each.code === "EA-1",
    );
    expect(found?.path).toBe("Estante azul");
  });
});

async function mainId(actor: InventoryActor) {
  return (
    await db.facility.findFirstOrThrow({
      where: { organizationId: actor.organizationId, isDefault: true },
    })
  ).id;
}
