import "server-only";

import { z } from "zod";

import { dec, log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  assertLocationsInScope,
  ARCHIVED_FACILITY_MESSAGE,
  assertWholeFacilityInScope,
  holdOpenFacility,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
  type LocationScopeReader,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import {
  classifyAbc,
  locationClass,
  parseAbcCuts,
  type AbcClass,
} from "./abc-rules";
import { dayWindow, type DayWindow } from "./calendar-day";
import type { InventoryActor } from "./movements";
import { ABC_BASIS, ABC_CUTS, ABC_PERIOD } from "./settings";

/**
 * Cycle counts (WMS-55, ADR 0050). A program of a warehouse says what it
 * covers (a location with all it holds, or the whole warehouse), how often
 * each location is counted — the same for all, or by the ABC class of what
 * it holds — and how many locations a day at most. A round of the worker
 * generates, for each active program, the counts of the day: ordinary
 * counts of one location (INV-31), marked with their program and day.
 *
 * Generating twice never duplicates: the program is locked, what it already
 * generated that day is counted under the lock, and the database keeps
 * program + day + location unique. A location with an open count, an
 * archived one, the transit location and «Preparación» are never generated.
 */

type Tx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];
type Reader = Pick<
  Tx,
  | "membership"
  | "location"
  | "stockBalance"
  | "stockCount"
  | "stockMovementLine"
  | "productCost"
  | "organizationSetting"
>;

export const PROGRAM_BASIS_LABELS = {
  EVEN: "Todas las ubicaciones por igual",
  ABC: "Por clasificación ABC",
} as const;

export type CountProgramBasis = keyof typeof PROGRAM_BASIS_LABELS;

/** Locations a program can hold in its plan at once. */
const MAX_LOCATIONS = 20_000;

type Failure<Field extends string> = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  field?: Field;
  error: string;
};

class Rejected<Field extends string> extends Error {
  constructor(readonly result: Failure<Field>) {
    super("count program rejected");
  }
}

const reject = <Field extends string>(
  reason: Failure<Field>["reason"],
  error: string,
  field?: Field,
): never => {
  throw new Rejected<Field>({ ok: false, reason, field, error });
};

export type ProgramField =
  | "name"
  | "rootLocationId"
  | "basis"
  | "everyDays"
  | "everyDaysB"
  | "everyDaysC"
  | "locationsPerDay";

const days = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `Escribe ${what}.`)
    .regex(/^\d{1,3}$/, `Escribe ${what} con un número entero.`)
    .transform(Number)
    .refine(
      (value) => value >= 1 && value <= 365,
      "Escribe entre 1 y 365 días.",
    );

const programSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Escribe un nombre para el programa.")
      .max(80, "El nombre es demasiado largo (máximo 80 caracteres).")
      .regex(
        /^[^\u0000-\u001f\u007f]*$/,
        "Quita los saltos de línea o tabuladores.",
      ),
    rootLocationId: z
      .string()
      .trim()
      .max(36)
      .optional()
      .transform((value) => value || null),
    basis: z.enum(["EVEN", "ABC"], {
      message: "Elige cómo se reparte el conteo.",
    }),
    everyDays: days("cada cuántos días se cuenta"),
    everyDaysB: z.string().trim().max(3).optional(),
    everyDaysC: z.string().trim().max(3).optional(),
    locationsPerDay: z
      .string()
      .trim()
      .min(1, "Escribe cuántas ubicaciones contar por día.")
      .regex(/^\d{1,3}$/, "Escribe un número entero de ubicaciones.")
      .transform(Number)
      .refine(
        (value) => value >= 1 && value <= 500,
        "Escribe entre 1 y 500 ubicaciones por día.",
      ),
  })
  .superRefine((data, context) => {
    if (data.basis !== "ABC") return;
    const parsed = {
      everyDaysB: days("cada cuántos días se cuenta la clase B").safeParse(
        data.everyDaysB ?? "",
      ),
      everyDaysC: days("cada cuántos días se cuenta la clase C").safeParse(
        data.everyDaysC ?? "",
      ),
    };
    for (const field of ["everyDaysB", "everyDaysC"] as const) {
      const result = parsed[field];
      if (!result.success) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: result.error.issues[0]!.message,
        });
      }
    }
    const b = parsed.everyDaysB.success ? parsed.everyDaysB.data : null;
    const c = parsed.everyDaysC.success ? parsed.everyDaysC.data : null;
    if (b !== null && b < data.everyDays) {
      context.addIssue({
        code: "custom",
        path: ["everyDaysB"],
        message:
          "La clase B se cuenta igual o menos seguido que la A: escribe tantos días como la A o más.",
      });
    } else if (b !== null && c !== null && c < b) {
      context.addIssue({
        code: "custom",
        path: ["everyDaysC"],
        message:
          "La clase C se cuenta igual o menos seguido que la B: escribe tantos días como la B o más.",
      });
    }
  });

