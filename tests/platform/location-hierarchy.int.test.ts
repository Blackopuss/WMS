import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  MAX_LOCATIONS,
  archiveLocation,
  createLocation,
  listLocations,
  moveLocation,
  renameLocation,
  restoreLocation,
  type LocationActor,
  type LocationNode,
  type LocationResult,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

import { migratorConnection } from "../setup/test-db";

// INV-14, WMS-22A: locations named by the business in the levels of its
// warehouse (by default Zona › Pasillo › Estante), in a hierarchy that
// cannot have a cycle.

/** The default levels of a new warehouse, by the name these tests use. */
type Kind = "ZONE" | "AISLE" | "SHELF";
const DEPTH: Record<Kind, number> = { ZONE: 1, AISLE: 2, SHELF: 3 };
const kindOf = (location: LocationNode) =>
  location.isDefault
    ? "GENERAL"
    : (["", "ZONE", "AISLE", "SHELF"][location.level?.depth ?? 0] ?? "?");

const stamp = Date.now();
let counter = 0;

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `jerarquia.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(expired = false): Promise<LocationActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Ferretería ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  await db.entitlement.create({
    data: {
      id: newId(),
      organizationId: created.organizationId,
      kind: "MODULE",
      key: "inventory",
      validFrom: new Date(Date.now() - 120_000),
      validUntil: expired ? new Date(Date.now() - 60_000) : null,
    },
  });
  invalidateEntitlements(created.organizationId);
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

/** Creates a location and returns its id; fails the test if it was refused. */
async function add(
  actor: LocationActor,
  kind: Kind,
  name: string,
  parentId?: string,
) {
  const result = await createLocation(actor, {
    level: DEPTH[kind],
    name,
    parentId,
  });
  if (!result.ok) {
    throw new Error(`location setup failed: ${JSON.stringify(result)}`);
  }
  return result.locationId;
}

const refusal = (result: LocationResult) =>
  result.ok
    ? "accepted"
    : `${result.reason}: ${result.formError ?? Object.values(result.fieldErrors)[0]}`;

const paths = async (actor: LocationActor, includeArchived = false) =>
  (await listLocations(actor, { includeArchived }))?.locations.map(
    (l) => l.path,
  );

afterEach(() => invalidateEntitlements());

afterAll(async () => {
  await db.$disconnect();
});

describe("a hierarchy named by the business", () => {
  it("zones hold aisles and shelves, with the names the business gives", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Bodega de atrás");
    const aisle = await add(actor, "AISLE", "Pasillo de tornillería", zone);
    await add(actor, "SHELF", "Anaquel rojo", aisle);
    await add(actor, "SHELF", "Tarimas", zone);
    const tree = await listLocations(actor);
    expect(tree?.facility.name).toBe("Principal");
    expect(
      tree?.locations.map((l) => [l.depth, kindOf(l), l.path, l.children]),
    ).toEqual([
      [0, "GENERAL", "General", 0],
      [0, "ZONE", "Bodega de atrás", 2],
      [1, "AISLE", "Bodega de atrás › Pasillo de tornillería", 1],
      [
        2,
        "SHELF",
        "Bodega de atrás › Pasillo de tornillería › Anaquel rojo",
        0,
      ],
      [1, "SHELF", "Bodega de atrás › Tarimas", 0],
    ]);
    expect(tree?.locations[0]).toMatchObject({ isDefault: true });
  });

  it("levels are optional: a small shop can have only shelves", async () => {
    const actor = await company();
    await add(actor, "SHELF", "Estante 10");
    await add(actor, "SHELF", "Estante 2");
    await add(actor, "AISLE", "Pasillo único");
    // General first, then by name with numbers in their natural order.
    expect(await paths(actor)).toEqual([
      "General",
      "Estante 2",
      "Estante 10",
      "Pasillo único",
    ]);
  });

  it("the same name can repeat in different places but not in the same one", async () => {
    const actor = await company();
    const a = await add(actor, "AISLE", "Pasillo 1");
    const b = await add(actor, "AISLE", "Pasillo 2");
    await add(actor, "SHELF", "Estante 1", a);
    await add(actor, "SHELF", "Estante 1", b);
    await add(actor, "SHELF", "Estante 1");
    for (const [name, parentId] of [
      ["estante 1", a],
      ["ESTANTE 1", undefined],
      ["Pasíllo 1", undefined],
      ["general", undefined],
    ] as const) {
      const result = await createLocation(actor, {
        level: 3,
        name,
        parentId,
      });
      expect(result, name).toMatchObject({ ok: false, reason: "duplicate" });
    }
    expect((await paths(actor))?.length).toBe(6);
  });

  it("validates the name and the level with a message for the person", async () => {
    const actor = await company();
    const cases: [unknown, unknown, string][] = [
      ["", 1, "invalid: Escribe el nombre de la ubicación."],
      ["   ", 1, "invalid: Escribe el nombre de la ubicación."],
      [undefined, 1, "invalid: Escribe el nombre de la ubicación."],
      [
        "x".repeat(61),
        1,
        "invalid: El nombre es demasiado largo (máximo 60 caracteres).",
      ],
      ["Zona\tA", 1, "invalid: Quita los saltos de línea o tabuladores."],
      ["Zona A", "", "invalid: Elige el nivel de la ubicación."],
      ["Zona A", 0, "invalid: Elige el nivel de la ubicación."],
      ["Zona A", 4, "invalid: Elige el nivel de la ubicación."],
      ["Zona A", "ZONE", "invalid: Elige el nivel de la ubicación."],
      ["Zona A", 1.5, "invalid: Elige el nivel de la ubicación."],
    ];
    for (const [name, level, expected] of cases) {
      expect(refusal(await createLocation(actor, { name, level }))).toBe(
        expected,
      );
    }
    // Spaces around the name are not part of it.
    const id = await add(actor, "ZONE", "  Zona A  ");
    expect(
      (await listLocations(actor))?.locations.find((l) => l.id === id)?.name,
    ).toBe("Zona A");
    expect(await paths(actor)).toEqual(["General", "Zona A"]);
  });

  it("a location that does not exist cannot hold others", async () => {
    const actor = await company();
    expect(
      refusal(
        await createLocation(actor, {
          level: 3,
          name: "Estante",
          parentId: newId(),
        }),
      ),
    ).toBe("not_found: La ubicación que elegiste ya no existe.");
  });

  it("stops at the maximum of locations", async () => {
    const actor = await company();
    const tree = await listLocations(actor);
    if (!tree) throw new Error("no facility");
    await db.location.createMany({
      data: Array.from({ length: MAX_LOCATIONS - 1 }, (_, i) => ({
        id: newId(),
        organizationId: actor.organizationId,
        facilityId: tree.facility.id,
        levelId: tree.levels[2]!.id,
        name: `Estante ${i + 1}`,
      })),
    });
    expect(
      refusal(await createLocation(actor, { level: 3, name: "Uno más" })),
    ).toBe("limit_reached: Llegaste al máximo de 1,000 ubicaciones.");
    expect((await listLocations(actor))?.locations).toHaveLength(MAX_LOCATIONS);
  });
});

describe("a hierarchy without cycles", () => {
  it("a location only goes inside a wider level", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const aisle = await add(actor, "AISLE", "Pasillo 1", zone);
    const shelf = await add(actor, "SHELF", "Estante 1", aisle);
    const general = (await listLocations(actor))?.locations[0]?.id;
    const cases: [Kind, string | undefined, string][] = [
      [
        "ZONE",
        zone,
        "not_allowed: Una ubicación de nivel «Zona» no puede ir dentro de una de nivel «Zona»: dentro de «Zona» solo van los niveles que siguen.",
      ],
      [
        "ZONE",
        aisle,
        "not_allowed: Una ubicación de nivel «Zona» no puede ir dentro de una de nivel «Pasillo»: dentro de «Pasillo» solo van los niveles que siguen.",
      ],
      [
        "AISLE",
        aisle,
        "not_allowed: Una ubicación de nivel «Pasillo» no puede ir dentro de una de nivel «Pasillo»: dentro de «Pasillo» solo van los niveles que siguen.",
      ],
      [
        "AISLE",
        shelf,
        "not_allowed: «Estante» es el último nivel: no contiene otras ubicaciones.",
      ],
      [
        "SHELF",
        shelf,
        "not_allowed: «Estante» es el último nivel: no contiene otras ubicaciones.",
      ],
      [
        "SHELF",
        general,
        "not_allowed: «General» no contiene otras ubicaciones.",
      ],
    ];
    for (const [kind, parentId, expected] of cases) {
      expect(
        refusal(
          await createLocation(actor, {
            level: DEPTH[kind],
            name: "Nueva",
            parentId,
          }),
        ),
      ).toBe(expected);
    }
    expect(await paths(actor)).toHaveLength(4);
  });

  it("moving a location into itself or into what it contains is refused", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const aisle = await add(actor, "AISLE", "Pasillo 1", zone);
    const shelf = await add(actor, "SHELF", "Estante 1", aisle);
    // Direct cycle.
    expect(refusal(await moveLocation(actor, zone, { parentId: zone }))).toBe(
      "not_allowed: Una ubicación no puede ir dentro de sí misma.",
    );
    // Indirect cycles: under its child and under its grandchild.
    expect(refusal(await moveLocation(actor, zone, { parentId: aisle }))).toBe(
      "not_allowed: Una ubicación de nivel «Zona» no puede ir dentro de una de nivel «Pasillo»: dentro de «Pasillo» solo van los niveles que siguen.",
    );
    expect(refusal(await moveLocation(actor, zone, { parentId: shelf }))).toBe(
      "not_allowed: «Estante» es el último nivel: no contiene otras ubicaciones.",
    );
    expect(refusal(await moveLocation(actor, aisle, { parentId: shelf }))).toBe(
      "not_allowed: «Estante» es el último nivel: no contiene otras ubicaciones.",
    );
    expect(await paths(actor)).toEqual([
      "General",
      "Zona A",
      "Zona A › Pasillo 1",
      "Zona A › Pasillo 1 › Estante 1",
    ]);
  });

  it("moves a location with everything inside it", async () => {
    const actor = await company();
    const a = await add(actor, "ZONE", "Zona A");
    const b = await add(actor, "ZONE", "Zona B");
    const aisle = await add(actor, "AISLE", "Pasillo 1", a);
    await add(actor, "SHELF", "Estante 1", aisle);
    expect(await moveLocation(actor, aisle, { parentId: b })).toMatchObject({
      ok: true,
    });
    expect(await paths(actor)).toEqual([
      "General",
      "Zona A",
      "Zona B",
      "Zona B › Pasillo 1",
      "Zona B › Pasillo 1 › Estante 1",
    ]);
    // Out to the facility itself.
    expect(await moveLocation(actor, aisle, { parentId: "" })).toMatchObject({
      ok: true,
    });
    expect(await paths(actor)).toEqual([
      "General",
      "Pasillo 1",
      "Pasillo 1 › Estante 1",
      "Zona A",
      "Zona B",
    ]);
    expect(refusal(await moveLocation(actor, aisle, { parentId: null }))).toBe(
      "unchanged: La ubicación ya está ahí.",
    );
  });

  it("a move cannot repeat a name where it arrives", async () => {
    const actor = await company();
    const a = await add(actor, "AISLE", "Pasillo 1");
    const b = await add(actor, "AISLE", "Pasillo 2");
    const shelf = await add(actor, "SHELF", "Estante 1", a);
    await add(actor, "SHELF", "estante 1", b);
    await add(actor, "SHELF", "ESTANTE 1");
    for (const parentId of [b, ""]) {
      expect(await moveLocation(actor, shelf, { parentId })).toMatchObject({
        ok: false,
        reason: "duplicate",
      });
    }
  });

  it("simultaneous moves never leave a cycle or a lost location", async () => {
    const actor = await company();
    const zones = await Promise.all(
      ["Zona A", "Zona B"].map((name) => add(actor, "ZONE", name)),
    );
    const aisles: string[] = [];
    for (let i = 1; i <= 4; i++) {
      aisles.push(await add(actor, "AISLE", `Pasillo ${i}`, zones[i % 2]));
    }
    const shelves: string[] = [];
    for (let i = 1; i <= 4; i++) {
      shelves.push(await add(actor, "SHELF", `Estante ${i}`, aisles[i - 1]));
    }
    // Everyone reorganizes at once, including moves that would close a
    // cycle if both were accepted (a zone under its aisle, an aisle under
    // its shelf) and legitimate ones.
    const attempts = [
      ...aisles.map((aisle, i) =>
        moveLocation(actor, aisle, { parentId: zones[(i + 1) % 2] }),
      ),
      ...zones.map((zone, i) =>
        moveLocation(actor, zone, { parentId: aisles[i] }),
      ),
      ...aisles.map((aisle, i) =>
        moveLocation(actor, aisle, { parentId: shelves[i] }),
      ),
      ...shelves.map((shelf, i) =>
        moveLocation(actor, shelf, { parentId: aisles[(i + 1) % 4] }),
      ),
      ...shelves.map((shelf, i) =>
        moveLocation(actor, shelf, { parentId: zones[i % 2] }),
      ),
    ];
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
    // Every location still reaches the root: the walk from the root finds
    // all eleven, each with a depth its level allows.
    const tree = await listLocations(actor);
    expect(tree?.locations).toHaveLength(11);
    for (const location of tree?.locations ?? []) {
      const allowed = (location.level?.depth ?? 1) - 1;
      expect(location.depth, location.path).toBeLessThanOrEqual(allowed);
    }
    const rows = await forOrganization(actor.organizationId).location.findMany({
      select: { id: true, parentId: true },
    });
    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
    for (const row of rows) {
      let current: string | null = row.id;
      for (let steps = 0; current; steps++) {
        expect(steps, "cycle").toBeLessThan(4);
        current = parentOf.get(current) ?? null;
      }
    }
  }, 30_000);

  it("simultaneous creations with the same name leave one", async () => {
    const actor = await company();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createLocation(actor, { level: 1, name: "Zona única" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && r.reason === "duplicate"),
    ).toHaveLength(5);
    expect(await paths(actor)).toEqual(["General", "Zona única"]);
  });
});

describe("renaming", () => {
  it("changes the name and the paths of what it contains", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    await add(actor, "SHELF", "Estante 1", zone);
    expect(await renameLocation(actor, zone, { name: "Patio" })).toMatchObject({
      ok: true,
    });
    expect(await paths(actor)).toEqual([
      "General",
      "Patio",
      "Patio › Estante 1",
    ]);
    // Only capitals or accents: still the same place, and it is accepted.
    expect(await renameLocation(actor, zone, { name: "PATIO" })).toMatchObject({
      ok: true,
    });
    expect(refusal(await renameLocation(actor, zone, { name: "PATIO" }))).toBe(
      "unchanged: Ese ya es su nombre.",
    );
  });

  it("refuses the name of a sibling, an empty name and a missing location", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    await add(actor, "ZONE", "Zona B");
    expect(await renameLocation(actor, zone, { name: "zona b" })).toMatchObject(
      { ok: false, reason: "duplicate" },
    );
    expect(await renameLocation(actor, zone, { name: " " })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      refusal(await renameLocation(actor, newId(), { name: "Otra" })),
    ).toBe("not_found: Esta ubicación ya no existe.");
  });
});

describe("General stays as it is", () => {
  it("cannot be renamed, moved or archived, and holds nothing", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const general = (await listLocations(actor))?.locations[0]?.id ?? "";
    const fixed =
      "not_allowed: «General» es la ubicación inicial de tu inventario: no se renombra, no se mueve y no se archiva.";
    expect(
      refusal(await renameLocation(actor, general, { name: "Mostrador" })),
    ).toBe(fixed);
    expect(
      refusal(await moveLocation(actor, general, { parentId: zone })),
    ).toBe(fixed);
    expect(refusal(await archiveLocation(actor, general))).toBe(fixed);
    expect(
      refusal(await moveLocation(actor, zone, { parentId: general })),
    ).toBe("not_allowed: «General» no contiene otras ubicaciones.");
    expect(await paths(actor)).toEqual(["General", "Zona A"]);
  });
});

describe("archiving", () => {
  it("an empty location is archived and can come back", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const shelf = await add(actor, "SHELF", "Estante 1", zone);
    expect(refusal(await archiveLocation(actor, zone))).toBe(
      "not_allowed: Tiene una ubicación dentro. Archívala o muévela primero.",
    );
    expect(await archiveLocation(actor, shelf)).toMatchObject({ ok: true });
    expect(refusal(await archiveLocation(actor, shelf))).toBe(
      "unchanged: Esta ubicación ya está archivada.",
    );
    expect(await archiveLocation(actor, zone)).toMatchObject({ ok: true });
    // Nothing is deleted: both stay, out of the usual list.
    expect(await paths(actor)).toEqual(["General"]);
    expect(await paths(actor, true)).toEqual([
      "General",
      "Zona A",
      "Zona A › Estante 1",
    ]);
    expect(
      (await listLocations(actor, { includeArchived: true }))?.locations.map(
        (l) => l.archived,
      ),
    ).toEqual([false, true, true]);

    // Its name stays taken, and nothing new goes inside it.
    expect(
      await createLocation(actor, { level: 1, name: "zona a" }),
    ).toMatchObject({ ok: false, reason: "duplicate" });
    expect(
      refusal(
        await createLocation(actor, {
          level: 3,
          name: "Estante 2",
          parentId: zone,
        }),
      ),
    ).toBe("not_allowed: «Zona A» está archivada. Reactívala o elige otra.");

    // What is inside comes back after what holds it.
    expect(refusal(await restoreLocation(actor, shelf))).toBe(
      "not_allowed: Está dentro de «Zona A», que sigue archivada. Reactiva esa primero.",
    );
    expect(await restoreLocation(actor, zone)).toMatchObject({ ok: true });
    expect(await restoreLocation(actor, shelf)).toMatchObject({ ok: true });
    expect(refusal(await restoreLocation(actor, shelf))).toBe(
      "unchanged: Esta ubicación ya está activa.",
    );
    expect(await paths(actor)).toEqual([
      "General",
      "Zona A",
      "Zona A › Estante 1",
    ]);
  });

  it("an archived location is not moved until it is back", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const shelf = await add(actor, "SHELF", "Estante 1");
    await archiveLocation(actor, shelf);
    expect(refusal(await moveLocation(actor, shelf, { parentId: zone }))).toBe(
      "not_allowed: Reactiva la ubicación antes de moverla.",
    );
  });
});

describe("who can change locations", () => {
  it("Almacén and Administrador organize; Comprador and Consulta only look", async () => {
    const owner = await company();
    const zone = await add(owner, "ZONE", "Zona A");
    for (const role of ["warehouse", "administrator"] as const) {
      const actor = await member(owner.organizationId, role);
      const shelf = await add(actor, "SHELF", `Estante de ${role}`, zone);
      expect(
        (await renameLocation(actor, shelf, { name: `Anaquel de ${role}` })).ok,
      ).toBe(true);
      expect((await moveLocation(actor, shelf, { parentId: "" })).ok).toBe(
        true,
      );
      expect((await archiveLocation(actor, shelf)).ok).toBe(true);
      expect((await restoreLocation(actor, shelf)).ok).toBe(true);
    }
    for (const role of ["buyer", "viewer"] as const) {
      const actor = await member(owner.organizationId, role);
      for (const attempt of [
        () => createLocation(actor, { level: 1, name: "Zona B" }),
        () => renameLocation(actor, zone, { name: "Otra" }),
        () => moveLocation(actor, zone, { parentId: "" }),
        () => archiveLocation(actor, zone),
        () => restoreLocation(actor, zone),
      ]) {
        await expect(attempt(), role).rejects.toMatchObject({
          code: "permission_denied",
        });
      }
      expect((await listLocations(actor))?.locations.length, role).toBe(4);
    }
  });

  it("with the plan expired the tree can be seen but not changed", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    await db.entitlement.updateMany({
      where: { organizationId: actor.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(actor.organizationId);
    for (const attempt of [
      () => createLocation(actor, { level: 1, name: "Zona B" }),
      () => renameLocation(actor, zone, { name: "Otra" }),
      () => moveLocation(actor, zone, { parentId: "" }),
      () => archiveLocation(actor, zone),
      () => restoreLocation(actor, zone),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "module_read_only",
      });
    }
    expect(await paths(actor)).toEqual(["General", "Zona A"]);
  });

  it("a company without the module cannot use locations", async () => {
    const owner = await newUser();
    const created = await createOrganization(owner, {
      name: "Sin plan",
      timeZone: "",
    });
    if (!created.ok) throw new Error("company setup failed");
    const actor = { organizationId: created.organizationId, userId: owner };
    await expect(
      createLocation(actor, { level: 1, name: "Zona A" }),
    ).rejects.toMatchObject({ code: "module_not_contracted" });
  });

  it("another company neither sees nor changes these locations (NEG-12)", async () => {
    const mine = await company();
    const theirs = await company();
    const zone = await add(mine, "ZONE", "Zona A");
    const shelf = await add(mine, "SHELF", "Estante 1", zone);
    const theirZone = await add(theirs, "ZONE", "Zona A");

    // With their own session, the ids of the other company do not exist.
    const gone = "not_found: Esta ubicación ya no existe.";
    expect(refusal(await renameLocation(theirs, zone, { name: "Mía" }))).toBe(
      gone,
    );
    expect(refusal(await moveLocation(theirs, shelf, { parentId: "" }))).toBe(
      gone,
    );
    expect(refusal(await archiveLocation(theirs, shelf))).toBe(gone);
    expect(refusal(await restoreLocation(theirs, shelf))).toBe(gone);
    // Nor can their locations hold or go into the ones of this company.
    expect(
      refusal(
        await createLocation(theirs, {
          level: 3,
          name: "Intruso",
          parentId: zone,
        }),
      ),
    ).toBe("not_found: La ubicación que elegiste ya no existe.");
    expect(
      refusal(await moveLocation(mine, shelf, { parentId: theirZone })),
    ).toBe("not_found: La ubicación que elegiste ya no existe.");
    expect(await paths(theirs)).toEqual(["General", "Zona A"]);
    expect(await paths(mine)).toEqual([
      "General",
      "Zona A",
      "Zona A › Estante 1",
    ]);
    // Acting on this company with the other person's account is refused.
    const intruder = {
      organizationId: mine.organizationId,
      userId: theirs.userId,
    };
    await expect(listLocations(intruder)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(
      renameLocation(intruder, zone, { name: "Mía" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("the audit trail of locations", () => {
  it("records who created, renamed, moved, archived and restored", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const shelf = await add(actor, "SHELF", "Estante 1");
    await renameLocation(actor, shelf, { name: "Anaquel 1" });
    await moveLocation(actor, shelf, { parentId: zone });
    await archiveLocation(actor, shelf);
    await restoreLocation(actor, shelf);
    // Refused changes leave nothing.
    await renameLocation(actor, shelf, { name: "" });
    await moveLocation(actor, zone, { parentId: shelf });

    const rows = await forOrganization(
      actor.organizationId,
    ).auditEvent.findMany({
      where: { action: { startsWith: "location." } },
      orderBy: { id: "asc" },
      select: {
        action: true,
        actorUserId: true,
        targetId: true,
        metadata: true,
      },
    });
    expect(rows.map((row) => [row.action, row.targetId, row.metadata])).toEqual(
      [
        [
          "location.created",
          zone,
          {
            name: "Zona A",
            nivel: "Zona",
            codigo: null,
            tipo: "Almacenamiento",
            path: "Zona A",
          },
        ],
        [
          "location.created",
          shelf,
          {
            name: "Estante 1",
            nivel: "Estante",
            codigo: null,
            tipo: "Almacenamiento",
            path: "Estante 1",
          },
        ],
        [
          "location.renamed",
          shelf,
          { before: "Estante 1", after: "Anaquel 1" },
        ],
        [
          "location.moved",
          shelf,
          { before: "Anaquel 1", after: "Zona A › Anaquel 1" },
        ],
        ["location.archived", shelf, { path: "Zona A › Anaquel 1" }],
        ["location.restored", shelf, { path: "Zona A › Anaquel 1" }],
      ],
    );
    expect(new Set(rows.map((row) => row.actorUserId))).toEqual(
      new Set([actor.userId]),
    );
    const trail = await listAuditTrail(actor.organizationId);
    expect(trail.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        "Creó una ubicación",
        "Cambió el nombre de una ubicación",
        "Movió una ubicación",
        "Archivó una ubicación",
        "Reactivó una ubicación",
      ]),
    );
  });
});

describe("the database keeps the hierarchy even when the application is bypassed", () => {
  it("rejects wrong parents, level changes, touching General and deletions", async () => {
    const actor = await company();
    const zone = await add(actor, "ZONE", "Zona A");
    const aisle = await add(actor, "AISLE", "Pasillo 1", zone);
    const other = await company();
    const theirZone = await add(other, "ZONE", "Zona ajena");
    const tree = await listLocations(actor);
    const general = tree?.locations[0]?.id;
    const facility = tree?.facility.id;
    const connection = await migratorConnection();
    const sql = (statement: string, values: unknown[] = []) =>
      connection.query(statement, values);
    const levelOf = (kind: Kind | "GENERAL") =>
      kind === "GENERAL" ? null : tree!.levels[DEPTH[kind] - 1]!.id;
    const insert = (
      name: string,
      kind: Kind | "GENERAL",
      parentId: string | null,
    ) =>
      sql(
        "INSERT INTO location (id, organizationId, facilityId, name, levelId, parentId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NOW(3))",
        [
          newId(),
          actor.organizationId,
          facility,
          name,
          levelOf(kind),
          parentId,
        ],
      );
    try {
      const coarser = /a location only goes inside a wider level/;
      // Same kind, finer parent, General as parent.
      await expect(insert("Zona B", "ZONE", zone)).rejects.toThrow(coarser);
      await expect(insert("Zona B", "ZONE", aisle)).rejects.toThrow(coarser);
      await expect(insert("Estante", "SHELF", general ?? "")).rejects.toThrow(
        coarser,
      );
      // A parent of another company (same or another facility).
      await expect(insert("Estante", "SHELF", theirZone)).rejects.toThrow(
        /foreign key/i,
      );
      // Itself as parent, and a cycle built with two updates.
      await expect(
        sql("UPDATE location SET parentId = id WHERE id = ?", [aisle]),
      ).rejects.toThrow(/location_parent_check|wider level/);
      await expect(
        sql("UPDATE location SET parentId = ? WHERE id = ?", [aisle, zone]),
      ).rejects.toThrow(coarser);
      // The level is fixed.
      await expect(
        sql("UPDATE location SET levelId = ? WHERE id = ?", [
          levelOf("SHELF"),
          aisle,
        ]),
      ).rejects.toThrow(/the level of a location never changes/);
      // Names at the root and inside a parent.
      await expect(insert("zona a", "ZONE", null)).rejects.toThrow(
        /name repeated at the root/,
      );
      await expect(insert("PASILLO 1", "AISLE", zone)).rejects.toThrow(
        /Duplicate entry/,
      );
      await expect(
        sql("UPDATE location SET name = 'General' WHERE id = ?", [zone]),
      ).rejects.toThrow(/name repeated at the root/);
      // General: not renamed, moved, archived, unmarked or given a level.
      for (const change of [
        "name = 'Mostrador'",
        "parentId = ?",
        "archivedAt = NOW(3)",
        "isDefault = NULL",
        "levelId = ?",
      ]) {
        await expect(
          sql(
            `UPDATE location SET ${change} WHERE id = ?`,
            change === "parentId = ?"
              ? [zone, general]
              : change === "levelId = ?"
                ? [levelOf("ZONE"), general]
                : [general],
          ),
          change,
        ).rejects.toThrow(
          /location_default_check|location_general_check|location_tree/,
        );
      }
      await expect(insert("Otra General", "GENERAL", null)).rejects.toThrow(
        /location_general_check/,
      );
      // Nothing is deleted.
      await expect(
        sql("DELETE FROM location WHERE id = ?", [aisle]),
      ).rejects.toThrow(/location is never deleted/);
    } finally {
      await connection.end();
    }
    expect(await paths(actor)).toEqual([
      "General",
      "Zona A",
      "Zona A › Pasillo 1",
    ]);
  });
});
