import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { afterAll, describe, expect, it, vi } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import {
  assignTask,
  blockTask,
  acceptTask,
  buildExport,
  createTask,
  getIndicatorsByFacility,
  getWarehouseIndicators,
  listOpenWorkByPerson,
  listTasks,
  registerEntry,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createProduct } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-34 (ADR 0085): the dashboards by role (the period against the one
// before, the warehouses side by side, open work per person) and the file
// of the indicators. Every figure must be the one of its screen or list.

const DAY = 86_400_000;
/** Reads of the view by warehouse with three warehouses. */
/** About 18 per warehouse plus 6 to start (measured: 60). */
const BY_FACILITY_BUDGET = 64;
/** Reads of the open work per person (permission, warehouse, scope, the
 * group and the names; measured: 16). */
const OPEN_WORK_BUDGET = 16;
const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `tableros.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  options: { facilities?: number; provision?: boolean } = {},
): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén tableros ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (options.provision === false) {
    return { organizationId: created.organizationId, userId: owner };
  }
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
      users: 20,
      facilities: options.facilities,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de tableros",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  name = "Persona",
): Promise<InventoryActor> {
  const userId = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

async function product(owner: InventoryActor, name: string) {
  const created = await createProduct(owner, { sku: `T-${++counter}`, name });
  if (!created.ok) throw new Error("product setup failed");
  return created.productId;
}

async function place(owner: InventoryActor, name: string, parentId?: string) {
  const result = await createLocation(owner, {
    level: parentId ? 3 : 1,
    name,
    ...(parentId ? { parentId } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function entry(
  actor: InventoryActor,
  productId: string,
  quantity: string,
  locationId: string,
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** An exit line written at a chosen moment (history only). */
async function exitAt(
  actor: InventoryActor,
  input: {
    at: Date;
    productId: string;
    locationId: string;
    quantity: string;
    unitCost?: string;
  },
) {
  const movementId = newId();
  await db.stockMovement.create({
    data: {
      id: movementId,
      organizationId: actor.organizationId,
      type: "EXIT",
      createdByUserId: actor.userId,
      createdAt: input.at,
    },
  });
  await db.stockMovementLine.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      movementId,
      lineNumber: 1,
      productId: input.productId,
      locationId: input.locationId,
      direction: "OUT",
      capturedQuantity: input.quantity,
      factor: "1",
      baseQuantity: input.quantity,
      unitCode: "piece",
      unitCost: input.unitCost ?? null,
      createdAt: input.at,
    },
  });
}

async function facilityOf(locationId: string) {
  return (await db.location.findUniqueOrThrow({ where: { id: locationId } }))
    .facilityId;
}

/** Statements sent by this test's own adapter, never the server's total. */
async function countingQueries() {
  const adapter = await new PrismaMariaDb({
    host: process.env.DATABASE_HOST!,
    port: Number(process.env.DATABASE_PORT ?? 3306),
    user: process.env.DATABASE_APP_USER!,
    password: process.env.DATABASE_APP_PASSWORD!,
    database: process.env.DATABASE_NAME!,
    connectionLimit: 1,
    allowPublicKeyRetrieval: true,
  }).connect();
  const queryable = Object.getPrototypeOf(Object.getPrototypeOf(adapter));
  await adapter.dispose();
  const reads = vi.spyOn(queryable, "queryRaw");
  const writes = vi.spyOn(queryable, "executeRaw");
  return {
    count: () => reads.mock.calls.length + writes.mock.calls.length,
    reset: () => {
      reads.mockClear();
      writes.mockClear();
    },
    restore: () => {
      reads.mockRestore();
      writes.mockRestore();
    },
  };
}

/** Two warehouses with exits in both, at a moment 20 days ahead. */
async function twoWarehouses() {
  const owner = await company({ facilities: 3 });
  const shelf = await place(owner, "Estante Centro");
  const item = await product(owner, "Martillo");
  await entry(owner, item, "50", shelf);
  const made = await createFacility(owner, { name: "Bodega Norte", code: "N" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const north = made.facilityId;
  const main = await facilityOf(shelf);
  await switchFacility(owner, north);
  const northShelf = await place(owner, "Estante Norte");
  await switchFacility(owner, main);
  // Real time, so the file (which cannot be given a moment) sees the same.
  const now = new Date();
  // Inside the 7 days ending `now`: two exits in the main warehouse, one in
  // the north; the period before: one in the main warehouse.
  for (const back of [1, 2]) {
    await exitAt(owner, {
      at: new Date(now.getTime() - back * DAY),
      productId: item,
      locationId: shelf,
      quantity: "2",
      unitCost: "10",
    });
  }
  await exitAt(owner, {
    at: new Date(now.getTime() - DAY),
    productId: item,
    locationId: northShelf,
    quantity: "3",
    unitCost: "10",
  });
  await exitAt(owner, {
    at: new Date(now.getTime() - 10 * DAY),
    productId: item,
    locationId: shelf,
    quantity: "5",
    unitCost: "10",
  });
  return { owner, item, shelf, northShelf, main, north, now };
}

afterAll(() => db.$disconnect());

describe("period against the one before", () => {
  it("is the same headline as asking for that period on its own", async () => {
    const { owner, now } = await twoWarehouses();
    const seen = await getWarehouseIndicators(owner, { preset: "7", now });
    expect(seen.exits.lines).toBe(2);
    expect(seen.previous).toBeDefined();
    const previous = seen.previous!;
    expect(previous.exits.lines).toBe(1);
    expect(previous.period.days).toBe(7);
    expect(previous.period.to < seen.period.from).toBe(true);
    const alone = await getWarehouseIndicators(owner, {
      from: previous.period.from,
      to: previous.period.to,
      now,
      compare: false,
    });
    expect(alone.previous).toBeUndefined();
    expect(previous.exits.lines).toBe(alone.exits.lines);
    expect(previous.exits.value).toBe(alone.exits.value);
    expect(previous.orders).toEqual(alone.orders);
    expect(previous.tasksDelivered).toBe(alone.tasksDelivered);
    expect(previous.picking).toEqual(alone.picking);
    expect(previous.receiving).toEqual(alone.receiving);
  }, 120_000);

  it("money only with costs, also in the period before", async () => {
    const { owner, now } = await twoWarehouses();
    const supervisor = await member(owner.organizationId, "supervisor");
    const manager = await member(owner.organizationId, "manager");
    const bySupervisor = await getWarehouseIndicators(supervisor, {
      preset: "7",
      now,
    });
    expect(bySupervisor.previous!.exits).not.toHaveProperty("value");
    expect(bySupervisor.previous!.exits).not.toHaveProperty("rawValue");
    const byManager = await getWarehouseIndicators(manager, {
      preset: "7",
      now,
    });
    expect(byManager.exits.value).toBe("$40.00");
    expect(byManager.previous!.exits.value).toBe("$50.00");
  }, 120_000);
});

describe("getIndicatorsByFacility", () => {
  it("each warehouse is its own indicators; the company adds them up", async () => {
    const { owner, main, north, now } = await twoWarehouses();
    const seen = await getIndicatorsByFacility(owner, { preset: "7", now });
    // In order of name.
    expect(seen.rows.map((row) => row.name)).toEqual([
      "Bodega Norte",
      "Principal",
    ]);
    for (const row of seen.rows) {
      const alone = await getWarehouseIndicators(owner, {
        preset: "7",
        now,
        facilityId: row.facilityId,
        compare: false,
      });
      expect(row.exits.lines).toBe(alone.exits.lines);
      expect(row.exits.value).toBe(alone.exits.value);
      expect(row.orders).toEqual(alone.orders);
      expect(row.tasksDelivered).toBe(alone.tasksDelivered);
    }
    expect(seen.rows.find((r) => r.facilityId === main)!.exits.lines).toBe(2);
    expect(seen.rows.find((r) => r.facilityId === north)!.exits.lines).toBe(1);
    expect(seen.company).toMatchObject({
      exitLines: 3,
      exitValue: "$70.00",
      shipped: 0,
    });
  }, 120_000);

  it("who is limited sees only what it reaches and never the company", async () => {
    const { owner, main, north, now } = await twoWarehouses();
    const limited = await member(owner.organizationId, "supervisor");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: north, zoneIds: [] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const seen = await getIndicatorsByFacility(limited, { preset: "7", now });
    expect(seen.rows.map((row) => row.facilityId)).toEqual([north]);
    expect(seen.company).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("Principal");
    expect(JSON.stringify(seen)).not.toContain(main);
    // A supervisor without limits sees the company but no money.
    const supervisor = await member(owner.organizationId, "supervisor");
    const all = await getIndicatorsByFacility(supervisor, { preset: "7", now });
    expect(all.company).toBeDefined();
    expect(all.company).not.toHaveProperty("exitValue");
    expect(all.rows.every((row) => row.exits.value === undefined)).toBe(true);
  }, 120_000);

  it("with zones, each warehouse counts only what is inside them", async () => {
    const owner = await company({ facilities: 2 });
    const zoneA = await place(owner, "Zona A");
    const zoneB = await place(owner, "Zona B");
    const item = await product(owner, "Taladro");
    const now = new Date(Date.now() + 20 * DAY);
    for (const location of [zoneA, zoneB, zoneB]) {
      await exitAt(owner, {
        at: new Date(now.getTime() - DAY),
        productId: item,
        locationId: location,
        quantity: "1",
      });
    }
    const made = await createFacility(owner, { name: "Bodega Sur", code: "S" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const viewer = await member(owner.organizationId, "manager");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: viewer.userId,
      facilities: [
        { facilityId: await facilityOf(zoneA), zoneIds: [zoneA] },
        { facilityId: made.facilityId, zoneIds: [] },
      ],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const seen = await getIndicatorsByFacility(viewer, { preset: "7", now });
    const main = await facilityOf(zoneA);
    expect(seen.rows).toHaveLength(2);
    expect(seen.rows.find((r) => r.facilityId === main)!.exits.lines).toBe(1);
    expect(seen.company).toBeUndefined();
    const own = await getIndicatorsByFacility(owner, { preset: "7", now });
    expect(own.rows.find((r) => r.facilityId === main)!.exits.lines).toBe(3);
  }, 120_000);

  it("only for who reads indicators; read-only plan still reads", async () => {
    const { owner, now } = await twoWarehouses();
    for (const role of ["warehouse", "operator", "forklift", "viewer"]) {
      const someone = await member(owner.organizationId, role as Role);
      await expect(
        getIndicatorsByFacility(someone, { preset: "7", now }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    const manager = await member(owner.organizationId, "manager");
    expect(
      (await getIndicatorsByFacility(manager, { preset: "7", now })).rows,
    ).toHaveLength(2);
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * DAY),
        validUntil: new Date(Date.now() - DAY),
      },
    });
    invalidateEntitlements(owner.organizationId);
    expect(
      (await getIndicatorsByFacility(manager, { preset: "7", now })).rows,
    ).toHaveLength(2);
    const file = await buildExport(manager, {
      kind: "indicadores",
      format: "csv",
      indicators: { preset: "7" },
    });
    expect(file.ok).toBe(true);
  }, 120_000);

  it("a company without Inventario gets nothing", async () => {
    const owner = await company({ provision: false });
    await expect(getIndicatorsByFacility(owner)).rejects.toThrow();
    await expect(listOpenWorkByPerson(owner)).rejects.toThrow();
    await expect(
      buildExport(owner, { kind: "indicadores", format: "csv" }),
    ).rejects.toThrow();
  }, 60_000);

  it("reads the database a fixed number of times", async () => {
    const owner = await company({ facilities: 3 });
    await place(owner, "Zona Q");
    for (const code of ["Q2", "Q3"]) {
      const made = await createFacility(owner, {
        name: `Bodega ${code}`,
        code,
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
    }
    const queries = await countingQueries();
    try {
      queries.reset();
      const seen = await getIndicatorsByFacility(owner, { preset: "30" });
      expect(seen.rows).toHaveLength(3);
      expect(queries.count()).toBeLessThanOrEqual(BY_FACILITY_BUDGET);
    } finally {
      queries.restore();
    }
  }, 60_000);
});

describe("listOpenWorkByPerson", () => {
  async function scenario() {
    const owner = await company();
    const zoneA = await place(owner, "Zona A");
    const zoneB = await place(owner, "Zona B");
    const a1 = await place(owner, "Estante A1", zoneA);
    const a2 = await place(owner, "Estante A2", zoneA);
    const b1 = await place(owner, "Estante B1", zoneB);
    const b2 = await place(owner, "Estante B2", zoneB);
    const item = await product(owner, "Caja");
    await entry(owner, item, "20", a1);
    await entry(owner, item, "20", b1);
    const ana = await member(owner.organizationId, "operator", "Ana");
    const beto = await member(owner.organizationId, "operator", "Beto");
    const task = async (from: string, to: string, who: InventoryActor) => {
      const made = await createTask(owner, {
        productId: item,
        fromLocationId: from,
        toLocationId: to,
        quantity: "1",
        priority: "NORMAL",
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      const given = await assignTask(owner, made.taskId, who.userId);
      if (!given.ok) throw new Error(JSON.stringify(given));
      return made.taskId;
    };
    await task(a1, a2, ana);
    const blocked = await task(a1, a2, ana);
    await task(b1, b2, ana);
    await task(b1, b2, beto);
    expect(await acceptTask(ana, blocked)).toMatchObject({ ok: true });
    expect(await blockTask(ana, blocked, "No está el producto")).toMatchObject({
      ok: true,
    });
    // A task nobody took does not count.
    const loose = await createTask(owner, {
      productId: item,
      fromLocationId: a1,
      toLocationId: a2,
      quantity: "1",
      priority: "NORMAL",
    });
    if (!loose.ok) throw new Error(JSON.stringify(loose));
    return { owner, zoneA, zoneB, ana, beto };
  }

  it("counts what each person has open, as the list it opens", async () => {
    const { owner, ana, beto } = await scenario();
    const supervisor = await member(owner.organizationId, "supervisor");
    const seen = await listOpenWorkByPerson(supervisor);
    expect(seen.rows).toEqual([
      { userId: ana.userId, name: "Ana", open: 3, blocked: 1 },
      { userId: beto.userId, name: "Beto", open: 1, blocked: 0 },
    ]);
    for (const row of seen.rows) {
      const list = await listTasks(supervisor, {
        view: "open",
        person: row.userId,
      });
      expect(list.total).toBe(row.open);
      expect(list.person).toMatchObject({ userId: row.userId });
    }
    // Someone who is not in the team: the filter is ignored.
    const stranger = await company();
    const list = await listTasks(supervisor, {
      view: "open",
      person: stranger.userId,
    });
    expect(list.person).toBeNull();
    expect(list.total).toBe(5);
  }, 120_000);

  it("with zones, only what is inside them", async () => {
    const { owner, zoneA, ana, beto } = await scenario();
    const limited = await member(owner.organizationId, "supervisor");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: await facilityOf(zoneA), zoneIds: [zoneA] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const seen = await listOpenWorkByPerson(limited);
    expect(seen.rows).toEqual([
      { userId: ana.userId, name: "Ana", open: 2, blocked: 1 },
    ]);
    expect(JSON.stringify(seen)).not.toContain(beto.userId);
    const list = await listTasks(limited, {
      view: "open",
      person: beto.userId,
    });
    expect(list.total).toBe(0);
  }, 120_000);

  it("two companies never mix and the reads are few", async () => {
    const { owner } = await scenario();
    const other = await company();
    expect((await listOpenWorkByPerson(other)).rows).toEqual([]);
    const queries = await countingQueries();
    try {
      queries.reset();
      expect((await listOpenWorkByPerson(owner)).rows).toHaveLength(2);
      expect(queries.count()).toBeLessThanOrEqual(OPEN_WORK_BUDGET);
    } finally {
      queries.restore();
    }
  }, 120_000);
});

describe("export of the indicators", () => {
  const csvText = async (
    actor: InventoryActor,
    indicators: Record<string, string>,
  ) => {
    const file = await buildExport(actor, {
      kind: "indicadores",
      format: "csv",
      indicators,
    });
    if (!file.ok) throw new Error(JSON.stringify(file));
    return file.bytes.toString("utf8");
  };

  it("holds what the screen shows; money only with costs", async () => {
    const { owner } = await twoWarehouses();
    const supervisor = await member(owner.organizationId, "supervisor");
    const manager = await member(owner.organizationId, "manager");
    const byManager = await csvText(manager, { preset: "30" });
    expect(byManager).toContain("Resumen");
    expect(byManager).toContain("Pedidos despachados");
    expect(byManager).toContain("Periodo anterior");
    expect(byManager).toContain("Mayor movimiento");
    expect(byManager).toContain("Por persona");
    expect(byManager).toContain("Valor de lo que salió");
    expect(byManager).toContain("Martillo");
    const bySupervisor = await csvText(supervisor, { preset: "30" });
    expect(bySupervisor).not.toContain("Valor");
    expect(bySupervisor).not.toContain("$");
    expect(bySupervisor).toContain("Por persona");

    const xlsx = await buildExport(manager, {
      kind: "indicadores",
      format: "xlsx",
      indicators: { preset: "30" },
    });
    expect(xlsx.ok && xlsx.contentType).toContain("spreadsheetml");

    const trail = await db.auditEvent.findFirst({
      where: {
        organizationId: owner.organizationId,
        actorUserId: supervisor.userId,
        action: "inventory.export_created",
      },
      orderBy: { id: "desc" },
    });
    expect(trail?.targetId).toBe("indicadores");
    expect(JSON.stringify(trail?.metadata)).toContain("Indicadores de almacén");
    expect(JSON.stringify(trail?.metadata)).not.toContain("$");
  }, 120_000);

  it("by warehouse: only what the person reaches", async () => {
    const { owner, north } = await twoWarehouses();
    const limited = await member(owner.organizationId, "manager");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: north, zoneIds: [] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    const text = await csvText(limited, { view: "almacenes", preset: "30" });
    expect(text).toContain("Bodega Norte");
    expect(text).not.toContain("Principal");
    expect(text).not.toContain("Toda la empresa");
    const all = await csvText(owner, { view: "almacenes", preset: "30" });
    expect(all).toContain("Toda la empresa");
  }, 120_000);

  it("asks for the permission to export and to read the indicators", async () => {
    const { owner } = await twoWarehouses();
    // Consulta and Almacén export other files but do not read indicators.
    for (const role of ["viewer", "warehouse"] as Role[]) {
      const someone = await member(owner.organizationId, role);
      await expect(
        buildExport(someone, {
          kind: "indicadores",
          format: "csv",
          indicators: {},
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    const operator = await member(owner.organizationId, "operator");
    await expect(
      buildExport(operator, { kind: "indicadores", format: "xlsx" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }, 120_000);
});