export type ProgramInput = z.input<typeof programSchema>;

export type ProgramResult =
  { ok: true; programId: string } | Failure<ProgramField>;

function parseProgram(input: ProgramInput) {
  const parsed = programSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return {
      ok: false as const,
      reason: "invalid" as const,
      field: issue.path[0] as ProgramField,
      error: issue.message,
    };
  }
  const data = parsed.data;
  return {
    ok: true as const,
    data: {
      name: data.name,
      rootLocationId: data.rootLocationId,
      basis: data.basis,
      everyDays: data.everyDays,
      everyDaysB: data.basis === "ABC" ? Number(data.everyDaysB) : null,
      everyDaysC: data.basis === "ABC" ? Number(data.everyDaysC) : null,
      locationsPerDay: data.locationsPerDay,
    },
  };
}

const nameClash = (error: unknown) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes("name");

const NAME_TAKEN = "Ya hay un programa con ese nombre en este almacén.";

/**
 * The root a program may cover: a location of its warehouse, not archived,
 * not the transit location nor «Preparación», inside the person's scope.
 * Without a root the program covers the whole warehouse, which takes the
 * whole warehouse in scope (WMS-20).
 */
async function checkRoot(
  tx: Tx,
  userId: string,
  facilityId: string,
  rootLocationId: string | null,
): Promise<string | null> {
  if (!rootLocationId) {
    await assertWholeFacilityInScope(tx, userId, facilityId);
    return null;
  }
  const [id] = await lockRows(tx, "location", [rootLocationId.slice(0, 36)]);
  const root = id
    ? await tx.location.findFirst({
        where: { id, facilityId, isTransit: null },
        select: { id: true, name: true, archivedAt: true, isStaging: true },
      })
    : null;
  if (!root) {
    return reject(
      "not_found",
      "Esa ubicación ya no existe en este almacén. Elige otra.",
      "rootLocationId",
    );
  }
  await assertLocationsInScope(tx, userId, [root.id]);
  if (root.archivedAt) {
    return reject(
      "not_allowed",
      `«${root.name}» está archivada. Elige otra ubicación.`,
      "rootLocationId",
    );
  }
  if (root.isStaging) {
    return reject(
      "not_allowed",
      "«Preparación» no entra en un programa: lo que espera ahí ya va apartado para un pedido.",
      "rootLocationId",
    );
  }
  return root.id;
}

/** Creates a program in the warehouse the person works in. */
export async function createCountProgram(
  actor: InventoryActor,
  input: ProgramInput,
): Promise<ProgramResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.count_program.manage",
  );
  const parsed = parseProgram(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      const facility = await activeFacilityOf(tx, userId);
      // WMS-82 (ADR 0077): its warehouse, shared, before its root location.
      if (!(await holdOpenFacility(tx, facility.id))) {
        reject("not_allowed", ARCHIVED_FACILITY_MESSAGE);
      }
      const rootLocationId = await checkRoot(
        tx,
        userId,
        facility.id,
        data.rootLocationId,
      );
      const programId = newId();
      await tx.countProgram.create({
        data: {
          id: programId,
          organizationId,
          facilityId: facility.id,
          ...data,
          rootLocationId,
          createdByUserId: userId,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.count_program_created",
        target: { type: "count_program", id: programId },
        metadata: {
          nombre: data.name,
          almacen: facility.name,
          forma: data.basis,
          cadaDias: data.everyDays,
          porDia: data.locationsPerDay,
        },
      });
      return { ok: true as const, programId };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result as ProgramResult;
    if (nameClash(error)) {
      return { ok: false, reason: "invalid", field: "name", error: NAME_TAKEN };
    }
    throw error;
  }
}

