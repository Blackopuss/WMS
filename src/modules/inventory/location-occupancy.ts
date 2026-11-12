import "server-only";

import { dec, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  CAPACITY_MEASURES,
  activeFacilityOf,
  assertFacilityInScope,
  isLimited,
  locationScopeWhere,
  type CapacityMeasure,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import type { InventoryActor } from "./movements";
import { addMeasured } from "./placement";

/**
 * How full each location of a warehouse is (WMS-22B, PC-11): what it holds
 * itself plus what everything inside it holds, each balance counted once.
 * Derived on every read from the balances — nothing is stored — and for
 * every state of the stock (ADR 0033): what is physically there.
 *
 * Units are the quantities of every product added up, each in its own
 * unit; weight is in kilograms and volume in cubic meters, and a product
 * whose card does not say them does not count there (`unweighed`,
 * `unsized` tell the screen to say so).
 */

/** Balance rows read at most; beyond it the report says it is incomplete. */
export const OCCUPANCY_MAX_ROWS = 50_000;

export type LocationOccupancy = {
  /** Sum of the quantities, each product in its own unit. */
  units: string;
  /** Kilograms. */
  weight: string;
  /** Cubic meters. */
  volume: string;
  /** Something inside has no weight in its card: it is not in `weight`. */
  unweighed: boolean;
  /** Something inside has no volume in its card: it is not in `volume`. */
  unsized: boolean;
  /** Measures in which it is above its own capacity. */
  over: CapacityMeasure[];
};

export type OccupancyReport = {
  /** By location id; a location that holds nothing is not listed. */
  byLocation: Record<string, LocationOccupancy>;
  /** There was more stock than is read at once: the totals are incomplete. */
  truncated: boolean;
};

type Total = {
  units: Decimal;
  weight: Decimal;
  volume: Decimal;
  unweighed: boolean;
  unsized: boolean;
};

const empty = (): Total => ({
  units: dec(0),
  weight: dec(0),
  volume: dec(0),
  unweighed: false,
  unsized: false,
});

/**
 * The occupancy of every location of one warehouse — the one asked for or
 * the one the person works in — inside the person's scope (WMS-20).
 */
export async function getLocationOccupancy(
  actor: InventoryActor,
  options: { facilityId?: string } = {},
): Promise<OccupancyReport> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const facilityId =
    options.facilityId ?? (await activeFacilityOf(client, actor.userId)).id;
  await assertFacilityInScope(client, actor.userId, facilityId);
  // With zones, only their locations: what is inside one of them is too.
  const scoped = await locationScopeWhere(client, actor.userId);
  const inScope = isLimited(scoped) ? scoped : {};

  const [locations, capacities, balances] = await Promise.all([
    client.location.findMany({
      where: { facilityId, ...inScope },
      select: { id: true, parentId: true },
    }),
    client.locationCapacity.findMany({
      where: { location: { facilityId } },
      select: {
        locationId: true,
        maxUnits: true,
        maxWeight: true,
        maxVolume: true,
      },
    }),
    // One row per product and location: every state and lot added up.
    client.stockBalance.groupBy({
      by: ["locationId", "productId"],
      where: { quantity: { gt: 0 }, location: { facilityId, ...inScope } },
      _sum: { quantity: true },
      orderBy: [{ locationId: "asc" }, { productId: "asc" }],
      take: OCCUPANCY_MAX_ROWS + 1,
    }),
  ]);
  const truncated = balances.length > OCCUPANCY_MAX_ROWS;
  const rows = truncated ? balances.slice(0, OCCUPANCY_MAX_ROWS) : balances;

  const productIds = [...new Set(rows.map((row) => row.productId))];
  const cards = new Map<
    string,
    {
      unitCode: string;
      unitWeight: { toString(): string } | null;
      unitVolume: { toString(): string } | null;
    }
  >();
  for (let start = 0; start < productIds.length; start += 1_000) {
    const piece = await client.product.findMany({
      where: { id: { in: productIds.slice(start, start + 1_000) } },
      select: { id: true, unitCode: true, unitWeight: true, unitVolume: true },
    });
    for (const card of piece) cards.set(card.id, card);
  }

  // What each location holds itself: every balance lands in exactly one.
  const own = new Map<string, Total>();
  for (const row of rows) {
    const total = own.get(row.locationId) ?? empty();
    const quantity = dec(row._sum.quantity?.toString() ?? 0);
    const card = cards.get(row.productId);
    if (card) {
      const measured = addMeasured(total, card, quantity);
      if (!measured.weighed) total.unweighed = true;
      if (!measured.sized) total.unsized = true;
    } else {
      total.units = total.units.plus(quantity);
    }
    own.set(row.locationId, total);
  }

  // Each node = its own stock + the total of each child, once.
  const children = new Map<string, string[]>();
  for (const location of locations) {
    if (location.parentId === null) continue;
    const list = children.get(location.parentId) ?? [];
    list.push(location.id);
    children.set(location.parentId, list);
  }
  const totals = new Map<string, Total>();
  const totalOf = (id: string, depth: number): Total => {
    const known = totals.get(id);
    if (known) return known;
    const mine = own.get(id) ?? empty();
    const total: Total = { ...mine };
    // Levels bound the depth; the limit only guards against bad data.
    if (depth < 16) {
      for (const childId of children.get(id) ?? []) {
        const inside = totalOf(childId, depth + 1);
        total.units = total.units.plus(inside.units);
        total.weight = total.weight.plus(inside.weight);
        total.volume = total.volume.plus(inside.volume);
        total.unweighed ||= inside.unweighed;
        total.unsized ||= inside.unsized;
      }
    }
    totals.set(id, total);
    return total;
  };

  const limitOf = new Map(
    capacities.map((row) => [
      row.locationId,
      {
        units: row.maxUnits?.toString() ?? null,
        weight: row.maxWeight?.toString() ?? null,
        volume: row.maxVolume?.toString() ?? null,
      },
    ]),
  );
  const byLocation: Record<string, LocationOccupancy> = {};
  for (const location of locations) {
    const total = totalOf(location.id, 0);
    if (total.units.isZero()) continue;
    const limits = limitOf.get(location.id);
    byLocation[location.id] = {
      units: total.units.toString(),
      weight: total.weight.toString(),
      volume: total.volume.toString(),
      unweighed: total.unweighed,
      unsized: total.unsized,
      over: limits
        ? CAPACITY_MEASURES.filter((measure) => {
            const limit = limits[measure];
            return limit !== null && total[measure].greaterThan(limit);
          })
        : [],
    };
  }
  return { byLocation, truncated };
}
