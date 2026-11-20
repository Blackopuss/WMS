import "server-only";

import { Decimal, dec } from "@/lib";
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
  restrictionProblem,
  type PlacementRules,
} from "./placement";
import { putawayPreferenceOf, rankPutawayPlaces } from "./putaway-rules";
import { largestThatFits } from "./replenishment-rules";
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
  /**
   * «product|location» already an origin or a destination of a suggestion
   * of this list: two suggestions of one product never contradict each
   * other (one taking out of where the other brings in).
   */
  planned: Set<string>;
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
    planned: new Set(),
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

/**
 * How much work one list may do beyond its fixed reads (ADR 0086): what
 * the database is asked per candidate is bounded, whatever the size of the
 * warehouse. Spent up, the list stops and says it is `truncated`.
 */
type Budget = {
  /** Capacity checks (each reads the occupancy of the place). */
  checks: number;
  /** Candidate pairs looked at in memory (restrictions, tasks). */
  looks: number;
  spent: boolean;
};

/** Capacity checks of one list. */
const CHECKS_MAX = 40;
/** Pairs looked at in memory by one list. */
const LOOKS_MAX = 50_000;

const newBudget = (): Budget => ({ checks: 0, looks: 0, spent: false });

/**
 * The largest amount (whole steps, up to `most`; with `whole`, all or
 * nothing) the place admits now. Restrictions and quarantine are decided
 * in memory with the rules read once; only a place under a capacity asks
 * the database (`checkPlacement`), and that spends the budget.
 */
async function fittingAmount(
  context: Context,
  input: {
    card: ProductCard;
    fromLocationId: string;
    toLocationId: string;
    most: Decimal;
    whole: boolean;
  },
  rules: PlacementRules,
): Promise<Decimal> {
  const { budget } = context;
  budget.looks += 1;
  if (budget.looks > LOOKS_MAX) {
    budget.spent = true;
    return dec(0);
  }
  const arrival = {
    productId: input.card.id,
    toLocationId: input.toLocationId,
    fromLocationId: input.fromLocationId,
    status: "AVAILABLE" as const,
  };
  if (restrictionProblem(rules, arrival, input.card)) return dec(0);
  const limited = rules
    .chainOf(input.toLocationId)
    .some((node) => rules.capacities.has(node.id));
  if (!limited) return input.most;
  const admits = async (quantity: Decimal) => {
    if (budget.checks >= CHECKS_MAX) {
      budget.spent = true;
      return false;
    }
    budget.checks += 1;
    const placed = await checkPlacement(
      context.tx,
      [{ ...arrival, quantity }],
      { mode: "report" },
      rules,
    );
    return placed.ok && placed.notes.length === 0;
  };
  if (await admits(input.most)) return input.most;
  const step = dec(input.card.quantityStep.toString());
  if (input.whole || !step.greaterThan(0) || budget.spent) return dec(0);
  const steps = await largestThatFits(
    input.most.dividedToIntegerBy(step).toNumber(),
    (k) => admits(step.times(k)),
  );
  return step.times(steps);
}

