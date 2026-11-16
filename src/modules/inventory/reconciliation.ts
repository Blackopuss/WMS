import "server-only";

import { dec } from "@/lib";
import { forOrganization } from "@/server";

import { OUTBOUND_LINE_SOURCE } from "./reservation-sources";

/**
 * The balance of a product in a location, state and lot (ADR 0033) is a
 * projection of its movement lines: everything that came in minus everything that went out (INV-15).
 * This check recomputes that sum and reports where the stored balance
 * differs. It must always come back empty; tests use it after every kind of
 * movement and after concurrent ones.
 */

export type StockDrift = {
  productId: string;
  locationId: string;
  /** State of the stock that differs (ADR 0033). */
  status: string;
  /** Lot of the stock that differs; null without a lot. */
  lotId: string | null;
  /** What the movement lines add up to. */
  fromMovements: string;
  /** What the balance row says ("0" when there is no row). */
  balance: string;
  /**
   * WMS-21B: the difference is in the units by serial, not in the lines.
   * `serial_units`: the units that say they are there (`fromMovements`
   * is their count); `serial_moves`: the units whose last move left them
   * there.
   */
  source?: "serial_units" | "serial_moves" | "containers" | "holds";
};

/** Differences between balances and movement history; empty when they agree. */
export async function reconcileStock(
  organizationId: string,
): Promise<StockDrift[]> {
  const client = forOrganization(organizationId);
  const [sums, balances] = await Promise.all([
    client.stockMovementLine.groupBy({
      by: ["productId", "locationId", "status", "lotKey", "direction"],
      _sum: { baseQuantity: true },
    }),
    client.stockBalance.findMany({
      select: {
        productId: true,
        locationId: true,
        status: true,
        lotKey: true,
        quantity: true,
      },
    }),
  ]);

  const key = (row: {
    productId: string;
    locationId: string;
    status: string;
    lotKey: string;
  }) => `${row.productId}|${row.locationId}|${row.status}|${row.lotKey}`;
  const expected = new Map<string, ReturnType<typeof dec>>();
  for (const sum of sums) {
    const amount = dec((sum._sum.baseQuantity ?? 0).toString());
    const current = expected.get(key(sum)) ?? dec(0);
    expected.set(
      key(sum),
      sum.direction === "IN" ? current.plus(amount) : current.minus(amount),
    );
  }
  const stored = new Map(
    balances.map((row) => [key(row), dec(row.quantity.toString())]),
  );

  const drift: StockDrift[] = [];
  for (const id of new Set([...expected.keys(), ...stored.keys()])) {
    const fromMovements = expected.get(id) ?? dec(0);
    const balance = stored.get(id) ?? dec(0);
    if (!fromMovements.equals(balance)) {
      const [productId = "", locationId = "", status = "", lotKey = ""] =
        id.split("|");
      drift.push({
        productId,
        locationId,
        status,
        lotId: lotKey || null,
        fromMovements: fromMovements.toString(),
        balance: balance.toString(),
      });
    }
  }
  drift.push(...(await reconcileSerials(organizationId, stored)));
  drift.push(...(await reconcileContainers(organizationId, stored)));
  drift.push(...(await reconcileHolds(organizationId, stored)));
  return drift;
}

/**
 * WMS-30-0 (ADR 0068): what open documents hold of stock that is not
 * available (active holds and open customer returns) never exceeds the
 * balance of its key, and each unit held is still there, in that state.
 * `source: "holds"`; `fromMovements` is what is held.
 */
