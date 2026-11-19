import "server-only";

import { dec, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  compareLocationNames,
  isLimited,
  locationPath,
  locationScopeWhere,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { forOrganization, type TenantDb } from "@/server";

import type { AbcClass } from "./abc-rules";
import { dayWindow } from "./calendar-day";
import { abcClassesOf } from "./cycle-counts";
import { isExpired, lotDayOf } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import {
  checkPlacement,
  loadPlacementRules,
  type PlacementRules,
} from "./placement";
import { putawayPreferenceOf, rankPutawayPlaces } from "./putaway-rules";
import { largestThatFits } from "./replenishment-rules";
import { freeToMoveFrom } from "./reservations";
import {
  KPI_IDLE_DAYS,
  PICKING_STRATEGY,
  PICK_EXPIRED,
  PUTAWAY_PREFERENCE,
  SLOTTING_CONSOLIDATE,
  SLOTTING_FAST_CLASSES,
  SLOTTING_LIMIT,
} from "./settings";
import {
  consolidationPlan,
  fastClassesOf,
  inWalkingOrder,
  isSlottingKind,
  rankFastProducts,
  slottingLimitOf,
  slottingReason,
  type SlottingKind,
} from "./slotting-rules";
import { rankStockSources } from "./stock-sources";
import { AVAILABLE_ANY_LOT } from "./stock-status";
import { OPEN_TASK_STATUSES, formatTaskNumber } from "./task-states";
import { createTaskGuarded, type CreateTaskGuard } from "./tasks";

/**
 * Relocation suggestions (WMS-65, ADR 0086). Derived each time from what
 * there is: nothing is stored. Three kinds (`slotting-rules.ts`): bring to
 * a picking place what leaves often and has none; take out of picking
 * what has not moved; join the same lot spread over storage places.
 *
 * Accepting one is a plain transfer task (`createTask` with a guard under
 * its locks): this module never moves stock by itself.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** Candidate balances each kind reads at most (`truncated` beyond). */
export const SLOTTING_SCAN_MAX = 2_000;

/** Destinations tried, in order, for one suggestion. */
const DESTINATIONS_TRIED = 10;

/** Open tasks of a warehouse looked at to avoid suggesting twice. */
const OPEN_TASKS_READ = 5_000;

export type SlottingSuggestion = {
  kind: SlottingKind;
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  lotId: string | null;
  lotCode: string | null;
  fromLocationId: string;
  fromName: string;
  toLocationId: string;
  toName: string;
  /** In the product's unit, as text (exact decimal). */
  quantity: string;
  /** «120 piezas». */
  quantityText: string;
  /** One line: why. */
  reason: string;
};

export type SlottingList = {
  facilityName: string;
  suggestions: SlottingSuggestion[];
  /** Some kind read its candidate cap: there may be more. */
  truncated: boolean;
};

/** Only one suggestion (accepting): the same kind, product, origin, lot. */
type Only = {
  kind: SlottingKind;
  productId: string;
  fromLocationId: string;
  lotId: string | null;
  toLocationId: string;
};

type Raw = {
  kind: SlottingKind;
  productId: string;
  lotId: string | null;
  fromLocationId: string;
  toLocationId: string;
  quantity: Decimal;
  reason: string;
};

type ProductCard = {
  id: string;
  name: string;
  sku: string;
  unitCode: string;
  quantityStep: { toString(): string };
  categoryId: string | null;
};

const PRODUCT_CARD = {
  id: true,
  name: true,
  sku: true,
  unitCode: true,
  quantityStep: true,
  categoryId: true,
} as const;

/**
 * What the suggestions avoid: places with work on the way. A task moves
 * nothing until it is delivered and a transfer task sets nothing aside, so
 * whatever an open task touches is left alone (ADR 0086).
 */
type Busy = {
  /** «product|location»: an open task of the product leaves or arrives. */
  productAt: Set<string>;
  /** Any open task goes there. */
  to: Set<string>;
  /** Destinations already given to a suggestion of this list. */
  used: Set<string>;
  /** «product|location» already the origin of a suggestion. */
  origins: Set<string>;
};

const at = (productId: string, locationId: string) =>
  `${productId}|${locationId}`;

async function busyOf(tx: Tx, facilityId: string): Promise<Busy> {
  const tasks = await tx.warehouseTask.findMany({
    where: {
      status: { in: [...OPEN_TASK_STATUSES] },
      OR: [{ fromLocation: { facilityId } }, { toLocation: { facilityId } }],
    },
    take: OPEN_TASKS_READ,
    select: { productId: true, fromLocationId: true, toLocationId: true },
  });
  const busy: Busy = {
    productAt: new Set(),
    to: new Set(),
    used: new Set(),
    origins: new Set(),
  };
  for (const task of tasks) {
    busy.to.add(task.toLocationId);
    if (task.productId) {
      busy.productAt.add(at(task.productId, task.fromLocationId));
      busy.productAt.add(at(task.productId, task.toLocationId));
    }
  }
  return busy;
}

/** The largest amount (whole steps, up to `most`) the place admits now. */
async function fittingAmount(
  tx: Tx,
  input: {
    productId: string;
    fromLocationId: string;
    toLocationId: string;
    most: Decimal;
    step: Decimal;
    whole: boolean;
  },
  /** Read once by the caller with every origin and destination. */
  rules: PlacementRules,
): Promise<Decimal> {
  const admits = async (quantity: Decimal) => {
    const placed = await checkPlacement(
      tx,
      [
        {
          productId: input.productId,
          quantity,
          toLocationId: input.toLocationId,
          fromLocationId: input.fromLocationId,
          status: "AVAILABLE",
        },
      ],
      { mode: "report" },
      rules,
    );
    return placed;
  };
  const full = await admits(input.most);
  if (full.ok && full.notes.length === 0) return input.most;
  // A restriction never lets anything in; with «whole», a part is useless.
  if (!full.ok && full.reason === "restricted") return dec(0);
  if (input.whole || !input.step.greaterThan(0)) return dec(0);
  const steps = await largestThatFits(
    input.most.dividedToIntegerBy(input.step).toNumber(),
    async (k) => {
      const placed = await admits(input.step.times(k));
      return placed.ok && placed.notes.length === 0;
    },
  );
  return input.step.times(steps);
}

type Context = {
  tx: Tx;
  userId: string;
  facilityId: string;
  scopeAnd: object;
  busy: Busy;
  limit: number;
  only: Only | null;
  /** «Today» (tests move it). */
  now: Date;
};

/** A leaf of the warehouse, active, never General, staging nor transit. */
const leafOf = (context: Context, type: "PICKING" | "STORAGE") => ({
  facilityId: context.facilityId,
  type,
  archivedAt: null,
  isDefault: null,
  isStaging: null,
  isTransit: null,
  children: { none: { archivedAt: null } },
  ...context.scopeAnd,
});

const blocked = (busy: Busy, productId: string, from: string) =>
  busy.productAt.has(at(productId, from)) ||
  busy.origins.has(at(productId, from));

const destinationFree = (busy: Busy, productId: string, to: string) =>
  !busy.to.has(to) &&
  !busy.used.has(to) &&
  !busy.productAt.has(at(productId, to));

// ── 1. Closer to picking ────────────────────────────────────────────────

async function closerSuggestions(
  context: Context,
  classes: Map<string, AbcClass>,
  fast: ReadonlySet<AbcClass>,
  ruleProducts: Set<string>,
  ruleLocations: Set<string>,
): Promise<{ found: Raw[]; truncated: boolean }> {
  const { tx, facilityId, busy, only } = context;
  let fastIds = [...classes]
    .filter(([id, value]) => fast.has(value) && !ruleProducts.has(id))
    .map(([id]) => id);
  if (only) fastIds = fastIds.filter((id) => id === only.productId);
  if (fastIds.length === 0) return { found: [], truncated: false };
  const truncated = fastIds.length > SLOTTING_SCAN_MAX;
  fastIds = fastIds.sort().slice(0, SLOTTING_SCAN_MAX);
  // Already with a picking place anywhere in the warehouse: not suggested.
  const inPicking = await tx.stockBalance.groupBy({
    by: ["productId"],
    where: {
      productId: { in: fastIds },
      quantity: { gt: 0 },
      ...AVAILABLE_ANY_LOT,
      location: { facilityId, type: "PICKING", archivedAt: null },
    },
  });
  const placed = new Set(inPicking.map((row) => row.productId));
  const cards = (await tx.product.findMany({
    where: {
      id: { in: fastIds.filter((id) => !placed.has(id)) },
      status: "ACTIVE",
    },
    select: PRODUCT_CARD,
  })) as ProductCard[];
  if (cards.length === 0) return { found: [], truncated };
  const ranked = rankFastProducts(
    cards.map((card) => ({
      ...card,
      productId: card.id,
      abcClass: classes.get(card.id)!,
    })),
  );
  const [balances, empties] = await Promise.all([
    tx.stockBalance.findMany({
      where: {
        productId: { in: ranked.map((card) => card.id) },
        quantity: { gt: 0 },
        ...AVAILABLE_ANY_LOT,
        location: leafOf(context, "STORAGE"),
        ...(only ? { locationId: only.fromLocationId } : {}),
      },
      orderBy: { id: "asc" },
      take: SLOTTING_SCAN_MAX + 1,
      select: {
        productId: true,
        locationId: true,
        quantity: true,
        lot: { select: { id: true, expiresOn: true } },
      },
    }),
    tx.location.findMany({
      where: {
        ...leafOf(context, "PICKING"),
        balances: { none: { quantity: { gt: 0 } } },
        ...(only ? { id: only.toLocationId } : {}),
      },
      take: SLOTTING_SCAN_MAX,
      select: { id: true, code: true },
    }),
  ]);
  const usable = empties.filter((place) => !ruleLocations.has(place.id));
  // The path only matters (walking order) for places without a code.
  const paths = await pathsOf(
    tx,
    usable.filter((place) => !place.code).map((place) => place.id),
  );
  const destinations = inWalkingOrder(
    usable.map((place) => ({
      id: place.id,
      code: place.code,
      path: paths.get(place.id) ?? "",
    })),
  );
  if (destinations.length === 0) {
    return {
      found: [],
      truncated: truncated || balances.length > SLOTTING_SCAN_MAX,
    };
  }
  const skipExpired =
    balances.some((row) => row.lot?.expiresOn) &&
    (await readSetting(tx, PICK_EXPIRED)) !== "allow";
  const today = skipExpired ? (await dayWindow(tx, context.now))?.day : null;
  const strategy = await readSetting(tx, PICKING_STRATEGY);
  const rules = await loadPlacementRules(tx, [
    ...destinations.map((place) => place.id),
    ...new Set(balances.map((row) => row.locationId)),
  ]);
  const found: Raw[] = [];
  for (const card of ranked) {
    if (found.length >= context.limit) break;
    const rows = rankStockSources(
      balances
        .filter((row) => row.productId === card.id)
        .map((row) => ({
          locationId: row.locationId,
          lotId: row.lot?.id ?? null,
          expiresOn: lotDayOf(row.lot?.expiresOn),
          quantity: dec(row.quantity.toString()),
        }))
        .filter((row) => !today || !isExpired(row.expiresOn, today))
        .filter((row) => !only || row.lotId === only.lotId),
      strategy,
    );
    // The first origin in taking order: what expires first is never left
    // behind what is brought closer.
    const first = rows[0];
    if (!first || blocked(busy, card.id, first.locationId)) continue;
    const free = await freeToMoveFrom(
      tx,
      card.id,
      first.locationId,
      first.lotId,
    );
    if (!free.greaterThan(0)) continue;
    const step = dec(card.quantityStep.toString());
    let tried = 0;
    for (const place of destinations) {
      if (tried >= DESTINATIONS_TRIED) break;
      if (!destinationFree(busy, card.id, place.id)) continue;
      tried += 1;
      const amount = await fittingAmount(
        tx,
        {
          productId: card.id,
          fromLocationId: first.locationId,
          toLocationId: place.id,
          most: free,
          step,
          whole: false,
        },
        rules,
      );
      if (!amount.greaterThan(0)) continue;
      busy.used.add(place.id);
      busy.origins.add(at(card.id, first.locationId));
      found.push({
        kind: "closer",
        productId: card.id,
        lotId: first.lotId,
        fromLocationId: first.locationId,
        toLocationId: place.id,
        quantity: amount,
        reason: slottingReason("closer", { abcClass: classes.get(card.id) }),
      });
      break;
    }
  }
  return {
    found,
    truncated: truncated || balances.length > SLOTTING_SCAN_MAX,
  };
}

// ── Storage destinations (idle and consolidate share the reading) ───────

type StoragePlace = { id: string; readingOrder: number };

/** «Zona A › Pasillo 2 › Estante 3» of some locations (none: no query). */
async function pathsOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.location.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, parent: LOCATION_PARENTS },
  });
  return new Map(rows.map((row) => [row.id, locationPath(row)]));
}