type Context = {
  tx: Tx;
  userId: string;
  facilityId: string;
  scopeAnd: object;
  busy: Busy;
  budget: Budget;
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
  busy.planned.has(at(productId, from));

const destinationFree = (busy: Busy, productId: string, to: string) =>
  !busy.to.has(to) &&
  !busy.used.has(to) &&
  !busy.productAt.has(at(productId, to)) &&
  !busy.planned.has(at(productId, to));

function plan(context: Context, raw: Raw): Raw {
  context.busy.used.add(raw.toLocationId);
  context.busy.planned.add(at(raw.productId, raw.fromLocationId));
  context.busy.planned.add(at(raw.productId, raw.toLocationId));
  return raw;
}

const lotKeyOf = (lotId: string | null | undefined) => lotId ?? "";
const atLot = (productId: string, locationId: string, lotId: string | null) =>
  `${productId}|${locationId}|${lotKeyOf(lotId)}`;

/**
 * What is free to move, read in bulk for many products and places: the
 * same arithmetic as `freeToMoveFrom` (available − reserved there − inside
 * storage containers; of the place and of the lot there, the least), in
 * three grouped queries instead of three per row. And what else of the
 * product each place holds (another state or lot), so a place that must
 * empty can be told apart. The task itself checks again under its locks.
 */
type Stock = {
  /** Free to move of a product, lot and place. */
  free(productId: string, locationId: string, lotId: string | null): Decimal;
  /** The place holds only this lot of the product, available. */
  onlyThis(
    productId: string,
    locationId: string,
    lotId: string | null,
  ): boolean;
};

async function stockOf(
  tx: Tx,
  productIds: string[],
  locationIds: string[],
): Promise<Stock> {
  const products = [...new Set(productIds)];
  const places = [...new Set(locationIds)];
  if (products.length === 0 || places.length === 0) {
    return { free: () => dec(0), onlyThis: () => false };
  }
  const [balances, reserved, contained] = await Promise.all([
    tx.stockBalance.findMany({
      where: {
        productId: { in: products },
        locationId: { in: places },
        quantity: { gt: 0 },
      },
      select: {
        productId: true,
        locationId: true,
        status: true,
        lotKey: true,
        quantity: true,
      },
    }),
    tx.stockReservation.groupBy({
      by: ["productId", "locationId", "lotId"],
      where: {
        productId: { in: products },
        locationId: { in: places },
        state: "ACTIVE",
      },
      _sum: { remaining: true },
    }),
    tx.containerItem.groupBy({
      by: ["productId", "locationId", "lotKey"],
      where: {
        productId: { in: products },
        locationId: { in: places },
        status: "AVAILABLE",
        container: { purpose: "STORAGE" },
      },
      _sum: { quantity: true },
    }),
  ]);
  const add = (map: Map<string, Decimal>, key: string, value: Decimal) =>
    map.set(key, (map.get(key) ?? dec(0)).plus(value));
  const placeFree = new Map<string, Decimal>();
  const lotFree = new Map<string, Decimal>();
  const kinds = new Map<string, number>();
  const plain = new Map<string, string>();
  for (const row of balances) {
    const place = at(row.productId, row.locationId);
    kinds.set(place, (kinds.get(place) ?? 0) + 1);
    plain.set(place, row.status === "AVAILABLE" ? row.lotKey : "\u0000");
    if (row.status !== "AVAILABLE") continue;
    const quantity = dec(row.quantity.toString());
    add(placeFree, place, quantity);
    add(lotFree, `${place}|${row.lotKey}`, quantity);
  }
  for (const row of reserved) {
    if (!row.locationId) continue;
    const place = at(row.productId, row.locationId);
    const quantity = dec((row._sum.remaining ?? 0).toString()).negated();
    add(placeFree, place, quantity);
    if (row.lotId) add(lotFree, `${place}|${row.lotId}`, quantity);
  }
  for (const row of contained) {
    const place = at(row.productId, row.locationId);
    const quantity = dec((row._sum.quantity ?? 0).toString()).negated();
    add(placeFree, place, quantity);
    add(lotFree, `${place}|${row.lotKey}`, quantity);
  }
  const free = (
    productId: string,
    locationId: string,
    lotId: string | null,
  ) => {
    const place = placeFree.get(at(productId, locationId)) ?? dec(0);
    const least = lotId
      ? Decimal.min(
          place,
          lotFree.get(atLot(productId, locationId, lotId)) ?? dec(0),
        )
      : place;
    return least.isNegative() ? dec(0) : least;
  };
  return {
    free,
    onlyThis: (productId, locationId, lotId) =>
      kinds.get(at(productId, locationId)) === 1 &&
      plain.get(at(productId, locationId)) === lotKeyOf(lotId),
  };
}

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
  let truncated = fastIds.length > SLOTTING_SCAN_MAX;
  fastIds = fastIds.sort().slice(0, SLOTTING_SCAN_MAX);

  // First: is there any destination at all? Empty picking leaves.
  const empties = await tx.location.findMany({
    where: {
      ...leafOf(context, "PICKING"),
      balances: { none: { quantity: { gt: 0 } } },
      ...(only ? { id: only.toLocationId } : {}),
    },
    take: SLOTTING_SCAN_MAX,
    select: { id: true, code: true },
  });
  const usable = empties.filter(
    (place) => !ruleLocations.has(place.id) && !busy.to.has(place.id),
  );
  if (usable.length === 0) return { found: [], truncated };

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
  const balances = await tx.stockBalance.findMany({
    where: {
      productId: { in: ranked.map((card) => card.id) },
      quantity: { gt: 0 },
      ...AVAILABLE_ANY_LOT,
      location: leafOf(context, "STORAGE"),
    },
    orderBy: { id: "asc" },
    take: SLOTTING_SCAN_MAX + 1,
    select: {
      productId: true,
      locationId: true,
      quantity: true,
      lot: { select: { id: true, expiresOn: true } },
    },
  });
  truncated ||= balances.length > SLOTTING_SCAN_MAX;
  const rows = balances.slice(0, SLOTTING_SCAN_MAX);
  if (rows.length === 0) return { found: [], truncated };

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
  const skipExpired =
    rows.some((row) => row.lot?.expiresOn) &&
    (await readSetting(tx, PICK_EXPIRED)) !== "allow";
  const today = skipExpired ? (await dayWindow(tx, context.now))?.day : null;
  const [strategy, rules, stock] = await Promise.all([
    readSetting(tx, PICKING_STRATEGY),
    loadPlacementRules(tx, [
      ...destinations.map((place) => place.id),
      ...new Set(rows.map((row) => row.locationId)),
    ]),
    stockOf(
      tx,
      rows.map((row) => row.productId),
      rows.map((row) => row.locationId),
    ),
  ]);
  const byProduct = new Map<string, typeof rows>();
  for (const row of rows) {
    byProduct.set(row.productId, [
      ...(byProduct.get(row.productId) ?? []),
      row,
    ]);
  }
  const found: Raw[] = [];
  for (const card of ranked) {
    if (found.length >= context.limit || context.budget.spent) break;
    // No destination left for anyone: nothing more to try.
    if (!destinations.some((place) => !busy.used.has(place.id))) break;
    const sources = rankStockSources(
      (byProduct.get(card.id) ?? [])
        .map((row) => ({
          locationId: row.locationId,
          lotId: row.lot?.id ?? null,
          expiresOn: lotDayOf(row.lot?.expiresOn),
          quantity: dec(row.quantity.toString()),
        }))
        .filter((row) => !today || !isExpired(row.expiresOn, today)),
      strategy,
    );
    // The first origin in taking order that has something free: what
    // expires first is never left behind what is brought closer.
    const first = sources.find((row) =>
      stock.free(card.id, row.locationId, row.lotId).greaterThan(0),
    );
    if (!first || blocked(busy, card.id, first.locationId)) continue;
    // Accepting: the origin must still be the first one.
    if (
      only &&
      (first.locationId !== only.fromLocationId || first.lotId !== only.lotId)
    ) {
      continue;
    }
    const free = stock.free(card.id, first.locationId, first.lotId);
    let tried = 0;
    for (const place of destinations) {
      if (tried >= DESTINATIONS_TRIED || context.budget.spent) break;
      if (!destinationFree(busy, card.id, place.id)) continue;
      const amount = await fittingAmount(
        context,
        {
          card,
          fromLocationId: first.locationId,
          toLocationId: place.id,
          most: free,
          whole: false,
        },
        rules,
      );
      if (!amount.greaterThan(0)) {
        // A restriction costs nothing: only a capacity check counts.
        if (
          rules.chainOf(place.id).some((node) => rules.capacities.has(node.id))
        ) {
          tried += 1;
        }
        continue;
      }
      found.push(
        plan(context, {
          kind: "closer",
          productId: card.id,
          lotId: first.lotId,
          fromLocationId: first.locationId,
          toLocationId: place.id,
          quantity: amount,
          reason: slottingReason("closer", { abcClass: classes.get(card.id) }),
        }),
      );
      break;
    }
  }
  return { found, truncated: truncated || context.budget.spent };
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
  // First: is there any destination at all?
  const storage = (await places()).filter(
    (place) =>
      !busy.to.has(place.id) && (!only || place.id === only.toLocationId),
  );
  if (storage.length === 0) return { found: [], truncated: false };
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
            lotKey: lotKeyOf(only.lotId),
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
  let truncated = balances.length > SLOTTING_SCAN_MAX;
  const candidates = balances
    .slice(0, SLOTTING_SCAN_MAX)
    .filter(
      (row) =>
        !rulePairs.has(at(row.productId, row.locationId)) &&
        !busy.productAt.has(at(row.productId, row.locationId)),
    );
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
  const productIds = [...new Set(idle.map((row) => row.productId))];
  const ids = storage.map((place) => place.id);
  const cards = (await tx.product.findMany({
    where: { id: { in: productIds } },
    select: PRODUCT_CARD,
  })) as ProductCard[];
  const cardOf = new Map(cards.map((card) => [card.id, card]));
  const categories = [
    ...new Set(
      cards.flatMap((card) => (card.categoryId ? [card.categoryId] : [])),
    ),
  ];
  // Everything the ranking needs, for every idle product at once.
  const [held, same, family, rules, stock] = await Promise.all([
    tx.stockBalance.groupBy({
      by: ["locationId"],
      where: { locationId: { in: ids }, quantity: { gt: 0 } },
      _sum: { quantity: true },
    }),
    tx.stockBalance.findMany({
      where: {
        productId: { in: productIds },
        locationId: { in: ids },
        quantity: { gt: 0 },
      },
      select: { productId: true, locationId: true, lotKey: true },
    }),
    categories.length > 0
      ? tx.stockBalance.findMany({
          where: {
            locationId: { in: ids },
            quantity: { gt: 0 },
            product: { categoryId: { in: categories } },
          },
          distinct: ["locationId", "productId"],
          select: {
            locationId: true,
            productId: true,
            product: { select: { categoryId: true } },
          },
        })
      : Promise.resolve([]),
    loadPlacementRules(tx, [
      ...ids,
      ...new Set(idle.map((row) => row.locationId)),
    ]),
    stockOf(
      tx,
      productIds,
      idle.map((row) => row.locationId),
    ),
  ]);
  const unitsAt = new Map(
    held.map((row) => [row.locationId, (row._sum.quantity ?? 0).toString()]),
  );
  // In sets, so ranking a row is linear in the open places.
  const productAt = new Set(
    same.map((item) => at(item.productId, item.locationId)),
  );
  const lotAt = new Set(
    same.map((item) => `${at(item.productId, item.locationId)}|${item.lotKey}`),
  );
  const familyAt = new Map<string, Set<string>>();
  for (const item of family) {
    const key = `${item.product.categoryId}|${item.locationId}`;
    familyAt.set(key, (familyAt.get(key) ?? new Set()).add(item.productId));
  }
  const preference = putawayPreferenceOf(
    await readSetting(tx, PUTAWAY_PREFERENCE),
  );
  const found: Raw[] = [];
  for (const row of idle) {
    if (found.length >= remaining || context.budget.spent) break;
    const card = cardOf.get(row.productId);
    if (!card || blocked(busy, row.productId, row.locationId)) continue;
    const open = storage.filter((place) =>
      destinationFree(busy, row.productId, place.id),
    );
    // No destination left for anyone: nothing more to try.
    if (!storage.some((place) => !busy.used.has(place.id))) break;
    if (open.length === 0) continue;
    const quantity = dec(row.quantity.toString());
    // All of it leaves, so the picking place empties of the product.
    if (
      !stock.onlyThis(row.productId, row.locationId, row.lotId) ||
      !stock.free(row.productId, row.locationId, row.lotId).equals(quantity)
    ) {
      continue;
    }
    // Ranking costs one look per open place: bounded like the rest.
    context.budget.looks += open.length;
    if (context.budget.looks > LOOKS_MAX) {
      context.budget.spent = true;
      break;
    }
    const ranked = rankPutawayPlaces(
      open.map((place) => ({
        id: place.id,
        readingOrder: place.readingOrder,
        units: unitsAt.get(place.id) ?? "0",
        sameProduct: productAt.has(at(row.productId, place.id)),
        sameLot:
          row.lotId !== null &&
          lotAt.has(`${at(row.productId, place.id)}|${row.lotId}`),
        sameCategory:
          card.categoryId !== null &&
          [...(familyAt.get(`${card.categoryId}|${place.id}`) ?? [])].some(
            (productId) => productId !== row.productId,
          ),
      })),
      preference,
    );
    let tried = 0;
    for (const place of ranked) {
      if (tried >= DESTINATIONS_TRIED || context.budget.spent) break;
      const amount = await fittingAmount(
        context,
        {
          card,
          fromLocationId: row.locationId,
          toLocationId: place.id,
          most: quantity,
          whole: true,
        },
        rules,
      );
      if (!amount.greaterThan(0)) {
        if (
          rules.chainOf(place.id).some((node) => rules.capacities.has(node.id))
        ) {
          tried += 1;
        }
        continue;
      }
      found.push(
        plan(context, {
          kind: "idle",
          productId: row.productId,
          lotId: row.lotId,
          fromLocationId: row.locationId,
          toLocationId: place.id,
          quantity,
          reason: slottingReason("idle", { idleDays }),
        }),
      );
      break;
    }
  }
  truncated ||= context.budget.spent;
  return { found, truncated };
}

