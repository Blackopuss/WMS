import "server-only";

import { dec } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  MAX_LOCATION_LEVELS,
  activeFacilityOf,
  isLimited,
  locationScopeWhere,
  compareLocationNames,
  locationPath,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { readSetting } from "@/platform/settings";

import { formatStock, type InventoryActor } from "./movements";
import { PUTAWAY_MODE } from "./settings";
import { AVAILABLE_ANY_LOT } from "./stock-status";
import { OPEN_TASK_STATUSES, formatTaskNumber } from "./task-states";

/**
 * Stock waiting to be put away (WMS-72): what the warehouse the person
 * works in already has, but still in its first location («General») or in a
 * location used for receiving. Nothing is stored about it: it is worked
 * out from the balances every time it is asked.
 *
 * - The quantity is what can be moved: AVAILABLE stock (ADR 0033), the same
 *   rows «Cambiar de lugar» works on. Damaged or held goods are not listed:
 *   they cannot be relocated. Reservations are not subtracted: what an
 *   order holds there still has to leave that place.
 * - A warehouse with no place to put things away — no storage or picking
 *   location besides «General» and the staging one — has nothing waiting:
 *   there «General» is the whole warehouse.
 */

export const UNPLACED_PAGE_SIZE = 25;

/** Locations of one warehouse that are looked at in one go. */
const MAX_LOCATIONS_READ = 1_000;

/** Entries read back, at most, to date what is still in a place. */
const MAX_ENTRIES_READ = 50;

export type UnplacedItem = {
  productId: string;
  name: string;
  sku: string;
  unitCode: string;
  locationId: string;
  /** «General», «Andén › Recepción». */
  locationPath: string;
  /** Available there, in the product's unit: "40". */
  quantity: string;
  /** «40 piezas». */
  quantityLabel: string;
  /**
   * Since when it waits: the entry into that place of the oldest goods
   * still there, taking what left as the oldest first. Null only when the
   * balance has no entry behind it.
   */
  since: Date | null;
  /**
   * WMS-52: what open put-away tasks already take from here («40 piezas»),
   * and the first of them; null when none does.
   */
  task: {
    id: string;
    numberText: string;
    coveredLabel: string;
    covers: boolean;
  } | null;
};

export type UnplacedPage = {
  /** One per product and place, the products of this page in name order. */
  items: UnplacedItem[];
  /** Products with something waiting, every page counted. */
  total: number;
  page: number;
  pageCount: number;
  /** Warehouse the list is about: the one the person works in. */
  facilityName: string;
  /** False when the warehouse has nowhere to put things away yet. */
  hasPlaces: boolean;
  /** WMS-52: the company puts away with tasks (`PUTAWAY_MODE`). */
  withTasks: boolean;
};

type Client = ReturnType<typeof forOrganization>;
type Reader = Pick<Client, "location">;

/**
 * Where goods are kept for good: what a put-away is for (WMS-52) and what
 * makes a warehouse have something to put away. Storage and picking
 * locations, active, never «General» nor the staging one.
 */
export const STORE_PLACE = {
  archivedAt: null,
  isDefault: null,
  isStaging: null,
  type: { in: ["STORAGE", "PICKING"] as ("STORAGE" | "PICKING")[] },
};

/**
 * Where goods wait to be put away: «General» and the receiving locations,
 * never the staging one. The one definition of a place «de paso» (WMS-72,
 * WMS-52): «Sin acomodar» lists them and put-away tasks leave from them.
 */
export const WAITING_PLACE = {
  isStaging: null,
  OR: [{ isDefault: true }, { type: "RECEIVING" as const }],
};

/**
 * WMS-31 (ADR 0093): a location of use «Producción» or anything inside
 * one (its own type or an ancestor's), in one condition of the query: an
 * area of production keeps what is made and the materials of its orders,
 * it is never where a put-away leaves goods.
 */