/**
 * The storage leaves of the warehouse in the person's zones. Their tie
 * order is the code (or name) in natural order: the full path would cost
 * a query per level.
 */
async function storagePlaces(context: Context): Promise<StoragePlace[]> {
  const rows = await context.tx.location.findMany({
    where: leafOf(context, "STORAGE"),
    take: SLOTTING_SCAN_MAX,
    select: { id: true, code: true, name: true },
  });
  return rows
    .map((row) => ({ id: row.id, key: row.code?.trim() || row.name }))
    .sort(
      (a, b) => compareLocationNames(a.key, b.key) || a.id.localeCompare(b.id),
    )
    .map((row, index) => ({ id: row.id, readingOrder: index }));
}

/**
 * Everything at a location of the product is this lot and available, and
 * all of it is free to move: the place empties of the product.
 */
async function wholeIsFree(
  tx: Tx,
  productId: string,
  locationId: string,
  lotId: string | null,
  quantity: Decimal,
): Promise<boolean> {
  const others = await tx.stockBalance.count({
    where: {
      productId,
      locationId,
      quantity: { gt: 0 },
      NOT: { status: "AVAILABLE", lotKey: lotId ?? "" },
    },
  });
  if (others > 0) return false;
  const free = await freeToMoveFrom(tx, productId, locationId, lotId);
  return free.equals(quantity);
}