/**
 * WMS-20: a program exists for who reaches what it covers — its root, or
 * the whole warehouse when it has none.
 */
async function programInScope(
  client: LocationScopeReader,
  userId: string,
  program: { facilityId: string; rootLocationId: string | null },
): Promise<boolean> {
  if (program.rootLocationId) {
    return (
      (await locationsOutOfScope(client, userId, [program.rootLocationId]))
        .length === 0
    );
  }
  try {
    await assertWholeFacilityInScope(client, userId, program.facilityId);
    return true;
  } catch {
    return false;
  }
}

/** Locks a program the person reaches; `null` when it does not exist. */
async function lockProgram(tx: Tx, userId: string, programId: string) {
  const [id] = await lockRows(tx, "countProgram", [
    String(programId).slice(0, 36),
  ]);
  const program = id
    ? await tx.countProgram.findFirst({
        where: { id },
        select: {
          id: true,
          name: true,
          facilityId: true,
          rootLocationId: true,
          pausedAt: true,
        },
      })
    : null;
  if (!program || !(await programInScope(tx, userId, program))) {
    return reject("not_found", "Ese programa ya no existe.");
  }
  return program;
}

/** Changes what a program covers, how often and how much. */
export async function updateCountProgram(
  actor: InventoryActor,
  programId: string,
  input: ProgramInput,
): Promise<ProgramResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.count_program.manage",
  );
  const parsed = parseProgram(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      const program = await lockProgram(tx, userId, programId);
      const rootLocationId = await checkRoot(
        tx,
        userId,
        program.facilityId,
        data.rootLocationId,
      );
      await tx.countProgram.updateMany({
        where: { id: program.id },
        data: { ...data, rootLocationId },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.count_program_changed",
        target: { type: "count_program", id: program.id },
        metadata: {
          nombre: data.name,
          forma: data.basis,
          cadaDias: data.everyDays,
          porDia: data.locationsPerDay,
        },
      });
      return { ok: true as const, programId: program.id };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result as ProgramResult;
    if (nameClash(error)) {
      return { ok: false, reason: "invalid", field: "name", error: NAME_TAKEN };
    }
    throw error;
  }
}

export type PauseResult = { ok: true; repeated?: true } | Failure<never>;

/** Pauses a program (the round skips it) or puts it back to work. */
export async function setCountProgramPaused(
  actor: InventoryActor,
  programId: string,
  paused: boolean,
): Promise<PauseResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.count_program.manage",
  );
  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      const program = await lockProgram(tx, userId, programId);
      if ((program.pausedAt !== null) === paused) {
        return { ok: true as const, repeated: true as const };
      }
      await tx.countProgram.updateMany({
        where: { id: program.id },
        data: { pausedAt: paused ? new Date() : null },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.count_program_changed",
        target: { type: "count_program", id: program.id },
        metadata: { nombre: program.name, pausado: paused },
      });
      return { ok: true as const };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result as PauseResult;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The plan: which locations a program counts today.

/** A day of the calendar moved by some days: «2026-11-12» − 3. */
export function shiftDay(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

/** The DATE column of a day of the calendar. */
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);

type ProgramRow = {
  id: string;
  facilityId: string;
  rootLocationId: string | null;
  basis: CountProgramBasis;
  everyDays: number;
  everyDaysB: number | null;
  everyDaysC: number | null;
  locationsPerDay: number;
};

