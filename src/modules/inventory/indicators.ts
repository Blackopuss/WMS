import "server-only";

import { dec } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { can, loadScope, loadSubject } from "@/platform/authorization";
import {
  activeFacilityOf,
  facilityInScope,
  isLimited,
  locationScopeWhere,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { forOrganization } from "@/server";

import {
  companyTimeZone,
  dayOf,
  windowOf,
  type DayWindow,
} from "./calendar-day";
import { accuracyFigures, type AccuracyFigures } from "./count-accuracy";
import {
  daysOfInventory,
  previousPeriod,
  resolvePeriod,
  rotationOf,
  shareOf,
  shiftDay,
  shippedOnTime,
  timeFigures,
  type KpiPeriod,
} from "./indicator-rules";
import { formatValue } from "./inventory-value";
import { formatStock, type InventoryActor } from "./movements";
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
/** Products with stock read to find the idle ones. */
export const KPI_IDLE_SCAN_MAX = 20_000;
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
  /** Tasks delivered in the period whose origin is in the place (WMS-34). */
  tasksDelivered: number;
  /** Only with `inventory.count_accuracy.read`. */
  accuracy?: AccuracyFigures;
  /** The headline figures of the period before (WMS-34, ADR 0085). */
  previous?: KpiHeadline & { period: KpiPeriod };
  exits: {
    lines: number;
    /** Total value that left. Only with costs. */
    value?: string;
    valueTruncated?: boolean;
    top: KpiProductRow[];
  };
  /** `truncated`: more products with stock than were read. */
  idle: { days: number; count: number; rows: KpiIdleRow[]; truncated: boolean };
  /** Only with `inventory.worker_performance.read`. */
  people?: KpiPersonRow[];
  zones: KpiZoneRow[];
  /** Rows of delivered tasks read for times were capped. */
  tasksTruncated: boolean;
};

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

/**
 * The headline figures of a period in a place (WMS-34, ADR 0085): what the
 * period comparison, the view by warehouse and the file show, computed by
 * the same function as the indicators themselves (every definition is in
 * ADR 0082), so they can never tell another number.
 */
export type KpiHeadline = {
  orders: WarehouseIndicators["orders"];
  picking: WarehouseIndicators["picking"];
  receiving: WarehouseIndicators["receiving"];
  tasksDelivered: number;
  /** Only with `inventory.count_accuracy.read`. */
  accuracy?: AccuracyFigures;
  exits: {
    lines: number;
    /** Only with costs. */
    value?: string;
    valueTruncated?: boolean;
    /** The exact sum, to add warehouses up. Only with costs. */
    rawValue?: string;
  };
};

type Client = ReturnType<typeof forOrganization>;

type HeadlineContext = {
  facilityId: string;
  /** The warehouse and, for who is limited, its zones. */
  place: object;
  scoped: Awaited<ReturnType<typeof locationScopeWhere>>;
  range: { gte: Date; lt: Date };
  window: DayWindow;
  /** First day and the day after the last. */
  days: [string, string];
  timeZone: string;
  costs: boolean;
  seesAccuracy: boolean;
  productId: string | null;
  personId: string | null;
  putawayMode: string;
};

/**
 * An exit (ADR 0082): an OUT line of a manual exit or a shipment, not
 * reversed, in the place and the period.
 */
function exitLineWhere(
  place: object,
  range: { gte: Date; lt: Date },
  productId: string | null,
) {
  return {
    direction: "OUT" as const,
    createdAt: range,
    location: place,
    movement: {
      type: { in: ["EXIT" as const, "SHIPMENT" as const] },
      reversedBy: { is: null },
    },
    ...(productId ? { productId } : {}),
  };
}

/** Tasks delivered in the period whose origin is in the place. */
function deliveredTaskWhere(
  place: object,
  range: { gte: Date; lt: Date },
  productId: string | null,
  personId: string | null,
) {
  return {
    status: "DELIVERED" as const,
    deliveredAt: range,
    fromLocation: place,
    ...(productId ? { productId } : {}),
    ...(personId ? { assignedToUserId: personId } : {}),
  };
}