// ── 2. Out of picking what does not move ────────────────────────────────

async function idleSuggestions(
  context: Context,
  idleDays: number,
  rulePairs: Set<string>,
  places: () => Promise<StoragePlace[]>,
  remaining: number,
): Promise<{ found: Raw[]; truncated: boolean }> {
  const { tx, facilityId, busy, only } = context;
  if (remaining <= 0) return { found: [], truncated: false };
  const balances = await tx.stockBalance.findMany({
    where: {
      quantity: { gt: 0 },
      ...AVAILABLE_ANY_LOT,
      location: leafOf(context, "PICKING"),
      product: { status: "ACTIVE" },
      ...(only
        ? {
            productId: only.productId,
            locationId: only.fromLocationId,
            lotKey: only.lotId ?? "",
          }
        : {}),
    },
    orderBy: { id: "asc" },
    take: SLOTTING_SCAN_MAX + 1,
    select: {
      productId: true,
      locationId: true,
      lotId: true,
      quantity: true,
    },
  });
  const truncated = balances.length > SLOTTING_SCAN_MAX;
  const candidates = balances
    .slice(0, SLOTTING_SCAN_MAX)
    .filter((row) => !rulePairs.has(at(row.productId, row.locationId)));
  if (candidates.length === 0) return { found: [], truncated };
  const since = new Date(context.now.getTime() - idleDays * 86_400_000);
  const moved = await tx.stockMovementLine.groupBy({
    by: ["productId"],
    where: {
      productId: { in: [...new Set(candidates.map((row) => row.productId))] },
      createdAt: { gte: since },
      location: { facilityId },
    },
  });
  const active = new Set(moved.map((row) => row.productId));
  const idle = candidates.filter((row) => !active.has(row.productId));
  if (idle.length === 0) return { found: [], truncated };
  const storage = await places();
  if (storage.length === 0) return { found: [], truncated };
  const cards = new Map(
    (
      (await tx.product.findMany({
        where: { id: { in: [...new Set(idle.map((row) => row.productId))] } },
        select: PRODUCT_CARD,
      })) as ProductCard[]
    ).map((card) => [card.id, card]),
  );
  const ids = storage.map((place) => place.id);
  const held = await tx.stockBalance.groupBy({
    by: ["locationId"],
    where: { locationId: { in: ids }, quantity: { gt: 0 } },
    _sum: { quantity: true },
  });
  const unitsAt = new Map(
    held.map((row) => [row.locationId, (row._sum.quantity ?? 0).toString()]),
  );
  const preference = putawayPreferenceOf(
    await readSetting(tx, PUTAWAY_PREFERENCE),
  );
  const rules = await loadPlacementRules(tx, [
    ...ids,
    ...new Set(idle.map((row) => row.locationId)),
  ]);
  const found: Raw[] = [];
  for (const row of idle) {
    if (found.length >= remaining) break;
    const card = cards.get(row.productId);
    if (!card || blocked(busy, row.productId, row.locationId)) continue;
    const quantity = dec(row.quantity.toString());
    if (
      !(await wholeIsFree(
        tx,
        row.productId,
        row.locationId,
        row.lotId,
        quantity,
      ))
    ) {
      continue;
    }
    const open = storage.filter(
      (place) =>
        destinationFree(busy, row.productId, place.id) &&
        (!only || place.id === only.toLocationId),
    );
    if (open.length === 0) continue;
    const [same, family] = await Promise.all([
      tx.stockBalance.findMany({
        where: {
          productId: row.productId,
          locationId: { in: open.map((place) => place.id) },
          quantity: { gt: 0 },
        },
        select: { locationId: true, lotKey: true },
      }),
      card.categoryId
        ? tx.stockBalance.findMany({
            where: {
              locationId: { in: open.map((place) => place.id) },
              quantity: { gt: 0 },
              productId: { not: row.productId },
              product: { categoryId: card.categoryId },
            },
            distinct: ["locationId"],
            select: { locationId: true },
          })
        : Promise.resolve([]),
    ]);
    const productAt = new Set(same.map((item) => item.locationId));
    const lotAt = new Set(
      same
        .filter((item) => row.lotId !== null && item.lotKey === row.lotId)
        .map((item) => item.locationId),
    );
    const familyAt = new Set(family.map((item) => item.locationId));
    const ranked = rankPutawayPlaces(
      open.map((place) => ({
        id: place.id,
        readingOrder: place.readingOrder,
        units: unitsAt.get(place.id) ?? "0",
        sameProduct: productAt.has(place.id),
        sameLot: lotAt.has(place.id),
        sameCategory: familyAt.has(place.id),
      })),
      preference,
    ).slice(0, DESTINATIONS_TRIED);
    for (const place of ranked) {
      const amount = await fittingAmount(
        tx,
        {
          productId: row.productId,
          fromLocationId: row.locationId,
          toLocationId: place.id,
          most: quantity,
          step: dec(card.quantityStep.toString()),
          whole: true,
        },
        rules,
      );
      if (!amount.greaterThan(0)) continue;
      busy.used.add(place.id);
      busy.origins.add(at(row.productId, row.locationId));
      found.push({
        kind: "idle",
        productId: row.productId,
        lotId: row.lotId,
        fromLocationId: row.locationId,
        toLocationId: place.id,
        quantity,
        reason: slottingReason("idle", { idleDays }),
      });
      break;
    }
  }
  return { found, truncated };
}

