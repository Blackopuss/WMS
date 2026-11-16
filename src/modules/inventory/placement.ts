import "server-only";

import { dec, type Decimal } from "@/lib";
import { unitVolumeOf, unitWeightOf } from "@/platform/catalog";
import {
  CAPACITY_MEASURES,
  LITERS_PER_CUBIC_METER,
  formatCapacityAmount,
  formatCapacityUse,
  scaleToTell,
  type CapacityLimits,
  type CapacityMeasure,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { lockRows, type TenantDb } from "@/server";

import { CAPACITY_MODE } from "./settings";
import type { StockStatus } from "./stock-status";

/**
 * Whether stock may be put in a location (WMS-22B, ADR 0039): the one
 * place that decides it. Every operation that brings stock into a location
 * calls `checkPlacement` inside its transaction, after its own locks and
 * before it writes anything.
 *
 * Two kinds of rule, and both count for a location and for everything
 * inside it (a rule of a zone holds for its aisles and shelves):
 *
 * - Restrictions always stop: a quarantine location takes no available
 *   stock, and a location limited to some products or categories takes
 *   nothing else.
 * - Capacity (units, weight, volume) depends on the company
 *   (`CAPACITY_MODE`): warn — nothing is written until the person accepts
 *   — or block. Where nobody can be asked (the delivery of a task, a
 *   reversal) the caller passes `report`: it never stops and the answer
 *   says what was left above its capacity.
 *
 * What is already stored is never corrected here: a location above its
 * capacity stays as it is, and only what would add to it is questioned.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** Stock about to be put in a location. */
export type Arrival = {
  /** Null for a product the same transaction is about to create. */
  productId: string | null;
  /**
   * Its category when the caller knows it better than the catalog (an
   * import that is about to change it); absent = the one of the catalog.
   */
  categoryId?: string | null;
  /** How the product is named in a refusal; absent = its name. */
  label?: string;
  /** In the product's unit. */
  quantity: Decimal;
  toLocationId: string;
  /**
   * Where the same movement takes it from (a relocation, a change of
   * state): moving inside a location adds nothing to it.
   */
  fromLocationId?: string | null;
  /** The state it arrives in. */
  status: StockStatus;
};

/**
 * What to do when a capacity would be exceeded:
 * - `ask`: what the company chose; with warn, only `accepted` lets it in.
 * - `report`: never stops; the notes say what was left above capacity.
 * - `skip`: capacity is not looked at (only restrictions).
 */
export type CapacityPolicy =
  { mode: "ask"; accepted: boolean } | { mode: "report" } | { mode: "skip" };

export type PlacementProblem =
  | {
      ok: false;
      reason: "restricted";
      /** Position of the arrival with the problem. */
      index: number;
      message: string;
    }
  | {
      ok: false;
      reason: "over_capacity";
      index: number;
      /** «Con esto, «Estante 3» tendría 620 unidades y su capacidad es de 500 unidades.» */
      message: string;
      /** The company forbids it; false = it only waits to be accepted. */
      blocked: boolean;
    };

export type PlacementResult =
  | {
      ok: true;
      /** One sentence per location left above its capacity. */
      notes: string[];
    }
  | PlacementProblem;

/**
 * A movement would leave a location above its capacity and the company
 * only warns (WMS-22B): nothing was written. It is not a refusal: sending
 * it again with `acceptCapacity` registers it.
 */
export type OverCapacity = {
  ok: false;
  reason: "over_capacity";
  fieldErrors: Record<string, never>;
  /** «Con esto, «Estante 3» tendría 620 unidades y su capacidad es de 500 unidades.» */
  formError: string;
};

/** Carries the warning out of the transaction, so nothing is written. */
export class CapacityNotice extends Error {
  readonly result: OverCapacity;
  constructor(message: string) {
    super("over capacity");
    this.result = {
      ok: false,
      reason: "over_capacity",
      fieldErrors: {},
      formError: message,
    };
  }
}

/** Uses of a location that take no available stock (WMS-22B, WMS-75). */
const NO_AVAILABLE_TYPES: ReadonlySet<string> = new Set([
  "QUARANTINE",
  "REPAIR",
]);

type Node = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
};

type CapacityRow = { id: string; limits: CapacityLimits };

/**
 * What limits the locations of a movement, read once: the tree of their
 * warehouses and the restrictions and capacities of each location and of
 * everything above it.
 */
export type PlacementRules = {
  /** The location first, then what contains it, up to the warehouse. */
  chainOf(locationId: string | null | undefined): Node[];
  /** The location and everything inside it. */
  subtreeOf(locationId: string): string[];
  restrictions: Map<string, { products: Set<string>; categories: Set<string> }>;
  capacities: Map<string, CapacityRow>;
};