async function periodHeadline(
  client: Client,
  context: HeadlineContext,
): Promise<KpiHeadline> {
  const { facilityId, place, scoped, range, window, costs, timeZone } = context;
  const exitLine = exitLineWhere(place, range, context.productId);
  const taskWhere = deliveredTaskWhere(
    place,
    range,
    context.productId,
    context.personId,
  );
  const shippedWhere = shippedOnWhere(facilityId, window);
  const pickedWhere = pickedOnWhere(facilityId, window);
  const [
    exitLines,
    costGroups,
    accuracy,
    shippedCount,
    shippedOrders,
    pickedCount,
    pickedOrders,
    putawayRows,
    tasksDelivered,
  ] = await Promise.all([
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
    context.seesAccuracy
      ? accuracyFigures(client, {
          location: {
            facilityId,
            ...(isLimited(scoped) ? scoped : {}),
          },
          costs,
          days: context.days,
          range,
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
      where: { ...taskWhere, kind: "PUTAWAY" },
      orderBy: { id: "asc" },
      take: KPI_TASK_ROWS_MAX + 1,
      select: { createdAt: true, deliveredAt: true },
    }),
    client.warehouseTask.count({ where: taskWhere }),
  ]);

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
    const isOnTime = shippedOnTime(
      shippedAt ?? null,
      order.dueOn.toISOString().slice(0, 10),
      timeZone,
    );
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

  // Receiving: creation → delivery of the put-away tasks.
  const putawayTimes = putawayRows
    .slice(0, KPI_TASK_ROWS_MAX)
    .flatMap((row) =>
      row.deliveredAt
        ? [row.deliveredAt.getTime() - row.createdAt.getTime()]
        : [],
    );

  const result: KpiHeadline = {
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
      withTasks: context.putawayMode === "tasks" || putawayTimes.length > 0,
      ...timeFigures(putawayTimes),
      truncated: putawayRows.length > KPI_TASK_ROWS_MAX,
    },
    tasksDelivered,
    exits: { lines: exitLines },
  };
  if (accuracy) result.accuracy = accuracy;
  if (costs && costGroups) {
    const raw = costGroups
      .slice(0, KPI_COST_GROUPS_MAX)
      .reduce(
        (sum, group) =>
          sum.plus(
            dec(String(group._sum.baseQuantity ?? 0)).times(
              String(group.unitCost ?? 0),
            ),
          ),
        dec(0),
      );
    result.exits.valueTruncated = costGroups.length > KPI_COST_GROUPS_MAX;
    result.exits.value = formatValue(raw);
    result.exits.rawValue = raw.toString();
  }
  return result;
}