// ── 3. Join what is spread ──────────────────────────────────────────────

async function consolidateSuggestions(
  context: Context,
  remaining: number,
): Promise<{ found: Raw[]; truncated: boolean }> {
  const { tx, busy, only } = context;
  if (remaining <= 0) return { found: [], truncated: false };
  const where = {
    quantity: { gt: 0 },
    ...AVAILABLE_ANY_LOT,
    location: leafOf(context, "STORAGE"),
    product: { status: "ACTIVE" as const },
    ...(only ? { productId: only.productId, lotKey: only.lotId ?? "" } : {}),
  };
  const groups = await tx.stockBalance.groupBy({
    by: ["productId", "lotKey"],
    where,
    having: { locationId: { _count: { gt: 1 } } },
    orderBy: [{ productId: "asc" }, { lotKey: "asc" }],
    take: SLOTTING_SCAN_MAX + 1,
  });
  const truncated = groups.length > SLOTTING_SCAN_MAX;
  const found: Raw[] = [];
  for (const group of groups.slice(0, SLOTTING_SCAN_MAX)) {
    if (found.length >= remaining) break;
    const rows = await tx.stockBalance.findMany({
      where: { ...where, productId: group.productId, lotKey: group.lotKey },
      select: { locationId: true, lotId: true, quantity: true },
    });
    const lotId = rows[0]?.lotId ?? null;
    const facts = [];
    for (const row of rows) {
      const quantity = dec(row.quantity.toString());
      const movable =
        !blocked(busy, group.productId, row.locationId) &&
        (!only || row.locationId === only.fromLocationId) &&
        (await wholeIsFree(
          tx,
          group.productId,
          row.locationId,
          lotId,
          quantity,
        ));
      facts.push({ locationId: row.locationId, quantity, movable });
    }
    const quantityAt = new Map(
      facts.map((row) => [row.locationId, row.quantity]),
    );
    let loaded: Promise<PlacementRules> | null = null;
    const groupRules = () =>
      (loaded ??= loadPlacementRules(
        tx,
        rows.map((row) => row.locationId),
      ));
    let done = false;
    for (const pair of consolidationPlan(facts)) {
      if (done) break;
      for (const target of pair.targets) {
        if (!destinationFree(busy, group.productId, target)) continue;
        if (only && target !== only.toLocationId) continue;
        const most = quantityAt.get(pair.fromId)!;
        const amount = await fittingAmount(
          tx,
          {
            productId: group.productId,
            fromLocationId: pair.fromId,
            toLocationId: target,
            most,
            step: dec(1),
            whole: true,
          },
          await groupRules(),
        );
        if (!amount.greaterThan(0)) continue;
        busy.used.add(target);
        busy.origins.add(at(group.productId, pair.fromId));
        found.push({
          kind: "consolidate",
          productId: group.productId,
          lotId,
          fromLocationId: pair.fromId,
          toLocationId: target,
          quantity: most,
          reason: slottingReason("consolidate", { places: rows.length }),
        });
        done = true;
        break;
      }
    }
  }
  return { found, truncated };
}