const PROGRAM_SELECT = {
  id: true,
  facilityId: true,
  rootLocationId: true,
  basis: true,
  everyDays: true,
  everyDaysB: true,
  everyDaysC: true,
  locationsPerDay: true,
} as const;

/** ABC classes of a warehouse, computed once per round (see the ADR). */
export type AbcCache = Map<string, Promise<Map<string, AbcClass>>>;

/**
 * ABC classes of the products of a warehouse, from its exits (manual exits
 * and shipments) of the period the company chose. By exit lines, or by
 * the value of what left: quantity × today's average cost. Two grouped
 * queries; nothing is stored.
 */
export async function abcClassesOf(
  client: Reader,
  facilityId: string,
  now: Date,
): Promise<Map<string, AbcClass>> {
  const [basis, cuts, period] = await Promise.all([
    readSetting(client, ABC_BASIS),
    readSetting(client, ABC_CUTS),
    readSetting(client, ABC_PERIOD),
  ]);
  const since = new Date(now.getTime() - Number(period) * 86_400_000);
  const rows = await client.stockMovementLine.groupBy({
    by: ["productId"],
    where: {
      direction: "OUT",
      createdAt: { gte: since },
      location: { facilityId },
      movement: { type: { in: ["EXIT", "SHIPMENT"] } },
    },
    _count: { _all: true },
    _sum: { baseQuantity: true },
  });
  let measured: { productId: string; amount: string }[];
  if (basis === "value") {
    const costs = new Map<string, string>();
    for (let start = 0; start < rows.length; start += 1_000) {
      const found = await client.productCost.findMany({
        where: {
          productId: {
            in: rows.slice(start, start + 1_000).map((row) => row.productId),
          },
        },
        select: { productId: true, averageCost: true },
      });
      for (const row of found) {
        costs.set(row.productId, row.averageCost.toString());
      }
    }
    measured = rows.map((row) => ({
      productId: row.productId,
      amount: dec((row._sum.baseQuantity ?? 0).toString())
        .times(costs.get(row.productId) ?? 0)
        .toString(),
    }));
  } else {
    measured = rows.map((row) => ({
      productId: row.productId,
      amount: String(row._count._all),
    }));
  }
  return classifyAbc(measured, parseAbcCuts(cuts));
}

export type PlannedLocation = {
  locationId: string;
  /** With ABC, the class of what it holds. */
  abcClass: AbcClass | null;
  /** Last time a count of it was applied; null = never. */
  lastCountedAt: Date | null;
};

export type ProgramPlan = {
  /** Locations the program covers and counts. */
  covered: number;
  /** Covered locations with an open count now. */
  open: number;
  /** Locations due today, in the order they are generated. */
  due: PlannedLocation[];
  /** With ABC, covered locations by class. */
  classes: Record<AbcClass, number> | null;
};

/**
 * Which locations of a program are due today, oldest count first.
 *
 * Covered: the root (or the whole warehouse) and everything inside it,
 * except archived locations, the transit location and «Preparación»; of
 * those, the ones that hold stock or hold no other location (a location
 * that only groups others, like a zone, is not counted by itself).
 *
 * Due: never counted, or its last applied count was on or before
 * `today − frequency`. With ABC the frequency is the one of its class.
 */