async function reconcileHolds(
  organizationId: string,
  stored: Map<string, ReturnType<typeof dec>>,
): Promise<StockDrift[]> {
  const client = forOrganization(organizationId);
  const [holds, returnLines] = await Promise.all([
    client.stockHold.findMany({
      where: { state: "ACTIVE" },
      select: {
        productId: true,
        locationId: true,
        status: true,
        lotKey: true,
        remaining: true,
        units: {
          where: { releasedAt: null },
          select: {
            serialUnit: { select: { locationId: true, status: true } },
          },
        },
      },
    }),
    client.customerReturnLine.findMany({
      where: { return: { status: "RECEIVED" } },
      select: {
        productId: true,
        lotId: true,
        quantity: true,
        return: { select: { locationId: true } },
        decisions: { select: { quantity: true } },
      },
    }),
  ]);
  if (holds.length === 0 && returnLines.length === 0) return [];
  const drift: StockDrift[] = [];
  const held = new Map<string, ReturnType<typeof dec>>();
  const add = (id: string, quantity: ReturnType<typeof dec>) =>
    held.set(id, (held.get(id) ?? dec(0)).plus(quantity));
  for (const hold of holds) {
    const id = `${hold.productId}|${hold.locationId}|${hold.status}|${hold.lotKey}`;
    add(id, dec(hold.remaining.toString()));
    const away = hold.units.filter(
      (unit) =>
        unit.serialUnit.locationId !== hold.locationId ||
        unit.serialUnit.status !== hold.status,
    ).length;
    if (away > 0) {
      drift.push({
        productId: hold.productId,
        locationId: hold.locationId,
        status: hold.status,
        lotId: hold.lotKey || null,
        fromMovements: String(hold.units.length),
        balance: String(hold.units.length - away),
        source: "holds",
      });
    }
  }
  for (const line of returnLines) {
    const decided = line.decisions.reduce(
      (sum, decision) => sum.plus(decision.quantity.toString()),
      dec(0),
    );
    const pending = dec(line.quantity.toString()).minus(decided);
    if (!pending.greaterThan(0)) continue;
    add(
      `${line.productId}|${line.return.locationId}|INSPECTION|${line.lotId ?? ""}`,
      pending,
    );
  }
  for (const [id, quantity] of held) {
    const balance = stored.get(id) ?? dec(0);
    if (quantity.greaterThan(balance)) {
      const [productId = "", locationId = "", status = "", lotKey = ""] =
        id.split("|");
      drift.push({
        productId,
        locationId,
        status,
        lotId: lotKey || null,
        fromMovements: quantity.toString(),
        balance: balance.toString(),
        source: "holds",
      });
    }
  }
  return drift;
}

/**
 * WMS-53 (ADR 0043): what the containers say they hold is part of the
 * balance of its key, never more; each item is where its container is; a
 * closed container is empty; and a product by serial has, in each
 * container, as many units marked in it (and in its place) as the
 * container says. `source: "containers"`; `fromMovements` is what the
 * containers say. Empty when they agree (and for a company without them).
 */
async function reconcileContainers(
  organizationId: string,
  stored: Map<string, ReturnType<typeof dec>>,
): Promise<StockDrift[]> {
  const client = forOrganization(organizationId);
  const items = await client.containerItem.findMany({
    select: {
      containerId: true,
      productId: true,
      locationId: true,
      status: true,
      lotKey: true,
      quantity: true,
      container: {
        select: { locationId: true, status: true, outboundOrderId: true },
      },
      product: { select: { tracking: true } },
    },
  });
  const units = await client.serialUnit.groupBy({
    by: ["containerId", "productId", "locationId"],
    where: { containerId: { not: null } },
    _count: { _all: true },
  });
  if (items.length === 0 && units.length === 0) return [];
  const drift: StockDrift[] = [];
  const push = (
    item: (typeof items)[number],
    said: ReturnType<typeof dec>,
    balance: ReturnType<typeof dec>,
  ) =>
    drift.push({
      productId: item.productId,
      locationId: item.locationId,
      status: item.status,
      lotId: item.lotKey || null,
      fromMovements: said.toString(),
      balance: balance.toString(),
      source: "containers",
    });
  const held = new Map<string, ReturnType<typeof dec>>();
  for (const item of items) {
    const id = `${item.productId}|${item.locationId}|${item.status}|${item.lotKey}`;
    held.set(id, (held.get(id) ?? dec(0)).plus(item.quantity.toString()));
    if (
      item.container.locationId !== item.locationId ||
      item.container.status !== "OPEN"
    ) {
      push(item, dec(item.quantity.toString()), dec(0));
    }
  }
  for (const [id, said] of held) {
    const balance = stored.get(id) ?? dec(0);
    if (said.greaterThan(balance)) {
      const item = items.find(
        (row) =>
          `${row.productId}|${row.locationId}|${row.status}|${row.lotKey}` ===
          id,
      )!;
      push(item, said, balance);
    }
  }
  const counted = new Map(
    units.map((row) => [
      `${row.containerId}|${row.productId}|${row.locationId}`,
      row._count._all,
    ]),
  );
  const serialItems = new Set<string>();
  for (const item of items) {
    if (item.product.tracking !== "SERIAL") continue;
    const id = `${item.containerId}|${item.productId}|${item.locationId}`;
    serialItems.add(id);
    const marked = counted.get(id) ?? 0;
    if (!dec(item.quantity.toString()).equals(marked)) {
      push(item, dec(item.quantity.toString()), dec(marked));
    }
  }
  drift.push(...(await reconcilePackages(client, items)));
  // Units marked in a container that says nothing of them (or elsewhere).
  for (const row of units) {
    const id = `${row.containerId}|${row.productId}|${row.locationId}`;
    if (serialItems.has(id)) continue;
    drift.push({
      productId: row.productId,
      locationId: row.locationId ?? "",
      status: "AVAILABLE",
      lotId: null,
      fromMovements: "0",
      balance: String(row._count._all),
      source: "containers",
    });
  }
  return drift;
}