const limitsOf = (row: {
  maxUnits: { toString(): string } | null;
  maxWeight: { toString(): string } | null;
  maxVolume: { toString(): string } | null;
}): CapacityLimits => ({
  units: row.maxUnits?.toString() ?? null,
  weight: row.maxWeight?.toString() ?? null,
  volume: row.maxVolume?.toString() ?? null,
});

/** Reads the rules that apply to these locations (three queries). */
export async function loadPlacementRules(
  tx: Tx,
  locationIds: readonly (string | null | undefined)[],
): Promise<PlacementRules> {
  const ids = [
    ...new Set(
      locationIds.filter(
        (id): id is string => typeof id === "string" && id !== "",
      ),
    ),
  ];
  const nodes =
    ids.length > 0
      ? await tx.location.findMany({
          // Every location of the warehouses involved: ancestors to walk
          // up, descendants to add up.
          where: { facility: { locations: { some: { id: { in: ids } } } } },
          select: { id: true, name: true, type: true, parentId: true },
        })
      : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const chainOf = (locationId: string | null | undefined): Node[] => {
    const chain: Node[] = [];
    let node = locationId ? byId.get(locationId) : undefined;
    // Levels bound the depth; the counter only guards against bad data.
    for (let step = 0; node && step < 16; step++) {
      chain.push(node);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return chain;
  };
  const subtreeOf = (locationId: string): string[] => {
    const inside: string[] = [];
    const seen = new Set<string>();
    const pending = [locationId];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      inside.push(id);
      pending.push(...(children.get(id) ?? []));
    }
    return inside;
  };

  const chainIds = [
    ...new Set(ids.flatMap((id) => chainOf(id).map((node) => node.id))),
  ];
  const restrictions: PlacementRules["restrictions"] = new Map();
  const capacities: PlacementRules["capacities"] = new Map();
  if (chainIds.length > 0) {
    const [restricted, limited] = await Promise.all([
      tx.locationRestriction.findMany({
        where: { locationId: { in: chainIds } },
        select: { locationId: true, productId: true, categoryId: true },
      }),
      tx.locationCapacity.findMany({
        where: { locationId: { in: chainIds } },
        select: {
          id: true,
          locationId: true,
          maxUnits: true,
          maxWeight: true,
          maxVolume: true,
        },
      }),
    ]);
    for (const row of restricted) {
      const entry = restrictions.get(row.locationId) ?? {
        products: new Set<string>(),
        categories: new Set<string>(),
      };
      if (row.productId) entry.products.add(row.productId);
      if (row.categoryId) entry.categories.add(row.categoryId);
      restrictions.set(row.locationId, entry);
    }
    for (const row of limited) {
      capacities.set(row.locationId, { id: row.id, limits: limitsOf(row) });
    }
  }
  return { chainOf, subtreeOf, restrictions, capacities };
}

/**
 * Why a restriction keeps this stock out of its destination, ready to
 * show, or null when nothing does. Pure: it decides with the rules read.
 */
export function restrictionProblem(
  rules: PlacementRules,
  arrival: Pick<Arrival, "toLocationId" | "fromLocationId" | "status">,
  product: { id: string | null; categoryId: string | null; name: string },
): string | null {
  const chain = rules.chainOf(arrival.toLocationId);
  const destination = chain[0];
  // A location that does not exist is answered by the caller.
  if (!destination) return null;
  const where = (node: Node, what: string) =>
    node.id === destination.id
      ? `«${destination.name}» ${what}`
      : `«${destination.name}» está dentro de «${node.name}», que ${what}`;

  // A quarantine place (and a repair place, WMS-75) takes no available
  // stock, wherever it comes from: not even a change of state done there.
  if (arrival.status === "AVAILABLE") {
    const closed = chain.find((node) => NO_AVAILABLE_TYPES.has(node.type));
    if (closed) {
      return `${where(closed, closed.type === "REPAIR" ? "es de restauración" : "es de cuarentena")}: solo recibe existencias que no están disponibles.`;
    }
  }
  // Products and categories: asked of every location it enters. What it
  // was already inside of (a move within a zone) is not entered again.
  const already = new Set(
    rules.chainOf(arrival.fromLocationId).map((node) => node.id),
  );
  for (const node of chain) {
    if (already.has(node.id)) break;
    const allowed = rules.restrictions.get(node.id);
    if (!allowed) continue;
    if (product.id && allowed.products.has(product.id)) continue;
    if (product.categoryId && allowed.categories.has(product.categoryId)) {
      continue;
    }
    return `${where(node, "solo admite ciertos productos")}: ${product.name} no está entre ellos.`;
  }
  return null;
}