export async function planProgram(
  client: Reader,
  program: ProgramRow,
  window: DayWindow,
  cache?: AbcCache,
): Promise<ProgramPlan> {
  const { facilityId } = program;
  const locations = await client.location.findMany({
    where: { facilityId, archivedAt: null, isTransit: null },
    take: MAX_LOCATIONS,
    orderBy: { id: "asc" },
    select: { id: true, parentId: true, isStaging: true },
  });
  const children = new Map<string, string[]>();
  for (const location of locations) {
    if (!location.parentId) continue;
    const list = children.get(location.parentId) ?? [];
    list.push(location.id);
    children.set(location.parentId, list);
  }
  let inside: Set<string>;
  if (program.rootLocationId) {
    inside = new Set();
    const pending = [program.rootLocationId];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (inside.has(id)) continue;
      inside.add(id);
      pending.push(...(children.get(id) ?? []));
    }
    // An archived root leaves nothing to count.
    if (!locations.some((location) => location.id === program.rootLocationId)) {
      inside.clear();
    }
  } else {
    inside = new Set(locations.map((location) => location.id));
  }
  const staging = new Set(
    locations.filter((location) => location.isStaging).map((row) => row.id),
  );

  const held = await client.stockBalance.groupBy({
    by: ["locationId", "productId"],
    where: { location: { facilityId }, quantity: { gt: 0 } },
    orderBy: [{ locationId: "asc" }, { productId: "asc" }],
    take: 100_000,
  });
  const productsAt = new Map<string, string[]>();
  for (const row of held) {
    const list = productsAt.get(row.locationId) ?? [];
    list.push(row.productId);
    productsAt.set(row.locationId, list);
  }
  const covered = [...inside].filter(
    (id) => !staging.has(id) && (productsAt.has(id) || !children.has(id)),
  );

  const [applied, openRows] = await Promise.all([
    client.stockCount.groupBy({
      by: ["locationId"],
      where: { status: "APPLIED", location: { facilityId } },
      _max: { closedAt: true },
    }),
    client.stockCount.findMany({
      where: { status: "OPEN", location: { facilityId } },
      select: { locationId: true },
    }),
  ]);
  const last = new Map(
    applied.map((row) => [row.locationId, row._max.closedAt ?? null]),
  );
  const open = new Set(openRows.map((row) => row.locationId));

  let classes: Map<string, AbcClass> | null = null;
  if (program.basis === "ABC") {
    let pending = cache?.get(facilityId);
    if (!pending) {
      pending = abcClassesOf(client, facilityId, window.range.gte);
      cache?.set(facilityId, pending);
    }
    classes = await pending;
  }
  const frequency = {
    A: program.everyDays,
    B: program.everyDaysB ?? program.everyDays,
    C: program.everyDaysC ?? program.everyDays,
  };
  // A location is due when its last count started before this moment.
  const thresholds = new Map<number, Date>();
  for (const every of new Set(Object.values(frequency))) {
    const edge = await dayWindow(client, shiftDay(window.day, 1 - every));
    if (!edge) throw new Error("Unreadable day for a count program");
    thresholds.set(every, edge.range.gte);
  }
  const byClass: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  const due: PlannedLocation[] = [];
  let openCovered = 0;
  for (const locationId of covered) {
    const abcClass = classes
      ? locationClass(productsAt.get(locationId) ?? [], classes)
      : null;
    if (abcClass) byClass[abcClass] += 1;
    if (open.has(locationId)) {
      openCovered += 1;
      continue;
    }
    const lastCountedAt = last.get(locationId) ?? null;
    const every = frequency[abcClass ?? "A"];
    if (lastCountedAt && lastCountedAt >= thresholds.get(every)!) continue;
    due.push({ locationId, abcClass, lastCountedAt });
  }
  const rank = { A: 0, B: 1, C: 2 };
  due.sort(
    (a, b) =>
      (a.lastCountedAt?.getTime() ?? 0) - (b.lastCountedAt?.getTime() ?? 0) ||
      rank[a.abcClass ?? "A"] - rank[b.abcClass ?? "A"] ||
      (a.locationId < b.locationId ? -1 : 1),
  );
  return {
    covered: covered.length,
    open: openCovered,
    due,
    classes: classes ? byClass : null,
  };
}

// ---------------------------------------------------------------------------
// Generation.

export type GenerateResult = {
  /** The day generated, in the company's calendar. */
  day: string;
  /** Counts created now. */
  created: number;
  /** Counts the program already had for that day. */
  already: number;
};

/**
 * Generates the counts of today of one program (the round's work for it).
 * Safe to run again and at the same time: the program is locked, what it
 * generated today is counted under the lock, and the locations chosen are
 * locked and checked again (an open count, archived) before creating.
 */
