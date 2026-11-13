import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  ABC_CUTS,
  COUNT_REVIEW_THRESHOLD,
  applyCount,
  captureCount,
  countTodayCounts,
  createCountProgram,
  generateTodayCounts,
  getCount,
  getCountAccuracy,
  getCountProgram,
  listCountPage,
  listCountPrograms,
  openCount,
  reconcileStock,
  registerEntry,
  registerExit,
  runCycleCountRound,
  setCountProgramPaused,
  updateCountProgram,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  archiveLocation,
  createLocation,
  ensureTransitLocation,
  setStagingLocation,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-55 (ADR 0050): cycle count programs. The round never duplicates, a
// program goes round its locations a few a day, ABC counts A more often,
// and accuracy matches a known scenario.

const stamp = Date.now();
let counter = 0;
let staff = "";
const DAY = 86_400_000;

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `ciclicos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa cíclicos ${counter}`,
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
      productLimit: 200,
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de conteos cíclicos",
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

async function place(
  owner: InventoryActor,
  level: 1 | 2 | 3,
  parentId?: string,
) {
  const result = await createLocation(owner, {
    level,
    name: `Lugar ${++counter}`,
    ...(parentId ? { parentId } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

/** A zone with `n` empty shelves inside. */
async function zone(owner: InventoryActor, n: number) {
  const zoneId = await place(owner, 1);
  const shelves: string[] = [];
  for (let i = 0; i < n; i++) shelves.push(await place(owner, 3, zoneId));
  return { zoneId, shelves };
}

async function product(owner: InventoryActor) {
  const result = await createProduct(owner, {
    sku: `CC-${++counter}`,
    name: `Producto ${counter}`,
  });
  if (!result.ok) throw new Error("product setup failed");
  return result.productId;
}

async function enter(
  owner: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
) {
  const result = await registerEntry(owner, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

async function program(
  owner: InventoryActor,
  input: Partial<Parameters<typeof createCountProgram>[1]> = {},
) {
  const result = await createCountProgram(owner, {
    name: `Programa ${++counter}`,
    basis: "EVEN",
    everyDays: "3",
    locationsPerDay: "2",
    ...input,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.programId;
}

const generatedOf = (programId: string) =>
  db.stockCount.findMany({
    where: { programId },
    orderBy: { id: "asc" },
    select: { id: true, locationId: true, programDay: true, status: true },
  });

/** Counts and applies an open count: `found` of each product it holds. */
async function countAndApply(
  owner: InventoryActor,
  countId: string,
  found: Record<string, string>,
  extra: { reviewed?: boolean } = {},
) {
  for (const [productId, quantity] of Object.entries(found)) {
    const captured = await captureCount(owner, {
      countId,
      productId,
      quantity,
    });
    if (!captured.ok) throw new Error(JSON.stringify(captured));
  }
  return applyCount(owner, { countId, reason: "Conteo cíclico", ...extra });
}

async function setting(owner: InventoryActor, key: string, value: string) {
  const result = await updateOperationSetting(
    owner,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("programs", () => {
  it("validates what a program says and who may set it up", async () => {
    const owner = await company();
    expect(
      await createCountProgram(owner, {
        name: "",
        basis: "EVEN",
        everyDays: "3",
        locationsPerDay: "2",
      }),
    ).toMatchObject({ ok: false, field: "name" });
    expect(
      await createCountProgram(owner, {
        name: "Diario",
        basis: "EVEN",
        everyDays: "0",
        locationsPerDay: "2",
      }),
    ).toMatchObject({ ok: false, field: "everyDays" });
    expect(
      await createCountProgram(owner, {
        name: "Diario",
        basis: "EVEN",
        everyDays: "3",
        locationsPerDay: "900",
      }),
    ).toMatchObject({ ok: false, field: "locationsPerDay" });
    // ABC counts A at least as often as B, and B as C.
    expect(
      await createCountProgram(owner, {
        name: "ABC",
        basis: "ABC",
        everyDays: "7",
        everyDaysB: "3",
        everyDaysC: "30",
        locationsPerDay: "2",
      }),
    ).toMatchObject({ ok: false, field: "everyDaysB" });
    const id = await program(owner, { name: "Diario" });
    expect(
      await createCountProgram(owner, {
        name: "diario",
        basis: "EVEN",
        everyDays: "3",
        locationsPerDay: "2",
      }),
    ).toMatchObject({ ok: false, field: "name" });
    // The transit location and «Preparación» are not programs' places.
    const staging = await place(owner, 3);
    expect(await setStagingLocation(owner, staging)).toMatchObject({
      ok: true,
    });
    expect(
      await createCountProgram(owner, {
        name: "Preparación",
        rootLocationId: staging,
        basis: "EVEN",
        everyDays: "3",
        locationsPerDay: "2",
      }),
    ).toMatchObject({ ok: false, field: "rootLocationId" });

    // The floor counts; it does not set programs up.
    const operator = await member(owner.organizationId, "operator");
    await expect(
      createCountProgram(operator, {
        name: "Piso",
        basis: "EVEN",
        everyDays: "3",
        locationsPerDay: "2",
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(listCountPrograms(operator)).rejects.toMatchObject({
      kind: "forbidden",
    });
    const supervisor = await member(owner.organizationId, "supervisor");
    expect((await listCountPrograms(supervisor)).map((p) => p.id)).toEqual([
      id,
    ]);

    // Changing, pausing and resuming leave their trace.
    expect(
      await updateCountProgram(owner, id, {
        name: "Diario 2",
        basis: "ABC",
        everyDays: "1",
        everyDaysB: "7",
        everyDaysC: "30",
        locationsPerDay: "5",
      }),
    ).toMatchObject({ ok: true });
    expect(await setCountProgramPaused(owner, id, true)).toEqual({ ok: true });
    expect(await setCountProgramPaused(owner, id, true)).toEqual({
      ok: true,
      repeated: true,
    });
    expect(await getCountProgram(owner, id)).toMatchObject({
      name: "Diario 2",
      paused: true,
      frequency: "A cada día, B cada 7 días y C cada 30 días",
      plan: { nextRound: 0 },
    });
    expect(await generateTodayCounts(owner, id)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(await setCountProgramPaused(owner, id, false)).toEqual({ ok: true });
    const trail = await listAuditTrail(owner.organizationId, { limit: 20 });
    expect(trail.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "inventory.count_program_created",
        "inventory.count_program_changed",
      ]),
    );
    // Never deleted: paused.
    await expect(db.countProgram.delete({ where: { id } })).rejects.toThrow(
      /never deleted/,
    );
  }, 120_000);
});

describe("the round", () => {
  it("repeated, or twice at once, never duplicates the counts of a day", async () => {
    const owner = await company();
    const { zoneId, shelves } = await zone(owner, 5);
    const id = await program(owner, { rootLocationId: zoneId });
    const first = await runCycleCountRound(owner.organizationId);
    expect(first.created).toBe(2);
    expect((await runCycleCountRound(owner.organizationId)).created).toBe(0);
    await Promise.all([
      runCycleCountRound(owner.organizationId),
      runCycleCountRound(owner.organizationId),
      generateTodayCounts(owner, id),
    ]);
    const counts = await generatedOf(id);
    expect(counts).toHaveLength(2);
    expect(new Set(counts.map((count) => count.locationId)).size).toBe(2);
    // Only shelves: the zone holds others and no stock of its own.
    for (const count of counts) expect(shelves).toContain(count.locationId);
    expect(await generateTodayCounts(owner, id)).toMatchObject({
      ok: true,
      created: 0,
      already: 2,
    });
    // The database keeps program + day + location unique.
    await expect(
      db.stockCount.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          locationId: counts[0]!.locationId,
          status: "CANCELLED",
          closedAt: new Date(),
          programId: id,
          programDay: counts[0]!.programDay,
          startedByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
    // The day and the program of a generated count do not change.
    await expect(
      db.stockCount.update({
        where: { id: counts[0]!.id },
        data: { programDay: new Date("2020-01-01T00:00:00Z") },
      }),
    ).rejects.toThrow(/program and day/);
  }, 120_000);

  it("goes round all the locations, a few a day, and starts over", async () => {
    const owner = await company();
    const { zoneId, shelves } = await zone(owner, 5);
    const item = await product(owner);
    const id = await program(owner, {
      rootLocationId: zoneId,
      everyDays: "3",
      locationsPerDay: "2",
    });
    const now = Date.now();
    const seen: string[][] = [];
    for (let day = 0; day < 4; day++) {
      const result = await runCycleCountRound(owner.organizationId, {
        now: new Date(now + day * DAY),
      });
      const counts = (await generatedOf(id)).filter(
        (count) => count.status === "OPEN",
      );
      seen.push(counts.map((count) => count.locationId).sort());
      expect(result.created).toBe(counts.length);
      // Each is counted (nothing found, nothing expected) and applied.
      for (const count of counts) {
        expect(
          await countAndApply(owner, count.id, { [item]: "0" }),
        ).toMatchObject({ ok: true });
      }
    }
    expect(seen.map((day) => day.length)).toEqual([2, 2, 1, 2]);
    // The first three days cover every shelf once.
    expect(seen.slice(0, 3).flat().sort()).toEqual([...shelves].sort());
    // Then it starts over with the ones counted longest ago.
    expect(seen[3]).toEqual(seen[0]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 180_000);

  it("skips open counts, archived, transit and «Preparación» locations", async () => {
    const owner = await company();
    const busy = await place(owner, 3);
    const archived = await place(owner, 3);
    const staging = await place(owner, 3);
    const free = await place(owner, 3);
    expect(await setStagingLocation(owner, staging)).toMatchObject({
      ok: true,
    });
    expect(await archiveLocation(owner, archived)).toMatchObject({ ok: true });
    const facilityId = (
      await db.location.findFirstOrThrow({ where: { id: free } })
    ).facilityId;
    const transit = await forOrganization(owner.organizationId).$transaction(
      (tx) => ensureTransitLocation(tx, owner.organizationId, facilityId),
    );
    const opened = await openCount(owner, { locationId: busy });
    if (!opened.ok) throw new Error("count");
    const id = await program(owner, { locationsPerDay: "50" });
    await runCycleCountRound(owner.organizationId);
    const places = (await generatedOf(id)).map((count) => count.locationId);
    expect(places).toContain(free);
    for (const skipped of [busy, archived, staging, transit.id]) {
      expect(places).not.toContain(skipped);
    }
    // A paused program generates nothing.
    const paused = await program(owner, { locationsPerDay: "50" });
    await setCountProgramPaused(owner, paused, true);
    await runCycleCountRound(owner.organizationId, {
      now: new Date(Date.now() + 10 * DAY),
    });
    expect(await generatedOf(paused)).toEqual([]);
  }, 120_000);

  it("counts A more often than B, and B than C (known scenario)", async () => {
    const owner = await company();
    await setting(owner, ABC_CUTS.key, "50_30_20");
    const { zoneId, shelves } = await zone(owner, 4);
    const [s1, s2, s3, s4] = shelves as [string, string, string, string];
    const [p1, p2, p3] = [
      await product(owner),
      await product(owner),
      await product(owner),
    ];
    await enter(owner, p1, s1, "100");
    await enter(owner, p2, s2, "100");
    await enter(owner, p3, s3, "100");
    // Exit lines: 5, 3 and 2 of 10 → A, B and C with 50/30/20.
    for (const [productId, locationId, times] of [
      [p1, s1, 5],
      [p2, s2, 3],
      [p3, s3, 2],
    ] as const) {
      for (let i = 0; i < times; i++) {
        const exit = await registerExit(owner, {
          productId,
          locationId,
          quantity: "1",
        });
        if (!exit.ok) throw new Error(JSON.stringify(exit));
      }
    }
    const id = await program(owner, {
      rootLocationId: zoneId,
      basis: "ABC",
      everyDays: "1",
      everyDaysB: "3",
      everyDaysC: "10",
      locationsPerDay: "10",
    });
    expect((await getCountProgram(owner, id))?.plan.classes).toEqual({
      A: 1,
      B: 1,
      C: 2,
    });
    const now = Date.now();
    const byDay: string[][] = [];
    for (let day = 0; day < 4; day++) {
      await runCycleCountRound(owner.organizationId, {
        now: new Date(now + day * DAY),
      });
      const open = (await generatedOf(id)).filter(
        (count) => count.status === "OPEN",
      );
      byDay.push(open.map((count) => count.locationId).sort());
      for (const count of open) {
        const at = count.locationId;
        const held = at === s1 ? p1 : at === s2 ? p2 : at === s3 ? p3 : p1;
        const quantity =
          at === s4 ? "0" : at === s1 ? "95" : at === s2 ? "97" : "98";
        expect(
          await countAndApply(owner, count.id, { [held]: quantity }),
        ).toMatchObject({ ok: true });
      }
    }
    // Day 1 all of them; then A every day, B on its third day.
    expect(byDay[0]).toEqual([...shelves].sort());
    expect(byDay[1]).toEqual([s1]);
    expect(byDay[2]).toEqual([s1]);
    expect(byDay[3]).toEqual([s1, s2].sort());
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 240_000);
});

describe("today's counts", () => {
  it("show up in «De hoy» and in Inicio for who counts", async () => {
    const owner = await company();
    const { zoneId } = await zone(owner, 3);
    const id = await program(owner, {
      rootLocationId: zoneId,
      locationsPerDay: "3",
    });
    await runCycleCountRound(owner.organizationId);
    const operator = await member(owner.organizationId, "operator");
    expect(await countTodayCounts(operator)).toBe(3);
    const page = await listCountPage(operator, { view: "today" });
    expect(page.total).toBe(3);
    expect(page.items[0]).toMatchObject({
      status: "OPEN",
      programName: expect.stringContaining("Programa"),
    });
    const detail = await getCount(operator, page.items[0]!.id);
    expect(detail?.program?.id).toBe(id);
    // A count opened by hand today is «de hoy» too; it is not «programado».
    const shelf = await place(owner, 3);
    const manual = await openCount(owner, { locationId: shelf });
    if (!manual.ok) throw new Error("count");
    const again = await listCountPage(operator, { view: "today" });
    expect(again.total).toBe(4);
    expect(
      again.items.find((count) => count.id === manual.countId)?.programName,
    ).toBeNull();
  }, 120_000);

  it("of one company are not seen nor generated from another", async () => {
    const owner = await company();
    const other = await company();
    const { zoneId } = await zone(owner, 2);
    const id = await program(owner, { rootLocationId: zoneId });
    await runCycleCountRound(owner.organizationId);
    expect(await getCountProgram(other, id)).toBeNull();
    expect(await generateTodayCounts(other, id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await setCountProgramPaused(other, id, true)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await listCountPrograms(other)).toEqual([]);
    expect((await listCountPage(other, { view: "today" })).total).toBe(0);
    // The round of the other company generates nothing of this one.
    expect(await runCycleCountRound(other.organizationId)).toEqual({
      programs: 0,
      created: 0,
    });
  }, 120_000);
});

describe("scope by zone (WMS-20)", () => {
  it("someone limited to a zone sees only programs and counts inside it", async () => {
    const owner = await company();
    const inside = await zone(owner, 2);
    const outside = await zone(owner, 2);
    const mine = await program(owner, { rootLocationId: inside.zoneId });
    const theirs = await program(owner, { rootLocationId: outside.zoneId });
    const whole = await program(owner, { locationsPerDay: "50" });
    await runCycleCountRound(owner.organizationId);
    const supervisor = await member(owner.organizationId, "supervisor");
    const facilityId = (
      await db.location.findFirstOrThrow({ where: { id: inside.zoneId } })
    ).facilityId;
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: supervisor.userId,
      facilities: [{ facilityId, zoneIds: [inside.zoneId] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    expect((await listCountPrograms(supervisor)).map((p) => p.id)).toEqual([
      mine,
    ]);
    for (const hidden of [theirs, whole]) {
      expect(await getCountProgram(supervisor, hidden)).toBeNull();
      expect(await generateTodayCounts(supervisor, hidden)).toMatchObject({
        ok: false,
        reason: "not_found",
      });
    }
    // The whole warehouse is not theirs to program.
    await expect(
      createCountProgram(supervisor, {
        name: "Todo",
        basis: "EVEN",
        everyDays: "7",
        locationsPerDay: "5",
      }),
    ).rejects.toMatchObject({ code: "facility_out_of_scope" });
    const today = await listCountPage(supervisor, { view: "today" });
    expect(today.total).toBeGreaterThan(0);
    for (const count of today.items) {
      expect(inside.shelves).toContain(
        (await db.stockCount.findFirstOrThrow({ where: { id: count.id } }))
          .locationId,
      );
    }
  }, 120_000);
});

describe("review of big differences", () => {
  it("marks the count and asks to confirm the review with the reason", async () => {
    const owner = await company();
    const shelf = await place(owner, 3);
    const [a, b] = [await product(owner), await product(owner)];
    await enter(owner, a, shelf, "10");
    await enter(owner, b, shelf, "10");
    const opened = await openCount(owner, { locationId: shelf });
    if (!opened.ok) throw new Error("count");
    await captureCount(owner, {
      countId: opened.countId,
      productId: a,
      quantity: "5",
    });
    await captureCount(owner, {
      countId: opened.countId,
      productId: b,
      quantity: "9",
    });
    // Off by default: nothing is marked.
    expect((await getCount(owner, opened.countId))?.review).toBeNull();

    await setting(owner, COUNT_REVIEW_THRESHOLD.key, "25");
    const count = await getCount(owner, opened.countId);
    expect(count?.review).toEqual({
      lines: 1,
      thresholdText: "más de 25 % de diferencia",
      // WMS-41: without the company's approval rule, the review box.
      byApproval: false,
    });
    expect(count?.lines.find((line) => line.productId === a)?.needsReview).toBe(
      true,
    );
    expect(count?.lines.find((line) => line.productId === b)?.needsReview).toBe(
      false,
    );
    const refused = await applyCount(owner, {
      countId: opened.countId,
      reason: "Faltante en revisión",
    });
    expect(refused).toMatchObject({
      ok: false,
      field: "reviewed",
      review: [expect.stringContaining("Producto")],
    });
    // Nothing moved.
    expect(
      await db.stockMovement.count({
        where: { idempotencyKey: `count:${opened.countId}` },
      }),
    ).toBe(0);
    // Applying still takes the permission to apply counts.
    const operator = await member(owner.organizationId, "operator");
    await expect(
      applyCount(operator, {
        countId: opened.countId,
        reason: "Faltante revisado",
        reviewed: true,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      await applyCount(owner, {
        countId: opened.countId,
        reason: "Faltante revisado con el supervisor",
        reviewed: true,
      }),
    ).toMatchObject({ ok: true, adjusted: 2 });
    const event = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        action: "inventory.count_applied",
      },
    });
    expect(event.metadata).toMatchObject({
      revisado: true,
      productosRevisados: 1,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 120_000);
});

describe("accuracy", () => {
  /** A count of `n` products with 5 each, `wrong` of them found with 4. */
  async function scenario(owner: InventoryActor, n: number, wrong: number) {
    const shelf = await place(owner, 3);
    const opened = await openCount(owner, { locationId: shelf });
    if (!opened.ok) throw new Error("count");
    const found: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const item = await product(owner);
      await enter(owner, item, shelf, "5");
      found[item] = i < wrong ? "4" : "5";
    }
    const applied = await countAndApply(owner, opened.countId, found);
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    return opened.countId;
  }

  it("matches a known scenario, by week and by month, against the period before", async () => {
    const owner = await company();
    const lastWeek = await scenario(owner, 10, 2);
    // That count was applied a week ago (its history only).
    await db.stockCount.update({
      where: { id: lastWeek },
      data: { closedAt: new Date(Date.now() - 7 * DAY) },
    });
    await scenario(owner, 10, 1);

    const week = await getCountAccuracy(owner, { period: "week" });
    expect(week.current).toMatchObject({
      counts: 1,
      rows: 10,
      exact: 9,
      accuracy: "90.0",
      truncated: false,
      differenceValue: expect.stringMatching(/^\$/),
    });
    expect(week.previous).toMatchObject({
      rows: 10,
      exact: 8,
      accuracy: "80.0",
    });
    expect(week.change).toBe("+10.0");

    // By month: the count of a week ago may fall in this month or the one
    // before; this month always has the latest.
    const month = await getCountAccuracy(owner, { period: "month" });
    expect(month.current.rows + month.previous.rows).toBe(20);
    expect(month.current.rows).toBeGreaterThanOrEqual(10);
    expect(month.current.from.endsWith("-01")).toBe(true);
    expect(month.previous.from.endsWith("-01")).toBe(true);

    // Seen from next week, this week is «la semana pasada».
    const next = await getCountAccuracy(owner, {
      period: "week",
      now: new Date(Date.now() + 7 * DAY),
    });
    expect(next.current.rows).toBe(0);
    expect(next.previous.accuracy).toBe("90.0");
    expect(next.change).toBeNull();

    // Without costs, the value of the differences does not exist.
    const supervisor = await member(owner.organizationId, "supervisor");
    const seen = await getCountAccuracy(supervisor, { period: "week" });
    expect(seen.current.accuracy).toBe("90.0");
    expect("differenceValue" in seen.current).toBe(false);
    // The floor does not read accuracy.
    const operator = await member(owner.organizationId, "operator");
    await expect(getCountAccuracy(operator)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 180_000);

  it("can be narrowed to the counts of one program", async () => {
    const owner = await company();
    const { zoneId } = await zone(owner, 1);
    const item = await product(owner);
    const id = await program(owner, { rootLocationId: zoneId });
    await runCycleCountRound(owner.organizationId);
    const [generated] = await generatedOf(id);
    expect(
      await countAndApply(owner, generated!.id, { [item]: "0" }),
    ).toMatchObject({ ok: true });
    const shelf = await place(owner, 3);
    const manual = await openCount(owner, { locationId: shelf });
    if (!manual.ok) throw new Error("count");
    expect(
      await countAndApply(owner, manual.countId, { [item]: "0" }),
    ).toMatchObject({ ok: true });
    expect(
      (await getCountAccuracy(owner, { programId: id })).current,
    ).toMatchObject({ counts: 1, rows: 1, exact: 1, accuracy: "100.0" });
    expect((await getCountAccuracy(owner)).current.counts).toBe(2);
  }, 120_000);
});
