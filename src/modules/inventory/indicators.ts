import "server-only";

import { dec, isAppError } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  activeFacilityOf,
  isFacilityInScope,
  isLimited,
  locationScopeWhere,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { forOrganization } from "@/server";

import { companyTimeZone, dayWindow, type DayWindow } from "./calendar-day";
import { accuracyFigures, type AccuracyFigures } from "./count-accuracy";
import {
  daysOfInventory,
  resolvePeriod,
  rotationOf,
  shareOf,
  shiftDay,
  timeFigures,
  type KpiPeriod,
} from "./indicator-rules";
import { formatValue } from "./inventory-value";
import { formatStock, startOfDay, type InventoryActor } from "./movements";
import { pickedOnWhere } from "./outbound-orders";
import { KPI_IDLE_DAYS, PUTAWAY_MODE } from "./settings";
import { shippedOnWhere } from "./shipment-ready";
import { zonesOf } from "./zones";

/**
 * Warehouse indicators (WMS-32, ADR 0082): what the warehouse did in a
 * period of the company's calendar, derived in the query from movements,
 * tasks, orders and counts. Read only; nothing is stored. Every definition
 * (what counts, from when to when, where) is in the ADR.
 *
 * «The place» is the chosen warehouse and, for who is limited to zones,
 * only what is inside them (ADR 0038). Orders and shipments are documents
 * of the whole warehouse, as in the summary of the day (WMS-73).
 */

/** Products per table. */
export const KPI_TOP_PRODUCTS = 20;
/** Orders read for complete, on time and picking time. */
export const KPI_ORDERS_MAX = 2_000;
/** Delivered tasks read for times. */
export const KPI_TASK_ROWS_MAX = 10_000;
/** Groups of cost read for the total value that left. */
export const KPI_COST_GROUPS_MAX = 5_000;

export type TaskKindCounts = {
  TRANSFER: number;
  PICK: number;
  PUTAWAY: number;
  REPLENISH: number;
  ISSUE: number;
};

export type KpiTimes = {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
  truncated: boolean;
};

export type KpiProductRow = {
  productId: string;
  name: string;
  sku: string;
  exitLines: number;
  /** «120 piezas». */
  exitQuantity: string;
  /** «45 piezas»: (start + end) ÷ 2. */
  averageStock: string;
  /** «2.67» times; null without average stock. */
  rotation: string | null;
  /** «11» days; null without rotation. */
  daysOfInventory: string | null;
  /** «$1,250.00» at the cost each exit left with. Only with costs. */
  exitValue?: string;
};

export type KpiIdleRow = {
  productId: string;
  name: string;
  sku: string;
  /** «30 piezas», all states. */
  stock: string;
  /** Last movement in the place, ever; null when none was found. */
  lastMovementAt: Date | null;
  /** At the current average cost. Only with costs. */
  value?: string;
};

export type KpiPersonRow = {
  userId: string;
  /** Null when the person is no longer in the team. */
  name: string | null;
  tasks: number;
  byKind: TaskKindCounts;
  movements: number;
  /** Accepted → delivered, of the rows read. */
  medianTaskMs: number | null;
};

export type KpiZoneRow = {
  zoneId: string;
  name: string;
  tasks: number;
  movementLines: number;
  medianTaskMs: number | null;
};

export type WarehouseIndicators = {
  period: KpiPeriod;
  facility: { id: string; name: string };
  /** Warehouses the person can choose (active, in scope). */
  facilities: { id: string; name: string }[];
  product: { id: string; name: string; sku: string } | null;
  /** Only with `inventory.worker_performance.read`. */
  person?: { userId: string; name: string | null } | null;
  orders: {
    shipped: number;
    read: number;
    complete: number;
    withDueDay: number;
    onTime: number;
    completeOnTime: number;
    completeShare: string | null;
    onTimeShare: string | null;
    completeOnTimeShare: string | null;
    truncated: boolean;
  };
  picking: KpiTimes & { orders: number };
  receiving: KpiTimes & { withTasks: boolean };
  /** Only with `inventory.count_accuracy.read`. */
  accuracy?: AccuracyFigures;
  exits: {
    lines: number;
    /** Total value that left. Only with costs. */
    value?: string;
    valueTruncated?: boolean;
    top: KpiProductRow[];
  };
  idle: { days: number; count: number; rows: KpiIdleRow[] };
  /** Only with `inventory.worker_performance.read`. */
  people?: KpiPersonRow[];
  zones: KpiZoneRow[];
  /** Rows of delivered tasks read for times were capped. */
  tasksTruncated: boolean;
};