async function generateFor(
  organizationId: string,
  programId: string,
  now: Date,
  cache?: AbcCache,
): Promise<GenerateResult | null> {
  return forOrganization(organizationId).$transaction(
    async (tx) => {
      const [id] = await lockRows(tx, "countProgram", [programId]);
      const program = id
        ? await tx.countProgram.findFirst({
            where: { id },
            select: {
              ...PROGRAM_SELECT,
              pausedAt: true,
              createdByUserId: true,
              facility: { select: { archivedAt: true } },
            },
          })
        : null;
      if (!program || program.pausedAt || program.facility.archivedAt) {
        return null;
      }
      const window = await dayWindow(tx, now);
      if (!window) throw new Error("Unreadable day for a count program");
      const programDay = dateOf(window.day);
      const already = await tx.stockCount.count({
        where: { programId: program.id, programDay },
      });
      const room = program.locationsPerDay - already;
      if (room <= 0) return { day: window.day, created: 0, already };
      const plan = await planProgram(tx, program, window, cache);
      // A few more than room: some may have changed before their lock.
      const chosen = plan.due.slice(0, room + 20).map((row) => row.locationId);
      const locked = new Set(await lockRows(tx, "location", chosen));
      const [busy, gone, taken] = await Promise.all([
        tx.stockCount.findMany({
          where: { openLocationId: { in: [...locked] } },
          select: { locationId: true },
        }),
        tx.location.findMany({
          where: { id: { in: [...locked] }, archivedAt: { not: null } },
          select: { id: true },
        }),
        tx.stockCount.findMany({
          where: { programId: program.id, programDay },
          select: { locationId: true },
        }),
      ]);
      const skip = new Set([
        ...busy.map((row) => row.locationId),
        ...gone.map((row) => row.id),
        ...taken.map((row) => row.locationId),
      ]);
      const final = chosen
        .filter((locationId) => locked.has(locationId) && !skip.has(locationId))
        .slice(0, room);
      if (final.length > 0) {
        await tx.stockCount.createMany({
          data: final.map((locationId) => ({
            id: newId(),
            organizationId,
            locationId,
            openLocationId: locationId,
            programId: program.id,
            programDay,
            // Who set the program up stands for who started its counts.
            startedByUserId: program.createdByUserId,
          })),
        });
      }
      return { day: window.day, created: final.length, already };
    },
    { ...LOCKING_TRANSACTION, timeout: 60_000, maxWait: 15_000 },
  );
}

const isCountClash = (error: unknown) =>
  (error as { code?: string }).code === "P2002";

/**
 * The scheduled round (worker, once an hour): every active program of the
 * company generates its counts of today. A program that fails is logged
 * and does not stop the others; running it again is harmless.
 */