// ── 3. Join what is spread ──────────────────────────────────────────────

async function consolidateSuggestions(
  context: Context,
  places: () => Promise<StoragePlace[]>,
  remaining: number,
): Promise<{ found: Raw[]; truncated: boolean }> {
  const { tx, busy, only } = context;
  if (remaining <= 0) return { found: [], truncated: false };
  // First: is there any destination at all? (A storage leaf with nothing
  // on its way to it.)
  const storage = (await places()).filter((place) => !busy.to.has(place.id));
  if (storage.length < 2) return { found: [], truncated: false };
  const where = {
    quantity: { gt: 0 },
    ...AVAILABLE_ANY_LOT,
    location: leafOf(context, "STORAGE"),
    product: { status: "ACTIVE" as const },
    ...(only
      ? { productId: only.productId, lotKey: lotKeyOf(only.lotId) }
      : {}),
  };
  const groups = await tx.stockBalance.groupBy({
    by: ["productId", "lotKey"],
    where,
    having: { locationId: { _count: { gt: 1 } } },
    orderBy: [{ productId: "asc" }, { lotKey: "asc" }],
    take: SLOTTING_SCAN_MAX + 1,
  });
  let truncated = groups.length > SLOTTING_SCAN_MAX;
  const kept = groups.slice(0, SLOTTING_SCAN_MAX);
  if (kept.length === 0) return { found: [], truncated };
  // Every row of those groups, at once.
  const productIds = [...new Set(kept.map((group) => group.productId))];
  const wanted = new Set(
    kept.map((group) => `${group.productId}|${group.lotKey}`),
  );
  const ROWS_MAX = SLOTTING_SCAN_MAX * 4;
  const read = await tx.stockBalance.findMany({
    where: { ...where, productId: { in: productIds } },
    orderBy: { id: "asc" },
    take: ROWS_MAX + 1,
    select: {
      productId: true,
      locationId: true,
      lotId: true,
      lotKey: true,
      quantity: true,
    },
  });
  truncated ||= read.length > ROWS_MAX;
  const rows = read
    .slice(0, ROWS_MAX)
    .filter((row) => wanted.has(`${row.productId}|${row.lotKey}`));
  const [cards, rules, stock] = await Promise.all([
    tx.product.findMany({
      where: { id: { in: productIds } },
      select: PRODUCT_CARD,
    }) as Promise<ProductCard[]>,
    loadPlacementRules(tx, [...new Set(rows.map((row) => row.locationId))]),
    stockOf(
      tx,
      productIds,
      rows.map((row) => row.locationId),
    ),
  ]);
  const cardOf = new Map(cards.map((card) => [card.id, card]));
  const found: Raw[] = [];
  for (const group of kept) {
    if (found.length >= remaining || context.budget.spent) break;
    const card = cardOf.get(group.productId);
    const members = rows.filter(
      (row) => row.productId === group.productId && row.lotKey === group.lotKey,
    );
    if (!card || members.length < 2) continue;
    const lotId = members[0]!.lotId;
    const facts = members.map((row) => {
      const quantity = dec(row.quantity.toString());
      return {
        locationId: row.locationId,
        quantity,
        movable:
          !blocked(busy, group.productId, row.locationId) &&
          (!only || row.locationId === only.fromLocationId) &&
          stock.onlyThis(group.productId, row.locationId, lotId) &&
          stock.free(group.productId, row.locationId, lotId).equals(quantity),
      };
    });
    const quantityAt = new Map(
      facts.map((row) => [row.locationId, row.quantity]),
    );
    let done = false;
    for (const pair of consolidationPlan(facts)) {
      if (done || context.budget.spent) break;
      let tried = 0;
      for (const target of pair.targets) {
        if (tried >= DESTINATIONS_TRIED || context.budget.spent) break;
        if (!destinationFree(busy, group.productId, target)) continue;
        if (only && target !== only.toLocationId) continue;
        const most = quantityAt.get(pair.fromId)!;
        const amount = await fittingAmount(
          context,
          {
            card,
            fromLocationId: pair.fromId,
            toLocationId: target,
            most,
            whole: true,
          },
          rules,
        );
        if (!amount.greaterThan(0)) {
          tried += 1;
          continue;
        }
        found.push(
          plan(context, {
            kind: "consolidate",
            productId: group.productId,
            lotId,
            fromLocationId: pair.fromId,
            toLocationId: target,
            quantity: most,
            reason: slottingReason("consolidate", { places: members.length }),
          }),
        );
        done = true;
        break;
      }
    }
  }
  truncated ||= context.budget.spent;
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
    budget: newBudget(),
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
      places,
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
  // Both places in the person's warehouse and zones before reading
  // anything else: what lies outside answers as if it did not exist.
  const scoped = await locationScopeWhere(client, userId);
  const reachable = await client.location.count({
    where: {
      id: { in: [only.fromLocationId, only.toLocationId] },
      facilityId: facility.id,
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
  });
  if (only.fromLocationId === only.toLocationId || reachable !== 2) {
    return { ok: false, reason: "changed", formError: SUGGESTION_CHANGED };
  }
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
            // The plan's rule: no open task of the product leaves or
            // arrives at either end (so two suggestions never contradict).
            OR: [
              { fromLocationId: task.fromLocationId },
              { toLocationId: task.fromLocationId },
              { fromLocationId: task.toLocationId },
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
