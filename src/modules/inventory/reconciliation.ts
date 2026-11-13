import "server-only";

import { dec } from "@/lib";
import { forOrganization } from "@/server";

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
  source?: "serial_units" | "serial_moves";
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