type Measured = Record<CapacityMeasure, Decimal>;

const nothing = (): Measured => ({
  units: dec(0),
  weight: dec(0),
  volume: dec(0),
});

type ProductMeasures = {
  unitCode: string;
  unitWeight: { toString(): string } | null;
  unitVolume: { toString(): string } | null;
};

/**
 * Adds a quantity of a product to a total: its units as they are, its
 * weight in kilograms and its volume in cubic meters. A product without
 * weight or volume does not count in that measure.
 */
export function addMeasured(
  total: Measured,
  product: ProductMeasures,
  quantity: Decimal,
): { weighed: boolean; sized: boolean } {
  total.units = total.units.plus(quantity);
  const weight = unitWeightOf(product);
  if (weight) total.weight = total.weight.plus(quantity.times(weight));
  const volume = unitVolumeOf(product);
  if (volume) {
    total.volume = total.volume.plus(
      quantity.times(volume).dividedBy(LITERS_PER_CUBIC_METER),
    );
  }
  return { weighed: weight !== null, sized: volume !== null };
}

const MEASURE_SELECT = {
  id: true,
  unitCode: true,
  unitWeight: true,
  unitVolume: true,
} as const;

/** Reads rows by id in pieces, so a list of ids never grows too long. */
async function inPieces<T>(
  ids: readonly string[],
  read: (piece: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += 1_000) {
    rows.push(...(await read(ids.slice(start, start + 1_000))));
  }
  return rows;
}

/**
 * What these locations hold now, every state included (ADR 0033): what is
 * physically there. Weight and volume are read only when asked: they need
 * the card of each product.
 */
async function occupancyOf(
  tx: Tx,
  locationIds: readonly string[],
  withMeasures: boolean,
): Promise<Measured> {
  const total = nothing();
  if (locationIds.length === 0) return total;
  const where = {
    locationId: { in: [...locationIds] },
    quantity: { gt: 0 },
  };
  if (!withMeasures) {
    const sum = await tx.stockBalance.aggregate({
      where,
      _sum: { quantity: true },
    });
    total.units = dec(sum._sum.quantity?.toString() ?? 0);
    return total;
  }
  const byProduct = await tx.stockBalance.groupBy({
    by: ["productId"],
    where,
    _sum: { quantity: true },
  });
  const products = await inPieces(
    byProduct.map((row) => row.productId),
    (piece) =>
      tx.product.findMany({
        where: { id: { in: piece } },
        select: MEASURE_SELECT,
      }),
  );
  const cardOf = new Map(products.map((product) => [product.id, product]));
  for (const row of byProduct) {
    const quantity = dec(row._sum.quantity?.toString() ?? 0);
    const card = cardOf.get(row.productId);
    if (card) addMeasured(total, card, quantity);
    else total.units = total.units.plus(quantity);
  }
  return total;
}

/** ««Zona A» (donde está «Estante 3»)», or just the destination. */
const nameOf = (node: Node, destination: Node) =>
  node.id === destination.id
    ? `«${node.name}»`
    : `«${node.name}» (donde está «${destination.name}»)`;

/**
 * Decides whether these arrivals may be written. Call it inside the
 * transaction of the movement, after its locks (products, locations and
 * whatever document it has) and before any balance changes: with `ask` it
 * takes one more lock, on the capacities involved, so two arrivals under
 * the same limit are decided one after the other. Call it once per
 * transaction with every arrival of the movement.
 */