async function may(actor: InventoryActor, permission: string) {
  try {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      permission as Parameters<typeof assertModulePermission>[2],
    );
    return true;
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return false;
    throw error;
  }
}

const id36 = (value: unknown) =>
  typeof value === "string" && value ? value.slice(0, 36) : null;

const emptyKinds = (): TaskKindCounts => ({
  TRANSFER: 0,
  PICK: 0,
  PUTAWAY: 0,
  REPLENISH: 0,
  ISSUE: 0,
});

const median = (values: number[]) => timeFigures(values).medianMs;

export async function getWarehouseIndicators(
  actor: InventoryActor,
  options: {
    preset?: unknown;
    from?: unknown;
    to?: unknown;
    facilityId?: unknown;
    productId?: unknown;
    personId?: unknown;
    /** For tests of the calendar's edges; screens never pass it. */
    now?: Date;
  } = {},
): Promise<WarehouseIndicators> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.kpi.read",
  );
  const client = forOrganization(actor.organizationId);
  const [today, active, scoped, costs, seesPeople, seesAccuracy, timeZone] =
    await Promise.all([
      dayWindow(client, options.now ?? new Date()),
      activeFacilityOf(client, actor.userId),
      locationScopeWhere(client, actor.userId),
      may(actor, "inventory.cost.read"),
      may(actor, "inventory.worker_performance.read"),
      may(actor, "inventory.count_accuracy.read"),
      companyTimeZone(client),
    ]);
  if (!today) throw new Error("Unreadable day for the indicators");

  // Warehouses the person reaches; one asked for outside them is ignored.
  const allFacilities = await client.facility.findMany({
    where: { archivedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  const reach = await Promise.all(
    allFacilities.map((f) => isFacilityInScope(client, actor.userId, f.id)),
  );
  const facilities = allFacilities.filter((_, index) => reach[index]);
  const asked = id36(options.facilityId);
  const facility = facilities.find((f) => f.id === asked) ?? {
    id: active.id,
    name: active.name,
  };

  const period = resolvePeriod(today.day, {
    preset: options.preset,
    from: options.from,
    to: options.to,
  });
  const [startDay, endDay, idleDays] = await Promise.all([
    dayWindow(client, period.from),
    dayWindow(client, period.next),
    readSetting(client, KPI_IDLE_DAYS),
  ]);
  if (!startDay || !endDay) throw new Error("Unreadable period");
  const range = { gte: startDay.range.gte, lt: endDay.range.gte };
  const window: DayWindow = { day: period.from, range };

  const askedProduct = id36(options.productId);
  const product = askedProduct
    ? await client.product.findFirst({
        where: { id: askedProduct },
        select: { id: true, name: true, sku: true },
      })
    : null;
  const askedPerson = seesPeople ? id36(options.personId) : null;
  const personMember = askedPerson
    ? await client.membership.findFirst({
        where: { userId: askedPerson },
        select: { userId: true, user: { select: { name: true } } },
      })
    : null;
  const personId = personMember?.userId ?? null;

  const place = {
    facilityId: facility.id,
    ...(isLimited(scoped) ? { AND: [scoped] } : {}),
  };
  const byProduct = product ? { productId: product.id } : {};
  const exitLine = {
    direction: "OUT" as const,
    createdAt: range,
    location: place,
    movement: {
      type: { in: ["EXIT" as const, "SHIPMENT" as const] },
      reversedBy: { is: null },
    },
    ...byProduct,
  };
  const taskWhere = {
    status: "DELIVERED" as const,
    deliveredAt: range,
    fromLocation: place,
    ...byProduct,
    ...(personId ? { assignedToUserId: personId } : {}),
  };
  const idleDaysCount = Number(idleDays);
  const idleSince = await dayWindow(
    client,
    shiftDay(today.day, 1 - idleDaysCount),
  );
  if (!idleSince) throw new Error("Unreadable day for idle products");
  const idleWhere = {
    ...(product ? { id: product.id } : {}),
    balances: { some: { quantity: { gt: 0 }, location: place } },
    movementLines: {
      none: { createdAt: { gte: idleSince.range.gte }, location: place },
    },
  };
  const shippedWhere = shippedOnWhere(facility.id, window);
  const pickedWhere = pickedOnWhere(facility.id, window);

  const [
    topGroups,
    exitLines,
    costGroups,
    idleCount,
    idleProducts,
    accuracy,
    shippedCount,
    shippedOrders,
    pickedCount,
    pickedOrders,
    taskRows,
    tasksByPerson,
    tasksFrom,
    tasksPlaced,
    movementsByPerson,
    linesByLocation,
    putawayMode,
  ] = await Promise.all([
    product
      ? Promise.resolve(null)
      : client.stockMovementLine.groupBy({
          by: ["productId"],
          where: exitLine,
          _count: { _all: true },
          _sum: { baseQuantity: true },
          orderBy: [{ _count: { productId: "desc" } }, { productId: "asc" }],
          take: KPI_TOP_PRODUCTS,
        }),
    client.stockMovementLine.count({ where: exitLine }),
    costs
      ? client.stockMovementLine.groupBy({
          by: ["unitCost"],
          where: exitLine,
          _sum: { baseQuantity: true },
          orderBy: { unitCost: "asc" },
          take: KPI_COST_GROUPS_MAX + 1,
        })
      : Promise.resolve(null),
    client.product.count({ where: idleWhere }),
    client.product.findMany({
      where: idleWhere,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: KPI_TOP_PRODUCTS,
      select: { id: true, name: true, sku: true, unitCode: true },
    }),
    seesAccuracy
      ? accuracyFigures(client, {
          location: {
            facilityId: facility.id,
            ...(isLimited(scoped) ? scoped : {}),
          },
          costs,
          days: [period.from, period.next],
        })
      : Promise.resolve(undefined),
    client.outboundOrder.count({ where: shippedWhere }),
    client.outboundOrder.findMany({
      where: shippedWhere,
      orderBy: { id: "asc" },
      take: KPI_ORDERS_MAX,
      select: {
        id: true,
        dueOn: true,
        lines: { select: { id: true, quantity: true } },
        shipments: {
          where: {
            openOrderId: { not: null },
            shipment: { status: "SHIPPED" },
          },
          select: { shipment: { select: { shippedAt: true } } },
        },
      },
    }),
    client.outboundOrder.count({ where: pickedWhere }),
    client.outboundOrder.findMany({
      where: pickedWhere,
      orderBy: { id: "asc" },
      take: KPI_ORDERS_MAX,
      select: {
        releasedAt: true,
        lines: {
          select: {
            tasks: {
              where: { kind: "PICK" },
              select: { deliveredAt: true, cancelledAt: true },
            },
          },
        },
      },
    }),
    client.warehouseTask.findMany({
      where: taskWhere,
      orderBy: { id: "asc" },
      take: KPI_TASK_ROWS_MAX + 1,
      select: {
        kind: true,
        assignedToUserId: true,
        createdAt: true,
        acceptedAt: true,
        deliveredAt: true,
        fromLocationId: true,
        toLocationId: true,
        placedLocationId: true,
      },
    }),
    seesPeople
      ? client.warehouseTask.groupBy({
          by: ["assignedToUserId", "kind"],
          where: taskWhere,
          orderBy: [{ assignedToUserId: "asc" }, { kind: "asc" }],
          _count: { _all: true },
        })
      : Promise.resolve([]),
    client.warehouseTask.groupBy({
      by: ["fromLocationId"],
      where: { ...taskWhere, kind: { not: "PUTAWAY" } },
      orderBy: { fromLocationId: "asc" },
      _count: { _all: true },
    }),
    client.warehouseTask.groupBy({
      by: ["placedLocationId", "toLocationId"],
      where: { ...taskWhere, kind: "PUTAWAY" },
      orderBy: [{ placedLocationId: "asc" }, { toLocationId: "asc" }],
      _count: { _all: true },
    }),
    seesPeople
      ? client.stockMovement.groupBy({
          by: ["createdByUserId"],
          where: {
            createdAt: range,
            lines: { some: { location: place, ...byProduct } },
            ...(personId ? { createdByUserId: personId } : {}),
          },
          orderBy: { createdByUserId: "asc" },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    client.stockMovementLine.groupBy({
      by: ["locationId"],
      where: {
        createdAt: range,
        location: place,
        ...byProduct,
        ...(personId ? { movement: { createdByUserId: personId } } : {}),
      },
      orderBy: { locationId: "asc" },
      _count: { _all: true },
    }),
    readSetting(client, PUTAWAY_MODE),
  ]);

  // Products: the busiest by exit lines (or the one filtered), with their
  // rotation in the period.
  const topRaw = topGroups
    ? topGroups.map((row) => ({
        productId: row.productId,
        lines: row._count._all,
        quantity: (row._sum.baseQuantity ?? 0).toString(),
      }))
    : product
      ? [
          await client.stockMovementLine
            .aggregate({
              where: exitLine,
              _count: { _all: true },
              _sum: { baseQuantity: true },
            })
            .then((sum) => ({
              productId: product.id,
              lines: sum._count._all,
              quantity: (sum._sum.baseQuantity ?? 0).toString(),
            })),
        ]
      : [];
  const shownIds = topRaw.map((row) => row.productId);
  const [shownProducts, balances, netAfter, netWithin, valueGroups] =
    shownIds.length === 0
      ? [[], [], [], [], []]
      : await Promise.all([
          client.product.findMany({
            where: { id: { in: shownIds } },
            select: { id: true, name: true, sku: true, unitCode: true },
          }),
          client.stockBalance.groupBy({
            by: ["productId"],
            where: { productId: { in: shownIds }, location: place },
            orderBy: { productId: "asc" },
            _sum: { quantity: true },
          }),
          client.stockMovementLine.groupBy({
            by: ["productId", "direction"],
            where: {
              productId: { in: shownIds },
              location: place,
              createdAt: { gte: range.lt },
            },
            orderBy: [{ productId: "asc" }, { direction: "asc" }],
            _sum: { baseQuantity: true },
          }),
          client.stockMovementLine.groupBy({
            by: ["productId", "direction"],
            where: {
              productId: { in: shownIds },
              location: place,
              createdAt: range,
            },
            orderBy: [{ productId: "asc" }, { direction: "asc" }],
            _sum: { baseQuantity: true },
          }),
          costs
            ? client.stockMovementLine.groupBy({
                by: ["productId", "unitCost"],
                where: { ...exitLine, productId: { in: shownIds } },
                orderBy: [{ productId: "asc" }, { unitCost: "asc" }],
                _sum: { baseQuantity: true },
              })
            : Promise.resolve([]),
        ]);
  const net = (
    rows: {
      productId: string;
      direction: "IN" | "OUT";
      _sum: { baseQuantity: unknown };
    }[],
    productId: string,
  ) =>
    rows
      .filter((row) => row.productId === productId)
      .reduce(
        (sum, row) =>
          row.direction === "IN"
            ? sum.plus(String(row._sum.baseQuantity ?? 0))
            : sum.minus(String(row._sum.baseQuantity ?? 0)),
        dec(0),
      );
  const productOf = new Map(shownProducts.map((p) => [p.id, p]));
  const top: KpiProductRow[] = topRaw.flatMap((row) => {
    const info = productOf.get(row.productId);
    if (!info) return [];
    const now = dec(
      String(
        balances.find((b) => b.productId === row.productId)?._sum.quantity ?? 0,
      ),
    );
    const end = now.minus(net(netAfter, row.productId));
    const start = end.minus(net(netWithin, row.productId));
    const rotation = rotationOf(row.quantity, start, end);
    const result: KpiProductRow = {
      productId: row.productId,
      name: info.name,
      sku: info.sku,
      exitLines: row.lines,
      exitQuantity: formatStock(row.quantity, info.unitCode),
      averageStock: formatStock(
        start.plus(end).dividedBy(2).toDecimalPlaces(3).toString(),
        info.unitCode,
      ),
      rotation,
      daysOfInventory: daysOfInventory(rotation, period.days),
    };
    if (costs) {
      result.exitValue = formatValue(
        valueGroups
          .filter((group) => group.productId === row.productId)
          .reduce(
            (sum, group) =>
              sum.plus(
                dec(String(group._sum.baseQuantity ?? 0)).times(
                  String(group.unitCost ?? 0),
                ),
              ),
            dec(0),
          ),
      );
    }
    return [result];
  });

  // Products with stock that did not move in the last days.
  const idleIds = idleProducts.map((p) => p.id);
  const [idleBalances, idleLast, idleCosts] =
    idleIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          client.stockBalance.groupBy({
            by: ["productId"],
            where: { productId: { in: idleIds }, location: place },
            orderBy: { productId: "asc" },
            _sum: { quantity: true },
          }),
          client.stockMovementLine.groupBy({
            by: ["productId"],
            where: { productId: { in: idleIds }, location: place },
            orderBy: { productId: "asc" },
            _max: { createdAt: true },
          }),
          costs
            ? client.productCost.findMany({
                where: { productId: { in: idleIds } },
                select: { productId: true, averageCost: true },
              })
            : Promise.resolve([]),
        ]);
  const idleRows: KpiIdleRow[] = idleProducts.map((p) => {
    const quantity = String(
      idleBalances.find((b) => b.productId === p.id)?._sum.quantity ?? 0,
    );
    const row: KpiIdleRow = {
      productId: p.id,
      name: p.name,
      sku: p.sku,
      stock: formatStock(quantity, p.unitCode),
      lastMovementAt:
        idleLast.find((l) => l.productId === p.id)?._max.createdAt ?? null,
    };
    if (costs) {
      const cost = idleCosts.find((c) => c.productId === p.id)?.averageCost;
      row.value = formatValue(dec(quantity).times(String(cost ?? 0)));
    }
    return row;
  });

  // Orders shipped in the period: complete and on time.
  const orderLineIds = shippedOrders.flatMap((o) => o.lines.map((l) => l.id));
  const shippedSums =
    orderLineIds.length === 0
      ? []
      : await client.shipmentLine.groupBy({
          by: ["orderLineId"],
          where: { orderId: { in: shippedOrders.map((o) => o.id) } },
          orderBy: { orderLineId: "asc" },
          _sum: { quantity: true },
        });
  const shippedOf = new Map(
    shippedSums.map((row) => [row.orderLineId, String(row._sum.quantity ?? 0)]),
  );
  let complete = 0;
  let withDueDay = 0;
  let onTime = 0;
  let completeOnTime = 0;
  for (const order of shippedOrders) {
    const isComplete = order.lines.every((line) =>
      dec(shippedOf.get(line.id) ?? 0).greaterThanOrEqualTo(
        line.quantity.toString(),
      ),
    );
    if (isComplete) complete += 1;
    if (!order.dueOn) continue;
    withDueDay += 1;
    const shippedAt = order.shipments
      .map((s) => s.shipment.shippedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const dueEnd = startOfDay(
      shiftDay(order.dueOn.toISOString().slice(0, 10), 1),
      timeZone,
    );
    const isOnTime = Boolean(shippedAt && dueEnd && shippedAt < dueEnd);
    if (isOnTime) onTime += 1;
    if (isOnTime && isComplete) completeOnTime += 1;
  }

  // Picking time: release → last picking task closed.
  const pickTimes: number[] = [];
  for (const order of pickedOrders) {
    if (!order.releasedAt) continue;
    let last = 0;
    for (const line of order.lines) {
      for (const task of line.tasks) {
        const closed = task.deliveredAt ?? task.cancelledAt;
        if (closed && closed.getTime() > last) last = closed.getTime();
      }
    }
    if (last > 0) pickTimes.push(last - order.releasedAt.getTime());
  }

  // Delivered tasks: times of putaway, per person and per zone.
  const tasksTruncated = taskRows.length > KPI_TASK_ROWS_MAX;
  const rows = taskRows.slice(0, KPI_TASK_ROWS_MAX);
  const zoneLocationOf = (row: (typeof rows)[number]) =>
    row.kind === "PUTAWAY"
      ? (row.placedLocationId ?? row.toLocationId)
      : row.fromLocationId;
  const locationIds = new Set<string>([
    ...rows.map(zoneLocationOf),
    ...tasksFrom.map((g) => g.fromLocationId),
    ...tasksPlaced.map((g) => g.placedLocationId ?? g.toLocationId),
    ...linesByLocation.map((g) => g.locationId),
  ]);
  const zoneOf = await zonesOf(client, [...locationIds]);
  const putawayTimes: number[] = [];
  const timesByPerson = new Map<string, number[]>();
  const timesByZone = new Map<string, number[]>();
  for (const row of rows) {
    if (row.kind === "PUTAWAY" && row.deliveredAt) {
      putawayTimes.push(row.deliveredAt.getTime() - row.createdAt.getTime());
    }
    if (!row.acceptedAt || !row.deliveredAt) continue;
    const took = row.deliveredAt.getTime() - row.acceptedAt.getTime();
    if (row.assignedToUserId) {
      const list = timesByPerson.get(row.assignedToUserId) ?? [];
      list.push(took);
      timesByPerson.set(row.assignedToUserId, list);
    }
    const zone = zoneOf.get(zoneLocationOf(row));
    if (zone) {
      const list = timesByZone.get(zone.id) ?? [];
      list.push(took);
      timesByZone.set(zone.id, list);
    }
  }

  const zones = new Map<string, KpiZoneRow>();
  const zoneRow = (locationId: string) => {
    const zone = zoneOf.get(locationId);
    if (!zone) return null;
    const known = zones.get(zone.id);
    if (known) return known;
    const fresh: KpiZoneRow = {
      zoneId: zone.id,
      name: zone.name,
      tasks: 0,
      movementLines: 0,
      medianTaskMs: median(timesByZone.get(zone.id) ?? []),
    };
    zones.set(zone.id, fresh);
    return fresh;
  };
  for (const group of tasksFrom) {
    const row = zoneRow(group.fromLocationId);
    if (row) row.tasks += group._count._all;
  }
  for (const group of tasksPlaced) {
    const row = zoneRow(group.placedLocationId ?? group.toLocationId);
    if (row) row.tasks += group._count._all;
  }
  for (const group of linesByLocation) {
    const row = zoneRow(group.locationId);
    if (row) row.movementLines += group._count._all;
  }

  const result: WarehouseIndicators = {
    period,
    facility,
    facilities,
    product,
    orders: {
      shipped: shippedCount,
      read: shippedOrders.length,
      complete,
      withDueDay,
      onTime,
      completeOnTime,
      completeShare: shareOf(complete, shippedOrders.length),
      onTimeShare: shareOf(onTime, withDueDay),
      completeOnTimeShare: shareOf(completeOnTime, withDueDay),
      truncated: shippedCount > shippedOrders.length,
    },
    picking: {
      orders: pickedCount,
      ...timeFigures(pickTimes),
      truncated: pickedCount > pickedOrders.length,
    },
    receiving: {
      withTasks: putawayMode === "tasks" || putawayTimes.length > 0,
      ...timeFigures(putawayTimes),
      truncated: tasksTruncated,
    },
    exits: { lines: exitLines, top },
    idle: { days: idleDaysCount, count: idleCount, rows: idleRows },
    zones: [...zones.values()].sort(
      (a, b) =>
        b.tasks + b.movementLines - (a.tasks + a.movementLines) ||
        a.name.localeCompare(b.name, "es") ||
        a.zoneId.localeCompare(b.zoneId),
    ),
    tasksTruncated,
  };
  if (accuracy) result.accuracy = accuracy;
  if (costs && costGroups) {
    result.exits.valueTruncated = costGroups.length > KPI_COST_GROUPS_MAX;
    result.exits.value = formatValue(
      costGroups
        .slice(0, KPI_COST_GROUPS_MAX)
        .reduce(
          (sum, group) =>
            sum.plus(
              dec(String(group._sum.baseQuantity ?? 0)).times(
                String(group.unitCost ?? 0),
              ),
            ),
          dec(0),
        ),
    );
  }

  if (seesPeople) {
    result.person = personMember
      ? { userId: personMember.userId, name: personMember.user.name }
      : null;
    const people = new Map<string, KpiPersonRow>();
    const personRow = (userId: string) => {
      const known = people.get(userId);
      if (known) return known;
      const fresh: KpiPersonRow = {
        userId,
        name: null,
        tasks: 0,
        byKind: emptyKinds(),
        movements: 0,
        medianTaskMs: median(timesByPerson.get(userId) ?? []),
      };
      people.set(userId, fresh);
      return fresh;
    };
    for (const group of tasksByPerson) {
      if (!group.assignedToUserId) continue;
      const row = personRow(group.assignedToUserId);
      row.tasks += group._count._all;
      row.byKind[group.kind] += group._count._all;
    }
    for (const group of movementsByPerson) {
      personRow(group.createdByUserId).movements += group._count._all;
    }
    // Names come from the memberships of this company only.
    const members =
      people.size === 0
        ? []
        : await client.membership.findMany({
            where: { userId: { in: [...people.keys()] } },
            select: { userId: true, user: { select: { name: true } } },
          });
    for (const member of members) {
      const row = people.get(member.userId);
      if (row) row.name = member.user.name;
    }
    result.people = [...people.values()].sort(
      (a, b) =>
        b.tasks + b.movements - (a.tasks + a.movements) ||
        (a.name ?? "").localeCompare(b.name ?? "", "es") ||
        a.userId.localeCompare(b.userId),
    );
  }
  return result;
}