// ── The list ─────────────────────────────────────────────────────────────

async function planSuggestions(
  tx: Tx,
  actor: InventoryActor,
  facilityId: string,
  only: Only | null,
  now: Date,
): Promise<{ raw: Raw[]; truncated: boolean }> {
  const scoped = await locationScopeWhere(tx, actor.userId);
  const [fastSetting, consolidate, limitSetting, idleSetting, busy, rules] =
    await Promise.all([
      readSetting(tx, SLOTTING_FAST_CLASSES),
      readSetting(tx, SLOTTING_CONSOLIDATE),
      readSetting(tx, SLOTTING_LIMIT),
      readSetting(tx, KPI_IDLE_DAYS),
      busyOf(tx, facilityId),
      tx.replenishmentRule.findMany({
        where: { location: { facilityId } },
        select: { productId: true, locationId: true },
      }),
    ]);
  const context: Context = {
    tx,
    userId: actor.userId,
    facilityId,
    scopeAnd: isLimited(scoped) ? { AND: [scoped] } : {},
    busy,
    limit: only ? 1 : slottingLimitOf(limitSetting),
    only,
    now,
  };
  const ruleProducts = new Set(rules.map((rule) => rule.productId));
  const ruleLocations = new Set(rules.map((rule) => rule.locationId));
  const rulePairs = new Set(
    rules.map((rule) => at(rule.productId, rule.locationId)),
  );
  let storage: Promise<StoragePlace[]> | null = null;
  const places = () => (storage ??= storagePlaces(context));

  const raw: Raw[] = [];
  let truncated = false;
  const wants = (kind: SlottingKind) => !only || only.kind === kind;
  if (wants("closer")) {
    const classes = await abcClassesOf(tx, facilityId, now);
    const closer = await closerSuggestions(
      context,
      classes,
      fastClassesOf(fastSetting),
      ruleProducts,
      ruleLocations,
    );
    raw.push(...closer.found);
    truncated ||= closer.truncated;
  }
  if (wants("idle")) {
    const idle = await idleSuggestions(
      context,
      Number(idleSetting) || 90,
      rulePairs,
      places,
      context.limit - raw.length,
    );
    raw.push(...idle.found);
    truncated ||= idle.truncated;
  }
  if (wants("consolidate") && consolidate === "on") {
    const joined = await consolidateSuggestions(
      context,
      context.limit - raw.length,
    );
    raw.push(...joined.found);
    truncated ||= joined.truncated;
  }
  return { raw, truncated };
}