export async function getWarehouseIndicators(
  actor: InventoryActor,
  options: {
    preset?: unknown;
    from?: unknown;
    to?: unknown;
    facilityId?: unknown;
    productId?: unknown;
    personId?: unknown;
    /** False skips the period before (WMS-34); the screen compares. */
    compare?: boolean;
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
  // The company's zone is read once; every day below is worked out from it.
  const [
    timeZone,
    active,
    scope,
    scoped,
    subject,
    allFacilities,
    idleDays,
    putawayMode,
  ] = await Promise.all([
    companyTimeZone(client),
    activeFacilityOf(client, actor.userId),
    loadScope(client, actor.userId),
    locationScopeWhere(client, actor.userId),
    loadSubject(actor.organizationId, actor.userId),
    client.facility.findMany({
      where: { archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
    readSetting(client, KPI_IDLE_DAYS),
    readSetting(client, PUTAWAY_MODE),
  ]);
  // The other reads are of the same module as `inventory.kpi.read`, which
  // just passed with its entitlement: the role decides, read once.
  const costs = can(subject, "inventory.cost.read");
  const seesPeople = can(subject, "inventory.worker_performance.read");
  const seesAccuracy = can(subject, "inventory.count_accuracy.read");
  const today = dayOf(options.now ?? new Date(), timeZone);

  // Warehouses the person reaches; one asked for outside them is ignored.
  const facilities = allFacilities.filter((f) => facilityInScope(scope, f.id));
  const asked = id36(options.facilityId);
  const facility = facilities.find((f) => f.id === asked) ?? {
    id: active.id,
    name: active.name,
  };

  const period = resolvePeriod(today, {
    preset: options.preset,
    from: options.from,
    to: options.to,
  });
  const idleDaysCount = Number(idleDays);
  const startDay = windowOf(period.from, timeZone);
  const endDay = windowOf(period.next, timeZone);
  const idleSince = windowOf(shiftDay(today, 1 - idleDaysCount), timeZone);
  if (!startDay || !endDay || !idleSince) throw new Error("Unreadable period");
  const range = { gte: startDay.range.gte, lt: endDay.range.gte };
  const window: DayWindow = { day: period.from, range };
  const place = {
    facilityId: facility.id,
    ...(isLimited(scoped) ? { AND: [scoped] } : {}),
  };

  const askedProduct = id36(options.productId);
  const product = askedProduct
    ? await client.product.findFirst({
        where: { id: askedProduct },
        select: { id: true, name: true, sku: true },
      })
    : null;
  const askedPerson = seesPeople ? id36(options.personId) : null;
  let personMember = askedPerson
    ? await client.membership.findFirst({
        where: { userId: askedPerson },
        select: { userId: true, user: { select: { name: true } } },
      })
    : null;
  // Who is limited to zones only names people who did something inside
  // them in the period (WMS-20: nothing outside the scope is named).
  if (personMember && isLimited(scoped)) {
    const [tasks, movements] = await Promise.all([
      client.warehouseTask.count({
        where: {
          status: "DELIVERED",
          deliveredAt: range,
          fromLocation: place,
          assignedToUserId: personMember.userId,
        },
      }),
      client.stockMovement.count({
        where: {
          createdAt: range,
          createdByUserId: personMember.userId,
          lines: { some: { location: place } },
        },
      }),
    ]);
    if (tasks + movements === 0) personMember = null;
  }
  const personId = personMember?.userId ?? null;
  const byProduct = product ? { productId: product.id } : {};
  const exitLine = exitLineWhere(place, range, product?.id ?? null);
  const taskWhere = deliveredTaskWhere(
    place,
    range,
    product?.id ?? null,
    personId,
  );

  const headlineContext: HeadlineContext = {
    facilityId: facility.id,
    place,
    scoped,
    range,
    window,
    days: [period.from, period.next],
    timeZone,
    costs,
    seesAccuracy,
    productId: product?.id ?? null,
    personId,
    putawayMode,
  };
  const previous = previousPeriod(period);
  // Its own days: with «Este mes» it ends before the current one starts
  // (the same days of the month before), so never `startDay` here.
  const previousStart = windowOf(previous.from, timeZone);
  const previousEnd = windowOf(previous.next, timeZone);
  if (!previousStart || !previousEnd) throw new Error("Unreadable period");
  const previousRange = {
    gte: previousStart.range.gte,
    lt: previousEnd.range.gte,
  };

  const [
    headline,
    before,
    topGroups,
    withStock,
    taskRows,
    tasksByPerson,
    tasksFrom,
    tasksPlaced,
    movementsByPerson,
    linesByLocation,
  ] = await Promise.all([
    periodHeadline(client, headlineContext),
    options.compare === false
      ? Promise.resolve(null)
      : periodHeadline(client, {
          ...headlineContext,
          range: previousRange,
          window: { day: previous.from, range: previousRange },
          days: [previous.from, previous.next],
        }),
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
    // Idle products: those with stock in the place (grouped in the
    // database, capped) minus those of them that moved there lately. Two
    // group-bys cost less than a count with EXISTS per product (measured
    // with 10,000 products).
    client.stockBalance.groupBy({
      by: ["productId"],
      where: { quantity: { gt: 0 }, location: place, ...byProduct },
      orderBy: { productId: "asc" },
      take: KPI_IDLE_SCAN_MAX + 1,
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
      // Counted where it was placed, and only when that place is in the
      // scope too (WMS-20).
      where: {
        ...taskWhere,
        kind: "PUTAWAY",
        OR: [
          { placedLocation: place },
          { placedLocationId: null, toLocation: place },
        ],
      },
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
      daysOfInventory: daysOfInventory(period.days, row.quantity, start, end),
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
  const idleTruncated = withStock.length > KPI_IDLE_SCAN_MAX;
  const stockIds = withStock
    .slice(0, KPI_IDLE_SCAN_MAX)
    .map((row) => row.productId);
  const movedLately =
    stockIds.length === 0
      ? []
      : await client.stockMovementLine.groupBy({
          by: ["productId"],
          where: {
            productId: { in: stockIds },
            createdAt: { gte: idleSince.range.gte },
            location: place,
          },
          orderBy: { productId: "asc" },
        });
  const moved = new Set(movedLately.map((row) => row.productId));
  const idleAll = stockIds.filter((id) => !moved.has(id));
  const idleProducts =
    idleAll.length === 0
      ? []
      : await client.product.findMany({
          where: { id: { in: idleAll } },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: KPI_TOP_PRODUCTS,
          select: { id: true, name: true, sku: true, unitCode: true },
        });
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
  // With zones, a place outside them is never named nor counted (WMS-20):
  // the destination of a put-away is checked here as well as in its query.
  const reachable = isLimited(scoped)
    ? new Set(
        (
          await client.location.findMany({
            where: { id: { in: [...locationIds] }, ...place },
            select: { id: true },
          })
        ).map((row) => row.id),
      )
    : locationIds;
  const zoneOf = await zonesOf(
    client,
    [...locationIds].filter((id) => reachable.has(id)),
  );
  const timesByPerson = new Map<string, number[]>();
  const timesByZone = new Map<string, number[]>();
  for (const row of rows) {
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
    orders: headline.orders,
    picking: headline.picking,
    receiving: headline.receiving,
    tasksDelivered: headline.tasksDelivered,
    exits: {
      lines: headline.exits.lines,
      ...(headline.exits.value !== undefined
        ? {
            value: headline.exits.value,
            valueTruncated: headline.exits.valueTruncated,
          }
        : {}),
      top,
    },
    idle: {
      days: idleDaysCount,
      count: idleAll.length,
      rows: idleRows,
      truncated: idleTruncated,
    },
    zones: [...zones.values()].sort(
      (a, b) =>
        b.tasks + b.movementLines - (a.tasks + a.movementLines) ||
        a.name.localeCompare(b.name, "es") ||
        a.zoneId.localeCompare(b.zoneId),
    ),
    tasksTruncated,
  };
  if (headline.accuracy) result.accuracy = headline.accuracy;
  if (before) result.previous = { period: previous, ...before };

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

/** Warehouses compared at most in the view by warehouse. */
export const KPI_FACILITIES_MAX = 10;

export type KpiFacilityRow = KpiHeadline & {
  facilityId: string;
  name: string;
};

export type IndicatorsByFacility = {
  period: KpiPeriod;
  rows: KpiFacilityRow[];
  /** More warehouses in the scope than were compared. */
  truncated: boolean;
  /**
   * The whole company, added up from the rows (WMS-34, ADR 0085). Only for
   * who has no limit of warehouse or zone and only when every warehouse
   * was compared; medians cannot be added up and are left out.
   */
  company?: {
    shipped: number;
    read: number;
    complete: number;
    withDueDay: number;
    onTime: number;
    completeOnTime: number;
    completeShare: string | null;
    onTimeShare: string | null;
    completeOnTimeShare: string | null;
    pickedOrders: number;
    tasksDelivered: number;
    exitLines: number;
    accuracy?: { rows: number; exact: number; share: string | null };
    exitValue?: string;
    truncated: boolean;
  };
};

/**
 * The headline figures of a period for each warehouse the person reaches
 * (WMS-34, ADR 0085), each one inside the person's zones, with the same
 * function as the indicators. Product and person filters do not apply.
 */
export async function getIndicatorsByFacility(
  actor: InventoryActor,
  options: {
    preset?: unknown;
    from?: unknown;
    to?: unknown;
    /** For tests of the calendar's edges; screens never pass it. */
    now?: Date;
  } = {},
): Promise<IndicatorsByFacility> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.kpi.read",
  );
  const client = forOrganization(actor.organizationId);
  const [timeZone, scope, scoped, subject, allFacilities, putawayMode] =
    await Promise.all([
      companyTimeZone(client),
      loadScope(client, actor.userId),
      locationScopeWhere(client, actor.userId),
      loadSubject(actor.organizationId, actor.userId),
      client.facility.findMany({
        where: { archivedAt: null },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true },
      }),
      readSetting(client, PUTAWAY_MODE),
    ]);
  const costs = can(subject, "inventory.cost.read");
  const seesAccuracy = can(subject, "inventory.count_accuracy.read");
  const today = dayOf(options.now ?? new Date(), timeZone);
  const period = resolvePeriod(today, {
    preset: options.preset,
    from: options.from,
    to: options.to,
  });
  const startDay = windowOf(period.from, timeZone);
  const endDay = windowOf(period.next, timeZone);
  if (!startDay || !endDay) throw new Error("Unreadable period");
  const range = { gte: startDay.range.gte, lt: endDay.range.gte };
  const window: DayWindow = { day: period.from, range };

  const reached = allFacilities.filter((f) => facilityInScope(scope, f.id));
  const compared = reached.slice(0, KPI_FACILITIES_MAX);
  const headlines = await Promise.all(
    compared.map((facility) =>
      periodHeadline(client, {
        facilityId: facility.id,
        place: {
          facilityId: facility.id,
          ...(isLimited(scoped) ? { AND: [scoped] } : {}),
        },
        scoped,
        range,
        window,
        days: [period.from, period.next],
        timeZone,
        costs,
        seesAccuracy,
        productId: null,
        personId: null,
        putawayMode,
      }),
    ),
  );
  const rows: KpiFacilityRow[] = compared.map((facility, at) => ({
    facilityId: facility.id,
    name: facility.name,
    ...headlines[at]!,
  }));
  const truncated = reached.length > compared.length;
  const result: IndicatorsByFacility = { period, rows, truncated };

  // The whole company only for who sees all of it, and only when every
  // warehouse was compared (ADR 0038: no figure of the company otherwise).
  if (scope === null && !truncated && rows.length > 0) {
    const sum = (pick: (row: KpiFacilityRow) => number) =>
      rows.reduce((total, row) => total + pick(row), 0);
    const read = sum((r) => r.orders.read);
    const complete = sum((r) => r.orders.complete);
    const withDueDay = sum((r) => r.orders.withDueDay);
    const onTime = sum((r) => r.orders.onTime);
    const completeOnTime = sum((r) => r.orders.completeOnTime);
    const company: NonNullable<IndicatorsByFacility["company"]> = {
      shipped: sum((r) => r.orders.shipped),
      read,
      complete,
      withDueDay,
      onTime,
      completeOnTime,
      completeShare: shareOf(complete, read),
      onTimeShare: shareOf(onTime, withDueDay),
      completeOnTimeShare: shareOf(completeOnTime, withDueDay),
      pickedOrders: sum((r) => r.picking.orders),
      tasksDelivered: sum((r) => r.tasksDelivered),
      exitLines: sum((r) => r.exits.lines),
      truncated: rows.some(
        (r) =>
          r.orders.truncated ||
          r.picking.truncated ||
          r.receiving.truncated ||
          r.accuracy?.truncated ||
          r.exits.valueTruncated,
      ),
    };
    if (seesAccuracy) {
      const lines = sum((r) => r.accuracy?.rows ?? 0);
      const exact = sum((r) => r.accuracy?.exact ?? 0);
      company.accuracy = { rows: lines, exact, share: shareOf(exact, lines) };
    }
    if (costs) {
      company.exitValue = formatValue(
        rows.reduce((total, r) => total.plus(r.exits.rawValue ?? 0), dec(0)),
      );
    }
    result.company = company;
  }
  return result;
}