/**
 * WMS-15 (ADR 0044): the packages of an order never hold more than what
 * its reservation sets aside there (product, place and lot): what is
 * packed is still set aside for its order. `fromMovements` is what the
 * packages hold; `balance`, what the reservation sets aside.
 */
async function reconcilePackages(
  client: ReturnType<typeof forOrganization>,
  items: {
    productId: string;
    locationId: string;
    status: string;
    lotKey: string;
    quantity: { toString(): string };
    container: { outboundOrderId: string | null };
  }[],
): Promise<StockDrift[]> {
  const packed = items.filter((item) => item.container.outboundOrderId);
  if (packed.length === 0) return [];
  const orderIds = [
    ...new Set(packed.map((item) => item.container.outboundOrderId!)),
  ];
  const lines = await client.outboundOrderLine.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true },
  });
  const orderOf = new Map(lines.map((line) => [line.id, line.orderId]));
  const reservations = await client.stockReservation.findMany({
    where: {
      sourceType: OUTBOUND_LINE_SOURCE,
      sourceId: { in: lines.map((line) => line.id) },
      state: "ACTIVE",
    },
    select: {
      sourceId: true,
      productId: true,
      locationId: true,
      lotId: true,
      remaining: true,
    },
  });
  const key = (order: string, product: string, place: string, lot: string) =>
    `${order}|${product}|${place}|${lot}`;
  const held = new Map<string, ReturnType<typeof dec>>();
  for (const row of reservations) {
    if (!row.locationId) continue;
    const id = key(
      orderOf.get(row.sourceId)!,
      row.productId,
      row.locationId,
      row.lotId ?? "",
    );
    held.set(id, (held.get(id) ?? dec(0)).plus(row.remaining.toString()));
  }
  const inside = new Map<
    string,
    { item: (typeof packed)[number]; said: ReturnType<typeof dec> }
  >();
  for (const item of packed) {
    const id = key(
      item.container.outboundOrderId!,
      item.productId,
      item.locationId,
      item.lotKey,
    );
    const current = inside.get(id);
    inside.set(id, {
      item,
      said: (current?.said ?? dec(0)).plus(item.quantity.toString()),
    });
  }
  const drift: StockDrift[] = [];
  for (const [id, { item, said }] of inside) {
    const reserved = held.get(id) ?? dec(0);
    if (said.greaterThan(reserved)) {
      drift.push({
        productId: item.productId,
        locationId: item.locationId,
        status: item.status,
        lotId: item.lotKey || null,
        fromMovements: said.toString(),
        balance: reserved.toString(),
        source: "containers",
      });
    }
  }
  return drift;
}

/**
 * WMS-21B (ADR 0041): for a product by serial, the balance of each
 * location and state is also the number of its units there — both as the
 * units say (`serial_unit`) and as their last move left them
 * (`serial_move`). Empty when they agree.
 */
async function reconcileSerials(
  organizationId: string,
  stored: Map<string, ReturnType<typeof dec>>,
): Promise<StockDrift[]> {
  const client = forOrganization(organizationId);
  const serialProducts = await client.product.findMany({
    where: { OR: [{ tracking: "SERIAL" }, { serialUnits: { some: {} } }] },
    select: { id: true },
  });
  if (serialProducts.length === 0) return [];
  const ids = new Set(serialProducts.map((product) => product.id));
  const [inside, lastMoves] = await Promise.all([
    client.serialUnit.groupBy({
      by: ["productId", "locationId", "status"],
      where: { locationId: { not: null } },
      _count: { _all: true },
    }),
    client.serialMove.groupBy({ by: ["serialUnitId"], _max: { id: true } }),
  ]);
  const byMoves = new Map<string, number>();
  const lastIds = lastMoves
    .map((row) => row._max.id)
    .filter((id): id is string => Boolean(id));
  for (let start = 0; start < lastIds.length; start += 1_000) {
    const moves = await client.serialMove.findMany({
      where: { id: { in: lastIds.slice(start, start + 1_000) } },
      select: {
        productId: true,
        locationId: true,
        status: true,
        direction: true,
      },
    });
    for (const move of moves) {
      if (move.direction !== "IN") continue;
      const id = `${move.productId}|${move.locationId}|${move.status}|`;
      byMoves.set(id, (byMoves.get(id) ?? 0) + 1);
    }
  }
  const byUnits = new Map(
    inside.map((row) => [
      `${row.productId}|${row.locationId}|${row.status}|`,
      row._count._all,
    ]),
  );
  const balances = [...stored.keys()].filter((id) =>
    ids.has(id.split("|")[0] ?? ""),
  );
  const drift: StockDrift[] = [];
  for (const [source, counted] of [
    ["serial_units", byUnits],
    ["serial_moves", byMoves],
  ] as const) {
    for (const id of new Set([...balances, ...counted.keys()])) {
      const balance = stored.get(id) ?? dec(0);
      const units = counted.get(id) ?? 0;
      if (balance.equals(units)) continue;
      const [productId = "", locationId = "", status = "", lotKey = ""] =
        id.split("|");
      drift.push({
        productId,
        locationId,
        status,
        lotId: lotKey || null,
        fromMovements: String(units),
        balance: balance.toString(),
        source,
      });
    }
  }
  return drift;
}