export const IN_PRODUCTION_AREA = (() => {
  const levels: Record<string, unknown>[] = [{ type: "PRODUCTION" }];
  let nested: Record<string, unknown> = { type: "PRODUCTION" };
  for (let depth = 1; depth < MAX_LOCATION_LEVELS; depth++) {
    nested = { parent: { is: nested } };
    levels.push(nested);
  }
  return { OR: levels };
})();

/** Is this location of a warehouse a place where goods wait? */
export const isWaitingPlace = (location: {
  isDefault: boolean | null;
  isStaging: boolean | null;
  type: string;
}) =>
  location.isStaging !== true &&
  (location.isDefault === true || location.type === "RECEIVING");

/**
 * Whether a warehouse has somewhere to put things away: without one,
 * «General» is the whole warehouse and nothing waits.
 */
export async function facilityHasPlaces(
  client: Reader,
  facilityId: string,
): Promise<boolean> {
  const somewhere = await client.location.findFirst({
    where: { facilityId, ...STORE_PLACE },
    select: { id: true },
  });
  return somewhere !== null;
}

/**
 * Where goods wait in the warehouse of the person: «General» and the
 * receiving locations. Empty when the warehouse has no other place to
 * store.
 */
export async function waitingPlaces(client: Client, userId: string) {
  const facility = await activeFacilityOf(client, userId);
  if (!(await facilityHasPlaces(client, facility.id))) {
    return { facility, hasPlaces: false, places: [] };
  }
  // WMS-20: someone limited to zones only sees what waits in their own.
  const scoped = await locationScopeWhere(client, userId);
  const places = await client.location.findMany({
    where: {
      facilityId: facility.id,
      archivedAt: null,
      isStaging: WAITING_PLACE.isStaging,
      AND: [{ OR: WAITING_PLACE.OR }, ...(isLimited(scoped) ? [scoped] : [])],
    },
    take: MAX_LOCATIONS_READ,
    select: { id: true, name: true, isDefault: true, parent: LOCATION_PARENTS },
  });
  return { facility, hasPlaces: true, places };
}

/** Products with available stock in any of these places. */
const waitingIn = (locationIds: string[]) => ({
  balances: {
    some: {
      locationId: { in: locationIds },
      ...AVAILABLE_ANY_LOT,
      quantity: { gt: 0 },
    },
  },
});

/**
 * Entry of the oldest goods still in a place: the latest entries are added
 * up, newest first, until they cover what is there today (what left is
 * taken as the oldest). With more than MAX_ENTRIES_READ entries behind the
 * balance, the oldest one read: it waits at least since then.
 */
async function waitingSince(
  client: Client,
  productId: string,
  locationId: string,
  quantity: string,
): Promise<Date | null> {
  const entries = await client.stockMovementLine.findMany({
    where: { productId, locationId, direction: "IN", ...AVAILABLE_ANY_LOT },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_ENTRIES_READ,
    select: { baseQuantity: true, createdAt: true },
  });
  let covered = dec(0);
  let since: Date | null = null;
  for (const entry of entries) {
    since = entry.createdAt;
    covered = covered.plus(entry.baseQuantity.toString());
    if (covered.greaterThanOrEqualTo(quantity)) break;
  }
  return since;
}

/**
 * What waits to be put away in the warehouse of the person, one page of
 * products at a time (in name order). Only stock of the actor's company.
 */