export async function checkPlacement(
  tx: Tx,
  arrivals: readonly Arrival[],
  policy: CapacityPolicy,
  /** Rules already read by the caller (a batch reads them once). */
  given?: PlacementRules,
): Promise<PlacementResult> {
  if (arrivals.length === 0) return { ok: true, notes: [] };
  const rules =
    given ??
    (await loadPlacementRules(
      tx,
      arrivals.flatMap((arrival) => [
        arrival.toLocationId,
        arrival.fromLocationId,
      ]),
    ));
  const quarantined = arrivals.some(
    (arrival) =>
      arrival.status === "AVAILABLE" &&
      rules
        .chainOf(arrival.toLocationId)
        .some((node) => NO_AVAILABLE_TYPES.has(node.type)),
  );
  const limited = policy.mode !== "skip" && rules.capacities.size > 0;
  // The usual case: nothing configured, nothing more to read.
  if (!quarantined && rules.restrictions.size === 0 && !limited) {
    return { ok: true, notes: [] };
  }

  const productIds = [
    ...new Set(
      arrivals.flatMap((arrival) =>
        arrival.productId ? [arrival.productId] : [],
      ),
    ),
  ];
  const cards = await inPieces(productIds, (piece) =>
    tx.product.findMany({
      where: { id: { in: piece } },
      select: { ...MEASURE_SELECT, name: true, categoryId: true },
    }),
  );
  const cardOf = new Map(cards.map((card) => [card.id, card]));

  // 1. Restrictions: they always stop.
  for (const [index, arrival] of arrivals.entries()) {
    const card = arrival.productId ? cardOf.get(arrival.productId) : undefined;
    const message = restrictionProblem(rules, arrival, {
      id: arrival.productId,
      categoryId:
        arrival.categoryId !== undefined
          ? arrival.categoryId
          : (card?.categoryId ?? null),
      name: arrival.label ?? card?.name ?? "este producto",
    });
    if (message) return { ok: false, reason: "restricted", index, message };
  }
  if (!limited) return { ok: true, notes: [] };

  // 2. Capacity: what each limited location would gain.
  type Gain = {
    node: Node;
    destination: Node;
    index: number;
    added: Measured;
  };
  const gains = new Map<string, Gain>();
  for (const [index, arrival] of arrivals.entries()) {
    const card = arrival.productId ? cardOf.get(arrival.productId) : undefined;
    if (!card) continue;
    const chain = rules.chainOf(arrival.toLocationId);
    const destination = chain[0];
    if (!destination) continue;
    const already = new Set(
      rules.chainOf(arrival.fromLocationId).map((node) => node.id),
    );
    for (const node of chain) {
      // From here up it was already inside: nothing is added.
      if (already.has(node.id)) break;
      if (!rules.capacities.has(node.id)) continue;
      const gain = gains.get(node.id) ?? {
        node,
        destination,
        index,
        added: nothing(),
      };
      addMeasured(gain.added, card, arrival.quantity);
      gains.set(node.id, gain);
    }
  }
  if (gains.size === 0) return { ok: true, notes: [] };

  if (policy.mode === "ask") {
    // The last lock of the transaction, on rows nothing else locks first:
    // whoever comes next reads the stock this movement leaves.
    await lockRows(
      tx,
      "locationCapacity",
      [...gains.keys()].map((id) => rules.capacities.get(id)!.id),
    );
    const fresh = await tx.locationCapacity.findMany({
      where: { locationId: { in: [...gains.keys()] } },
      select: {
        id: true,
        locationId: true,
        maxUnits: true,
        maxWeight: true,
        maxVolume: true,
      },
    });
    for (const id of gains.keys()) rules.capacities.delete(id);
    for (const row of fresh) {
      rules.capacities.set(row.locationId, {
        id: row.id,
        limits: limitsOf(row),
      });
    }
  }

  const notes: string[] = [];
  for (const gain of gains.values()) {
    const limits = rules.capacities.get(gain.node.id)?.limits;
    if (!limits) continue;
    const asked = CAPACITY_MEASURES.filter(
      (measure) =>
        limits[measure] !== null && gain.added[measure].greaterThan(0),
    );
    if (asked.length === 0) continue;
    const held = await occupancyOf(
      tx,
      rules.subtreeOf(gain.node.id),
      asked.some((measure) => measure !== "units"),
    );
    const over = asked.find((measure) =>
      held[measure].plus(gain.added[measure]).greaterThan(limits[measure]!),
    );
    if (!over) continue;
    const limit = limits[over]!;
    const after = held[over].plus(gain.added[over]).toString();
    const capacity = formatCapacityAmount(over, limit);
    const letIn =
      policy.mode === "report" ||
      (policy.mode === "ask" &&
        policy.accepted &&
        (await readSetting(tx, CAPACITY_MODE)) !== "block");
    if (letIn) {
      notes.push(
        `${nameOf(gain.node, gain.destination)} quedó por encima de su capacidad: ${formatCapacityUse(over, after, limit)}.`,
      );
      continue;
    }
    const blocked = (await readSetting(tx, CAPACITY_MODE)) === "block";
    return {
      ok: false,
      reason: "over_capacity",
      index: gain.index,
      message: `Con esto, ${nameOf(gain.node, gain.destination)} tendría ${formatCapacityAmount(over, after, scaleToTell(after, limit))} y su capacidad es de ${capacity}.${blocked ? " Elige otra ubicación o una cantidad menor." : ""}`,
      blocked,
    };
  }
  return { ok: true, notes };
}