export type ValueDrift = {
  productId: string;
  /** All the stock of the product, every location. */
  quantity: string;
  averageCost: string;
  /** What `product_cost` says it is worth. */
  stockValue: string;
  /** quantity × averageCost. */
  expected: string;
};

/**
 * VAL-04 (ADR 0031): the value kept for each product must be its stock
 * times its average cost, up to the rounding of six decimals per
 * movement. Empty when they agree; a difference is a defect to
 * investigate, like one in the stock.
 */
export async function reconcileValue(
  organizationId: string,
): Promise<ValueDrift[]> {
  const client = forOrganization(organizationId);
  const [costs, stock] = await Promise.all([
    client.productCost.findMany({
      select: { productId: true, averageCost: true, stockValue: true },
    }),
    client.stockBalance.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
    }),
  ]);
  const onHand = new Map(
    stock.map((row) => [
      row.productId,
      dec((row._sum.quantity ?? 0).toString()),
    ]),
  );
  const drift: ValueDrift[] = [];
  for (const cost of costs) {
    const quantity = onHand.get(cost.productId) ?? dec(0);
    const average = dec(cost.averageCost.toString());
    const value = dec(cost.stockValue.toString());
    const expected = quantity.times(average);
    // Half a millionth per unit of rounding, and a cent of slack.
    const slack = quantity.times("0.000001").plus("0.01");
    if (value.minus(expected).abs().greaterThan(slack)) {
      drift.push({
        productId: cost.productId,
        quantity: quantity.toString(),
        averageCost: average.toString(),
        stockValue: value.toString(),
        expected: expected.toString(),
      });
    }
  }
  return drift;
}

export type ReconciliationReport = {
  organizationId: string;
  /** Product–location pairs that were compared. */
  pairs: number;
  /** Differences found, named so a person can go and look. */
  drift: (StockDrift & {
    sku: string;
    productName: string;
    locationName: string;
    /** balance − fromMovements: what the balance has too much (or too little). */
    difference: string;
  })[];
  /** Products whose stored value is not stock × average cost (VAL-04). */
  valueDrift: (ValueDrift & { sku: string; productName: string })[];
};

/**
 * Reconciliation of one company (INV-34): compares every balance with its
 * movement history and names what differs. It only reads — a difference
 * is a defect to investigate, never something to repair silently.
 */
export async function reconcileCompany(
  organizationId: string,
): Promise<ReconciliationReport> {
  const client = forOrganization(organizationId);
  const [drift, pairs, values] = await Promise.all([
    reconcileStock(organizationId),
    client.stockBalance.count(),
    reconcileValue(organizationId),
  ]);
  const valueDrift = await named(organizationId, values.slice(0, 500));
  if (drift.length === 0) {
    return { organizationId, pairs, drift: [], valueDrift };
  }

  const shown = drift.slice(0, 500);
  const [products, locations] = await Promise.all([
    client.product.findMany({
      where: { id: { in: [...new Set(shown.map((row) => row.productId))] } },
      select: { id: true, sku: true, name: true },
    }),
    client.location.findMany({
      where: { id: { in: [...new Set(shown.map((row) => row.locationId))] } },
      select: { id: true, name: true },
    }),
  ]);
  const productOf = new Map(products.map((product) => [product.id, product]));
  const locationOf = new Map(
    locations.map((location) => [location.id, location.name]),
  );
  return {
    organizationId,
    pairs,
    drift: shown.map((row) => ({
      ...row,
      sku: productOf.get(row.productId)?.sku ?? "?",
      productName: productOf.get(row.productId)?.name ?? "?",
      locationName: locationOf.get(row.locationId) ?? "?",
      difference: dec(row.balance).minus(row.fromMovements).toString(),
    })),
    valueDrift,
  };
}

/** Value differences with the product a person can go and look at. */
async function named(organizationId: string, rows: ValueDrift[]) {
  if (rows.length === 0) return [];
  const products = await forOrganization(organizationId).product.findMany({
    where: { id: { in: rows.map((row) => row.productId) } },
    select: { id: true, sku: true, name: true },
  });
  const productOf = new Map(products.map((product) => [product.id, product]));
  return rows.map((row) => ({
    ...row,
    sku: productOf.get(row.productId)?.sku ?? "?",
    productName: productOf.get(row.productId)?.name ?? "?",
  }));
}