export async function listUnplacedStock(
  actor: InventoryActor,
  options: { page?: number } = {},
): Promise<UnplacedPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const { facility, hasPlaces, places } = await waitingPlaces(
    client,
    actor.userId,
  );
  const withTasks = (await readSetting(client, PUTAWAY_MODE)) === "tasks";
  const empty = {
    items: [],
    total: 0,
    page: 1,
    pageCount: 1,
    facilityName: facility.name,
    hasPlaces,
    withTasks,
  };
  if (places.length === 0) return empty;
  const locationIds = places.map((place) => place.id);
  const where = waitingIn(locationIds);
  const total = await client.product.count({ where });
  if (total === 0) return empty;
  const pageCount = Math.max(1, Math.ceil(total / UNPLACED_PAGE_SIZE));
  const requested = Number.isInteger(options.page) ? Number(options.page) : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const products = await client.product.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * UNPLACED_PAGE_SIZE,
    take: UNPLACED_PAGE_SIZE,
    select: { id: true, name: true, sku: true, unitCode: true },
  });
  // WMS-21: a product by lot has a row per lot; a place adds them up.
  const balances = (
    await client.stockBalance.groupBy({
      by: ["productId", "locationId"],
      where: {
        productId: { in: products.map((product) => product.id) },
        locationId: { in: locationIds },
        ...AVAILABLE_ANY_LOT,
        quantity: { gt: 0 },
      },
      _sum: { quantity: true },
      orderBy: [{ productId: "asc" }, { locationId: "asc" }],
    })
  ).map((group) => ({
    productId: group.productId,
    locationId: group.locationId,
    quantity: group._sum.quantity ?? 0,
  }));
  // WMS-52: what open put-away tasks already take from each place.
  const tasks = await client.warehouseTask.findMany({
    where: {
      kind: "PUTAWAY",
      status: { in: [...OPEN_TASK_STATUSES] },
      productId: { in: products.map((product) => product.id) },
      fromLocationId: { in: locationIds },
    },
    orderBy: { number: "asc" },
    take: 2_000,
    select: {
      id: true,
      number: true,
      productId: true,
      fromLocationId: true,
      quantity: true,
    },
  });
  const taskOf = new Map<
    string,
    { id: string; number: number; quantity: ReturnType<typeof dec> }
  >();
  for (const task of tasks) {
    const key = `${task.productId} ${task.fromLocationId}`;
    const known = taskOf.get(key);
    taskOf.set(key, {
      id: known?.id ?? task.id,
      number: known?.number ?? task.number,
      quantity: (known?.quantity ?? dec(0)).plus(
        task.quantity?.toString() ?? 0,
      ),
    });
  }
  const placeOf = new Map(
    places.map((place) => [
      place.id,
      { path: locationPath(place), general: place.isDefault === true },
    ]),
  );
  const items: UnplacedItem[] = [];
  for (const product of products) {
    const rows = balances
      .filter((balance) => balance.productId === product.id)
      .map((balance) => ({
        locationId: balance.locationId,
        locationPath: placeOf.get(balance.locationId)?.path ?? "",
        quantity: balance.quantity.toString(),
      }))
      // «General» first, then the receiving places in reading order.
      .sort(
        (a, b) =>
          Number(placeOf.get(b.locationId)?.general ?? false) -
            Number(placeOf.get(a.locationId)?.general ?? false) ||
          compareLocationNames(a.locationPath, b.locationPath) ||
          a.locationId.localeCompare(b.locationId),
      );
    for (const row of rows) {
      const task = taskOf.get(`${product.id} ${row.locationId}`);
      items.push({
        productId: product.id,
        name: product.name,
        sku: product.sku,
        unitCode: product.unitCode,
        ...row,
        quantityLabel: formatStock(row.quantity, product.unitCode),
        since: await waitingSince(
          client,
          product.id,
          row.locationId,
          row.quantity,
        ),
        task: task
          ? {
              id: task.id,
              numberText: formatTaskNumber(task.number),
              coveredLabel: formatStock(
                task.quantity.toString(),
                product.unitCode,
              ),
              covers: task.quantity.greaterThanOrEqualTo(row.quantity),
            }
          : null,
      });
    }
  }
  return {
    items,
    total,
    page,
    pageCount,
    facilityName: facility.name,
    hasPlaces,
    withTasks,
  };
}

/** How many products wait to be put away in the warehouse of the person. */
export async function countUnplacedStock(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const { places } = await waitingPlaces(client, actor.userId);
  if (places.length === 0) return 0;
  return client.product.count({
    where: waitingIn(places.map((place) => place.id)),
  });
}
