import "server-only";

import { dec } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  isLimited,
  locationScopeWhere,
  compareLocationNames,
  locationPath,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { formatStock, type InventoryActor } from "./movements";
import { AVAILABLE_ANY_LOT } from "./stock-status";

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
};

type Client = ReturnType<typeof forOrganization>;

/**
 * Where goods wait in the warehouse of the person: «General» and the
 * receiving locations. Empty when the warehouse has no other place to
 * store.
 */
async function waitingPlaces(client: Client, userId: string) {
  const facility = await activeFacilityOf(client, userId);
  const somewhere = await client.location.findFirst({
    where: {
      facilityId: facility.id,
      archivedAt: null,
      isDefault: null,
      isStaging: null,
      type: { in: ["STORAGE", "PICKING"] },
    },
    select: { id: true },
  });
  if (!somewhere) return { facility, hasPlaces: false, places: [] };
  // WMS-20: someone limited to zones only sees what waits in their own.
  const scoped = await locationScopeWhere(client, userId);
  const places = await client.location.findMany({
    where: {
      facilityId: facility.id,
      archivedAt: null,
      isStaging: null,
      AND: [
        { OR: [{ isDefault: true }, { type: "RECEIVING" }] },
        ...(isLimited(scoped) ? [scoped] : []),
      ],
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
  const empty = {
    items: [],
    total: 0,
    page: 1,
    pageCount: 1,
    facilityName: facility.name,
    hasPlaces,
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