export async function runCycleCountRound(
  organizationId: string,
  options: { now?: Date } = {},
): Promise<{ programs: number; created: number }> {
  const now = options.now ?? new Date();
  const programs = await forOrganization(organizationId).countProgram.findMany({
    where: { pausedAt: null, facility: { archivedAt: null } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const cache: AbcCache = new Map();
  let created = 0;
  for (const program of programs) {
    try {
      const result = await generateFor(organizationId, program.id, now, cache);
      created += result?.created ?? 0;
    } catch (error) {
      // Two rounds at once can still meet at the unique key: the other
      // one created it, which is what was wanted.
      if (isCountClash(error)) continue;
      log.error("cycle_count_program_failed", error, {
        organizationId,
        programId: program.id,
      });
    }
  }
  return { programs: programs.length, created };
}

export type GenerateNowResult =
  ({ ok: true; summary: string } & GenerateResult) | Failure<never>;

/**
 * «Generar los de hoy»: what the round would do for one program, right
 * now, for who manages programs (the round runs once an hour).
 */
export async function generateTodayCounts(
  actor: InventoryActor,
  programId: string,
  options: { now?: Date } = {},
): Promise<GenerateNowResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.count_program.manage",
  );
  const client = forOrganization(organizationId);
  const program = await client.countProgram.findFirst({
    where: { id: String(programId).slice(0, 36) },
    select: {
      id: true,
      facilityId: true,
      rootLocationId: true,
      pausedAt: true,
    },
  });
  if (!program || !(await programInScope(client, userId, program))) {
    return {
      ok: false,
      reason: "not_found",
      error: "Ese programa ya no existe.",
    };
  }
  if (program.pausedAt) {
    return {
      ok: false,
      reason: "not_allowed",
      error: "El programa está en pausa: reanúdalo para generar sus conteos.",
    };
  }
  let result: GenerateResult | null;
  try {
    result = await generateFor(
      organizationId,
      program.id,
      options.now ?? new Date(),
    );
  } catch (error) {
    if (!isCountClash(error)) throw error;
    result = await generateFor(
      organizationId,
      program.id,
      options.now ?? new Date(),
    );
  }
  if (!result) {
    return {
      ok: false,
      reason: "not_allowed",
      error: "Este programa no puede generar conteos ahora.",
    };
  }
  const n = result.created;
  return {
    ok: true,
    ...result,
    summary:
      n === 0
        ? result.already > 0
          ? "Los conteos de hoy de este programa ya estaban generados."
          : "Hoy no le toca contar ninguna ubicación a este programa."
        : n === 1
          ? "Se generó 1 conteo para hoy."
          : `Se generaron ${n.toLocaleString("es-MX")} conteos para hoy.`,
  };
}

// ---------------------------------------------------------------------------
// Reading.

export type CountProgramSummary = {
  id: string;
  name: string;
  /** «Zona A», or «Todo el almacén». */
  covers: string;
  rootLocationId: string | null;
  basis: CountProgramBasis;
  basisLabel: string;
  /** «Cada 7 días», «A cada 7, B cada 30 y C cada 90 días». */
  frequency: string;
  everyDays: number;
  everyDaysB: number | null;
  everyDaysC: number | null;
  locationsPerDay: number;
  paused: boolean;
  /** Counts it generated for today, and how many of them are still open. */
  today: { generated: number; open: number };
};

const frequencyText = (program: {
  basis: CountProgramBasis;
  everyDays: number;
  everyDaysB: number | null;
  everyDaysC: number | null;
}) => {
  const each = (n: number) => (n === 1 ? "cada día" : `cada ${n} días`);
  return program.basis === "ABC"
    ? `A ${each(program.everyDays)}, B ${each(program.everyDaysB ?? 0)} y C ${each(program.everyDaysC ?? 0)}`
    : `${each(program.everyDays).replace(/^c/, "C")}`;
};

const SUMMARY_SELECT = {
  ...PROGRAM_SELECT,
  name: true,
  pausedAt: true,
  rootLocation: { select: { name: true, parent: LOCATION_PARENTS } },
} as const;

async function summaries(
  client: ReturnType<typeof forOrganization>,
  rows: {
    id: string;
    name: string;
    rootLocationId: string | null;
    basis: CountProgramBasis;
    everyDays: number;
    everyDaysB: number | null;
    everyDaysC: number | null;
    locationsPerDay: number;
    pausedAt: Date | null;
    rootLocation: Parameters<typeof locationPath>[0] | null;
  }[],
  day: string,
): Promise<CountProgramSummary[]> {
  const ids = rows.map((row) => row.id);
  const today =
    ids.length === 0
      ? []
      : await client.stockCount.groupBy({
          by: ["programId", "status"],
          where: { programId: { in: ids }, programDay: dateOf(day) },
          _count: { _all: true },
        });
  return rows.map((row) => {
    const mine = today.filter((group) => group.programId === row.id);
    return {
      id: row.id,
      name: row.name,
      covers: row.rootLocation
        ? locationPath(row.rootLocation)
        : "Todo el almacén",
      rootLocationId: row.rootLocationId,
      basis: row.basis,
      basisLabel: PROGRAM_BASIS_LABELS[row.basis],
      frequency: frequencyText(row),
      everyDays: row.everyDays,
      everyDaysB: row.everyDaysB,
      everyDaysC: row.everyDaysC,
      locationsPerDay: row.locationsPerDay,
      paused: row.pausedAt !== null,
      today: {
        generated: mine.reduce((sum, group) => sum + group._count._all, 0),
        open: mine
          .filter((group) => group.status === "OPEN")
          .reduce((sum, group) => sum + group._count._all, 0),
      },
    };
  });
}

/** The programs of the warehouse the person works in, active first. */
export async function listCountPrograms(
  actor: InventoryActor,
): Promise<CountProgramSummary[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.count_program.read",
  );
  const client = forOrganization(actor.organizationId);
  const [facility, window] = await Promise.all([
    activeFacilityOf(client, actor.userId),
    dayWindow(client, new Date()),
  ]);
  if (!window) throw new Error("Unreadable day for count programs");
  const rows = await client.countProgram.findMany({
    where: { facilityId: facility.id },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
    select: SUMMARY_SELECT,
  });
  const visible = [];
  for (const row of rows) {
    if (await programInScope(client, actor.userId, row)) visible.push(row);
  }
  return (await summaries(client, visible, window.day)).sort(
    (a, b) => Number(a.paused) - Number(b.paused),
  );
}