/** Names for the screen: two queries for the whole list. */
async function describe(tx: Tx, raw: Raw[]): Promise<SlottingSuggestion[]> {
  if (raw.length === 0) return [];
  const [products, locations, lots] = await Promise.all([
    tx.product.findMany({
      where: { id: { in: [...new Set(raw.map((row) => row.productId))] } },
      select: { id: true, name: true, sku: true, unitCode: true },
    }),
    tx.location.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              raw.flatMap((row) => [row.fromLocationId, row.toLocationId]),
            ),
          ],
        },
      },
      select: { id: true, code: true, name: true, parent: LOCATION_PARENTS },
    }),
    tx.lot.findMany({
      where: {
        id: { in: raw.flatMap((row) => (row.lotId ? [row.lotId] : [])) },
      },
      select: { id: true, code: true },
    }),
  ]);
  const productOf = new Map(products.map((row) => [row.id, row]));
  const placeOf = new Map(
    locations.map((row) => [
      row.id,
      row.code ? `${row.code} · ${locationPath(row)}` : locationPath(row),
    ]),
  );
  const lotOf = new Map(lots.map((row) => [row.id, row.code]));
  return raw.map((row) => {
    const product = productOf.get(row.productId)!;
    return {
      kind: row.kind,
      productId: row.productId,
      productName: product.name,
      sku: product.sku,
      unitCode: product.unitCode,
      lotId: row.lotId,
      lotCode: row.lotId ? (lotOf.get(row.lotId) ?? null) : null,
      fromLocationId: row.fromLocationId,
      fromName: placeOf.get(row.fromLocationId) ?? "",
      toLocationId: row.toLocationId,
      toName: placeOf.get(row.toLocationId) ?? "",
      quantity: row.quantity.toString(),
      quantityText: formatStock(row.quantity.toString(), product.unitCode),
      reason: row.reason,
    };
  });
}