export type CountProgramDetail = CountProgramSummary & {
  /** What the round would generate today if it ran now. */
  plan: {
    covered: number;
    open: number;
    dueToday: number;
    /** What today still has room for: at most the locations per day. */
    nextRound: number;
    classes: Record<AbcClass, number> | null;
    /** Days for one full turn of every covered location. */
    turnDays: number | null;
  };
};

/** One program and what it would generate today; null if out of reach. */
export async function getCountProgram(
  actor: InventoryActor,
  programId: string,
): Promise<CountProgramDetail | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.count_program.read",
  );
  const client = forOrganization(actor.organizationId);
  const [facility, window] = await Promise.all([
    activeFacilityOf(client, actor.userId),
    dayWindow(client, new Date()),
  ]);
  if (!window) throw new Error("Unreadable day for count programs");
  const row = await client.countProgram.findFirst({
    where: { id: String(programId).slice(0, 36), facilityId: facility.id },
    select: SUMMARY_SELECT,
  });
  if (!row || !(await programInScope(client, actor.userId, row))) return null;
  const [summary] = await summaries(client, [row], window.day);
  const plan = await planProgram(client, row, window);
  const room = Math.max(row.locationsPerDay - summary!.today.generated, 0);
  return {
    ...summary!,
    plan: {
      covered: plan.covered,
      open: plan.open,
      dueToday: plan.due.length,
      nextRound: row.pausedAt ? 0 : Math.min(room, plan.due.length),
      classes: plan.classes,
      turnDays:
        plan.covered === 0
          ? null
          : Math.ceil(plan.covered / row.locationsPerDay),
    },
  };
}

/**
 * «De hoy» (WMS-55): counts generated for today and counts opened by hand
 * today, in the warehouse the person works in and inside their scope. The
 * list of `/conteos?vista=hoy` and the number of Inicio share it.
 */
export async function todayCountsWhere(
  client: ReturnType<typeof forOrganization>,
  userId: string,
  now: Date = new Date(),
) {
  const [window, facility, scoped] = await Promise.all([
    dayWindow(client, now),
    activeFacilityOf(client, userId),
    locationScopeWhere(client, userId),
  ]);
  if (!window) throw new Error("Unreadable day for today's counts");
  return {
    day: window.day,
    where: {
      location: {
        facilityId: facility.id,
        ...(isLimited(scoped) ? scoped : {}),
      },
      OR: [
        { programDay: dateOf(window.day) },
        { programDay: null, startedAt: window.range },
      ],
    },
  };
}

/** «Conteos de hoy» of Inicio: the ones of today still open. */
export async function countTodayCounts(actor: InventoryActor): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.count.read",
  );
  const client = forOrganization(actor.organizationId);
  const { where } = await todayCountsWhere(client, actor.userId);
  return client.stockCount.count({ where: { ...where, status: "OPEN" } });
}