/**
 * The suggestions of the person's warehouse, inside their zones (WMS-65).
 * Reads only (one transaction for a consistent picture); writes nothing.
 */
export async function listSlottingSuggestions(
  actor: InventoryActor,
  /** `now`: «today» (tests); the screen never passes it. */
  options: { now?: Date } = {},
): Promise<SlottingList> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.slotting.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.$transaction(
    async (tx) => {
      const { raw, truncated } = await planSuggestions(
        tx,
        actor,
        facility.id,
        null,
        options.now ?? new Date(),
      );
      return {
        facilityName: facility.name,
        suggestions: await describe(tx, raw),
        truncated,
      };
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

// ── Accepting ────────────────────────────────────────────────────────────

export type SlottingAcceptInput = {
  kind: string;
  productId: string;
  fromLocationId: string;
  lotId?: string | null;
  toLocationId: string;
};

export type SlottingAcceptResult =
  | { ok: true; taskId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "changed" | "not_allowed" | "invalid";
      formError: string;
    };

export const SUGGESTION_CHANGED =
  "Esta sugerencia cambió desde que se mostró. Revisa la lista otra vez.";

const ID = /^[0-9a-f-]{36}$/i;

/**
 * Turns one suggestion into a transfer task (WMS-65). The browser sends
 * only ids; the suggestion is decided again on the server and must still
 * name the same destination. The task is created by `createTask` itself,
 * with a guard under its locks: an open task of the product from that
 * origin, or any open task to that destination, creates nothing (two
 * accepts at once make one task).
 */
export async function acceptSlottingSuggestion(
  actor: InventoryActor,
  input: SlottingAcceptInput,
  /** `now`: «today» (tests); the action never passes it. */
  options: { now?: Date } = {},
): Promise<SlottingAcceptResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.slotting.read",
  );
  await assertModulePermission(organizationId, userId, "inventory.task.create");
  const lotId = input.lotId || null;
  if (
    !isSlottingKind(input.kind) ||
    !ID.test(input.productId) ||
    !ID.test(input.fromLocationId) ||
    !ID.test(input.toLocationId) ||
    (lotId !== null && !ID.test(lotId))
  ) {
    return { ok: false, reason: "invalid", formError: SUGGESTION_CHANGED };
  }
  const only: Only = {
    kind: input.kind,
    productId: input.productId,
    fromLocationId: input.fromLocationId,
    lotId,
    toLocationId: input.toLocationId,
  };
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  const decided = await client.$transaction(
    (tx) =>
      planSuggestions(tx, actor, facility.id, only, options.now ?? new Date()),
    { timeout: 30_000, maxWait: 15_000 },
  );
  const suggestion = decided.raw.find(
    (row) =>
      row.kind === only.kind &&
      row.productId === only.productId &&
      row.fromLocationId === only.fromLocationId &&
      row.lotId === only.lotId &&
      row.toLocationId === only.toLocationId,
  );
  if (!suggestion) {
    // Already turned into a task? Say so instead of «changed».
    const existing = await client.warehouseTask.findFirst({
      where: {
        productId: only.productId,
        fromLocationId: only.fromLocationId,
        toLocationId: only.toLocationId,
        status: { in: [...OPEN_TASK_STATUSES] },
      },
      select: { id: true, number: true },
    });
    if (existing) {
      return {
        ok: true,
        taskId: existing.id,
        summary: `Ya existe la tarea ${formatTaskNumber(existing.number)} para esta sugerencia.`,
        repeated: true,
      };
    }
    return { ok: false, reason: "changed", formError: SUGGESTION_CHANGED };
  }
  const guard: CreateTaskGuard = async (tx, task) => {
    const open = await tx.warehouseTask.findFirst({
      where: {
        status: { in: [...OPEN_TASK_STATUSES] },
        OR: [
          {
            productId: task.productId,
            OR: [
              { fromLocationId: task.fromLocationId },
              { toLocationId: task.fromLocationId },
            ],
          },
          { toLocationId: task.toLocationId },
        ],
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        number: true,
        productId: true,
        fromLocationId: true,
        toLocationId: true,
      },
    });
    if (!open) return null;
    if (
      open.productId === task.productId &&
      open.fromLocationId === task.fromLocationId &&
      open.toLocationId === task.toLocationId
    ) {
      return {
        ok: true,
        taskId: open.id,
        summary: `Ya existe la tarea ${formatTaskNumber(open.number)} para esta sugerencia.`,
        repeated: true,
      };
    }
    return {
      ok: false,
      reason: "not_allowed",
      formError: `Ya hay una tarea abierta (${formatTaskNumber(open.number)}) en una de esas ubicaciones. ${SUGGESTION_CHANGED}`,
    };
  };
  const created = await createTaskGuarded(
    actor,
    {
      productId: suggestion.productId,
      fromLocationId: suggestion.fromLocationId,
      toLocationId: suggestion.toLocationId,
      lotId: suggestion.lotId ?? undefined,
      quantity: suggestion.quantity.toString(),
      note: `Sugerencia de reubicación: ${suggestion.reason}`,
    },
    guard,
  );
  if (created.ok) {
    return {
      ok: true,
      taskId: created.taskId,
      summary: created.summary,
      ...(created.repeated ? { repeated: true as const } : {}),
    };
  }
  const message =
    created.formError ??
    Object.values(created.fieldErrors ?? {}).find(Boolean) ??
    SUGGESTION_CHANGED;
  return {
    ok: false,
    reason: created.reason === "over_capacity" ? "changed" : "not_allowed",
    formError: message,
  };
}
